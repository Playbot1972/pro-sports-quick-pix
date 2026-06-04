# GitHub Actions — auto deploy on merge to `main`

Workflow: [`.github/workflows/deploy-production.yml`](../.github/workflows/deploy-production.yml)

When you **merge into `main`**, GitHub Actions deploys to Firebase project **`pro-sports-quick-pix`**:

| Path changed | Deploy target |
|--------------|---------------|
| Static app files (`index.html`, `demo.html`, `version.json`, assets, …) | **Hosting** → https://prosports.win |
| `functions/**` | **Cloud Functions** (API, Stripe webhooks, etc.) |

Only one production deploy runs at a time (`concurrency`).

## One-time setup (required)

### 1. Create a deploy service account

1. Open [Firebase Console](https://console.firebase.google.com/) → project **pro-sports-quick-pix**.
2. **Project settings** (gear) → **Service accounts**.
3. **Generate new private key** (JSON). Store the file securely.

The account needs permission to deploy Hosting and (if you use functions deploy) Cloud Functions. The default Firebase Admin service account usually works; if deploy fails with permission errors, in [Google Cloud IAM](https://console.cloud.google.com/iam-admin/iam?project=pro-sports-quick-pix) grant that service account:

- **Firebase Hosting Admin**
- **Cloud Functions Admin** (only if `functions/**` deploys)
- **Service Account User** (sometimes required for functions)

### 2. Add GitHub secret

**Do not commit the JSON file to git.** Only paste it into GitHub Secrets.

#### Option A — GitHub website (easiest)

1. Open the JSON in Notepad (e.g. `Downloads\pro-sports-quick-pix-firebase-adminsdk-fbsvc-fc0eee5a81.json`).
2. Select all (`Ctrl+A`) → Copy (`Ctrl+C`).
3. GitHub → repo **Playbot1972/pro-sports-quick-pix** → **Settings** → **Secrets and variables** → **Actions**.
4. **New repository secret**
5. Name: **`FIREBASE_SERVICE_ACCOUNT`**
6. Value: paste the **entire** JSON (starts with `{` and includes `"private_key"`).
7. **Add secret**

#### Option B — PowerShell (GitHub CLI on your PC)

```powershell
cd C:\Users\tisar\Downloads
gh auth login
gh secret set FIREBASE_SERVICE_ACCOUNT --repo Playbot1972/pro-sports-quick-pix --app actions < ".\pro-sports-quick-pix-firebase-adminsdk-fbsvc-fc0eee5a81.json"
```

If `gh` is not installed: `winget install GitHub.cli`

### 3. Enable Actions

Repo → **Settings** → **Actions** → **General** → allow Actions for this repository.

## Verify

1. Merge a change to `main` (or push directly).
2. **Actions** tab → workflow **Deploy production**.
3. After success, open https://prosports.win/version.json — should match `version.json` in the repo (e.g. `v1.24.2`).
4. App badge at https://prosports.win/app should show the same version (with **• server** in the tooltip).

## Manual deploy (fallback)

```bash
npm ci
npx firebase deploy --only hosting --project pro-sports-quick-pix
# functions only when needed:
cd functions && npm ci && cd ..
npx firebase deploy --only functions --project pro-sports-quick-pix
```

## Notes

- **Secrets in Functions** (`STRIPE_*`, etc.) are **not** set by this workflow; configure them in Firebase/Google Cloud as you do today.
- The workflow does **not** open PRs or merge branches — merge to `main` is still a human (or separate) step.
- Until the secret is added, the first deploy run will fail at the auth step.
