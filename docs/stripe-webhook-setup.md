# Stripe → Firebase webhook (fix 400 and verify)

Endpoint (Live):

`https://us-central1-pro-sports-quick-pix.cloudfunctions.net/api/webhooks/stripe`

Secret in Google Cloud Secret Manager: **`STRIPE_WEBHOOK_SECRET`** (value is Stripe’s **`whsec_…`** for **this** endpoint only).

---

## Step-by-step: fix **400** on webhook delivery

### 1. Open the correct webhook in Stripe (Live)

1. [Stripe Dashboard](https://dashboard.stripe.com) → turn **Test mode OFF**.
2. **Developers** → **Webhooks**.
3. Open the endpoint whose URL is **exactly** the URL above (not Ko-fi or another app).

### 2. Copy the Signing secret for that endpoint

1. On that endpoint’s page, **Signing secret** → **Reveal** (or **Roll** only if you intentionally rotate — then use the **new** secret).
2. Copy the full value starting with **`whsec_`**.

### 3. Update Secret Manager

1. [Google Cloud Console](https://console.cloud.google.com) → project **`pro-sports-quick-pix`**.
2. **Secret Manager** → open **`STRIPE_WEBHOOK_SECRET`**.
3. **+ New version** → paste the **`whsec_…`** → save.  
   Do not create a duplicate secret name; add a new **version** only.

### 4. Redeploy functions

```bash
cd /path/to/pro-sports-quick-pix
npx firebase-tools deploy --only functions
```

Wait for **Deploy complete**.

### 5. Quick checks (browser)

- Health (Stripe secrets loaded):  
  `https://us-central1-pro-sports-quick-pix.cloudfunctions.net/api/health`  
  Expect `stripeWebhookSecretConfigured: true`, `stripeSecretKeyMode: "live"` for live traffic.

- Webhook route reachable (GET probe):  
  `https://us-central1-pro-sports-quick-pix.cloudfunctions.net/api/webhooks/stripe`  
  Expect `{"ok":true,...}`.

### 6. Retry from Stripe

1. **Developers** → **Webhooks** → same endpoint.
2. Open the failed delivery → on the **latest** attempt, **Resend** if available.

### 7. If Resend isn’t available

Trigger a **new** event: small subscription change in Dashboard, or **Send test webhook** → e.g. `customer.subscription.updated`.

### 8. Confirm success

- Stripe delivery shows **HTTP 200** and response **`{"received":true}`**.
- Logs: search **`stripe_webhook_received`** in Google Cloud Logging.

### 9. User still not Pro in the app

After webhooks succeed, have the user run in-app **restore purchases** / billing restore if you expose it, or wait for the next relevant webhook.

---

## Common mistakes

- **`whsec_` from Test mode** or from a **different** webhook endpoint → signature never matches → **400**.
- **`STRIPE_SECRET_KEY`** must be **`sk_live_…`** for live subscription IDs (Secret Manager).
- Only the **most recent** delivery attempt can be **Resend**’d in Stripe; older attempts need a **new** event.

---

## Related code

- Handler: `functions/index.js` → `POST /webhooks/stripe`
- README: billing + troubleshooting section
