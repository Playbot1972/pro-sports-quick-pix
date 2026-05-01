import express from "express";
import cors from "cors";
import Stripe from "stripe";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import crypto from "node:crypto";

admin.initializeApp();

const db = admin.firestore();
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const stripePriceId = defineSecret("STRIPE_PRICE_ID");
const appUrl = defineSecret("APP_URL");
const resendApiKey = defineSecret("RESEND_API_KEY");
const feedbackToEmail = defineSecret("FEEDBACK_TO_EMAIL");
const twilioAccountSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TWILIO_AUTH_TOKEN");
const twilioFromNumber = defineSecret("TWILIO_FROM_NUMBER");
const STRIPE_BRAND_NAME = "ProSports.Win";
const STRIPE_STATEMENT_DESCRIPTOR = "PROSPORTS WIN";
const STRIPE_SUBSCRIPTION_DESCRIPTION = "ProSports.Win Pro monthly subscription";
let stripeClient = null;
let stripeClientKey = "";

function getStripeClient() {
  const key = stripeSecretKey.value();
  if (!key) return null;
  if (!stripeClient || stripeClientKey !== key) {
    stripeClient = new Stripe(key);
    stripeClientKey = key;
  }
  return stripeClient;
}

const app = express();
app.use(cors({ origin: true }));

// When Firebase Hosting rewrites `/api/**` to this function, the request path may include an
// `/api` prefix. Strip it so the same routes work for both Hosting (`/api/health`) and the
// default Cloud Functions URL shape (`/health`).
app.use((req, _res, next) => {
  if (typeof req.url === "string" && (req.url === "/api" || req.url.startsWith("/api/"))) {
    req.url = req.url.slice(4) || "/";
  }
  next();
});

const sportsCache = new Map();
const SPORTS_CACHE_MAX_ENTRIES = 250;
const SPORTS_CACHE_HOSTS = new Set(["site.api.espn.com", "statsapi.mlb.com", "api.open-meteo.com"]);

function sportsCacheTtlMs(url) {
  if (url.hostname === "api.open-meteo.com") return 20 * 60 * 1000;
  if (url.hostname === "statsapi.mlb.com") return 3 * 60 * 1000;
  return 2 * 60 * 1000;
}

function normalizeSportsCacheUrl(raw) {
  const url = new URL(String(raw || ""));
  if (url.protocol !== "https:" || !SPORTS_CACHE_HOSTS.has(url.hostname)) {
    throw new Error("URL is not an allowed sports data source.");
  }
  url.hash = "";
  return url;
}

function pruneSportsCache() {
  if (sportsCache.size <= SPORTS_CACHE_MAX_ENTRIES) return;
  const entries = [...sportsCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of entries.slice(0, Math.ceil(SPORTS_CACHE_MAX_ENTRIES / 5))) {
    sportsCache.delete(key);
  }
}

function logInfo(event, fields = {}) {
  console.info(JSON.stringify({ severity: "INFO", event, ...fields }));
}

function logWarn(event, fields = {}) {
  console.warn(JSON.stringify({ severity: "WARNING", event, ...fields }));
}

function logError(event, fields = {}) {
  console.error(JSON.stringify({ severity: "ERROR", event, ...fields }));
}

const ANALYTICS_EVENTS = new Set([
  "page_visit",
  "ad_landing",
  "sign_up",
  "account_created",
  "free_pick_used",
  "upgrade_modal_opened",
  "checkout_auth_required",
  "begin_checkout",
  "purchase",
  "billing_portal_opened",
  "feedback_submit",
  "access_code_redeemed",
]);

function safeMetricKey(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 64) || "unknown";
}

