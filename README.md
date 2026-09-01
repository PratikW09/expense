# Daily Expense & Friend Split Tracker

A modern, high-performance web app for daily personal expense tracking and splitting bills with friends, backed directly by Google Sheets with long-lived session persistence.

---

## 📌 Features & Architecture

- **OAuth 2.0 Authorization Code Flow + Long-Lived Refresh Tokens**:
  - Eliminates frequent re-logins using a minimal serverless backend (`/auth/login`, `/auth/callback`, `/api/get-access-token`, `/api/logout`).
  - Google refresh tokens are encrypted at rest with AES-256-GCM and kept secure in `HttpOnly` session cookies.
  - Client secret never touches the browser.
- **Direct Google Sheets API v4 Integration**:
  - The frontend communicates directly with Google Sheets API v4 using fresh access tokens supplied by the backend.
  - Automatic silent refresh before token expiry with 401 retry-once.
- **Edit & Delete Actions**:
  - Edit any past expense with instant formula recalculation and Google Sheets update.
  - Delete master expenses or individual friend split line items.
- **Idempotency-Key Duplicate Prevention**:
  - Generates permanent UUIDs at creation time via `crypto.randomUUID()`.
  - Performs check-before-write reads on sync retries to prevent duplicates across network drops and timeouts.
- **3 Smart Split Modes**:
  - Equal Split (You + Friends).
  - Paid for Them (100%).
  - Custom Amounts with dynamic balance auto-sum.

---

## ⚙️ Environment Variables (Netlify)

Add the following environment variables in **Netlify Site Configuration > Environment Variables**:

| Variable | Description |
| :--- | :--- |
| `GOOGLE_CLIENT_ID` | Your Google OAuth 2.0 Web Client ID |
| `GOOGLE_CLIENT_SECRET` | Your Google OAuth 2.0 Client Secret |
| `ENCRYPTION_SECRET` | 32+ character random string for AES-256-GCM token encryption |
| `APP_URL` | *(Optional)* Your production URL (e.g. `https://serene-frangipane-551005.netlify.app`) |

---

## 🌐 Google Cloud Console Setup

In [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials):

1. Under **Authorized JavaScript origins**, add:
   - `https://serene-frangipane-551005.netlify.app`
   - `http://localhost:8888` (for local development)
2. Under **Authorized redirect URIs**, add:
   - `https://serene-frangipane-551005.netlify.app/auth/callback`
   - `http://localhost:8888/auth/callback` (for local development)
