(() => {
  const state = {
    accounts: [],
    selected: new Set(),
    jobsByUsername: new Map(), // username -> latest job {role, status, detail}
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

  // --- Step 2: status ---
  async function pollStatus() {
    try {
      const s = await api('/api/status');
      $('#stat-accounts').textContent = s.accountCount;
      $('#stat-counts').textContent = s.accountsWithCounts;
      $('#stat-bio').textContent = s.accountsWithBio;
      $('#stat-queue').textContent = s.profileFetchQueueLength;
      setBadge('#tpl-block', 'block', s.taggedTemplates.block);
      setBadge('#tpl-report', 'report', s.taggedTemplates.report);
      setBadge('#tpl-profile', 'profile_info', s.taggedTemplates.profile_info);
    } catch (err) {
      console.error(err);
    }
  }
  function setBadge(sel, name, ok) {
    const el = $(sel);
    el.textContent = `${name} ${ok ? '✓' : '✗'}`;
    el.classList.toggle('ok', !!ok);
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
    try {
      const r = await api('/api/request-profile-fetch', { method: 'POST', body: JSON.stringify({ usernames: missing }) });
      $('#fetch-missing-hint').textContent = `Queued ${r.queued}. Keep the threads.net tab open — the bridge will fetch them with delays between each.`;
    } catch (err) {
      $('#fetch-missing-hint').textContent = `Error: ${err.message}`;
    }
  });

  // --- Step 3: action requests / tagging ---
  async function pollActionRequests() {
    try {
      const reqs = await api('/api/action-requests');
      const body = $('#requests-body');
      body.innerHTML = '';
      for (const r of reqs.slice().reverse()) {
        const tr = document.createElement('tr');
        const fullPreview = `REQUEST BODY:\n${r.bodyPreview || '(empty)'}\n\nRESPONSE:\n${r.responseSnippet || '(empty/non-JSON)'}`;
        const previewLine = r.bodyPreview ? truncate(r.bodyPreview.replace(/\s+/g, ' '), 70) : '(empty body)';
        tr.innerHTML = `
          <td>${escapeHtml(timeAgo(r.ts))}</td>
          <td>${r.method}</td>
          <td>${r.operationHint ? `<strong>${escapeHtml(r.operationHint)}</strong>` : '<span class="hint">none found</span>'}</td>
          <td class="preview-cell" title="${escapeHtml(fullPreview)}"><code>${escapeHtml(previewLine)}</code></td>
          <td>
            <button data-role="block">Block</button>
            <button data-role="report">Report</button>
            <button data-role="profile_info">Profile info</button>
          </td>
          <td><input type="text" placeholder="username" /></td>
          <td>${r.taggedRole ? `tagged: ${r.taggedRole}` : ''}</td>
        `;
        const input = tr.querySelector('input');
        tr.querySelectorAll('button[data-role]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const targetUsername = input.value.trim();
            if (!targetUsername) { input.focus(); return; }
            try {
              await api('/api/tag-request', {
                method: 'POST',
                body: JSON.stringify({ requestId: r.id, role: btn.dataset.role, targetUsername }),
              });
              pollActionRequests();
              pollStatus();
            } catch (err) {
              alert(err.message);
            }
          });
        });
        body.appendChild(tr);
      }
    } catch (err) {
      console.error(err);
    }
  }

  // --- Step 4: accounts / filtering / actions ---
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

  function activeFilters() {
    return $$('.rule-filter:checked').map((el) => el.value);
  }

  function matchesFilters(account, filters, mode) {
    if (filters.length === 0) return true;
    const matchedIds = new Set(account.matches.map((m) => m.id));
    if (mode === 'all') return filters.every((f) => matchedIds.has(f));
    return filters.some((f) => matchedIds.has(f));
  }

  function renderResults() {
    const showAll = $('#show-all').checked;
    const filters = activeFilters();
    const mode = $('#match-mode').value;
    const rows = state.accounts.filter((a) => showAll || matchesFilters(a, filters, mode));

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
      const job = state.jobsByUsername.get(a.username);
      const statusText = job ? `${job.role}: ${job.status}` : '';
      const statusClass = job ? job.status : '';

      tr.innerHTML = `
        <td><input type="checkbox" class="row-select" ${checked} /></td>
        <td><a href="https://www.threads.net/@${encodeURIComponent(a.username)}" target="_blank" rel="noopener">@${escapeHtml(a.username)}</a></td>
        <td>${escapeHtml(a.full_name || '')}</td>
        <td>${a.follower_count ?? '?'}</td>
        <td>${a.following_count ?? '?'}</td>
        <td>${a.is_default_avatar === undefined ? '?' : (a.is_default_avatar ? 'none' : 'yes')}</td>
        <td>${badges}${unknown}</td>
        <td>${bioSnippet}${igLink}</td>
        <td class="status-cell ${statusClass}" title="${escapeHtml(job ? job.detail || '' : '')}">${statusText}</td>
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

  $('#select-all').addEventListener('click', () => {
    $$('.row-select').forEach((cb) => { cb.checked = true; });
    const showAll = $('#show-all').checked;
    const filters = activeFilters();
    const mode = $('#match-mode').value;
    for (const a of state.accounts) {
      if (showAll || matchesFilters(a, filters, mode)) state.selected.add(a.username);
    }
    updateSelectedCount();
  });
  $('#select-none').addEventListener('click', () => {
    state.selected.clear();
    renderResults();
  });

  async function runBulkAction(roles) {
    const usernames = Array.from(state.selected);
    if (usernames.length === 0) return;
    if (!confirm(`${roles.join(' + ')} ${usernames.length} account(s)? This will be executed from your threads.net tab.`)) return;
    try {
      for (const role of roles) {
        await api('/api/request-actions', { method: 'POST', body: JSON.stringify({ role, usernames }) });
      }
    } catch (err) {
      alert(err.message);
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
  pollActionRequests(); setInterval(pollActionRequests, 2500);
  pollAccounts(); setInterval(pollAccounts, 3500);
  pollJobs(); setInterval(pollJobs, 2500);
})();