function analyticsDay(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function analyticsDateFromValue(value) {
  const ms = timestampToMillis(value);
  return ms ? new Date(ms) : new Date();
}

function analyticsDays(count) {
  const n = Math.min(30, Math.max(1, Number(count) || 7));
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i += 1) {
    out.push(analyticsDay(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

async function recordAnalyticsEvent(event, fields = {}) {
  const safeEvent = safeMetricKey(event);
  if (!ANALYTICS_EVENTS.has(safeEvent)) return false;
  const source = safeMetricKey(fields.source || "direct");
  const day = fields.day && /^\d{4}-\d{2}-\d{2}$/.test(String(fields.day))
    ? String(fields.day)
    : analyticsDay(fields.date ? analyticsDateFromValue(fields.date) : new Date());
  const update = {
    day,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    totalEvents: admin.firestore.FieldValue.increment(1),
    [`events.${safeEvent}`]: admin.firestore.FieldValue.increment(1),
    [`sources.${source}`]: admin.firestore.FieldValue.increment(1),
  };
  if (safeEvent === "purchase" || safeEvent === "begin_checkout") {
    update[`revenue.${safeEvent}`] = admin.firestore.FieldValue.increment(Number(fields.value || 0) || 0);
  }

  const dailyRef = db.collection("analyticsDaily").doc(day);
  const transactionId = fields.transactionId ? safeMetricKey(fields.transactionId) : "";
  const dedupeId = fields.dedupeId ? String(fields.dedupeId) : "";
  if (safeEvent === "purchase" && transactionId) {
    const dedupeRef = db.collection("analyticsPurchaseEvents").doc(transactionId);
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(dedupeRef);
      if (existing.exists) return false;
      tx.set(dedupeRef, {
        transactionId,
        day,
        source,
        value: Number(fields.value || 0) || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(dailyRef, update, { merge: true });
      return true;
    });
  }
  if (dedupeId || transactionId) {
    const stableId = dedupeId || `${safeEvent}:${transactionId}`;
    const dedupeRef = db.collection("analyticsEventDedupe").doc(`${safeEvent}_${sha256(stableId).slice(0, 40)}`);
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(dedupeRef);
      if (existing.exists) return false;
      tx.set(dedupeRef, {
        event: safeEvent,
        dedupeId: stableId,
        day,
        source,
        value: Number(fields.value || 0) || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(dailyRef, update, { merge: true });
      return true;
    });
  }

  await dailyRef.set(update, { merge: true });
  return true;
}

const PROMO_TRIAL_DAYS = 7;
const PROMO_ACCESS_CODES = new Set([
  "4Z059", "664B3", "S1014", "C0173", "G2843", "V1912", "5W955", "5M349", "3376R", "Z1099",
  "3068M", "N2736", "0802D", "4N530", "520G7", "99B78", "139R0", "Z6342", "066H6", "06Q93",
  "7564G", "54W38", "M1760", "4C257", "3M778", "559N2", "32Y77", "3D716", "2970V", "3H733",
  "08K08", "3E138", "G4386", "2K043", "1134V", "1A374", "3032X", "V6884", "544Y4", "458G3",
  "170H7", "1716Z", "663P0", "391C6", "8X534", "377Q1", "440R1", "R6965", "196F5", "387B1",
  "69Q89", "D6747", "D3549", "13R61", "358M3", "08E53", "Z3161", "H7124", "T0517", "772N8",
  "4X957", "006K0", "337Q1", "605D3", "J5320", "26H64", "173R9", "102D1", "4686R", "1H536",
  "2742J", "0176W", "C8608", "4E176", "766E5", "49X57", "05N40", "93H21", "3443Q", "2G641",
  "90V89", "8955Y", "673N3", "6B792", "7189J", "D5620", "206D4", "2H742", "98X39", "7D859",
  "6K141", "0367G", "200T8", "3272P", "930P7", "77S16", "5J966", "96P76", "2339F", "1F054",
]);

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const token = auth.slice("Bearer ".length);
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid token" });
  }
}

async function requireOwner(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  try {
    const token = auth.slice("Bearer ".length);
    const user = await admin.auth().verifyIdToken(token);
    const email = normalizeEmail(user.email);
    const ownerEmail = normalizeEmail(feedbackToEmail.value() || "digitaldr@gmail.com");
    if (!email || email !== ownerEmail) {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    req.user = user;
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid token" });
  }
}

function activeStatusToPro(status) {
  return ["active", "trialing", "past_due"].includes(status);
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function entitlementIsPro(data) {
  if (!data) return false;
  if (data.isPro) return true;
  return timestampToMillis(data.trialEndsAt) > Date.now();
}

function normalizePromoCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isValidPromoCodeShape(code) {
  return /^[A-Z0-9]{5}$/.test(code) && (code.match(/[A-Z]/g) || []).length === 1 && (code.match(/\d/g) || []).length === 4;
}

function normalizePhoneE164(value) {
  const raw = String(value || "").trim();
  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (plus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function isLikelyValidE164(value) {
  return /^\+[1-9]\d{9,14}$/.test(String(value || ""));
}

function smsTemplates() {
  return [
    {
      id: "birthday",
      label: "Birthday Gift",
      text: "Happy Birthday! 🎉 As a gift, here is your one-time access code for ProSports.win: {CODE}. Go to https://prosports.win/app and enter the code to unlock access. Enjoy your day!",
    },
    {
      id: "welcome",
      label: "Welcome Gift",
      text: "Welcome to ProSports.win! 🎉 Your one-time access code is {CODE}. Use it at https://prosports.win/app to unlock access.",
    },
    {
      id: "vip",
      label: "VIP Access",
      text: "You have been selected for VIP access on ProSports.win. Your one-time code: {CODE}. Redeem at https://prosports.win/app.",
    },
    {
      id: "limited",
      label: "Limited-Time Promo",
      text: "Limited-time ProSports.win access code: {CODE}. Redeem now at https://prosports.win/app before it expires.",
    },
    {
      id: "winback",
      label: "Come Back Offer",
      text: "We would love to have you back at ProSports.win. Here is your one-time code: {CODE}. Use it at https://prosports.win/app.",
    },
    {
      id: "thanks",
      label: "Thanks for Support",
      text: "Thanks for your support! 🙌 Here is your one-time ProSports.win access code: {CODE}. Redeem at https://prosports.win/app.",
    },
    {
      id: "short",
      label: "Quick Access (Short SMS)",
      text: "ProSports.win code: {CODE}. Redeem: https://prosports.win/app",
    },
  ];
}

function formatTimestampForEmail(value) {
  const ms = timestampToMillis(value);
  if (!ms) return "Unknown";
  return new Date(ms).toISOString();
}

async function sendOwnerNotificationEmail(subject, text) {
  const resendKey = resendApiKey.value();
  const toEmail = feedbackToEmail.value();
  if (!resendKey || !toEmail) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Pro Sports Win <onboarding@resend.dev>",
      to: [toEmail],
      subject,
      text,
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(detail || r.statusText);
  }
  return true;
}

function serverDay() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function optionalAuth(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    return await admin.auth().verifyIdToken(auth.slice("Bearer ".length));
  } catch (_) {
    return null;
  }
}

function freePickIdentity(user, email) {
  if (user?.uid) return { id: `uid:${user.uid}`, kind: "uid", uid: user.uid };
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) return null;
  return { id: `email:${sha256(normalizedEmail)}`, kind: "email", emailHash: sha256(normalizedEmail) };
}

async function userIsPro(uid) {
  if (!uid) return false;
  const snap = await db.collection("entitlements").doc(uid).get();
  const data = snap.exists ? snap.data() : null;
  return entitlementIsPro(data);
}

/** Stripe may send `customer` as id string or expanded object. */
function stripeCustomerIdString(customer) {
  if (!customer) return null;
  if (typeof customer === "string") return customer;
  if (typeof customer === "object" && typeof customer.id === "string") return customer.id;
  return null;
}

/** Resolve Firebase uid when subscription.metadata.uid is missing (older subs / Dashboard-created). */
async function findUidByStripeCustomerId(customerId) {
  if (!customerId) return null;
  const snap = await db.collection("stripeCustomers").where("stripeCustomerId", "==", customerId).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return doc.id || doc.data()?.uid || null;
}

async function upsertEntitlementFromSubscription(subscription, fallbackUid) {
  const customerId = stripeCustomerIdString(subscription.customer);
  let uid = subscription.metadata?.uid || fallbackUid || null;
  if (!uid && customerId) {
    uid = await findUidByStripeCustomerId(customerId);
  }
  if (!uid) {
    logWarn("stripe_subscription_no_firebase_uid", {
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customerId,
      hasMetadataUid: !!subscription.metadata?.uid,
    });
    return;
  }

  const isPro = activeStatusToPro(subscription.status);
  await db.collection("entitlements").doc(uid).set(
    {
      uid,
      isPro,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** Stripe requires the exact raw bytes; strict `type: application/json` can skip parsing for some Content-Type variants. */
const stripeWebhookRaw = express.raw({ type: "*/*", limit: "2mb" });

const STRIPE_WEBHOOK_POST_PATHS = ["/webhooks/stripe", "/webhooks/stripe/", "/webhooks/stripe."];

function stripeWebhookPayloadBuffer(req) {
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === "string") return Buffer.from(b, "utf8");
  return null;
}

app.get(STRIPE_WEBHOOK_POST_PATHS, (_req, res) => {
  res.status(200).json({
    ok: true,
    detail: "POST Stripe webhook events to this path. GET is only for reachability checks.",
  });
});

app.post(STRIPE_WEBHOOK_POST_PATHS, stripeWebhookRaw, async (req, res) => {
  const stripe = getStripeClient();
  const webhookSecret = stripeWebhookSecret.value();
  if (!stripe || !webhookSecret) {
    logError("stripe_webhook_not_configured");
    res.status(500).send("Stripe not configured");
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    logWarn("stripe_webhook_missing_signature", { path: req.path });
    res.status(400).send("Missing stripe-signature header");
    return;
  }

  const payload = stripeWebhookPayloadBuffer(req);
  if (!payload || !payload.length) {
    logWarn("stripe_webhook_empty_body", {
      path: req.path,
      contentType: req.headers["content-type"] || "",
      bodyType: typeof req.body,
    });
    res.status(400).send("Empty or non-raw body (signature verification requires raw payload)");
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    logWarn("stripe_webhook_signature_failed", {
      path: req.path,
      message: err.message,
      contentType: req.headers["content-type"] || "",
      payloadBytes: payload.length,
    });
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    logInfo("stripe_webhook_received", { type: event.type, stripeEventId: event.id });
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.metadata?.uid || session.client_reference_id;
      if (uid && session.customer) {
        await db.collection("stripeCustomers").doc(uid).set(
          {
            uid,
            stripeCustomerId: session.customer,
            email: session.customer_details?.email || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const uid = session.metadata?.uid || session.client_reference_id;
        await upsertEntitlementFromSubscription(subscription, uid);
        try {
          await recordAnalyticsEvent("purchase", {
            source: "stripe_webhook",
            value: 4.99,
            transactionId: `stripe_${session.id}`,
          });
        } catch (analyticsErr) {
          logError("stripe_webhook_analytics_failed", { message: analyticsErr.message, stripeEventId: event.id });
        }
        logInfo("stripe_checkout_fulfilled", {
          uid,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
        });
      }
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      await upsertEntitlementFromSubscription(subscription);
      logInfo("stripe_subscription_synced", {
        stripeCustomerId: stripeCustomerIdString(subscription.customer),
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        eventType: event.type,
        firebaseUid: subscription.metadata?.uid || null,
      });
    }
  } catch (err) {
    logError("stripe_webhook_processing_failed", { type: event.type, stripeEventId: event.id, message: err.message });
    res.status(500).send(`Webhook processing failed: ${err.message}`);
    return;
  }

  res.json({ received: true });
});

app.get("/sports-cache", async (req, res) => {
  let url;
  try {
    url = normalizeSportsCacheUrl(req.query.url);
  } catch (err) {
    res.status(400).json({ error: err.message || "Invalid sports data URL." });
    return;
  }

  const key = url.toString();
  const now = Date.now();
  const cached = sportsCache.get(key);
  if (cached && cached.expiresAt > now) {
    res.set("Cache-Control", "public, max-age=30");
    res.set("X-Sports-Cache", "HIT");
    res.json(cached.body);
    return;
  }

  try {
    const upstream = await fetch(key, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ProSportsQuickPix/1.0 (+https://prosports.win)",
      },
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      logWarn("sports_cache_upstream_non_200", { host: url.hostname, path: url.pathname, status: upstream.status });
      res.status(upstream.status).type("text/plain").send(text || upstream.statusText);
      return;
    }
    const body = JSON.parse(text);
    sportsCache.set(key, { body, expiresAt: now + sportsCacheTtlMs(url) });
    pruneSportsCache();
    res.set("Cache-Control", "public, max-age=30");
    res.set("X-Sports-Cache", "MISS");
    res.json(body);
  } catch (err) {
    if (cached) {
      logWarn("sports_cache_served_stale", { host: url.hostname, path: url.pathname, message: err.message });
      res.set("Cache-Control", "public, max-age=10");
      res.set("X-Sports-Cache", "STALE");
      res.json(cached.body);
      return;
    }
    logError("sports_cache_fetch_failed", { host: url.hostname, path: url.pathname, message: err.message });
    res.status(502).json({ error: `Sports data fetch failed: ${err.message}` });
  }
});

app.use(express.json());

function stripeSecretsProbe() {
  try {
    const sk = String(stripeSecretKey.value() || "");
    const wh = String(stripeWebhookSecret.value() || "");
    return {
      stripeSecretKeyConfigured: sk.startsWith("sk_"),
      stripeWebhookSecretConfigured: wh.startsWith("whsec_"),
      stripeSecretKeyMode: sk.startsWith("sk_live_") ? "live" : sk.startsWith("sk_test_") ? "test" : "missing_or_unknown",
    };
  } catch (_) {
    return {
      stripeSecretKeyConfigured: false,
      stripeWebhookSecretConfigured: false,
      stripeSecretKeyMode: "unavailable",
    };
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pro-sports-quick-pix-api",
    cacheEntries: sportsCache.size,
    checkedAt: new Date().toISOString(),
    stripe: stripeSecretsProbe(),
  });
});

app.post("/analytics/event", async (req, res) => {
  const event = safeMetricKey(req.body?.event);
  if (!ANALYTICS_EVENTS.has(event)) {
    res.status(204).send("");
    return;
  }

  const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {};
  const source = safeMetricKey(params.source || req.body?.source || "direct");
  try {
    await recordAnalyticsEvent(event, {
      source,
      value: Number(params.value || 0) || 0,
      transactionId: params.transaction_id || params.transactionId || "",
    });
    res.status(204).send("");
  } catch (err) {
    logError("analytics_event_write_failed", { event, source, message: err.message });
    res.status(204).send("");
  }
});

app.post("/analytics/debug-ping", requireOwner, async (_req, res) => {
  try {
    const day = analyticsDay(new Date());
    const dailyRef = db.collection("analyticsDaily").doc(day);
    await dailyRef.set({
      day,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      totalEvents: admin.firestore.FieldValue.increment(2),
      events: {
        page_visit: admin.firestore.FieldValue.increment(1),
        ad_landing: admin.firestore.FieldValue.increment(1),
      },
      sources: {
        monitor_debug: admin.firestore.FieldValue.increment(1),
        reddit: admin.firestore.FieldValue.increment(1),
      },
    }, { merge: true });
    const snap = await db.collection("analyticsDaily").doc(day).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    res.json({
      ok: true,
      day,
      events: data.events || {},
      sources: data.sources || {},
      totalEvents: data.totalEvents || 0,
    });
  } catch (err) {
    logError("analytics_debug_ping_failed", { message: err.message });
    res.status(500).json({ ok: false, error: `Debug ping failed: ${err.message}` });
  }
});

app.get("/analytics/summary", requireOwner, async (req, res) => {
  const days = analyticsDays(req.query.days);
  const snaps = await Promise.all(days.map((day) => db.collection("analyticsDaily").doc(day).get()));
  const rows = snaps.map((snap, idx) => {
    const data = snap.exists ? snap.data() : {};
    return {
      day: days[idx],
      totalEvents: data.totalEvents || 0,
      events: data.events || {},
      sources: data.sources || {},
      revenue: data.revenue || {},
    };
  });
  res.json({
    ok: true,
    days: rows,
    generatedAt: new Date().toISOString(),
  });
});

async function backfillStripeAnalytics(days) {
  const stripe = getStripeClient();
  if (!stripe) return { skipped: true, reason: "stripe_not_configured" };
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceSeconds = Math.floor(sinceMs / 1000);
  let startingAfter = null;
  const counts = { beginCheckout: 0, purchases: 0, scanned: 0 };

  while (true) {
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      created: { gte: sinceSeconds },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of sessions.data) {
      counts.scanned += 1;
      const eventDate = new Date(Number(session.created || 0) * 1000);
      const value = Number(session.amount_total || 0) > 0 ? Number(session.amount_total) / 100 : 4.99;
      if (await recordAnalyticsEvent("begin_checkout", {
        source: "backfill_stripe",
        value,
        transactionId: `checkout_${session.id}`,
        date: eventDate,
      })) {
        counts.beginCheckout += 1;
      }
      if (session.payment_status === "paid" || session.status === "complete") {
        if (await recordAnalyticsEvent("purchase", {
          source: "backfill_stripe",
          value,
          transactionId: `stripe_${session.id}`,
          date: eventDate,
        })) {
          counts.purchases += 1;
        }
      }
    }
    if (!sessions.has_more || !sessions.data.length) break;
    startingAfter = sessions.data[sessions.data.length - 1].id;
  }
  return counts;
}

async function backfillFirestoreAnalytics(days, authDays) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceDay = analyticsDay(new Date(sinceMs));
  const sinceTimestamp = admin.firestore.Timestamp.fromMillis(sinceMs);
  const authSinceMs = Date.now() - authDays * 24 * 60 * 60 * 1000;
  const counts = { accountCreated: 0, accessCodes: 0, freePicks: 0 };

  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) {
      const createdMs = Date.parse(user.metadata.creationTime);
      if (Number.isFinite(createdMs) && createdMs >= authSinceMs) {
        if (await recordAnalyticsEvent("account_created", {
          source: "backfill_auth",
          date: new Date(createdMs),
          dedupeId: `auth_user:${user.uid}`,
        })) {
          counts.accountCreated += 1;
        }
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  const promoSnap = await db.collection("promoCodeUsage").where("redeemedAt", ">=", sinceTimestamp).get();
  for (const doc of promoSnap.docs) {
    const data = doc.data() || {};
    if (await recordAnalyticsEvent("access_code_redeemed", {
      source: "backfill_access_code",
      date: analyticsDateFromValue(data.redeemedAt),
      dedupeId: `promo_code:${doc.id}`,
    })) {
      counts.accessCodes += 1;
    }
  }

  const freePickSnap = await db.collection("freePickUsage").get();
  for (const doc of freePickSnap.docs) {
    const data = doc.data() || {};
    const day = String(data.lastFreePickDate || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= sinceDay) {
      if (await recordAnalyticsEvent("free_pick_used", {
        source: "backfill_free_pick",
        day,
        dedupeId: `free_pick:${doc.id}:${day}`,
      })) {
        counts.freePicks += 1;
      }
    }
  }

  return counts;
}

app.post("/analytics/backfill", requireOwner, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body?.days || req.query.days) || 30));
  const parsedAuthDays = Number(req.body?.authDays);
  const authDays = Number.isFinite(parsedAuthDays)
    ? Math.min(3650, Math.max(1, parsedAuthDays))
    : Math.min(3650, 365);
  try {
    const [stripe, firestore] = await Promise.all([
      backfillStripeAnalytics(days),
      backfillFirestoreAnalytics(days, authDays),
    ]);
    logInfo("analytics_backfill_completed", { uid: req.user.uid, days, authDays, stripe, firestore });
    res.json({ ok: true, days, authDays, stripe, firestore, generatedAt: new Date().toISOString() });
  } catch (err) {
    logError("analytics_backfill_failed", { uid: req.user?.uid || "", days, message: err.message });
    res.status(500).json({ error: `Backfill failed: ${err.message}` });
  }
});

