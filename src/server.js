const path = require('path');
const express = require('express');
const { Store } = require('./store');
const { evaluateAccount } = require('./heuristics');

function classifyGuessType(method, url) {
  const u = url.toLowerCase();
  if (method === 'GET') return 'read';
  if (/unblock/.test(u)) return 'unblock?';
  if (/block/.test(u)) return 'block?';
  if (/report|flag/.test(u)) return 'report?';
  return 'other-write';
}

// Threads' web app (like most of Meta's stack) routes nearly everything
// through one GraphQL endpoint, so the URL alone can't tell block apart
// from report apart from viewing a profile. Pull whatever identifying hints
// we can out of the request/response instead, so a human can tell them
// apart without needing DevTools open themselves.
function extractOperationHint(requestBody, responseBody) {
  const hints = new Set();

  if (typeof requestBody === 'string') {
    try {
      const params = new URLSearchParams(requestBody);
      const friendlyName = params.get('fb_api_req_friendly_name') || params.get('operationName');
      if (friendlyName) hints.add(friendlyName);
      const docId = params.get('doc_id');
      if (docId) hints.add(`doc_id:${docId}`);
    } catch {
      // not form-encoded, ignore
    }
    try {
      const asJson = JSON.parse(requestBody);
      if (asJson.operationName) hints.add(asJson.operationName);
    } catch {
      // not JSON, ignore
    }
  }

  if (responseBody && typeof responseBody === 'object' && responseBody.data && typeof responseBody.data === 'object') {
    for (const key of Object.keys(responseBody.data)) hints.add(key);
  }

  return Array.from(hints).join(', ');
}

function accountSummary(account) {
  const { matches, unknownRules } = evaluateAccount(account);
  return { ...account, matches, unknownRules };
}

