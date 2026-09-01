/**
 * app.js
 * Expense & Split Tracker — Modern Fintech UX
 * - OAuth Authorization Code Flow with Long-Lived Refresh Tokens
 * - Edit & Delete for Personal Expenses & Split Requests
 * - Idempotency & Duplicate Prevention (crypto.randomUUID assigned at creation)
 * - Sub-item batch integrity & check-before-write on sync retries
 * - 3 Smart Split Modes: Equal, Paid for Them (100%), Custom Amounts
 */

const App = (() => {
  // Local state
  let expenses = JSON.parse(localStorage.getItem('local_expenses_cache') || '[]');
  let splits = JSON.parse(localStorage.getItem('local_splits_cache') || '[]');
  let friends = JSON.parse(localStorage.getItem('local_friends_list') || '["Sharad", "Shivraj"]');
  let selectedFriends = new Set();
  let splitMode = 'equal'; // 'equal' | 'full' | 'custom'
  let customAmounts = {};  // { [personName]: number }
  let currentTab = 'add';
  let activeFriendFilter = 'all';
  let searchQuery = '';
  let isSaving = false;
  let syncQueuePaused = false;
  let editingExpenseId = null;
  let els = {};

  /**
   * Generate permanent UUID at creation time
   */
  function generateUUID(prefix = '') {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return prefix ? `${prefix}_${crypto.randomUUID()}` : crypto.randomUUID();
    }
    const rand = Math.random().toString(36).substring(2, 12);
    const time = Date.now().toString(36);
    return prefix ? `${prefix}_${time}_${rand}` : `${time}_${rand}`;
  }

  async function init() {
    cacheDom();
    bindEvents();
    renderFriendChips();
    renderExpenses();
    renderFriendsBalances();
    setDefaultDate();

    // Register Scope Upgrade and Token Revocation listeners
    GoogleSheets.onScopeUpgradeRequired(handleScopeUpgradeRequired);
    GoogleSheets.onTokenRevoked(handleTokenRevoked);

    // Handle OAuth Redirect URL parameters
    await handleUrlAuthParams();

    // Initial auth & data synchronization
    await checkInitialSession();
  }

  function cacheDom() {
    els = {
      // Screens
      signinScreen: document.getElementById('signin-screen'),
      appScreen: document.getElementById('app-screen'),

      // Sign in & User
      googleSignInBtn: document.getElementById('google-signin-btn'),
      userAvatar: document.getElementById('user-avatar'),
      userName: document.getElementById('user-name'),
      sheetLink: document.getElementById('sheet-link'),
      signOutBtn: document.getElementById('signout-btn'),

      // Scope Upgrade Banner
      scopeUpgradeBanner: document.getElementById('scope-upgrade-banner'),
      reconnectGoogleBtn: document.getElementById('reconnect-google-btn'),

      // Edit Mode Indicator
      editModeIndicator: document.getElementById('edit-mode-indicator'),
      cancelEditBtn: document.getElementById('cancel-edit-btn'),

      // Tabs
      tabAdd: document.getElementById('tab-add'),
      tabFriends: document.getElementById('tab-friends'),
      viewAdd: document.getElementById('view-add'),
      viewFriends: document.getElementById('view-friends'),
      pendingBadge: document.getElementById('pending-badge'),

      // Expense Form
      expenseForm: document.getElementById('expense-form'),
      amountInput: document.getElementById('expense-amount'),
      actualDateInput: document.getElementById('expense-date'),
      noteInput: document.getElementById('expense-note'),
      friendsChipsContainer: document.getElementById('friends-chips'),
      splitClearBtn: document.getElementById('split-clear-btn'),
      splitModeContainer: document.getElementById('split-mode-container'),
      splitModeEqualBtn: document.getElementById('split-mode-equal'),
      splitModeFullBtn: document.getElementById('split-mode-full'),
      splitModeCustomBtn: document.getElementById('split-mode-custom'),
      customAmountsList: document.getElementById('custom-amounts-list'),
      splitPreview: document.getElementById('split-preview'),
      submitBtn: document.getElementById('submit-btn'),
      formStatus: document.getElementById('form-status'),

      // List & Stats
      totalAmountEl: document.getElementById('total-amount'),
      expensesList: document.getElementById('expenses-list'),
      recentDrawer: document.getElementById('recent-drawer'),

      // Friends View
      totalOwedAmountEl: document.getElementById('total-owed-amount'),
      friendsSearchInput: document.getElementById('friends-search-input'),
      clearSearchBtn: document.getElementById('clear-search-btn'),
      friendsFilterChips: document.getElementById('friends-filter-chips'),
      friendsBalancesList: document.getElementById('friends-balances-list'),
      friendsEmpty: document.getElementById('friends-empty'),
    };
  }

  function bindEvents() {
    // 1. Sign In (Authorization Code redirect)
    els.googleSignInBtn?.addEventListener('click', () => {
      showStatus('Redirecting to Google Sign-In...', 'info');
      GoogleSheets.signIn();
    });

    // 2. Interactive Scope Upgrade / Reconnect
    els.reconnectGoogleBtn?.addEventListener('click', () => {
      GoogleSheets.requestScopeConsent();
    });

    // 3. Sign Out
    els.signOutBtn?.addEventListener('click', async () => {
      showStatus('Signing out...', 'info');
      await GoogleSheets.signOut();
      updateAuthUI(false);
      showStatus('Signed out successfully.', 'info');
    });

    // 4. Tab Switching
    els.tabAdd?.addEventListener('click', () => switchTab('add'));
    els.tabFriends?.addEventListener('click', () => switchTab('friends'));

    // 5. Live Split Preview on Amount input
    els.amountInput?.addEventListener('input', updateSplitPreview);

    // 6. 3-Way Split Mode Toggle
    els.splitModeEqualBtn?.addEventListener('click', () => setSplitMode('equal'));
    els.splitModeFullBtn?.addEventListener('click', () => setSplitMode('full'));
    els.splitModeCustomBtn?.addEventListener('click', () => setSplitMode('custom'));

    // 7. Clear Split Selection
    els.splitClearBtn?.addEventListener('click', () => {
      selectedFriends.clear();
      customAmounts = {};
      setSplitMode('equal');
      if (els.splitModeContainer) els.splitModeContainer.style.display = 'none';
      if (els.customAmountsList) els.customAmountsList.style.display = 'none';
      renderFriendChips();
      updateSplitPreview();
    });

    // 8. Cancel Edit Mode
    els.cancelEditBtn?.addEventListener('click', cancelEdit);

    // 9. Search & Filter in Who Owes Me
    els.friendsSearchInput?.addEventListener('input', (e) => {
      searchQuery = (e.target.value || '').trim().toLowerCase();
      if (els.clearSearchBtn) {
        els.clearSearchBtn.style.display = searchQuery ? 'inline' : 'none';
      }
      renderFriendsBalances();
    });

    els.clearSearchBtn?.addEventListener('click', () => {
      searchQuery = '';
      if (els.friendsSearchInput) els.friendsSearchInput.value = '';
      els.clearSearchBtn.style.display = 'none';
      renderFriendsBalances();
    });

    // 10. Form Submit
    els.expenseForm?.addEventListener('submit', handleAddOrUpdateExpense);
  }

  /**
   * Handle OAuth Return Query Params (/?auth=success or /?auth_error=...)
   */
  async function handleUrlAuthParams() {
    const params = new URLSearchParams(window.location.search);

    if (params.has('auth')) {
      // Clean up URL query parameters without reloading
      window.history.replaceState({}, document.title, window.location.pathname);
      showStatus('Google Account connected! Syncing data... ✅', 'success');
    }

    if (params.has('auth_error')) {
      const err = params.get('auth_error');
      window.history.replaceState({}, document.title, window.location.pathname);
      showStatus(`Sign-in was not completed: ${err}`, 'error');
    }
  }

  /**
   * Check initial session status with the backend on page load
   */
  async function checkInitialSession() {
    try {
      await GoogleSheets.requestAccessToken();
      updateAuthUI(true);
      await GoogleSheets.getOrCreateSpreadsheet();
      syncQueuePaused = false;
      await syncAllPendingData();
      await syncFromGoogle();
    } catch (err) {
      if (err.isTokenRevoked || err.code === 'UNAUTHORIZED' || err.code === 'TOKEN_REQUIRED') {
        updateAuthUI(false);
      } else if (err.isInsufficientScope) {
        updateAuthUI(true);
        handleScopeUpgradeRequired(err);
      } else {
        // Offline or transient network issue — stay in cached app mode if we have local cache
        const hasCachedData = expenses.length > 0 || splits.length > 0;
        updateAuthUI(hasCachedData);
        if (!hasCachedData) {
          showStatus(`Could not reach backend: ${err.message}`, 'warning');
        }
      }
    }
  }

  function handleScopeUpgradeRequired(err) {
    console.warn('Scope upgrade required:', err);
    syncQueuePaused = true;
    if (els.scopeUpgradeBanner) {
      els.scopeUpgradeBanner.style.display = 'flex';
    }
  }

  function handleTokenRevoked(err) {
    console.warn('Token revoked / re-auth required:', err);
    syncQueuePaused = true;
    updateAuthUI(false);
    showStatus('Your session expired or Google permission was revoked. Please sign in again.', 'warning');
  }

  function updateAuthUI(connected) {
    const profile = GoogleSheets.getUserProfile();
    const sheetUrl = GoogleSheets.getSpreadsheetUrl();

    if (connected) {
      if (els.signinScreen) els.signinScreen.style.display = 'none';
      if (els.appScreen) els.appScreen.style.display = 'flex';

      if (profile) {
        if (els.userName) els.userName.textContent = profile.given_name || profile.name || 'Friend';
        if (els.userAvatar) {
          if (profile.picture) {
            els.userAvatar.src = profile.picture;
            els.userAvatar.style.display = 'block';
          } else {
            els.userAvatar.style.display = 'none';
          }
        }
      }

      if (sheetUrl && els.sheetLink) {
        els.sheetLink.href = sheetUrl;
      }
      setTimeout(() => els.amountInput?.focus(), 100);
    } else {
      if (els.signinScreen) els.signinScreen.style.display = 'block';
      if (els.appScreen) els.appScreen.style.display = 'none';
    }
  }

  function setSplitMode(mode) {
    splitMode = mode;
    [els.splitModeEqualBtn, els.splitModeFullBtn, els.splitModeCustomBtn].forEach((btn) => btn?.classList.remove('active'));

    if (mode === 'equal') {
      els.splitModeEqualBtn?.classList.add('active');
      if (els.customAmountsList) els.customAmountsList.style.display = 'none';
    } else if (mode === 'full') {
      els.splitModeFullBtn?.classList.add('active');
      if (els.customAmountsList) els.customAmountsList.style.display = 'none';
    } else if (mode === 'custom') {
      els.splitModeCustomBtn?.classList.add('active');
      renderCustomAmountInputs();
    }
    updateSplitPreview();
  }

  function switchTab(tab) {
    currentTab = tab;
    if (tab === 'add') {
      els.tabAdd.classList.add('active');
      els.tabFriends.classList.remove('active');
      els.viewAdd.style.display = 'block';
      els.viewFriends.style.display = 'none';
      els.amountInput?.focus();
    } else {
      els.tabFriends.classList.add('active');
      els.tabAdd.classList.remove('active');
      els.viewAdd.style.display = 'none';
      els.viewFriends.style.display = 'block';
      renderFriendsBalances();
    }
  }

  function setDefaultDate() {
    if (els.actualDateInput) {
      const today = new Date().toISOString().split('T')[0];
      els.actualDateInput.value = today;
    }
  }

  function formatDateTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ─── Friend Chips & Split Calculation ───────────────────── */
  function renderFriendChips() {
    if (!els.friendsChipsContainer) return;

    let html = '';
    friends.forEach((name) => {
      const isSelected = selectedFriends.has(name);
      html += `<button type="button" class="friend-chip ${isSelected ? 'active' : ''}" data-name="${escapeHtml(name)}">
        ${isSelected ? '✓ ' : '+ '}${escapeHtml(name)}
      </button>`;
    });

    html += `<button type="button" class="friend-chip friend-chip-add" id="add-new-friend-btn">
      + Add Person
    </button>`;

    els.friendsChipsContainer.innerHTML = html;

    els.friendsChipsContainer.querySelectorAll('.friend-chip:not(.friend-chip-add)').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        if (selectedFriends.has(name)) {
          selectedFriends.delete(name);
          delete customAmounts[name];
        } else {
          selectedFriends.add(name);
        }
        renderFriendChips();
        if (splitMode === 'custom') {
          renderCustomAmountInputs();
        }
        updateSplitPreview();
      });
    });

    document.getElementById('add-new-friend-btn')?.addEventListener('click', () => {
      const newName = prompt('Enter friend name:');
      if (newName && newName.trim()) {
        const trimmed = newName.trim();
        if (!friends.includes(trimmed)) {
          friends.push(trimmed);
          localStorage.setItem('local_friends_list', JSON.stringify(friends));
        }
        selectedFriends.add(trimmed);
        renderFriendChips();
        if (splitMode === 'custom') {
          renderCustomAmountInputs();
        }
        updateSplitPreview();
      }
    });

    const hasSelection = selectedFriends.size > 0;
    if (els.splitClearBtn) els.splitClearBtn.style.display = hasSelection ? 'inline' : 'none';
    if (els.splitModeContainer) els.splitModeContainer.style.display = hasSelection ? 'flex' : 'none';
  }

  function renderCustomAmountInputs() {
    if (!els.customAmountsList) return;
    const count = selectedFriends.size;

    if (count === 0 || splitMode !== 'custom') {
      els.customAmountsList.style.display = 'none';
      return;
    }

    els.customAmountsList.style.display = 'flex';
    const total = parseFloat(els.amountInput.value) || 0;
    const defaultPerPerson = count > 0 ? (total / (count + 1)).toFixed(2) : 0;

    let html = '';
    selectedFriends.forEach((person) => {
      if (customAmounts[person] === undefined && total > 0) {
        customAmounts[person] = Number(defaultPerPerson);
      }
      const val = customAmounts[person] !== undefined ? customAmounts[person] : '';

      html += `
        <div class="custom-amount-row">
          <span class="custom-amount-name">${escapeHtml(person)}</span>
          <div class="custom-input-box">
            <span>₹</span>
            <input 
              type="number" 
              class="custom-person-input" 
              data-person="${escapeHtml(person)}" 
              placeholder="0.00" 
              step="0.01" 
              min="0" 
              value="${val}" 
            />
          </div>
        </div>
      `;
    });

    els.customAmountsList.innerHTML = html;

    els.customAmountsList.querySelectorAll('.custom-person-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const pName = inp.dataset.person;
        const val = parseFloat(inp.value) || 0;
        customAmounts[pName] = val;
        
        const currentMainTotal = parseFloat(els.amountInput.value) || 0;
        if (currentMainTotal === 0) {
          let sum = 0;
          selectedFriends.forEach((p) => { sum += Number(customAmounts[p] || 0); });
          if (sum > 0) {
            els.amountInput.value = sum.toFixed(2);
          }
        }

        updateSplitPreview();
      });
    });
  }

  function updateSplitPreview() {
    const totalAmount = parseFloat(els.amountInput.value) || 0;
    const count = selectedFriends.size;

    if (!els.splitPreview) return;

    if (count === 0 || totalAmount <= 0) {
      els.splitPreview.style.display = 'none';
      return;
    }

    els.splitPreview.style.display = 'block';
    const friendNames = Array.from(selectedFriends).join(', ');

    if (splitMode === 'equal') {
      const totalPeople = count + 1;
      const share = (totalAmount / totalPeople).toFixed(2);
      const friendsTotalOwed = (Number(share) * count).toFixed(2);

      els.splitPreview.innerHTML = `
        <strong>${totalPeople} people</strong> (You + ${friendNames}) • <strong>${CONFIG.CURRENCY} ${share} each</strong><br/>
        <span style="color: var(--text-muted); font-size: 0.76rem;">
          Your share: ${CONFIG.CURRENCY} ${share} • Total friends owe: ${CONFIG.CURRENCY} ${friendsTotalOwed}
        </span>
      `;
    } else if (splitMode === 'full') {
      const perFriendShare = (totalAmount / count).toFixed(2);
      els.splitPreview.innerHTML = `
        <strong>100% Paid for Friends</strong> (${friendNames}) • <strong>${CONFIG.CURRENCY} ${perFriendShare} each</strong><br/>
        <span style="color: var(--text-muted); font-size: 0.76rem;">
          Your share: <strong>${CONFIG.CURRENCY} 0.00</strong> • Friends owe full: <strong>${CONFIG.CURRENCY} ${totalAmount.toFixed(2)}</strong>
        </span>
      `;
    } else {
      let friendsSum = 0;
      const breakdown = [];

      selectedFriends.forEach((person) => {
        const amt = Number(customAmounts[person] || 0);
        friendsSum += amt;
        breakdown.push(`${person}: ${CONFIG.CURRENCY}${amt.toFixed(2)}`);
      });

      const myShare = totalAmount - friendsSum;
      const isOver = myShare < 0;

      if (isOver) {
        els.splitPreview.innerHTML = `
          <span style="color: var(--danger); font-weight: 700;">
            Assigned amounts (${CONFIG.CURRENCY}${friendsSum.toFixed(2)}) exceed total bill (${CONFIG.CURRENCY}${totalAmount.toFixed(2)})!
          </span>
        `;
      } else {
        els.splitPreview.innerHTML = `
          <strong>Custom:</strong> ${breakdown.join(' • ')}<br/>
          <span style="color: var(--text-muted); font-size: 0.76rem;">
            Your remaining share: <strong>${CONFIG.CURRENCY} ${myShare.toFixed(2)}</strong> • Friends owe: <strong>${CONFIG.CURRENCY} ${friendsSum.toFixed(2)}</strong>
          </span>
        `;
      }
    }
  }

  /* ─── Sub-Item Batch Sync Function ───────────────────────── */
  async function syncItemBatch(expense, splitRows = [], isRetry = false) {
    if (!GoogleSheets.isConnected() || syncQueuePaused) return;

    if (!expense.syncedToGoogle) {
      try {
        await GoogleSheets.appendExpenseRow(expense, isRetry);
        expense.syncedToGoogle = true;
        saveExpensesCache();
      } catch (err) {
        console.error('Error syncing expense row:', err);
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
          return;
        }
        if (err.isTokenRevoked) {
          handleTokenRevoked(err);
          return;
        }
      }
    }

    const unsyncedSplits = splitRows.filter((s) => !s.syncedToGoogle);
    if (unsyncedSplits.length > 0) {
      try {
        await GoogleSheets.appendSplitRows(unsyncedSplits, isRetry);
        unsyncedSplits.forEach((s) => {
          s.syncedToGoogle = true;
        });
        saveSplitsCache();
      } catch (err) {
        console.error('Error syncing split rows:', err);
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
          return;
        }
        if (err.isTokenRevoked) {
          handleTokenRevoked(err);
          return;
        }
      }
    }

    renderExpenses();
    renderFriendsBalances();
  }

  /* ─── Form Submission: Add or Update Expense ─────────────── */
  async function handleAddOrUpdateExpense(e) {
    e.preventDefault();
    if (isSaving) return;

    const totalAmount = parseFloat(els.amountInput.value);
    const note = els.noteInput.value.trim();
    const actualDate = els.actualDateInput.value;

    if (isNaN(totalAmount) || totalAmount <= 0) {
      showStatus('Please enter a valid amount.', 'error');
      els.amountInput.focus();
      return;
    }
    if (!note) {
      showStatus('Please enter what this was for.', 'error');
      els.noteInput.focus();
      return;
    }
    if (!actualDate) {
      showStatus('Please choose a date.', 'error');
      return;
    }

    const splitFriendsList = Array.from(selectedFriends);
    const isSplit = splitFriendsList.length > 0;
    let myShare = totalAmount;
    let friendsTotalShare = 0;
    const newSplitRows = [];

    const isEditing = !!editingExpenseId;
    const expenseId = isEditing ? editingExpenseId : generateUUID('exp');
    const existingExpense = isEditing ? expenses.find((x) => x.id === expenseId) : null;
    const createdDate = existingExpense ? existingExpense.createdDate : formatDateTime(new Date());

    if (isSplit) {
      if (splitMode === 'equal') {
        const splitCount = splitFriendsList.length + 1;
        const perPersonShare = Math.round((totalAmount / splitCount) * 100) / 100;
        myShare = perPersonShare;
        friendsTotalShare = Math.round((perPersonShare * splitFriendsList.length) * 100) / 100;

        splitFriendsList.forEach((person) => {
          const prevSplit = isEditing ? splits.find((s) => s.expenseId === expenseId && s.personName === person) : null;
          newSplitRows.push({
            id: prevSplit ? prevSplit.id : generateUUID('spl'),
            expenseId,
            date: actualDate,
            description: note,
            personName: person,
            shareAmount: perPersonShare,
            isPaid: prevSplit ? prevSplit.isPaid : false,
            paidDate: prevSplit ? prevSplit.paidDate : '',
            syncedToGoogle: false,
          });
        });
      } else if (splitMode === 'full') {
        myShare = 0;
        friendsTotalShare = totalAmount;
        const perPersonShare = Math.round((totalAmount / splitFriendsList.length) * 100) / 100;

        splitFriendsList.forEach((person) => {
          const prevSplit = isEditing ? splits.find((s) => s.expenseId === expenseId && s.personName === person) : null;
          newSplitRows.push({
            id: prevSplit ? prevSplit.id : generateUUID('spl'),
            expenseId,
            date: actualDate,
            description: note,
            personName: person,
            shareAmount: perPersonShare,
            isPaid: prevSplit ? prevSplit.isPaid : false,
            paidDate: prevSplit ? prevSplit.paidDate : '',
            syncedToGoogle: false,
          });
        });
      } else {
        let friendsSum = 0;
        splitFriendsList.forEach((person) => {
          const amt = Number(customAmounts[person] || 0);
          friendsSum += amt;
          const prevSplit = isEditing ? splits.find((s) => s.expenseId === expenseId && s.personName === person) : null;
          newSplitRows.push({
            id: prevSplit ? prevSplit.id : generateUUID('spl'),
            expenseId,
            date: actualDate,
            description: note,
            personName: person,
            shareAmount: amt,
            isPaid: prevSplit ? prevSplit.isPaid : false,
            paidDate: prevSplit ? prevSplit.paidDate : '',
            syncedToGoogle: false,
          });
        });

        friendsTotalShare = friendsSum;
        myShare = totalAmount - friendsSum;

        if (myShare < 0) {
          showStatus('Error: Assigned split amounts exceed total bill amount.', 'error');
          return;
        }
      }
    }

    const expenseObj = {
      id: expenseId,
      createdDate,
      actualDate,
      amount: totalAmount,
      myShare,
      friendsShare: friendsTotalShare,
      note,
      splitWith: isSplit ? splitFriendsList.join(', ') : '',
      syncedToGoogle: false,
    };

    isSaving = true;
    els.submitBtn.disabled = true;
    els.submitBtn.innerHTML = isEditing ? 'Updating...' : 'Saving...';

    // 1. Update local cache immediately (0ms)
    if (isEditing) {
      expenses = expenses.map((e) => (e.id === expenseId ? expenseObj : e));
      splits = splits.filter((s) => s.expenseId !== expenseId);
      if (newSplitRows.length > 0) {
        splits = [...newSplitRows, ...splits];
      }
    } else {
      expenses.unshift(expenseObj);
      if (newSplitRows.length > 0) {
        splits = [...newSplitRows, ...splits];
      }
    }
    saveExpensesCache();
    saveSplitsCache();

    renderExpenses();
    renderFriendsBalances();

    // 2. Reset form
    cancelEdit();

    // 3. Write to Google Sheets
    if (GoogleSheets.isConnected() && !syncQueuePaused) {
      try {
        if (isEditing) {
          await GoogleSheets.updateExpenseRow(expenseObj);
          expenseObj.syncedToGoogle = true;
          saveExpensesCache();

          if (newSplitRows.length > 0) {
            await GoogleSheets.appendSplitRows(newSplitRows, true);
            newSplitRows.forEach((s) => (s.syncedToGoogle = true));
            saveSplitsCache();
          }
          showStatus(`Updated "${note}" (${CONFIG.CURRENCY}${totalAmount}) in Google Sheet ✅`, 'success');
        } else {
          await syncItemBatch(expenseObj, newSplitRows, false);
          if (expenseObj.syncedToGoogle) {
            if (isSplit) {
              const breakdownMsg = newSplitRows.map((r) => `${r.personName}: ${CONFIG.CURRENCY}${r.shareAmount}`).join(', ');
              showStatus(`Saved ${CONFIG.CURRENCY}${totalAmount} in Google Sheet (${breakdownMsg}) ✅`, 'success');
            } else {
              showStatus(`Saved ${CONFIG.CURRENCY}${totalAmount} for "${note}" in Google Sheet ✅`, 'success');
            }
          }
        }
      } catch (err) {
        console.error('Google Sheet save/update error:', err);
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
        } else if (err.isTokenRevoked) {
          handleTokenRevoked(err);
        } else {
          showStatus(`Saved locally. Will sync to Sheet automatically.`, 'info');
        }
      }
    } else {
      showStatus(isEditing ? `Updated locally.` : `Saved ${CONFIG.CURRENCY}${totalAmount} locally.`, 'info');
    }

    isSaving = false;
    els.submitBtn.disabled = false;
    els.submitBtn.innerHTML = 'Save Expense';
  }

  /* ─── Edit Expense Flow ─────────────────────────────────── */
  function startEditExpense(id) {
    const exp = expenses.find((e) => e.id === id);
    if (!exp) return;

    editingExpenseId = id;
    switchTab('add');

    els.amountInput.value = exp.amount;
    els.actualDateInput.value = exp.actualDate;
    els.noteInput.value = exp.note;

    selectedFriends.clear();
    customAmounts = {};

    const matchingSplits = splits.filter((s) => s.expenseId === id);
    if (matchingSplits.length > 0) {
      matchingSplits.forEach((s) => {
        selectedFriends.add(s.personName);
        customAmounts[s.personName] = Number(s.shareAmount);
      });

      if (exp.myShare === 0) {
        splitMode = 'full';
      } else {
        const totalPeople = matchingSplits.length + 1;
        const equalShare = Math.round((exp.amount / totalPeople) * 100) / 100;
        const isAllEqual = matchingSplits.every((s) => Math.abs(s.shareAmount - equalShare) < 0.05);
        splitMode = isAllEqual ? 'equal' : 'custom';
      }
    } else if (exp.splitWith) {
      exp.splitWith.split(',').forEach((name) => {
        const trimmed = name.trim();
        if (trimmed) selectedFriends.add(trimmed);
      });
      splitMode = 'equal';
    } else {
      splitMode = 'equal';
    }

    renderFriendChips();
    setSplitMode(splitMode);
    if (splitMode === 'custom') {
      renderCustomAmountInputs();
    }
    updateSplitPreview();

    if (els.editModeIndicator) els.editModeIndicator.style.display = 'flex';
    if (els.submitBtn) els.submitBtn.innerHTML = 'Update Expense';

    window.scrollTo({ top: 0, behavior: 'smooth' });
    els.amountInput.focus();
  }

  function cancelEdit() {
    editingExpenseId = null;
    els.amountInput.value = '';
    els.noteInput.value = '';
    selectedFriends.clear();
    customAmounts = {};
    setSplitMode('equal');
    if (els.splitModeContainer) els.splitModeContainer.style.display = 'none';
    if (els.customAmountsList) els.customAmountsList.style.display = 'none';
    if (els.editModeIndicator) els.editModeIndicator.style.display = 'none';
    if (els.submitBtn) els.submitBtn.innerHTML = 'Save Expense';
    renderFriendChips();
    updateSplitPreview();
    setDefaultDate();
  }

  /* ─── Delete Expense Flow ───────────────────────────────── */
  async function handleDeleteExpense(id) {
    const exp = expenses.find((e) => e.id === id);
    if (!exp) return;

    const confirmMsg = `Delete "${exp.note}" (${CONFIG.CURRENCY}${Number(exp.amount).toFixed(2)})? This will also remove any associated friend splits.`;
    if (!confirm(confirmMsg)) return;

    showStatus(`Deleting "${exp.note}"...`, 'info');

    expenses = expenses.filter((e) => e.id !== id);
    splits = splits.filter((s) => s.expenseId !== id);
    saveExpensesCache();
    saveSplitsCache();

    renderExpenses();
    renderFriendsBalances();

    if (editingExpenseId === id) {
      cancelEdit();
    }

    if (GoogleSheets.isConnected() && !syncQueuePaused) {
      try {
        await GoogleSheets.deleteExpenseAndSplits(id);
        showStatus(`Deleted "${exp.note}" from Google Sheet ✅`, 'success');
      } catch (err) {
        console.error('Delete expense error:', err);
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
        } else if (err.isTokenRevoked) {
          handleTokenRevoked(err);
        } else {
          showStatus(`Deleted locally. (Sheet warning: ${err.message})`, 'warning');
        }
      }
    } else {
      showStatus(`Deleted "${exp.note}" locally.`, 'success');
    }
  }

  /* ─── Delete Single Split Flow ──────────────────────────── */
  async function handleDeleteSplit(splitId) {
    const split = splits.find((s) => s.id === splitId);
    if (!split) return;

    const confirmMsg = `Delete split request of ${CONFIG.CURRENCY}${Number(split.shareAmount).toFixed(2)} for ${split.personName}?`;
    if (!confirm(confirmMsg)) return;

    showStatus(`Deleting split item for ${split.personName}...`, 'info');

    splits = splits.filter((s) => s.id !== splitId);
    saveSplitsCache();
    renderFriendsBalances();

    if (GoogleSheets.isConnected() && !syncQueuePaused) {
      try {
        await GoogleSheets.deleteSingleSplit(splitId);
        showStatus(`Deleted split request for ${split.personName} from Google Sheet ✅`, 'success');
      } catch (err) {
        console.error('Delete split error:', err);
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
        } else if (err.isTokenRevoked) {
          handleTokenRevoked(err);
        } else {
          showStatus(`Deleted locally. (Sheet warning: ${err.message})`, 'warning');
        }
      }
    } else {
      showStatus(`Deleted split request for ${split.personName} locally.`, 'success');
    }
  }

  /* ─── Friends & Balances View ────────────────────────────── */
  function renderFriendsBalances() {
    if (!els.friendsBalancesList) return;

    const unpaidSplits = splits.filter((s) => !s.isPaid);
    const map = {};

    unpaidSplits.forEach((s) => {
      if (!map[s.personName]) {
        map[s.personName] = { total: 0, items: [] };
      }
      map[s.personName].total += Number(s.shareAmount);
      map[s.personName].items.push(s);
    });

    const allPeople = Object.keys(map);
    const totalOwed = allPeople.reduce((sum, p) => sum + map[p].total, 0);

    if (els.totalOwedAmountEl) {
      els.totalOwedAmountEl.textContent = `${CONFIG.CURRENCY} ${totalOwed.toFixed(2)}`;
    }

    if (els.pendingBadge) {
      if (unpaidSplits.length > 0) {
        els.pendingBadge.textContent = unpaidSplits.length;
        els.pendingBadge.style.display = 'inline-block';
      } else {
        els.pendingBadge.style.display = 'none';
      }
    }

    if (els.friendsFilterChips) {
      if (allPeople.length > 1) {
        let chipsHtml = `<button type="button" class="filter-chip ${activeFriendFilter === 'all' ? 'active' : ''}" data-filter="all">
          All (${allPeople.length})
        </button>`;
        allPeople.forEach((p) => {
          chipsHtml += `<button type="button" class="filter-chip ${activeFriendFilter === p ? 'active' : ''}" data-filter="${escapeHtml(p)}">
            ${escapeHtml(p)} (${CONFIG.CURRENCY}${map[p].total.toFixed(0)})
          </button>`;
        });
        els.friendsFilterChips.innerHTML = chipsHtml;
        els.friendsFilterChips.style.display = 'flex';

        els.friendsFilterChips.querySelectorAll('.filter-chip').forEach((btn) => {
          btn.addEventListener('click', () => {
            activeFriendFilter = btn.dataset.filter;
            renderFriendsBalances();
          });
        });
      } else {
        els.friendsFilterChips.style.display = 'none';
      }
    }

    let filteredPeople = allPeople;
    if (activeFriendFilter !== 'all') {
      filteredPeople = filteredPeople.filter((p) => p === activeFriendFilter);
    }
    if (searchQuery) {
      filteredPeople = filteredPeople.filter((p) => p.toLowerCase().includes(searchQuery));
    }

    if (filteredPeople.length === 0) {
      if (els.friendsEmpty) {
        els.friendsEmpty.style.display = 'block';
        els.friendsEmpty.innerHTML = allPeople.length === 0
          ? '<p>All settled up! No pending dues.</p>'
          : '<p>No friends matching your search.</p>';
      }
      els.friendsBalancesList.innerHTML = '';
      return;
    }

    if (els.friendsEmpty) els.friendsEmpty.style.display = 'none';

    els.friendsBalancesList.innerHTML = filteredPeople
      .map((person) => {
        const data = map[person];
        const initial = person.charAt(0).toUpperCase();
        const itemCount = data.items.length;

        const itemsHtml = data.items
          .map(
            (it) => `
            <div class="fbc-item-row">
              <div class="fbc-item-desc">
                <span class="fbc-item-note">${escapeHtml(it.description)}</span>
                <span class="fbc-item-date">${escapeHtml(it.date)}</span>
              </div>
              <div class="fbc-item-right">
                <span class="fbc-item-amt">${CONFIG.CURRENCY} ${Number(it.shareAmount).toFixed(2)}</span>
                <button 
                  type="button" 
                  class="btn-item-settle" 
                  data-split-id="${escapeHtml(it.id)}" 
                  data-person="${escapeHtml(person)}" 
                  data-note="${escapeHtml(it.description)}" 
                  data-amount="${Number(it.shareAmount)}"
                  title="Mark this item as paid"
                >
                  Mark Paid
                </button>
                <button 
                  type="button" 
                  class="btn-item-delete" 
                  data-split-id="${escapeHtml(it.id)}" 
                  title="Delete split item"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          `
          )
          .join('');

        return `
          <details class="friend-accordion" open>
            <summary class="friend-summary-row">
              <div class="fbc-left">
                <div class="fbc-avatar">${initial}</div>
                <div class="fbc-name-wrap">
                  <span class="fbc-name">${escapeHtml(person)}</span>
                  <span class="fbc-count">${itemCount} unpaid expense${itemCount !== 1 ? 's' : ''}</span>
                </div>
              </div>
              
              <div class="fbc-right">
                <span class="fbc-badge">owes ${CONFIG.CURRENCY} ${data.total.toFixed(2)}</span>
                <span class="chevron-icon">▼</span>
              </div>
            </summary>

            <div class="fbc-content">
              <div class="fbc-items">
                ${itemsHtml}
              </div>

              <button type="button" class="btn-settle-all" data-person="${escapeHtml(person)}">
                Settle All (${CONFIG.CURRENCY} ${data.total.toFixed(2)})
              </button>
            </div>
          </details>
        `;
      })
      .join('');

    // Bind Settle and Delete buttons
    els.friendsBalancesList.querySelectorAll('.btn-item-settle').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const splitId = btn.dataset.splitId;
        const person = btn.dataset.person;
        const note = btn.dataset.note;
        const amount = btn.dataset.amount;
        await handleSettleSingleItem(splitId, person, note, amount);
      });
    });

    els.friendsBalancesList.querySelectorAll('.btn-item-delete').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const splitId = btn.dataset.splitId;
        await handleDeleteSplit(splitId);
      });
    });

    els.friendsBalancesList.querySelectorAll('.btn-settle-all').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const person = btn.dataset.person;
        await handleSettleAll(person);
      });
    });
  }

  /* ─── Settle Individual Item ─────────────────────────────── */
  async function handleSettleSingleItem(splitId, personName, note, amount) {
    const today = new Date().toISOString().split('T')[0];
    showStatus(`Settling ${CONFIG.CURRENCY}${amount} for "${note}" with ${personName}...`, 'info');

    splits = splits.map((s) => {
      if (s.id === splitId) {
        return { ...s, isPaid: true, paidDate: today };
      }
      return s;
    });
    saveSplitsCache();
    renderFriendsBalances();

    if (GoogleSheets.isConnected() && !syncQueuePaused) {
      try {
        await GoogleSheets.markSingleSplitAsPaid(splitId, today);
        showStatus(`Settled ${CONFIG.CURRENCY}${amount} for "${note}" with ${personName} in Google Sheet ✅`, 'success');
      } catch (err) {
        console.error('Single item settle sync error:', err);
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
        } else if (err.isTokenRevoked) {
          handleTokenRevoked(err);
        } else {
          showStatus(`Settled locally. (Sheet sync: ${err.message})`, 'warning');
        }
      }
    } else {
      showStatus(`Settled ${CONFIG.CURRENCY}${amount} for "${note}" with ${personName}`, 'success');
    }
  }

  /* ─── Settle All Dues For a Person ───────────────────────── */
  async function handleSettleAll(personName) {
    const today = new Date().toISOString().split('T')[0];
    showStatus(`Settling all dues for ${personName}...`, 'info');

    splits = splits.map((s) => {
      if (s.personName.toLowerCase() === personName.toLowerCase() && !s.isPaid) {
        return { ...s, isPaid: true, paidDate: today };
      }
      return s;
    });
    saveSplitsCache();
    renderFriendsBalances();

    if (GoogleSheets.isConnected() && !syncQueuePaused) {
      try {
        await GoogleSheets.settlePersonSplits(personName, today);
        showStatus(`${personName} is all settled up in Google Sheet! 🎉`, 'success');
      } catch (err) {
        console.error('Settle all sync error:', err);
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
        } else if (err.isTokenRevoked) {
          handleTokenRevoked(err);
        } else {
          showStatus(`Marked settled locally. (Sheet sync: ${err.message})`, 'warning');
        }
      }
    } else {
      showStatus(`${personName} marked as settled`, 'success');
    }
  }

  /* ─── Retry Sync with Check-Before-Write ─────────────────── */
  async function syncAllPendingData() {
    if (syncQueuePaused || !GoogleSheets.isConnected()) return;

    const unsyncedExpenses = expenses.filter((e) => !e.syncedToGoogle);
    for (const exp of unsyncedExpenses) {
      try {
        await GoogleSheets.appendExpenseRow(exp, true);
        exp.syncedToGoogle = true;
      } catch (err) {
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
          return;
        }
        if (err.isTokenRevoked) {
          handleTokenRevoked(err);
          return;
        }
        console.warn('Expense retry sync warning:', exp.id, err);
      }
    }
    saveExpensesCache();

    const unsyncedSplits = splits.filter((s) => !s.syncedToGoogle);
    if (unsyncedSplits.length > 0) {
      try {
        await GoogleSheets.appendSplitRows(unsyncedSplits, true);
        unsyncedSplits.forEach((s) => {
          s.syncedToGoogle = true;
        });
        saveSplitsCache();
      } catch (err) {
        if (err.isInsufficientScope) {
          handleScopeUpgradeRequired(err);
          return;
        }
        if (err.isTokenRevoked) {
          handleTokenRevoked(err);
          return;
        }
        console.warn('Splits retry sync warning:', err);
      }
    }

    renderExpenses();
    renderFriendsBalances();
  }

  /* ─── Sync From Google Sheets ────────────────────────────── */
  async function syncFromGoogle() {
    if (syncQueuePaused || !GoogleSheets.isConnected()) return;

    try {
      const [sheetExpenses, sheetSplits] = await Promise.all([
        GoogleSheets.fetchExpenses(),
        GoogleSheets.fetchSplits(),
      ]);

      if (sheetExpenses && sheetExpenses.length > 0) {
        const mappedExp = sheetExpenses.map((r) => ({
          id: r.id || generateUUID('exp'),
          createdDate: r.createdDate,
          actualDate: r.actualDate,
          amount: Number(r.amount),
          myShare: Number(r.myShare),
          friendsShare: Number(r.friendsShare),
          note: r.note,
          splitWith: r.splitWith,
          syncedToGoogle: true,
        }));

        const expMap = new Map();
        expenses.filter((e) => !e.syncedToGoogle).forEach((e) => expMap.set(e.id, e));
        mappedExp.forEach((e) => expMap.set(e.id, e));

        expenses = Array.from(expMap.values()).sort((a, b) => {
          return (b.actualDate || '').localeCompare(a.actualDate || '') || (b.createdDate || '').localeCompare(a.createdDate || '');
        });
        saveExpensesCache();
      }

      if (sheetSplits && sheetSplits.length > 0) {
        const splitMap = new Map();
        splits.filter((s) => !s.syncedToGoogle).forEach((s) => splitMap.set(s.id, s));
        sheetSplits.forEach((s) => splitMap.set(s.id, s));

        splits = Array.from(splitMap.values());
        saveSplitsCache();

        sheetSplits.forEach((s) => {
          if (s.personName && !friends.includes(s.personName)) {
            friends.push(s.personName);
          }
        });
        localStorage.setItem('local_friends_list', JSON.stringify(friends));
        renderFriendChips();
      }

      renderExpenses();
      renderFriendsBalances();
    } catch (e) {
      if (e.isInsufficientScope) {
        handleScopeUpgradeRequired(e);
      } else if (e.isTokenRevoked) {
        handleTokenRevoked(e);
      } else {
        console.warn('Could not auto-sync:', e);
      }
    }
  }

  function saveExpensesCache() {
    localStorage.setItem('local_expenses_cache', JSON.stringify(expenses));
  }

  function saveSplitsCache() {
    localStorage.setItem('local_splits_cache', JSON.stringify(splits));
  }

  /* ─── Render Recent Expenses with Edit & Delete ──────────── */
  function renderExpenses() {
    if (!els.expensesList) return;

    const total = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    if (els.totalAmountEl) els.totalAmountEl.textContent = `${CONFIG.CURRENCY} ${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (expenses.length === 0) {
      els.expensesList.innerHTML = '<div class="empty-state">No recent expenses.</div>';
      return;
    }

    const displayList = expenses.slice(0, 15);

    els.expensesList.innerHTML = displayList
      .map(
        (exp) => `
        <div class="expense-row-item" data-id="${escapeHtml(exp.id)}">
          <div class="row-left">
            <span class="row-note">${escapeHtml(exp.note)}</span>
            <span class="row-date">${escapeHtml(exp.actualDate)}${exp.splitWith ? ' • Split with: ' + escapeHtml(exp.splitWith) : ''}</span>
          </div>
          <div class="row-right">
            <span class="row-amount">${CONFIG.CURRENCY} ${Number(exp.amount).toFixed(2)}</span>
            <span class="row-status">${exp.syncedToGoogle ? 'In Sheet' : 'Local'}</span>
            <div class="row-actions">
              <button 
                type="button" 
                class="btn-row-action btn-row-edit" 
                data-id="${escapeHtml(exp.id)}" 
                title="Edit expense"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button 
                type="button" 
                class="btn-row-action btn-row-delete" 
                data-id="${escapeHtml(exp.id)}" 
                title="Delete expense"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      `
      )
      .join('');

    els.expensesList.querySelectorAll('.btn-row-edit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        startEditExpense(id);
      });
    });

    els.expensesList.querySelectorAll('.btn-row-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        handleDeleteExpense(id);
      });
    });
  }

  function showStatus(msg, type = 'info') {
    if (!els.formStatus) return;
    els.formStatus.textContent = msg;
    els.formStatus.className = `status-banner status-${type}`;
    els.formStatus.style.display = 'block';

    if (type === 'success') {
      setTimeout(() => {
        if (els.formStatus.textContent === msg) {
          els.formStatus.style.display = 'none';
        }
      }, 4000);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
