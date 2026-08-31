/**
 * google-sheets.js
 * Google Identity Services (OAuth2) & Google Sheets API v4
 * - Scope Consolidation: https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets
 * - Silent token renewal on expiry via GIS requestAccessToken({ prompt: '' })
 * - Single wrapped sheetsFetch for all Google API calls with automatic 401 retry
 * - Genuine 403 scope error detection and interactive consent recovery
 * - Idempotent check-before-write functions for Expenses & Splits
 * - Row Edit & Delete support (deleteDimension & values.update)
 */

const GoogleSheets = (() => {
  let tokenClient = null;
  let accessToken = sessionStorage.getItem('g_access_token') || null;
  let tokenExpiresAt = parseInt(sessionStorage.getItem('g_token_expires_at') || '0', 10);
  let spreadsheetId = localStorage.getItem('g_spreadsheet_id') || null;
  let spreadsheetUrl = localStorage.getItem('g_spreadsheet_url') || null;
  let userProfile = JSON.parse(sessionStorage.getItem('g_user_profile') || 'null');

  let activeTokenPromise = null;
  let scopeUpgradeHandler = null;

  function getClientId() {
    return localStorage.getItem('g_client_id') || CONFIG.CLIENT_ID || '';
  }

  function setClientId(id) {
    id = (id || '').trim();
    localStorage.setItem('g_client_id', id);
    CONFIG.CLIENT_ID = id;
  }

  function isConnected() {
    return !!accessToken;
  }

  function getUserProfile() {
    return userProfile;
  }

  function getSpreadsheetUrl() {
    return spreadsheetUrl || (spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null);
  }

  /**
   * Register listener for genuine 403 scope upgrade events
   */
  function onScopeUpgradeRequired(handler) {
    scopeUpgradeHandler = handler;
  }

  /**
   * Initialize or retrieve GIS Token Client with consolidated scopes
   */
  function ensureTokenClient(callback) {
    const clientId = getClientId();
    if (!clientId) {
      throw new Error('Google OAuth Client ID is missing.');
    }

    if (!window.google?.accounts?.oauth2) {
      throw new Error('Google Identity Services library is not loaded.');
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: CONFIG.SCOPES,
      callback: callback || (() => {}),
    });

    return tokenClient;
  }

  /**
   * Request Access Token via GIS
   * @param {string} promptMode - '' for silent renewal, 'consent' for interactive login/consent
   * @returns {Promise<string>} new access token
   */
  function requestAccessTokenPromise(promptMode = '') {
    if (activeTokenPromise) {
      return activeTokenPromise;
    }

    activeTokenPromise = new Promise((resolve, reject) => {
      const handleTokenCallback = async (resp) => {
        if (resp.error) {
          const err = new Error(resp.error_description || resp.error);
          err.oauthError = resp.error;
          reject(err);
          return;
        }

        accessToken = resp.access_token;
        const expiresInSec = parseInt(resp.expires_in, 10) || 3600;
        tokenExpiresAt = Date.now() + (expiresInSec * 1000);

        sessionStorage.setItem('g_access_token', accessToken);
        sessionStorage.setItem('g_token_expires_at', tokenExpiresAt.toString());

        resolve(accessToken);
      };

      try {
        const client = ensureTokenClient(handleTokenCallback);
        client.requestAccessToken({ prompt: promptMode });
      } catch (err) {
        reject(err);
      }
    }).finally(() => {
      activeTokenPromise = null;
    });

    return activeTokenPromise;
  }

  /**
   * Ensure a valid, non-expired access token is available.
   */
  async function getValidToken(interactive = false) {
    const now = Date.now();
    const hasValidCachedToken = accessToken && tokenExpiresAt && (tokenExpiresAt - now > 60000);

    if (!interactive && hasValidCachedToken) {
      return accessToken;
    }

    return await requestAccessTokenPromise(interactive ? 'consent' : '');
  }

  /**
   * Single wrapped Sheets/Google API fetch function
   */
  async function sheetsFetch(url, options = {}, isRetry = false) {
    let token;
    try {
      token = await getValidToken(false);
    } catch (tokenErr) {
      if (tokenErr.oauthError === 'interaction_required' || tokenErr.oauthError === 'consent_required') {
        const err = new Error('Session expired. Please reconnect your account.');
        err.requiresConsent = true;
        throw err;
      }
      throw tokenErr;
    }

    const headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, { ...options, headers });

    if (res.ok) {
      return await res.json();
    }

    // Case A: 401 Unauthorized (Silent renewal retry)
    if (res.status === 401 && !isRetry) {
      console.warn('Google API returned 401. Silently renewing token and retrying...');
      try {
        await requestAccessTokenPromise('');
        return await sheetsFetch(url, options, true);
      } catch (retryTokenErr) {
        console.error('Silent token renewal failed after 401:', retryTokenErr);
        const err = new Error('Session expired. Please sign in again.');
        err.requiresConsent = true;
        throw err;
      }
    }

    // Case B: 403 Forbidden (Check Insufficient Scopes)
    const errJson = await res.json().catch(() => ({}));
    const errMsg = errJson.error?.message || `Google API error: ${res.statusText}`;
    const errStatus = errJson.error?.status || '';

    const isInsufficientScope =
      res.status === 403 &&
      (errMsg.toLowerCase().includes('insufficient') ||
       errMsg.toLowerCase().includes('scope') ||
       errStatus === 'PERMISSION_DENIED' ||
       errJson.error?.details?.some(d => JSON.stringify(d).toLowerCase().includes('scope')));

    if (isInsufficientScope) {
      const scopeError = new Error('INSUFFICIENT_SCOPES: ' + errMsg);
      scopeError.isInsufficientScope = true;
      scopeError.statusCode = 403;

      if (typeof scopeUpgradeHandler === 'function') {
        scopeUpgradeHandler(scopeError);
      }
      throw scopeError;
    }

    const generalErr = new Error(errMsg);
    generalErr.statusCode = res.status;
    generalErr.errorDetails = errJson.error;
    throw generalErr;
  }

  /**
   * Interactive Sign-In / First Consent
   */
  async function signIn(onSuccess, onError) {
    let clientId = getClientId();

    if (!clientId) {
      clientId = prompt('Please enter your Google OAuth Web Client ID:');
      if (!clientId) {
        if (onError) onError('Google Client ID is required to sign in.');
        return;
      }
      setClientId(clientId);
    }

    try {
      await requestAccessTokenPromise('consent');

      try {
        const profile = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => r.ok ? r.json() : null).catch(() => null);

        if (profile) {
          userProfile = profile;
          sessionStorage.setItem('g_user_profile', JSON.stringify(profile));
        }
      } catch (e) {
        console.warn('Profile fetch skipped:', e);
      }

      await getOrCreateSpreadsheet();
      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Sign in error:', err);
      if (onError) onError(err.message || String(err));
    }
  }

  /**
   * Explicit Interactive Consent for Scope Upgrade
   */
  async function requestScopeConsent() {
    await requestAccessTokenPromise('consent');
    await ensureTabsExist(spreadsheetId).catch(console.warn);
    return accessToken;
  }

  function signOut() {
    if (accessToken && window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
    userProfile = null;
    sessionStorage.removeItem('g_access_token');
    sessionStorage.removeItem('g_token_expires_at');
    sessionStorage.removeItem('g_user_profile');
  }

  /**
   * Get internal sheetId number by title (for deleteDimension batchUpdates)
   */
  async function getSheetIdByName(tabName) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();
    const meta = await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
    const sheet = (meta.sheets || []).find((s) => s.properties.title === tabName);
    return sheet ? sheet.properties.sheetId : null;
  }

  /**
   * Ensure both Expenses and Splits tabs exist with correct headers
   */
  async function ensureTabsExist(sId) {
    try {
      const meta = await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${sId}?fields=sheets.properties.title,sheets.properties.sheetId`);
      const tabNames = (meta.sheets || []).map((s) => s.properties.title);
      const requests = [];

      if (!tabNames.includes(CONFIG.EXPENSES_TAB)) {
        const firstSheet = meta.sheets?.[0];
        if (firstSheet && firstSheet.properties.title === 'Sheet1') {
          requests.push({
            updateSheetProperties: {
              properties: { sheetId: firstSheet.properties.sheetId, title: CONFIG.EXPENSES_TAB },
              fields: 'title',
            },
          });
        } else {
          requests.push({
            addSheet: { properties: { title: CONFIG.EXPENSES_TAB, gridProperties: { frozenRowCount: 1 } } },
          });
        }
      }

      if (!tabNames.includes(CONFIG.SPLITS_TAB)) {
        requests.push({
          addSheet: { properties: { title: CONFIG.SPLITS_TAB, gridProperties: { frozenRowCount: 1 } } },
        });
      }

      if (requests.length > 0) {
        await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${sId}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({ requests }),
        });
      }

      const expHeader = [['Expense ID', 'Created Date', 'Actual Date', 'Total Amount', 'My Share', 'Friends Share', 'Note', 'Split With']];
      const splHeader = [['Split ID', 'Expense ID', 'Date', 'Note / Description', 'Person Name', 'Share Amount', 'Status', 'Paid Date']];

      await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sId}/values/${CONFIG.EXPENSES_TAB}!A1:H1?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: expHeader }) }
      ).catch(console.warn);

      await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sId}/values/${CONFIG.SPLITS_TAB}!A1:H1?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: splHeader }) }
      ).catch(console.warn);

    } catch (e) {
      console.warn('ensureTabsExist error:', e);
      throw e;
    }
  }

  /**
   * Find or create spreadsheet
   */
  async function getOrCreateSpreadsheet() {
    if (spreadsheetId) {
      try {
        const sheet = await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title`);
        await ensureTabsExist(spreadsheetId);
        return { spreadsheetId: sheet.spreadsheetId, url: getSpreadsheetUrl() };
      } catch (e) {
        if (e.isInsufficientScope) throw e;
        spreadsheetId = null;
        localStorage.removeItem('g_spreadsheet_id');
      }
    }

    try {
      const query = encodeURIComponent(`name = '${CONFIG.SPREADSHEET_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
      const searchRes = await sheetsFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,webViewLink)`);

      if (searchRes.files && searchRes.files.length > 0) {
        const found = searchRes.files[0];
        spreadsheetId = found.id;
        spreadsheetUrl = found.webViewLink || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        localStorage.setItem('g_spreadsheet_id', spreadsheetId);
        localStorage.setItem('g_spreadsheet_url', spreadsheetUrl);
        
        await ensureTabsExist(spreadsheetId);
        return { spreadsheetId, url: spreadsheetUrl };
      }
    } catch (e) {
      if (e.isInsufficientScope) throw e;
      console.warn('Drive search fallback:', e);
    }

    const newSheet = await sheetsFetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: CONFIG.SPREADSHEET_NAME },
        sheets: [
          { properties: { title: CONFIG.EXPENSES_TAB, gridProperties: { frozenRowCount: 1 } } },
          { properties: { title: CONFIG.SPLITS_TAB, gridProperties: { frozenRowCount: 1 } } },
        ],
      }),
    });

    spreadsheetId = newSheet.spreadsheetId;
    spreadsheetUrl = newSheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    localStorage.setItem('g_spreadsheet_id', spreadsheetId);
    localStorage.setItem('g_spreadsheet_url', spreadsheetUrl);

    await ensureTabsExist(spreadsheetId);

    return { spreadsheetId, url: spreadsheetUrl };
  }

  /**
   * Lightweight read of Column A (IDs) to check if an item is already recorded
   */
  async function fetchExistingIds(tabName) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();
    try {
      const res = await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${tabName}!A2:A`
      );
      const rows = res.values || [];
      const idSet = new Set();
      rows.forEach((r) => {
        if (r && r[0]) {
          idSet.add(String(r[0]).trim());
        }
      });
      return idSet;
    } catch (err) {
      if (err.isInsufficientScope) throw err;
      console.warn(`fetchExistingIds warning for ${tabName}:`, err);
      return new Set();
    }
  }

  /**
   * Append master expense row with check-before-write for retries
   */
  async function appendExpenseRow(expense, isRetry = false) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    if (isRetry) {
      const existingIds = await fetchExistingIds(CONFIG.EXPENSES_TAB);
      if (existingIds.has(String(expense.id).trim())) {
        console.log(`Expense ${expense.id} already exists in Sheet. Skipping append.`);
        return { alreadyExists: true };
      }
    }

    const row = [[
      expense.id,
      expense.createdDate,
      expense.actualDate,
      Number(expense.amount),
      Number(expense.myShare !== undefined ? expense.myShare : expense.amount),
      Number(expense.friendsShare || 0),
      expense.note,
      expense.splitWith || ''
    ]];

    try {
      return await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.EXPENSES_TAB}!A:H:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          body: JSON.stringify({ values: row }),
        }
      );
    } catch (err) {
      if (String(err.message || err).includes('Unable to parse range')) {
        await ensureTabsExist(spreadsheetId);
        return await sheetsFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.EXPENSES_TAB}!A:H:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          {
            method: 'POST',
            body: JSON.stringify({ values: row }),
          }
        );
      }
      throw err;
    }
  }

  /**
   * Append split rows with check-before-write for retries
   */
  async function appendSplitRows(splitRows, isRetry = false) {
    if (!splitRows || splitRows.length === 0) return { count: 0 };
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    let itemsToAppend = splitRows;

    if (isRetry) {
      const existingIds = await fetchExistingIds(CONFIG.SPLITS_TAB);
      itemsToAppend = splitRows.filter((s) => !existingIds.has(String(s.id).trim()));

      if (itemsToAppend.length === 0) {
        console.log('All split rows in batch already exist in Sheet. Skipping append.');
        return { alreadyExists: true, appendedCount: 0 };
      }
    }

    const rows = itemsToAppend.map((s) => [
      s.id,
      s.expenseId,
      s.date,
      s.description,
      s.personName,
      Number(s.shareAmount),
      s.isPaid ? 'Paid' : 'Unpaid',
      s.paidDate || '',
    ]);

    try {
      const res = await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.SPLITS_TAB}!A:H:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          body: JSON.stringify({ values: rows }),
        }
      );
      return { ...res, appendedIds: itemsToAppend.map(s => s.id) };
    } catch (err) {
      if (String(err.message || err).includes('Unable to parse range')) {
        await ensureTabsExist(spreadsheetId);
        const res = await sheetsFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.SPLITS_TAB}!A:H:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          {
            method: 'POST',
            body: JSON.stringify({ values: rows }),
          }
        );
        return { ...res, appendedIds: itemsToAppend.map(s => s.id) };
      }
      throw err;
    }
  }

  /**
   * Fetch all master expenses (with row indices for edit/delete)
   */
  async function fetchExpenses() {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    try {
      const res = await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.EXPENSES_TAB}!A2:H`
      );
      const rows = res.values || [];
      return rows.map((r, idx) => ({
        rowIndex: idx + 2,
        id: r[0] || '',
        createdDate: r[1] || '',
        actualDate: r[2] || '',
        amount: parseFloat(r[3]) || 0,
        myShare: parseFloat(r[4]) || parseFloat(r[3]) || 0,
        friendsShare: parseFloat(r[5]) || 0,
        note: r[6] || '',
        splitWith: r[7] || '',
      }));
    } catch (e) {
      if (e.isInsufficientScope) throw e;
      console.warn('fetchExpenses warning:', e);
      return [];
    }
  }

  /**
   * Fetch all splits (with row indices for edit/delete/settle)
   */
  async function fetchSplits() {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    try {
      const res = await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.SPLITS_TAB}!A2:H`
      );
      const rows = res.values || [];
      return rows.map((r, idx) => {
        const isPaidVal = String(r[6] || '').toLowerCase();
        const isPaid = isPaidVal === 'paid' || isPaidVal === 'true';
        return {
          rowIndex: idx + 2,
          id: r[0] || '',
          expenseId: r[1] || '',
          date: r[2] || '',
          description: r[3] || '',
          personName: r[4] || '',
          shareAmount: parseFloat(r[5]) || 0,
          isPaid,
          paidDate: r[7] || '',
        };
      });
    } catch (e) {
      if (e.isInsufficientScope) throw e;
      console.warn('fetchSplits warning:', e);
      return [];
    }
  }

  /**
   * Update an existing expense row in Google Sheets
   */
  async function updateExpenseRow(expense) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    const allExpenses = await fetchExpenses();
    const target = allExpenses.find((e) => e.id === expense.id);
    if (!target) return;

    const row = [
      expense.id,
      expense.createdDate || target.createdDate,
      expense.actualDate,
      Number(expense.amount),
      Number(expense.myShare !== undefined ? expense.myShare : expense.amount),
      Number(expense.friendsShare || 0),
      expense.note,
      expense.splitWith || ''
    ];

    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.EXPENSES_TAB}!A${target.rowIndex}:H${target.rowIndex}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        body: JSON.stringify({ values: [row] }),
      }
    );
  }

  /**
   * Delete an expense row and all its corresponding split rows from Google Sheets
   */
  async function deleteExpenseAndSplits(expenseId) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    // 1. Delete matching split rows first (in reverse row order so indices don't shift)
    const allSplits = await fetchSplits();
    const targetSplits = allSplits
      .filter((s) => s.expenseId === expenseId)
      .sort((a, b) => b.rowIndex - a.rowIndex);

    const splitsSheetId = await getSheetIdByName(CONFIG.SPLITS_TAB);
    if (splitsSheetId !== null && targetSplits.length > 0) {
      const splitRequests = targetSplits.map((s) => ({
        deleteDimension: {
          range: {
            sheetId: splitsSheetId,
            dimension: 'ROWS',
            startIndex: s.rowIndex - 1,
            endIndex: s.rowIndex,
          },
        },
      }));

      await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests: splitRequests }),
      }).catch(console.warn);
    }

    // 2. Delete the master expense row
    const allExpenses = await fetchExpenses();
    const targetExpense = allExpenses.find((e) => e.id === expenseId);
    const expensesSheetId = await getSheetIdByName(CONFIG.EXPENSES_TAB);

    if (expensesSheetId !== null && targetExpense) {
      await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: expensesSheetId,
                  dimension: 'ROWS',
                  startIndex: targetExpense.rowIndex - 1,
                  endIndex: targetExpense.rowIndex,
                },
              },
            },
          ],
        }),
      });
    }
  }

  /**
   * Delete a single split row by splitId
   */
  async function deleteSingleSplit(splitId) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    const allSplits = await fetchSplits();
    const target = allSplits.find((s) => s.id === splitId);
    if (!target) return;

    const splitsSheetId = await getSheetIdByName(CONFIG.SPLITS_TAB);
    if (splitsSheetId === null) return;

    await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: splitsSheetId,
                dimension: 'ROWS',
                startIndex: target.rowIndex - 1,
                endIndex: target.rowIndex,
              },
            },
          },
        ],
      }),
    });
  }

  /**
   * Settle a single split item by splitId
   */
  async function markSingleSplitAsPaid(splitId, paidDate) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    const splits = await fetchSplits();
    const target = splits.find((s) => s.id === splitId);
    if (!target) return;

    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${CONFIG.SPLITS_TAB}!G${target.rowIndex}:H${target.rowIndex}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        body: JSON.stringify({
          values: [['Paid', paidDate]],
        }),
      }
    );
  }

  /**
   * Settle all unpaid splits for a specific person in Google Sheets
   */
  async function settlePersonSplits(personName, paidDate) {
    if (!spreadsheetId) await getOrCreateSpreadsheet();

    const splits = await fetchSplits();
    const targets = splits.filter((s) => s.personName.toLowerCase() === personName.toLowerCase() && !s.isPaid);
    if (targets.length === 0) return;

    const data = targets.map((t) => ({
      range: `${CONFIG.SPLITS_TAB}!G${t.rowIndex}:H${t.rowIndex}`,
      values: [['Paid', paidDate]],
    }));

    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data,
        }),
      }
    );
  }

  return {
    getClientId,
    setClientId,
    signIn,
    signOut,
    isConnected,
    getUserProfile,
    getSpreadsheetUrl,
    getOrCreateSpreadsheet,
    ensureTabsExist,
    fetchExistingIds,
    appendExpenseRow,
    appendSplitRows,
    updateExpenseRow,
    deleteExpenseAndSplits,
    deleteSingleSplit,
    fetchExpenses,
    fetchSplits,
    markSingleSplitAsPaid,
    settlePersonSplits,
    sheetsFetch,
    onScopeUpgradeRequired,
    requestScopeConsent,
  };
})();
