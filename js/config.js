/**
 * config.js
 * Google OAuth & Backend Configuration
 */
const CONFIG = {
  // Backend API URL (empty string "" if served from the same domain/server, or e.g. "http://localhost:8000")
  API_BASE_URL: '',

  CLIENT_ID: '264456296680-7j2iu4c26sf4req03ms0hliecu78fn4g.apps.googleusercontent.com',
  
  SPREADSHEET_NAME: 'ExpenseSplit Tracker',
  EXPENSES_TAB: 'Expenses',
  SPLITS_TAB: 'Splits',
  CURRENCY: '₹',

  // Exactly these scopes together (no broader permissions)
  SCOPES: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email'
};