app.get("/owner/sms/meta", requireOwner, async (_req, res) => {
  try {
    const stateRef = db.collection("ownerState").doc("sms");
    const stateSnap = await stateRef.get();
    const state = stateSnap.exists ? (stateSnap.data() || {}) : {};
    const recent = Array.isArray(state.recentCodes) ? state.recentCodes : [];
    const codes = [...PROMO_ACCESS_CODES].sort((a, b) => a.localeCompare(b));
    const templates = smsTemplates().map((t) => ({ id: t.id, label: t.label, text: t.text }));
    res.json({
      ok: true,
      codes,
      lastCode: normalizePromoCode(state.lastCode || ""),
      recentCodes: recent.map((c) => normalizePromoCode(c)).filter(Boolean).slice(0, 5),
      templates,
    });
  } catch (err) {
    logError("owner_sms_meta_failed", { message: err.message });
    res.status(500).json({ error: "Could not load SMS metadata." });
  }
});

app.get("/owner/sms/config-status", requireOwner, async (_req, res) => {
  const sid = String(twilioAccountSid.value() || "").trim();
  const token = String(twilioAuthToken.value() || "").trim();
  const fromRaw = String(twilioFromNumber.value() || "").trim();
  const fromNormalized = normalizePhoneE164(fromRaw);
  const isMessagingServiceSid = /^MG[A-Za-z0-9]{32}$/.test(fromRaw);
  const validFrom = isLikelyValidE164(fromNormalized) || isMessagingServiceSid;
  res.json({
    ok: true,
    checks: {
      accountSidPresent: !!sid,
      authTokenPresent: !!token,
      fromPresent: !!fromRaw,
      fromIsE164: isLikelyValidE164(fromNormalized),
      fromIsMessagingServiceSid: isMessagingServiceSid,
      fromValid: validFrom,
    },
    guidance: validFrom
      ? "SMS provider config looks valid."
      : "TWILIO_FROM_NUMBER must be either +1... E.164 or Twilio Messaging Service SID (MG...).",
  });
});

