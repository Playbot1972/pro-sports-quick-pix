# Pro Sports Quick Pix

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
   - `APP_URL` (optional; defaults to GitHub Pages URL)
3. Deploy functions:
   - `firebase deploy --only functions`
4. Configure Stripe webhook to:
   - `https://us-central1-pro-sports-quick-pix.cloudfunctions.net/api/webhooks/stripe`

## Notes

- The frontend expects users to be logged in with Firebase Auth for checkout/restore.
- Entitlements are stored in Firestore (`entitlements/{uid}`).
