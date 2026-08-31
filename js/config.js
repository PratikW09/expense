/**
 * config.js
 * Google Identity Services configuration.
 * Consolidates exact required scopes at initial login.
 */
const CONFIG = {
  CLIENT_ID: '264456296680-kagklpicnp77fb32j89kc6uh1djassv6.apps.googleusercontent.com',
  
  SPREADSHEET_NAME: 'ExpenseSplit Tracker',
  EXPENSES_TAB: 'Expenses',
  SPLITS_TAB: 'Splits',
  CURRENCY: '₹',

  // Exactly these two scopes together (single space-delimited string, no broader permissions)
  SCOPES: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets'
};