app.get("/owner/sms/auth-test", requireOwner, async (_req, res) => {
  const sid = String(twilioAccountSid.value() || "").trim();
  const token = String(twilioAuthToken.value() || "").trim();
  if (!sid || !token) {
    res.status(400).json({
      ok: false,
      error: "Missing Twilio credentials.",
      details: {
        accountSidPresent: !!sid,
        authTokenPresent: !!token,
      },
    });
    return;
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const twResp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
    });
    const twData = await twResp.json().catch(() => ({}));
    if (!twResp.ok) {
      logWarn("owner_sms_auth_test_failed", {
        status: twResp.status,
        message: twData?.message || twResp.statusText,
      });
      res.status(401).json({
        ok: false,
        error: twData?.message || "Twilio auth failed.",
        code: twData?.code || null,
      });
      return;
    }
    res.json({ ok: true, accountStatus: twData?.status || "unknown" });
  } catch (err) {
    logError("owner_sms_auth_test_exception", { message: err.message });
    res.status(500).json({ ok: false, error: `Twilio auth test failed: ${err.message}` });
  }
});

app.post("/owner/sms/send", requireOwner, async (req, res) => {
  const to = normalizePhoneE164(req.body?.to);
  const code = normalizePromoCode(req.body?.code);
  const templateId = safeMetricKey(req.body?.templateId || "custom");
  const message = String(req.body?.message || "").trim();
  if (!isLikelyValidE164(to)) {
    res.status(400).json({ error: "Enter a valid phone number in E.164 format." });
    return;
  }
  if (!code || !PROMO_ACCESS_CODES.has(code)) {
    res.status(400).json({ error: "Select a valid access code." });
    return;
  }
  if (!message || message.length < 8) {
    res.status(400).json({ error: "Message is required." });
    return;
  }
  if (message.length > 1200) {
    res.status(400).json({ error: "Message is too long." });
    return;
  }

  const sid = String(twilioAccountSid.value() || "").trim();
  const token = String(twilioAuthToken.value() || "").trim();
  const fromRaw = String(twilioFromNumber.value() || "").trim();
  const from = normalizePhoneE164(fromRaw);
  const messagingServiceSid = /^MG[A-Za-z0-9]{32}$/.test(fromRaw) ? fromRaw : "";
  if (!sid || !token || !fromRaw) {
    res.status(500).json({
      error: "SMS provider is not configured.",
      details: {
        accountSidPresent: !!sid,
        authTokenPresent: !!token,
        fromPresent: !!fromRaw,
        fromLooksE164: isLikelyValidE164(from),
        fromLooksMessagingServiceSid: !!messagingServiceSid,
      },
    });
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const body = new URLSearchParams({
      To: to,
      Body: message,
    });
    if (messagingServiceSid) body.set("MessagingServiceSid", messagingServiceSid);
    else body.set("From", isLikelyValidE164(from) ? from : fromRaw);
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const smsResp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const smsData = await smsResp.json().catch(() => ({}));
    if (!smsResp.ok) {
      logError("owner_sms_send_failed", {
        status: smsResp.status,
        toMasked: `${to.slice(0, 3)}***${to.slice(-2)}`,
        message: smsData?.message || smsResp.statusText,
      });
      res.status(500).json({ error: smsData?.message || "SMS send failed." });
      return;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.collection("ownerSmsSends").add({
      to,
      code,
      templateId,
      message,
      provider: "twilio",
      providerSid: smsData?.sid || null,
      ownerUid: req.user.uid || null,
      ownerEmail: normalizeEmail(req.user.email || ""),
      createdAt: now,
    });
    await db.collection("ownerState").doc("sms").set({
      lastCode: code,
      recentCodes: admin.firestore.FieldValue.arrayUnion(code),
      updatedAt: now,
    }, { merge: true });
    logInfo("owner_sms_sent", {
      templateId,
      code,
      toMasked: `${to.slice(0, 3)}***${to.slice(-2)}`,
      providerSid: smsData?.sid || null,
    });
    res.json({ ok: true, providerSid: smsData?.sid || null });
  } catch (err) {
    logError("owner_sms_send_exception", { message: err.message });
    res.status(500).json({ error: `SMS send failed: ${err.message}` });
  }
});

app.get("/entitlements/me", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection("entitlements").doc(uid).get();
  const data = snap.exists ? snap.data() : null;
  const trialEndsAtMs = timestampToMillis(data?.trialEndsAt);
  res.json({
    uid,
    isPro: entitlementIsPro(data),
    subscriptionStatus: data?.subscriptionStatus || null,
    proSource: data?.isPro ? "stripe" : (trialEndsAtMs > Date.now() ? data?.proSource || "promo" : null),
    trialEndsAt: data?.trialEndsAt || null,
    updatedAt: data?.updatedAt || null,
  });
});