function createApp(port) {
  const store = new Store();
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/bridge-script', (req, res) => {
    const fs = require('fs');
    const template = fs.readFileSync(path.join(__dirname, '..', 'browser', 'bridge.js'), 'utf8');
    const rendered = template.replace(/__LOCAL_SERVER_PORT__/g, String(port));
    res.type('application/javascript').send(rendered);
  });

  // --- Endpoints called same-origin, from the relay popup (which itself
  // relays via postMessage from the bridge script running on threads.net —
  // threads.net's own CSP blocks that tab from fetching 127.0.0.1 directly) ---
  app.post('/api/ingest', (req, res) => {
    const { method, url, requestHeaders, requestBody, responseBody, ts } = req.body || {};
    if (!url) return res.status(400).json({ error: 'missing url' });
    store.lastIngestAt = Date.now();

    let harvested = 0;
    if (responseBody && typeof responseBody === 'object') {
      harvested = store.ingestJson(responseBody);
    }

    let recordedRequest = null;
    if (method && method !== 'GET') {
      const normalizedBody = typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody || {});
      recordedRequest = store.recordActionRequest({
        ts: ts || Date.now(),
        method,
        url,
        requestHeaders,
        requestBody: normalizedBody,
        responseSnippet: responseBody ? JSON.stringify(responseBody).slice(0, 500) : null,
        operationHint: extractOperationHint(normalizedBody, responseBody),
        guessType: classifyGuessType(method, url),
      });
    }

    // "Teach it" mode: the local UI armed recording (see /api/start-recording)
    // right before asking the user to manually block/report/view-a-profile on
    // threads.net. The very next write request we see is almost certainly
    // that action, so tag it automatically — no manual matching required.
    if (store.recording && recordedRequest) {
      const target = store.getAccountByUsername(store.recording.targetUsername);
      if (target) {
        try {
          store.tagActionRequest(recordedRequest.id, store.recording.role, target);
        } catch (err) {
          console.error('[threads-bot-filter] auto-tag failed:', err.message);
        }
      }
      store.recording = null;
    }

    store.persist();
    res.json({ ok: true, harvested });
  });

  app.get('/api/pending-jobs', (req, res) => {
    store.lastPollAt = Date.now();
    const profileFetchUsernames = store.drainProfileFetchQueue(15);
    const actionJobs = store.drainActionJobs(5);
    res.json({
      profileFetchUsernames,
      actionJobs,
      templates: store.taggedTemplates,
    });
  });

  app.post('/api/complete-job', (req, res) => {
    const { jobId, status, detail } = req.body || {};
    const job = store.completeActionJob(jobId, status, detail);
    if (job && status === 'success') {
      store.markAccountActioned(job.target.username, job.role);
    }
    res.json({ ok: true, found: !!job });
  });

  // --- Endpoints called same-origin, from the local web UI ---
  app.get('/api/status', (req, res) => {
    const accounts = store.listAccounts();
    const withCounts = accounts.filter((a) => typeof a.follower_count === 'number').length;
    const withBio = accounts.filter((a) => a.biography !== undefined && a.biography !== null).length;
    res.json({
      accountCount: accounts.length,
      accountsWithCounts: withCounts,
      accountsWithBio: withBio,
      profileFetchQueueLength: store.profileFetchQueue.length,
      taggedTemplates: {
        block: !!store.taggedTemplates.block,
        report: !!store.taggedTemplates.report,
        profile_info: !!store.taggedTemplates.profile_info,
      },
      pendingActionJobs: store.actionJobs.filter((j) => j.status === 'pending' || j.status === 'dispatched').length,
      lastPollAt: store.lastPollAt,
      lastIngestAt: store.lastIngestAt,
    });
  });

  app.get('/api/accounts', (req, res) => {
    res.json(store.listAccounts().map(accountSummary));
  });

  app.get('/api/action-requests', (req, res) => {
    res.json(store.actionRequests.map((r) => ({
      id: r.id,
      ts: r.ts,
      method: r.method,
      url: r.url,
      guessType: r.guessType,
      taggedRole: r.taggedRole,
      operationHint: r.operationHint,
      bodyPreview: (r.requestBody || '').slice(0, 400),
      responseSnippet: r.responseSnippet,
    })));
  });

  app.post('/api/tag-request', (req, res) => {
    const { requestId, role, targetUsername } = req.body || {};
    const target = store.getAccountByUsername(targetUsername || '');
    if (!target) return res.status(400).json({ error: `no known account for username "${targetUsername}" — make sure it was captured first` });
    try {
      const template = store.tagActionRequest(requestId, role, target);
      res.json({ ok: true, template });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/start-recording', (req, res) => {
    const { role, targetUsername } = req.body || {};
    const target = store.getAccountByUsername(targetUsername || '');
    if (!target) return res.status(400).json({ error: `no known account for username "${targetUsername}"` });
    try {
      store.startRecording(role, target.username);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/cancel-recording', (req, res) => {
    store.cancelRecording();
    res.json({ ok: true });
  });

  // Used when an account was actioned manually as the "teach it" example
  // rather than through a replayed job — it still needs to be marked done
  // so it doesn't get re-selected next time.
  app.post('/api/mark-actioned', (req, res) => {
    const { username, role } = req.body || {};
    if (!username || (role !== 'block' && role !== 'report')) {
      return res.status(400).json({ error: 'username and role (block|report) required' });
    }
    store.markAccountActioned(username, role);
    res.json({ ok: true });
  });

  app.get('/api/recording-status', (req, res) => {
    res.json({ recording: store.recording });
  });

  app.post('/api/clear-template', (req, res) => {
    const { role } = req.body || {};
    try {
      store.clearTemplate(role);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/request-profile-fetch', (req, res) => {
    const { usernames } = req.body || {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }
    store.queueProfileFetch(usernames);
    res.json({ ok: true, queued: usernames.length });
  });

  app.post('/api/request-actions', (req, res) => {
    const { role, usernames } = req.body || {};
    if (role !== 'block' && role !== 'report') return res.status(400).json({ error: 'role must be block or report' });
    if (!store.taggedTemplates[role]) return res.status(400).json({ error: `no ${role} template recorded yet — perform that action once on threads.net while the bridge is running` });
    if (!Array.isArray(usernames) || usernames.length === 0) return res.status(400).json({ error: 'usernames must be a non-empty array' });

    const targets = [];
    for (const u of usernames) {
      const acct = store.getAccountByUsername(u);
      if (acct) targets.push({ pk: acct.pk, username: acct.username });
    }
    const jobs = store.queueActionJobs(role, targets);
    res.json({ ok: true, jobs: jobs.map((j) => ({ jobId: j.jobId, username: j.target.username })) });
  });

  app.get('/api/action-jobs', (req, res) => {
    res.json(store.actionJobs);
  });

  return app;
}

module.exports = { createApp };
