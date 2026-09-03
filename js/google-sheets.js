/**
 * google-sheets.js
 * Google Sheets API v4 Integration with Serverless OAuth Authorization Code & Refresh Tokens
 * - Backend token refresh endpoint: /api/get-access-token
 * - Eliminates frequent re-logins using long-lived encrypted refresh tokens
 * - Direct client-to-Google Sheets API v4 calls via wrapped sheetsFetch
 * - Distinct TOKEN_REVOKED error handling and sync queue protection
 * - Idempotent check-before-write, batch integrity, edit, and delete support
 */

const GoogleSheets = (() => {
  let accessToken = sessionStorage.getItem('g_access_token') || null;
  let tokenExpiresAt = parseInt(sessionStorage.getItem('g_token_expires_at') || '0', 10);
  let spreadsheetId = localStorage.getItem('g_spreadsheet_id') || null;
  let spreadsheetUrl = localStorage.getItem('g_spreadsheet_url') || null;
  let userProfile = JSON.parse(sessionStorage.getItem('g_user_profile') || 'null');

  let activeTokenPromise = null;
  let scopeUpgradeHandler = null;
  let tokenRevocationHandler = null;

  function isConnected() {
    return !!(accessToken || sessionStorage.getItem('g_access_token'));
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
   * Register listener for revoked/invalid refresh tokens (Task 2 & 5)
   */
  function onTokenRevoked(handler) {
    tokenRevocationHandler = handler;
  }

  /**
   * Task 2 & Task 5: Request or Refresh Access Token via backend /api/get-access-token
   * @param {boolean} force - Force an immediate backend refresh
   * @returns {Promise<string>} access token
   */
  function requestAccessTokenPromise(force = false) {
    if (activeTokenPromise) {
      return activeTokenPromise;
    }

    activeTokenPromise = (async () => {
      try {
        const baseUrl = (CONFIG.API_BASE_URL || '').replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/api/get-access-token`, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Cache-Control': 'no-cache',
          },
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const isRevoked = data.error === 'TOKEN_REVOKED' || data.error === 'TOKEN_REQUIRED';
          const err = new Error(data.message || 'Failed to authenticate with backend.');
          err.code = data.error || 'AUTH_FAILED';
          err.isTokenRevoked = isRevoked;
          err.statusCode = res.status;

          if (isRevoked) {
            accessToken = null;
            sessionStorage.removeItem('g_access_token');
            sessionStorage.removeItem('g_token_expires_at');
            if (typeof tokenRevocationHandler === 'function') {
              tokenRevocationHandler(err);
            }
          }
          throw err;
        }

        accessToken = data.accessToken;
        const expiresInSec = parseInt(data.expiresIn, 10) || 3600;
        tokenExpiresAt = Date.now() + (expiresInSec * 1000);

        sessionStorage.setItem('g_access_token', accessToken);
        sessionStorage.setItem('g_token_expires_at', tokenExpiresAt.toString());

        if (data.userProfile) {
          userProfile = data.userProfile;
          sessionStorage.setItem('g_user_profile', JSON.stringify(data.userProfile));
        }

        return accessToken;
      } finally {
        activeTokenPromise = null;
      }
    })();

    return activeTokenPromise;
  }

  /**
   * Ensure a valid, non-expired access token is available before each Sheets call.
   */
  async function getValidToken() {
    const now = Date.now();
    const hasValidCachedToken = accessToken && tokenExpiresAt && (tokenExpiresAt - now > 60000);

    if (hasValidCachedToken) {
      return accessToken;
    }

    return await requestAccessTokenPromise();
  }

  /**
   * Single wrapped Sheets/Google API fetch function with 401 retry-once (Task 5)
   */
  async function sheetsFetch(url, options = {}, isRetry = false) {
    let token;
    try {
      token = await getValidToken();
    } catch (tokenErr) {
      if (tokenErr.isTokenRevoked) {
        throw tokenErr;
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

    // Case A: 401 Unauthorized (Silent refresh retry via backend)
    if (res.status === 401 && !isRetry) {
      console.warn('Sheets API returned 401. Refreshing token via backend and retrying...');
      try {
        await requestAccessTokenPromise(true);
        return await sheetsFetch(url, options, true);
      } catch (retryTokenErr) {
        console.error('Token refresh failed after 401:', retryTokenErr);
        throw retryTokenErr;
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
   * Task 4: Initiate Login via Google Authorization Code flow with offline refresh token
   */
  function signIn() {
    const baseUrl = (CONFIG.API_BASE_URL || '').replace(/\/$/, '');
    window.location.href = `${baseUrl}/auth/login`;
  }

  /**
   * Task 3: Logout endpoint call
   */
  async function signOut() {
    try {
      const baseUrl = (CONFIG.API_BASE_URL || '').replace(/\/$/, '');
      await fetch(`${baseUrl}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
    } finally {
      accessToken = null;
      tokenExpiresAt = 0;
      userProfile = null;
      sessionStorage.removeItem('g_access_token');
      sessionStorage.removeItem('g_token_expires_at');
      sessionStorage.removeItem('g_user_profile');
    }
  }

  /**
   * Request scope upgrade / re-consent
   */
  function requestScopeConsent() {
    const baseUrl = (CONFIG.API_BASE_URL || '').replace(/\/$/, '');
    window.location.href = `${baseUrl}/auth/login`;
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
   * Find or create spreadsheet in user's Google Drive
   */
  async function getOrCreateSpreadsheet() {
    if (spreadsheetId) {
      try {
        const sheet = await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title`);
        await ensureTabsExist(spreadsheetId);
        return { spreadsheetId: sheet.spreadsheetId, url: getSpreadsheetUrl() };
      } catch (e) {
        if (e.isInsufficientScope || e.isTokenRevoked) throw e;
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
      if (e.isInsufficientScope || e.isTokenRevoked) throw e;
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
   * Lightweight read of Column A (IDs) to check if an item is already recorded (Idempotency)
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
      if (err.isInsufficientScope || err.isTokenRevoked) throw err;
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
   * Fetch all master expenses
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
      if (e.isInsufficientScope || e.isTokenRevoked) throw e;
      console.warn('fetchExpenses warning:', e);
      return [];
    }
  }

  /**
   * Fetch all splits
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
      if (e.isInsufficientScope || e.isTokenRevoked) throw e;
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
    requestAccessToken: requestAccessTokenPromise,
    onScopeUpgradeRequired,
    onTokenRevoked,
    requestScopeConsent,
  };
})();