app.post("/promo/redeem", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const email = normalizeEmail(req.user.email || req.body?.email);
  const code = normalizePromoCode(req.body?.code);

  if (!isValidPromoCodeShape(code)) {
    res.status(400).json({ error: "Enter a valid 5-character access code." });
    return;
  }
  if (!PROMO_ACCESS_CODES.has(code)) {
    res.status(404).json({ error: "Access code not found." });
    return;
  }

  const entitlementRef = db.collection("entitlements").doc(uid);
  const usageRef = db.collection("promoCodeUsage").doc(code);
  const redemptionRef = db.collection("promoRedemptions").doc(`${uid}_${code}`);
  const nowMs = Date.now();
  const days = Math.min(30, Math.max(1, PROMO_TRIAL_DAYS));

  try {
    const result = await db.runTransaction(async (tx) => {
      const [entitlementSnap, usageSnap, redemptionSnap] = await Promise.all([
        tx.get(entitlementRef),
        tx.get(usageRef),
        tx.get(redemptionRef),
      ]);
      const entitlement = entitlementSnap.exists ? entitlementSnap.data() : {};
      if (entitlement?.isPro) {
        return { alreadyPro: true, redeemed: false, isPro: true, trialEndsAt: entitlement.trialEndsAt || null };
      }
      if (usageSnap.exists) {
        throw new Error("This access code has already been used.");
      }
      if (redemptionSnap.exists) {
        throw new Error("This account already redeemed that access code.");
      }

      const existingTrialMs = timestampToMillis(entitlement?.trialEndsAt);
      const startsAtMs = Math.max(nowMs, existingTrialMs);
      const trialEndsAt = admin.firestore.Timestamp.fromMillis(startsAtMs + days * 24 * 60 * 60 * 1000);
      const serverNow = admin.firestore.FieldValue.serverTimestamp();

      tx.set(
        usageRef,
        {
          code,
          uid,
          email,
          days,
          redeemedAt: serverNow,
          trialEndsAt,
        },
        { merge: false },
      );
      tx.set(
        redemptionRef,
        {
          uid,
          email,
          code,
          days,
          redeemedAt: serverNow,
          trialEndsAt,
        },
        { merge: false },
      );
      tx.set(
        entitlementRef,
        {
          uid,
          isPro: false,
          proSource: "promo",
          promoCode: code,
          trialDays: days,
          trialEndsAt,
          updatedAt: serverNow,
        },
        { merge: true },
      );

      return { alreadyPro: false, redeemed: true, isPro: true, trialEndsAt };
    });

    if (result.redeemed) {
      await recordAnalyticsEvent("access_code_redeemed", {
        source: "server_access_code",
        dedupeId: `promo_code:${code}`,
      });
      const text = [
        "A Pro Sports Win access code was redeemed.",
        "",
        `Code: ${code}`,
        `Trial days: ${days}`,
        `Trial ends: ${formatTimestampForEmail(result.trialEndsAt)}`,
        `User email: ${email || "Unknown"}`,
        `Firebase UID: ${uid}`,
        "",
        "This was an automatic notification from the promo code redemption flow.",
      ].join("\n");
      sendOwnerNotificationEmail("Pro Sports Win - Access Code Redeemed", text).catch((err) => {
        console.error("Promo redemption email failed:", err);
      });
    }

    res.json({ ok: true, code, days, ...result });
  } catch (err) {
    res.status(409).json({ error: err.message || "Could not redeem access code." });
  }
});

