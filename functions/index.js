import express from "express";
import cors from "cors";
import Stripe from "stripe";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

admin.initializeApp();

const db = admin.firestore();
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const stripePriceId = defineSecret("STRIPE_PRICE_ID");
const appUrl = defineSecret("APP_URL");
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

function activeStatusToPro(status) {
  return ["active", "trialing", "past_due"].includes(status);
}

async function upsertEntitlementFromSubscription(subscription) {
  const uid = subscription.metadata?.uid;
  if (!uid) return;

  const isPro = activeStatusToPro(subscription.status);
  await db.collection("entitlements").doc(uid).set(
    {
      uid,
      isPro,
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = getStripeClient();
  const webhookSecret = stripeWebhookSecret.value();
  if (!stripe || !webhookSecret) {
    res.status(500).send("Stripe not configured");
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.status(400).send("Missing stripe-signature header");
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
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
        await upsertEntitlementFromSubscription(subscription);
      }
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      await upsertEntitlementFromSubscription(subscription);
    }
  } catch (err) {
    res.status(500).send(`Webhook processing failed: ${err.message}`);
    return;
  }

  res.json({ received: true });
});

app.use(express.json());

app.get("/entitlements/me", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection("entitlements").doc(uid).get();
  const data = snap.exists ? snap.data() : null;
  res.json({
    uid,
    isPro: !!data?.isPro,
    subscriptionStatus: data?.subscriptionStatus || null,
    updatedAt: data?.updatedAt || null,
  });
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
      metadata: { uid },
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

  const urlBase = appUrl.value() || "https://playbot1972.github.io/pro-sports-quick-pix/";
  const successUrl = `${urlBase}?pro=success`;
  const cancelUrl = `${urlBase}?pro=cancel`;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: stripeCustomerId,
    client_reference_id: uid,
    metadata: { uid },
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  });

  res.json({ url: session.url });
});

app.post("/billing/restore", requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    res.status(500).json({ error: "Stripe not configured" });
    return;
  }
  const uid = req.user.uid;
  const customerSnap = await db.collection("stripeCustomers").doc(uid).get();
  if (!customerSnap.exists) {
    res.json({ restored: false, isPro: false, reason: "no_customer" });
    return;
  }

  const stripeCustomerId = customerSnap.data().stripeCustomerId;
  const subs = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 10,
  });

  const newest = subs.data.sort((a, b) => b.created - a.created)[0];
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

  await upsertEntitlementFromSubscription(newest);
  res.json({ restored: true, isPro: activeStatusToPro(newest.status), subscriptionStatus: newest.status });
});

export const api = onRequest(
  {
    region: "us-central1",
    invoker: "public",
    secrets: [stripeSecretKey, stripeWebhookSecret, stripePriceId, appUrl],
  },
  app,
);
