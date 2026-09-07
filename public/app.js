(() => {
  const state = {
    accounts: [],
    selected: new Set(),
    jobsByUsername: new Map(), // username -> latest job {role, status, detail}
    bridgeConnected: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${path} failed (${res.status})`);
    return body;
  }

  // --- Step 1: bridge script ---
  async function loadBridgeScript() {
    const res = await fetch('/api/bridge-script');
    const text = await res.text();
    $('#bridge-script').value = text;
  }
  $('#copy-bridge').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#bridge-script').value);
    $('#copy-confirm').textContent = 'Copied! Paste it into the threads.net console.';
    setTimeout(() => { $('#copy-confirm').textContent = ''; }, 4000);
  });

  // --- Bridge connectivity banner ---
  // The bridge's poll loop hits /api/pending-jobs roughly every 4s while
  // it's running — but browsers throttle JS timers in tabs that aren't in
  // the foreground (to save battery/CPU), so if the threads.net/threads.com
  // tab isn't the one you're actively looking at, its poll interval can
  // stretch to well past 4s even though nothing is actually broken. So we
  // treat a short gap as "probably just throttled" and only call it
  // genuinely disconnected after a much longer silence.
  const BRIDGE_THROTTLED_MS = 15000;
  const BRIDGE_DISCONNECTED_MS = 90000;
  function updateBridgeBanner(s) {
    const el = $('#bridge-status');
    const age = s.lastPollAt ? Date.now() - s.lastPollAt : null;
    if (age !== null && age < BRIDGE_THROTTLED_MS) {
      state.bridgeConnected = true;
      el.className = 'bridge-status connected';
      el.textContent = '● Bridge: connected';
    } else if (age !== null && age < BRIDGE_DISCONNECTED_MS) {
      // Not necessarily broken — most likely the tab is just backgrounded
      // and throttled. Still usable, just slower.
      state.bridgeConnected = true;
      el.className = 'bridge-status throttled';
      el.textContent = `● Bridge: slow to respond (last seen ${timeAgo(s.lastPollAt)}) — probably just backgrounded; click into the threads.net tab to wake it up`;
    } else if (s.lastPollAt) {
      state.bridgeConnected = false;
      el.className = 'bridge-status disconnected';
      el.textContent = `● Bridge: not responding (last seen ${timeAgo(s.lastPollAt)}) — click into the threads.net tab (browsers pause background tabs), and check the relay popup is still open and hasn't errored`;
    } else {
      state.bridgeConnected = false;
      el.className = 'bridge-status unknown';
      el.textContent = '● Bridge: not connected yet — paste the script into your threads.net console (step 1)';
    }
  }

  function showToast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.hidden = true; }, 6000);
  }

  // --- Step 2: status ---
  async function pollStatus() {
    try {
      const s = await api('/api/status');
      $('#stat-accounts').textContent = s.accountCount;
      $('#stat-counts').textContent = s.accountsWithCounts;
      $('#stat-bio').textContent = s.accountsWithBio;
      $('#stat-queue').textContent = s.profileFetchQueueLength;
      updateBridgeBanner(s);
    } catch (err) {
      console.error(err);
    }
  }

  $('#fetch-missing').addEventListener('click', async () => {
    const missing = state.accounts
      .filter((a) => typeof a.follower_count !== 'number' || a.biography === undefined || a.biography === null)
      .map((a) => a.username)
      .slice(0, 300);
    if (missing.length === 0) {
      $('#fetch-missing-hint').textContent = 'Nothing missing — all captured accounts already have full data.';
      return;
    }
    const { ok } = await ensureTemplate('profile_info', missing[0]);
    if (!ok) { $('#fetch-missing-hint').textContent = 'Cancelled.'; return; }
    try {
      const r = await api('/api/request-profile-fetch', { method: 'POST', body: JSON.stringify({ usernames: missing }) });
      $('#fetch-missing-hint').textContent = `Queued ${r.queued}. Keep the threads.net tab open — the bridge will fetch them with delays between each.`;
    } catch (err) {
      $('#fetch-missing-hint').textContent = `Error: ${err.message}`;
    }
  });

  // --- Guided "teach it" modal: used the first time block/report/profile_info
  // is needed. Arms server-side recording, tells the user exactly what to do
  // on threads.net, and polls until the action is auto-detected & tagged. ---
  async function ensureTemplate(role, exampleUsername) {
    const status = await api('/api/status');
    if (status.taggedTemplates[role]) return { ok: true, recorded: false };
    const ok = await new Promise((resolve) => openRecordModal(role, exampleUsername, resolve));
    return { ok, recorded: ok };
  }

  function openRecordModal(role, username, resolve) {
    const modal = $('#record-modal');
    const actionLabel = { block: 'Block', report: 'Report' }[role];
    $('#record-modal-title').textContent = role === 'profile_info'
      ? 'One-time: teach the tool how to view a profile'
      : `One-time: teach the tool how you ${role}`;
    $('#record-modal-body').innerHTML = role === 'profile_info'
      ? `Go to your threads.net tab (the one running the bridge) and open <strong>@${escapeHtml(username)}</strong>'s profile. You don't need to do anything else — we'll detect it automatically.`
      : `Go to your threads.net tab (the one running the bridge), open <strong>@${escapeHtml(username)}</strong>'s profile, and click <strong>${actionLabel}</strong>. We'll detect it automatically and handle the rest of your selection for you.`;
    $('#record-modal-status').textContent = 'Waiting for your action…';
    modal.hidden = false;

    api('/api/start-recording', { method: 'POST', body: JSON.stringify({ role, targetUsername: username }) })
      .catch((err) => { $('#record-modal-status').textContent = `Error: ${err.message}`; });

    let settled = false;
    const cancelBtn = $('#record-modal-cancel');
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      cancelBtn.removeEventListener('click', onCancel);
      modal.hidden = true;
      resolve(result);
    };
    const onCancel = async () => {
      await api('/api/cancel-recording', { method: 'POST' }).catch(() => {});
      finish(false);
    };
    cancelBtn.addEventListener('click', onCancel);

    const poll = setInterval(async () => {
      try {
        const status = await api('/api/status');
        if (status.taggedTemplates[role]) {
          $('#record-modal-status').textContent = 'Captured! Continuing…';
          setTimeout(() => finish(true), 900);
        }
      } catch (err) {
        console.error(err);
      }
    }, 1500);
  }

  $('#reset-learned').addEventListener('click', async () => {
    if (!confirm('Reset everything this tool has learned (block, report, and profile-info requests)? You\'ll be walked through teaching it again next time you need each one.')) return;
    try {
      await Promise.all(['block', 'report', 'profile_info'].map(
        (role) => api('/api/clear-template', { method: 'POST', body: JSON.stringify({ role }) }),
      ));
      showToast('Reset. It\'ll walk you through teaching it again next time you click Block, Report, or Fetch details.');
    } catch (err) {
      alert(err.message);
    }
  });

  // --- Step 3: accounts / filtering / actions ---
  async function pollAccounts() {
    try {
      state.accounts = await api('/api/accounts');
      renderResults();
    } catch (err) {
      console.error(err);
    }
  }

  async function pollJobs() {
    try {
      const jobs = await api('/api/action-jobs');
      for (const j of jobs) {
        const existing = state.jobsByUsername.get(j.target.username);
        if (!existing || j.jobId >= existing.jobId) {
          state.jobsByUsername.set(j.target.username, j);
        }
      }
      renderResults();
    } catch (err) {
      console.error(err);
    }
  }

  const ALL_RULE_IDS = ['a', 'b', 'c', 'd', 'e'];

  function activeFilters() {
    return $$('.rule-filter:checked').map((el) => el.value);
  }

  // No checkboxes checked means "everything suspicious" (any of the 5
  // rules), not "everyone captured" — that's what the explicit "show all
  // captured accounts" checkbox is for.
  function matchesFilters(account, filters, mode) {
    const effective = filters.length === 0 ? ALL_RULE_IDS : filters;
    const matchedIds = new Set(account.matches.map((m) => m.id));
    if (mode === 'all') return effective.every((f) => matchedIds.has(f));
    return effective.some((f) => matchedIds.has(f));
  }

  // Shared by rendering and "select all" so they never drift apart.
  function visibleAccounts() {
    const showAll = $('#show-all').checked;
    const hideActioned = $('#hide-actioned').checked;
    const filters = activeFilters();
    const mode = $('#match-mode').value;
    return state.accounts.filter((a) => {
      if (hideActioned && (a.blocked || a.reported)) return false;
      return showAll || matchesFilters(a, filters, mode);
    });
  }

  function statusFor(a) {
    const job = state.jobsByUsername.get(a.username);
    // Persisted account-level flags (survive reload) take priority over a
    // stale in-memory job entry, but a live in-progress job still shows.
    if (job && (job.status === 'pending' || job.status === 'dispatched')) {
      return { text: `${job.role}: ${job.status}`, cls: job.status, title: job.detail || '' };
    }
    const parts = [];
    if (a.blocked) parts.push('blocked ✓');
    if (a.reported) parts.push('reported ✓');
    if (parts.length) return { text: parts.join(', '), cls: 'success', title: '' };
    if (job) {
      let text = `${job.role}: ${job.status}`;
      let cls = job.status;
      if (job.detail && /not blocked/i.test(job.detail)) { text += ' ⚠ NOT actually blocked'; cls = 'failed'; } else if (job.detail && /unverified/i.test(job.detail)) text += ' (unverified)';
      return { text, cls, title: job.detail || '' };
    }
    return { text: '', cls: '', title: '' };
  }

  function renderResults() {
    const rows = visibleAccounts();

    const body = $('#results-body');
    body.innerHTML = '';
    for (const a of rows) {
      const tr = document.createElement('tr');
      const checked = state.selected.has(a.username) ? 'checked' : '';
      const badges = a.matches.map((m) => `<span class="rule-badge" title="${escapeHtml(m.detail)}">${m.id}: ${m.name}</span>`).join(' ');
      const unknown = a.unknownRules && a.unknownRules.length
        ? `<div class="hint">needs fetch: ${a.unknownRules.join(',')}</div>` : '';
      const igHandle = a.matches.find((m) => m.id === 'd')?.instagramHandle;
      const bioSnippet = a.biography ? escapeHtml(truncate(a.biography, 80)) : '<span class="hint">no bio fetched</span>';
      const igLink = igHandle ? `<br/><a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener">@${igHandle}</a>` : '';
      const { text: statusText, cls: statusClass, title: statusTitle } = statusFor(a);

      tr.innerHTML = `
        <td><input type="checkbox" class="row-select" ${checked} /></td>
        <td><a href="https://www.threads.net/@${encodeURIComponent(a.username)}" target="_blank" rel="noopener">@${escapeHtml(a.username)}</a></td>
        <td>${escapeHtml(a.full_name || '')}</td>
        <td>${a.follower_count ?? '?'}</td>
        <td>${a.following_count ?? '?'}</td>
        <td>${a.is_default_avatar === undefined ? '?' : (a.is_default_avatar ? 'none' : 'yes')}</td>
        <td>${badges}${unknown}</td>
        <td>${bioSnippet}${igLink}</td>
        <td class="status-cell ${statusClass}" title="${escapeHtml(statusTitle)}">${statusText}</td>
      `;
      tr.querySelector('.row-select').addEventListener('change', (e) => {
        if (e.target.checked) state.selected.add(a.username);
        else state.selected.delete(a.username);
        updateSelectedCount();
      });
      body.appendChild(tr);
    }
    updateSelectedCount();
  }

  function updateSelectedCount() {
    $('#selected-count').textContent = `${state.selected.size} selected`;
  }

  $$('.rule-filter').forEach((el) => el.addEventListener('change', renderResults));
  $('#match-mode').addEventListener('change', renderResults);
  $('#show-all').addEventListener('change', renderResults);
  $('#hide-actioned').addEventListener('change', renderResults);

  $('#select-all').addEventListener('click', () => {
    for (const a of visibleAccounts()) state.selected.add(a.username);
    renderResults();
  });
  $('#select-none').addEventListener('click', () => {
    state.selected.clear();
    renderResults();
  });
  $('#refresh-now').addEventListener('click', () => {
    pollStatus();
    pollAccounts();
    pollJobs();
  });

  async function runBulkAction(roles) {
    const usernames = Array.from(state.selected);
    if (usernames.length === 0) return;
    if (!state.bridgeConnected) {
      const proceed = confirm(
        "The bridge doesn't look connected right now (see the banner at the top of the page) — "
        + 'nothing will actually run on threads.net until it is, including the one-time "teach it" step. '
        + 'Continue anyway (e.g. because you just pasted the script and it hasn\'t checked in yet)?',
      );
      if (!proceed) return;
    }
    if (!confirm(`${roles.join(' + ')} ${usernames.length} account(s)? This will be executed from your threads.net tab.`)) return;

    try {
      let totalQueued = 0;
      let totalSkipped = 0;
      for (const role of roles) {
        // Never re-queue an account that's already confirmed done for this
        // role, even if it's still in the current selection.
        const alreadyDone = new Set(
          state.accounts.filter((a) => (role === 'block' ? a.blocked : a.reported)).map((a) => a.username),
        );
        const roleUsernames = usernames.filter((u) => !alreadyDone.has(u));
        totalSkipped += usernames.length - roleUsernames.length;
        if (roleUsernames.length === 0) continue;

        const { ok, recorded } = await ensureTemplate(role, roleUsernames[0]);
        if (!ok) return; // user cancelled the guided capture

        let toQueue = roleUsernames;
        if (recorded) {
          // roleUsernames[0] was just done manually as the "teach it"
          // example — don't queue it again, just reflect that it's done.
          toQueue = roleUsernames.slice(1);
          state.jobsByUsername.set(roleUsernames[0], {
            jobId: -1,
            role,
            status: 'success',
            detail: 'done manually (used to teach the tool)',
          });
          api('/api/mark-actioned', { method: 'POST', body: JSON.stringify({ username: roleUsernames[0], role }) }).catch(() => {});
          renderResults();
        }
        if (toQueue.length === 0) continue;
        const r = await api('/api/request-actions', { method: 'POST', body: JSON.stringify({ role, usernames: toQueue }) });
        totalQueued += r.jobs.length;
        for (const j of r.jobs) {
          state.jobsByUsername.set(j.username, { jobId: j.jobId, role, status: 'pending' });
        }
      }
      renderResults();
      const notes = [];
      if (totalQueued > 0) {
        notes.push(state.bridgeConnected
          ? `Queued ${totalQueued} action(s) — watch the Status column below.`
          : `Queued ${totalQueued} action(s), but the bridge doesn't look connected — they'll stay "pending" until it is.`);
      }
      if (totalSkipped > 0) notes.push(`Skipped ${totalSkipped} already-done account(s).`);
      if (notes.length) showToast(notes.join(' '));
    } catch (err) {
      alert(`Something went wrong: ${err.message}`);
    }
  }
  $('#block-selected').addEventListener('click', () => runBulkAction(['block']));
  $('#block-report-selected').addEventListener('click', () => runBulkAction(['block', 'report']));

  function truncate(s, n) { return s.length > n ? `${s.slice(0, n)}…` : s; }
  function timeAgo(ts) {
    if (!ts) return '';
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    return new Date(ts).toLocaleTimeString();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  loadBridgeScript();
  pollStatus(); setInterval(pollStatus, 2500);
  pollAccounts(); setInterval(pollAccounts, 3500);
  pollJobs(); setInterval(pollJobs, 2500);
})();