app.post("/free-pick/status", async (req, res) => {
  const user = await optionalAuth(req);
  const identity = freePickIdentity(user, req.body?.email);
  if (!identity) {
    res.status(400).json({ error: "Missing verified user or email." });
    return;
  }

  const today = serverDay();
  const isPro = await userIsPro(user?.uid);
  const snap = await db.collection("freePickUsage").doc(identity.id).get();
  const data = snap.exists ? snap.data() : {};
  const freePickUsed = !!(data.lastFreePickDate && data.lastFreePickDate === today);

  res.json({
    ok: true,
    isPro,
    freePickUsed: isPro ? false : freePickUsed,
    freePickDate: data.lastFreePickDate || null,
    serverDate: today,
  });
});

app.post("/free-pick/consume", async (req, res) => {
  const user = await optionalAuth(req);
  const identity = freePickIdentity(user, req.body?.email);
  if (!identity) {
    res.status(400).json({ error: "Missing verified user or email." });
    return;
  }

  const today = serverDay();
  const isPro = await userIsPro(user?.uid);
  if (isPro) {
    res.json({ ok: true, consumed: false, isPro: true, freePickUsed: false, serverDate: today });
    return;
  }

  const ref = db.collection("freePickUsage").doc(identity.id);
  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      if (data.lastFreePickDate === today) {
        return { allowed: false, freePickUsed: true, freePickDate: today };
      }
      tx.set(
        ref,
        {
          identityKind: identity.kind,
          uid: identity.uid || null,
          emailHash: identity.emailHash || null,
          lastFreePickDate: today,
          lastSport: String(req.body?.sport || ""),
          lastOption: String(req.body?.option || ""),
          lastCount: Number(req.body?.count || 0) || 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { allowed: true, freePickUsed: true, freePickDate: today };
    });

    logInfo("free_pick_consumed", {
      identityKind: identity.kind,
      consumed: result.allowed,
      sport: String(req.body?.sport || ""),
      option: String(req.body?.option || ""),
      count: Number(req.body?.count || 0) || 0,
      serverDate: today,
    });
    if (result.allowed) {
      await recordAnalyticsEvent("free_pick_used", {
        source: "server_free_pick",
        day: today,
        dedupeId: `free_pick:${identity.id}:${today}`,
      });
    }
    res.json({ ok: true, consumed: result.allowed, ...result, serverDate: today });
  } catch (err) {
    logError("free_pick_consume_failed", { identityKind: identity.kind, message: err.message });
    res.status(500).json({ error: `Could not consume free pick: ${err.message}` });
  }
});

