# Daily Expense & Friend Split Tracker (Google Sheets Backed)

## 📌 Features & Complete Lifecycle Management

A modern, fast web app with:
- **Edit & Delete Actions**:
  - **Edit Expense**: 1-click `✏️` loads any previous expense back into the form with an interactive "Editing Expense" mode, updating the master row and replacing/updating split entries in both local cache and Google Sheets.
  - **Delete Expense**: 1-click `🗑️` removes the expense and all corresponding friend split items with prompt confirmation, deleting the rows from Google Sheets via `deleteDimension`.
  - **Delete Split Request**: 1-click `🗑️` on individual friend split items under "Who Owes Me" removes erroneous or cancelled split requests.
- **Idempotency-Key Duplicate Prevention**: Assigns permanent IDs via `crypto.randomUUID()` at the moment of local creation, reused across retries.
- **Check-Before-Write Read**: Performs lightweight Column A reads (`values.get` on `${tab}!A2:A`) before appending retried items to prevent duplicate rows across network drops or multi-device syncs.
- **Sub-Item Batch Integrity**: Tracks sync status per sub-item (`expense.syncedToGoogle` and `split.syncedToGoogle`), allowing retries to sync only genuinely missing rows.
- **Consolidated OAuth Scopes**: `https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets`
- **Silent Token Renewal on Expiry**: Automatic, transparent refresh via Google Identity Services (`requestAccessToken({ prompt: '' })`) without user interruption.
- **Distinct Scope Upgrade Handling (403)**: Automatically detects genuine permission upgrades and offers 1-click interactive re-authorization.
- **3 Smart Split Modes**: Equal Split, Paid for Them (100%), and Custom Amounts with auto-sum.
