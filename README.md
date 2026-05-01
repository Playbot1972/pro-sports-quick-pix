# Pro Sports Win (Quick Pix in-app)

Primary product and domain: **Pro Sports Win** — [prosports.win](https://prosports.win). **Quick Pix** is the quick-picks experience inside the `/app` web app.

Remote testing site for MLB and multi-sport pick generation.

## Billing + Restore Purchases (in progress)

This repo now includes a starter backend in `functions/` for secure Pro entitlements:

- `POST /billing/create-checkout-session` (requires Firebase Auth token)
- `POST /billing/restore` (requires Firebase Auth token)
- `GET /entitlements/me` (requires Firebase Auth token)
- `POST /webhooks/stripe` (Stripe webhook signature verification)

The frontend `index.html` now uses those endpoints for checkout and restore, and no longer treats `?pro=success` as a direct unlock.

## Deploy backend

1. Install dependencies:
   - `cd functions && npm install`
2. Set Firebase function secrets / env vars:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_ID`
   - `APP_URL` (optional; defaults to `https://prosports.win/app`)
3. Deploy functions:
   - `firebase deploy --only functions`
4. Configure Stripe **live** webhooks (Stripe Dashboard → Developers → Webhooks) to **exactly**:
   - `https://us-central1-pro-sports-quick-pix.cloudfunctions.net/api/webhooks/stripe`  
   After deploy, Cloud Run may also show a `*.run.app` URL — either form is fine if it hits this function; pick one and keep it consistent in Stripe.

### Stripe webhook failures (signature / “trouble sending requests”)

- **`STRIPE_WEBHOOK_SECRET`** must be the **Signing secret** (`whsec_…`) for **this** endpoint in the same mode as the events: use the **Live** secret for live traffic (not the test `whsec_` from test-mode webhooks). Update the value in Secret Manager and redeploy only if you change how secrets are bound; the secret *value* can be updated in GCP without code changes.
- **`STRIPE_SECRET_KEY`** must be a **`sk_live_`** key when processing **live** webhooks; a test key can break `subscriptions.retrieve` and return **500** to Stripe.
- **Reachability:** open the same URL with **GET** in a browser — you should see JSON `ok: true` and a short `detail` string. If GET fails, POST from Stripe will too.
- **Logs:** in Cloud Logging, filter for `stripe_webhook_signature_failed` or `stripe_webhook_empty_body` to distinguish bad secrets/payload from downstream errors.

Step-by-step (copy/paste checklist): [docs/stripe-webhook-setup.md](docs/stripe-webhook-setup.md).

## Notes

- The frontend expects users to be logged in with Firebase Auth for checkout/restore.
- Entitlements are stored in Firestore (`entitlements/{uid}`).