app.post("/billing/create-checkout-session", requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  const priceId = stripePriceId.value();
  if (!stripe || !priceId) {
    res.status(500).json({ error: "Stripe not configured" });
    return;
  }

  const uid = req.user.uid;
  const email = req.user.email || req.body?.email || null;

  let stripeCustomerId = null;
  const customerSnap = await db.collection("stripeCustomers").doc(uid).get();
  if (customerSnap.exists) {
    stripeCustomerId = customerSnap.data().stripeCustomerId || null;
  }

  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: email || undefined,
      description: STRIPE_BRAND_NAME,
      metadata: { uid, brand: STRIPE_BRAND_NAME },
    });
    stripeCustomerId = customer.id;
    await db.collection("stripeCustomers").doc(uid).set(
      {
        uid,
        stripeCustomerId,
        email: email || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  const urlBase = appUrl.value() || "https://prosports.win/app";
  const successUrl = `${urlBase}?pro=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${urlBase}?pro=cancel`;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: stripeCustomerId,
    client_reference_id: uid,
    metadata: {
      uid,
      brand: STRIPE_BRAND_NAME,
      statementDescriptor: STRIPE_STATEMENT_DESCRIPTOR,
    },
    subscription_data: {
      description: STRIPE_SUBSCRIPTION_DESCRIPTION,
      invoice_settings: {
        issuer: { type: "self" },
      },
      metadata: {
        uid,
        brand: STRIPE_BRAND_NAME,
        statementDescriptor: STRIPE_STATEMENT_DESCRIPTOR,
      },
    },
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    branding_settings: {
      display_name: STRIPE_BRAND_NAME,
      border_style: "rounded",
      button_color: "#6ee7ff",
    },
    custom_text: {
      submit: {
        message: `Billed by ${STRIPE_BRAND_NAME}. Card statements may show ${STRIPE_STATEMENT_DESCRIPTOR}, depending on your bank.`,
      },
    },
    allow_promotion_codes: true,
  });

  logInfo("stripe_checkout_session_created", {
    uid,
    stripeCustomerId,
    stripeSessionId: session.id,
    successUrl,
  });
  await recordAnalyticsEvent("begin_checkout", {
    source: "server_checkout",
    value: 4.99,
    transactionId: `checkout_${session.id}`,
  });
  res.json({ url: session.url });
});

app.post("/billing/create-portal-session", requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    res.status(500).json({ error: "Stripe not configured" });
    return;
  }

  const uid = req.user.uid;
  const customerSnap = await db.collection("stripeCustomers").doc(uid).get();
  const stripeCustomerId = customerSnap.exists ? customerSnap.data().stripeCustomerId : null;
  if (!stripeCustomerId) {
    res.status(404).json({ error: "No Stripe customer found. Restore purchases first." });
    return;
  }

  try {
    const urlBase = appUrl.value() || "https://prosports.win/app";
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: urlBase,
    });
    logInfo("stripe_billing_portal_created", { uid, stripeCustomerId });
    res.json({ url: session.url });
  } catch (err) {
    logError("stripe_billing_portal_failed", { uid, stripeCustomerId, message: err.message });
    res.status(500).json({ error: `Billing portal failed: ${err.message}` });
  }
});

app.post("/billing/verify-checkout-session", requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    res.status(500).json({ error: "Stripe not configured" });
    return;
  }

  const uid = req.user.uid;
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+/.test(sessionId)) {
    res.status(400).json({ error: "Missing checkout session." });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
    const sessionUid = session.metadata?.uid || session.client_reference_id;
    if (!sessionUid || sessionUid !== uid) {
      logWarn("stripe_checkout_verify_uid_mismatch", { uid, sessionUid, stripeSessionId: session.id });
      res.status(403).json({ error: "Checkout session does not match this account." });
      return;
    }
    if (session.payment_status !== "paid" && session.status !== "complete") {
      res.status(409).json({ error: "Checkout is not paid yet.", paymentStatus: session.payment_status, status: session.status });
      return;
    }

    const subscription = typeof session.subscription === "string"
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription;
    if (!subscription) {
      res.status(409).json({ error: "Checkout session has no subscription yet." });
      return;
    }

    if (session.customer) {
      await db.collection("stripeCustomers").doc(uid).set(
        {
          uid,
          stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer.id,
          email: session.customer_details?.email || req.user.email || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    await upsertEntitlementFromSubscription(subscription, uid);
    await recordAnalyticsEvent("purchase", {
      source: "stripe_return_verify",
      value: 4.99,
      transactionId: `stripe_${session.id}`,
    });
    logInfo("stripe_checkout_verified_from_return", {
      uid,
      stripeSessionId: session.id,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
    });
    res.json({ isPro: activeStatusToPro(subscription.status), subscriptionStatus: subscription.status });
  } catch (err) {
    logError("stripe_checkout_verify_failed", { uid, sessionId, message: err.message });
    res.status(500).json({ error: `Checkout verification failed: ${err.message}` });
  }
});

app.post("/billing/restore", requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    res.status(500).json({ error: "Stripe not configured" });
    return;
  }
  const uid = req.user.uid;
  const email = (req.user.email || "").toLowerCase();
  const customerSnap = await db.collection("stripeCustomers").doc(uid).get();
  let stripeCustomerId = customerSnap.exists ? customerSnap.data().stripeCustomerId : null;
  let newest = null;

  async function newestSubForCustomer(customerId) {
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });
    return subs.data.sort((a, b) => b.created - a.created)[0] || null;
  }

  // First try explicit uid->customer mapping.
  if (stripeCustomerId) {
    newest = await newestSubForCustomer(stripeCustomerId);
  }

  // Fallback: discover Stripe customer by authenticated email.
  if (!newest && email) {
    const customers = await stripe.customers.list({ email, limit: 20 });
    for (const c of customers.data) {
      const sub = await newestSubForCustomer(c.id);
      if (sub) {
        newest = sub;
        stripeCustomerId = c.id;
        break;
      }
    }
  }

  if (!newest) {
    await db.collection("entitlements").doc(uid).set(
      {
        uid,
        isPro: false,
        subscriptionStatus: "none",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    res.json({ restored: false, isPro: false, reason: "no_subscription" });
    return;
  }

  // Persist discovered mapping to make future restores instant.
  if (stripeCustomerId) {
    await db.collection("stripeCustomers").doc(uid).set(
      {
        uid,
        stripeCustomerId,
        email: email || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  await upsertEntitlementFromSubscription(newest, uid);
  res.json({ restored: true, isPro: activeStatusToPro(newest.status), subscriptionStatus: newest.status });
});

app.post("/feedback/send", async (req, res) => {
  const resendKey = resendApiKey.value();
  const toEmail = feedbackToEmail.value();
  if (!resendKey || !toEmail) {
    res.status(500).json({ error: "Feedback email is not configured yet." });
    return;
  }

  const rating = Number(req.body?.rating || 0);
  const tags = String(req.body?.tags || "").trim();
  const comment = String(req.body?.comment || "").trim();
  const sport = String(req.body?.sport || "Unknown").trim();
  const subOption = String(req.body?.subOption || "Unknown").trim();
  const userEmail = String(req.body?.userEmail || "").trim();
  const userName = String(req.body?.userName || "").trim();
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: "Rating must be between 1 and 5." });
    return;
  }

  const text = [
    "New Pro Sports Win feedback",
    "",
    `Rating: ${rating} / 5`,
    `Tags: ${tags || "None"}`,
    `Sport: ${sport}`,
    `Option: ${subOption}`,
    `User name: ${userName || "Unknown"}`,
    `User email: ${userEmail || "Unknown"}`,
    "",
    "Comment:",
    comment || "(no comment)",
  ].join("\n");

  try {
    await sendOwnerNotificationEmail("Pro Sports Win - User Feedback", text);
    logInfo("feedback_sent", { rating, sport, subOption, hasComment: !!comment });
    res.json({ ok: true });
  } catch (err) {
    logError("feedback_send_failed", { rating, sport, subOption, message: err.message });
    res.status(500).json({ error: `Feedback send failed: ${err.message}` });
  }
});

export const api = onRequest(
  {
    region: "us-central1",
    invoker: "public",
    timeoutSeconds: 300,
    secrets: [
      stripeSecretKey,
      stripeWebhookSecret,
      stripePriceId,
      appUrl,
      resendApiKey,
      feedbackToEmail,
      twilioAccountSid,
      twilioAuthToken,
      twilioFromNumber,
    ],
  },
  app,
);
