/* threads-bot-filter browser bridge
 *
 * Paste this whole file into the DevTools console while you're on
 * https://www.threads.com, logged in as yourself.
 *
 * What it does, and does NOT do:
 *  - It wraps this tab's fetch()/XMLHttpRequest so it can also forward a copy
 *    of same-site JSON traffic to your local threads-bot-filter server
 *    (http://127.0.0.1:__LOCAL_SERVER_PORT__), running on YOUR machine.
 *  - threads.com's own Content-Security-Policy blocks this tab from making
 *    network requests straight to 127.0.0.1, so instead this opens a small
 *    same-origin "relay" popup (served by your local tool) and talks to it
 *    via postMessage, which CSP doesn't govern. The relay does the actual
 *    localhost fetch on its own same-origin page. Leave that popup open.
 *  - It never reads or transmits your cookies. It doesn't need to: because
 *    it runs inside the real threads.com tab, the browser attaches your
 *    session automatically to every request it replays, same as if you'd
 *    clicked the button yourself.
 *  - It does not act on its own. Blocking/reporting only happens for
 *    accounts you explicitly select in the local web UI, after you've
 *    reviewed the labels.
 *
 * You can stop it any time with: __tfBridge.stop()
 */
(() => {
  const PORT = '__LOCAL_SERVER_PORT__';
  const BASE = `http://127.0.0.1:${PORT}`;
  const POLL_INTERVAL_MS = 4000;
  const MIN_ACTION_DELAY_MS = 1500;
  const MAX_ACTION_DELAY_MS = 3500;
  const RPC_TIMEOUT_MS = 4000;
  const RPC_MAX_ATTEMPTS = 4;

  if (window.__tfBridge && window.__tfBridge._active) {
    console.log('[threads-bot-filter] bridge already running. Use __tfBridge.stop() first if you want to restart it.');
    return;
  }

  const originalFetch = window.fetch.bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitterDelay() {
    return MIN_ACTION_DELAY_MS + Math.random() * (MAX_ACTION_DELAY_MS - MIN_ACTION_DELAY_MS);
  }

  // --- Relay popup + postMessage RPC (threads.com's CSP blocks direct fetch
  // from this tab to 127.0.0.1, so we go through a same-origin popup instead) ---
  let relayWindow = null;
  let rpcCounter = 0;
  const pendingRpcs = new Map();

  function openRelay() {
    relayWindow = window.open(`${BASE}/relay.html`, 'tf-relay', 'width=420,height=260');
    if (!relayWindow) {
      console.error('[threads-bot-filter] popup blocked. Allow popups for threads.com, then run __tfBridge.openRelay() again.');
      return false;
    }
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== relayWindow) return;
    const { rpcId, result } = event.data || {};
    const pending = pendingRpcs.get(rpcId);
    if (!pending) return;
    pendingRpcs.delete(rpcId);
    clearTimeout(pending.timeoutHandle);
    pending.resolve(result);
  });

  function rpcOnce(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!relayWindow || relayWindow.closed) {
        reject(new Error('relay window not open'));
        return;
      }
      const rpcId = `${Date.now()}-${rpcCounter++}`;
      const timeoutHandle = setTimeout(() => {
        pendingRpcs.delete(rpcId);
        reject(new Error(`rpc "${type}" timed out`));
      }, timeoutMs);
      pendingRpcs.set(rpcId, { resolve, timeoutHandle });
      relayWindow.postMessage({ rpcId, type, payload }, BASE);
    });
  }

  async function rpc(type, payload) {
    let lastErr;
    for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
      if (!relayWindow || relayWindow.closed) {
        if (!openRelay()) throw new Error('relay popup unavailable');
        await sleep(600); // give the popup a moment to load before first send
      }
      try {
        return await rpcOnce(type, payload, RPC_TIMEOUT_MS);
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }
    throw lastErr;
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
      for (const [k, v] of headers.entries()) out[k] = v;
    } else if (typeof headers === 'object') {
      Object.assign(out, headers);
    }
    return out;
  }

  // Whether a captured request is worth forwarding at all. GET requests
  // are only useful to us if their response is JSON (that's where follower/
  // profile data lives). Non-GET requests (block, report, follow, ...) are
  // ALWAYS worth forwarding for tagging purposes, even when their response
  // body is empty or not JSON (a lot of action endpoints return 204/plain
  // "ok" — we still need the request URL/method/headers/body to build a
  // replay template from it, we just won't get any response data from it).
  //
  // One exception: Meta's "Comet" framework fires a constant stream of
  // internal telemetry/perf-logging beacons (recognizable by the __a/__hs/
  // __spin_*/fb_dtsg/jazoest querystring noise) that are never anything
  // Threads-related — skip those so they don't clutter capture or trigger
  // pointless work for a request we'd never want to replay anyway.
  const TELEMETRY_URL_RE = /\/ajax\/bz(\?|$)/i;

  function shouldForward(url, method, contentType) {
    if (url.startsWith(BASE)) return false; // never loop back on ourselves
    if (TELEMETRY_URL_RE.test(url)) return false;
    if (method !== 'GET') return true;
    return !contentType || contentType.includes('json');
  }

  // postMessage can only send structured-cloneable data — FormData (and a
  // few other body types some requests use) aren't cloneable and throw
  // synchronously if we try, which was silently breaking capture for any
  // request that happened to use one. Normalize everything to a plain
  // string upfront so this can never happen regardless of body type.
  function serializeBody(body) {
    if (body === undefined || body === null || typeof body === 'string') return body;
    try {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const obj = {};
        for (const [k, v] of body.entries()) {
          obj[k] = (typeof File !== 'undefined' && v instanceof File) ? `[File: ${v.name}]` : v;
        }
        return JSON.stringify(obj);
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob]';
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return '[binary]';
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }

  function safeIngest(payload) {
    if (payload.method !== 'GET') {
      console.log(`[threads-bot-filter] captured ${payload.method} ${payload.url}`);
    }
    rpc('ingest', payload).catch((err) => console.warn('[threads-bot-filter] ingest relay failed:', err));
  }

  // --- fetch() wrapper ---
  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
      const contentType = response.headers.get('content-type') || '';
      if (shouldForward(url, method, contentType)) {
        // Best-effort JSON parse — never let a non-JSON/empty body (common
        // for action endpoints) stop us from forwarding the request itself.
        response.clone().json().catch(() => null).then((json) => {
          safeIngest({
            method,
            url,
            requestHeaders: headersToObject(init && init.headers),
            requestBody: serializeBody(init && init.body),
            responseBody: json,
            ts: Date.now(),
          });
        });
      }
    } catch {
      // never let capture logic break the real request
    }
    return response;
  };

  // --- XMLHttpRequest wrapper ---
  const xhrMeta = new WeakMap();
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    xhrMeta.set(this, { method, url, headers: {} });
    return originalXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
    const meta = xhrMeta.get(this);
    if (meta) meta.headers[name] = value;
    return originalXhrSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const meta = xhrMeta.get(this);
    if (meta) {
      this.addEventListener('load', () => {
        try {
          const contentType = this.getResponseHeader('content-type') || '';
          if (shouldForward(meta.url, meta.method, contentType)) {
            let json = null;
            try { json = JSON.parse(this.responseText); } catch { json = null; }
            safeIngest({
              method: meta.method,
              url: meta.url,
              requestHeaders: meta.headers,
              requestBody: serializeBody(body),
              responseBody: json,
              ts: Date.now(),
            });
          }
        } catch {
          // never let capture logic break the real request
        }
      });
    }
    return originalXhrSend.call(this, body);
  };

  function substitute(str, targetId, targetUsername) {
    if (typeof str !== 'string') return str;
    let out = str;
    if (targetId != null) out = out.split('{{TARGET_ID}}').join(String(targetId));
    if (targetUsername != null) out = out.split('{{TARGET_USERNAME}}').join(targetUsername);
    return out;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Headers captured once during "teach it" can go stale (rotating CSRF
  // tokens etc.) — for any header that looks like a CSRF token, use the
  // live cookie value at replay time instead of the frozen snapshot.
  function refreshHeaders(headers) {
    const out = { ...headers };
    for (const key of Object.keys(out)) {
      if (/csrftoken/i.test(key)) {
        const live = getCookie('csrftoken');
        if (live) out[key] = live;
      }
    }
    return out;
  }

  // A replayed request can come back HTTP 200 while Threads' GraphQL layer
  // reports the mutation failed (an `errors` array, or `data` full of
  // nulls) — trusting res.ok alone is exactly how "says success but wasn't
  // actually blocked" happens. Parse the body and treat those as failure.
  function evaluateGraphqlResult(res, text) {
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!json) return { ok: res.ok, json: null };
    if (Array.isArray(json.errors) && json.errors.length > 0) return { ok: false, json };
    if (json.data && typeof json.data === 'object') {
      const values = Object.values(json.data);
      if (values.length > 0 && values.every((v) => v === null || v === undefined)) {
        return { ok: false, json };
      }
    }
    return { ok: res.ok, json };
  }

  // These run as ordinary requests from the threads.com tab to threads.com's
  // own API — same-origin, so unaffected by the CSP issue the relay works
  // around. No relay needed here.
  async function runTemplate(template, target) {
    const url = substitute(template.url, target.pk, target.username);
    const body = template.body !== undefined ? substitute(template.body, target.pk, target.username) : undefined;
    const res = await originalFetch(url, {
      method: template.method,
      headers: refreshHeaders(template.headers),
      body: template.method === 'GET' ? undefined : body,
      credentials: 'include',
    });
    let text = '';
    try {
      text = await res.clone().text();
    } catch {
      // ignore
    }
    const { ok, json } = evaluateGraphqlResult(res, text);
    return { ok, status: res.status, snippet: text.slice(0, 300), json };
  }

  // Best-effort: after a block, re-fetch the target via the profile_info
  // template (if we have one) and look for a friendship_status.blocking-ish
  // field to confirm it actually stuck, rather than trusting the mutation's
  // own HTTP response. Returns 'verified' | 'contradicted' | 'unavailable'.
  function extractBlockingFlag(json) {
    if (!json || typeof json !== 'object') return undefined;
    const stack = [json];
    let depth = 0;
    while (stack.length && depth < 5000) {
      depth++;
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (typeof node.blocking === 'boolean') return node.blocking;
      if (node.friendship_status && typeof node.friendship_status.blocking === 'boolean') {
        return node.friendship_status.blocking;
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
    return undefined;
  }

  async function verifyBlock(target, templates) {
    if (!templates.profile_info) return { outcome: 'unavailable' };
    try {
      const result = await runTemplate(templates.profile_info, target);
      const blocking = extractBlockingFlag(result.json);
      if (blocking === true) return { outcome: 'verified' };
      if (blocking === false) return { outcome: 'contradicted' };
      return { outcome: 'unavailable' };
    } catch {
      return { outcome: 'unavailable' };
    }
  }

  let stopped = false;
  async function pollLoop() {
    while (!stopped) {
      try {
        const { profileFetchUsernames, actionJobs, templates } = await rpc('pending-jobs', {});

        if (profileFetchUsernames && profileFetchUsernames.length) {
          if (!templates.profile_info) {
            console.warn('[threads-bot-filter] have profile-fetch requests queued but no "profile_info" template tagged yet — open the local UI\'s "Recorder" tab and tag a captured profile-view request.');
          } else {
            for (const username of profileFetchUsernames) {
              try {
                await runTemplate(templates.profile_info, { username });
              } catch (err) {
                console.warn('[threads-bot-filter] profile fetch failed for', username, err);
              }
              await sleep(jitterDelay());
            }
          }
        }

        if (actionJobs && actionJobs.length) {
          for (const job of actionJobs) {
            const template = templates[job.role];
            if (!template) {
              safeCompleteJob(job.jobId, 'failed', `no ${job.role} template tagged`);
              continue;
            }
            try {
              const result = await runTemplate(template, job.target);
              if (!result.ok) {
                safeCompleteJob(job.jobId, 'failed', `HTTP ${result.status}: ${result.snippet}`);
              } else if (job.role === 'block') {
                // The mutation call succeeding doesn't guarantee the block
                // actually stuck — re-check via profile_info before calling
                // it done (see verifyBlock's comment above).
                await sleep(jitterDelay());
                const verification = await verifyBlock(job.target, templates);
                if (verification.outcome === 'verified') {
                  safeCompleteJob(job.jobId, 'success', `HTTP ${result.status}, verified blocked`);
                } else if (verification.outcome === 'contradicted') {
                  safeCompleteJob(job.jobId, 'failed', `HTTP ${result.status} but re-check shows NOT blocked — try again, or tag a fresh block request`);
                } else {
                  safeCompleteJob(job.jobId, 'success', `HTTP ${result.status} (unverified — no profile_info template to double-check with)`);
                }
              } else {
                safeCompleteJob(job.jobId, 'success', `HTTP ${result.status}: ${result.snippet}`);
              }
            } catch (err) {
              safeCompleteJob(job.jobId, 'failed', String(err));
            }
            await sleep(jitterDelay());
          }
        }
      } catch (err) {
        console.warn('[threads-bot-filter] poll loop error (will retry):', err);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  function safeCompleteJob(jobId, status, detail) {
    rpc('complete-job', { jobId, status, detail }).catch((err) => console.warn('[threads-bot-filter] complete-job relay failed:', err));
  }

  // --- Auto-scroll: you don't have to manually scroll the followers list.
  // Only active while the URL looks like a followers/following list (so it
  // never touches your main feed or anywhere else), and only re-does the
  // expensive "find the scrollable element" DOM query when the path
  // actually changes rather than on every tick.
  let cachedScrollPath = null;
  let cachedScrollEl = null;

  function findBestScrollable() {
    let best = null;
    let bestScore = 0;
    const candidates = document.querySelectorAll('div, main, section');
    for (const el of candidates) {
      const score = el.scrollHeight - el.clientHeight;
      if (score > 200 && score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  async function autoScrollLoop() {
    while (!stopped) {
      try {
        if (/\/(followers|following)(\/|$)/i.test(location.pathname)) {
          if (location.pathname !== cachedScrollPath) {
            cachedScrollPath = location.pathname;
            cachedScrollEl = findBestScrollable();
          }
          window.scrollBy(0, 2500);
          if (document.scrollingElement) {
            document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
          }
          if (cachedScrollEl) cachedScrollEl.scrollTop = cachedScrollEl.scrollHeight;
        } else {
          cachedScrollPath = null;
          cachedScrollEl = null;
        }
      } catch (err) {
        console.warn('[threads-bot-filter] auto-scroll error (will retry):', err);
      }
      await sleep(1800 + Math.random() * 1200);
    }
  }

  window.__tfBridge = {
    _active: true,
    openRelay,
    stop() {
      stopped = true;
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
      XMLHttpRequest.prototype.setRequestHeader = originalXhrSetHeader;
      this._active = false;
      console.log('[threads-bot-filter] bridge stopped, fetch/XHR restored.');
    },
  };

  if (!openRelay()) {
    console.warn('[threads-bot-filter] continuing without a relay for now — run __tfBridge.openRelay() once you\'ve allowed popups.');
  }
  pollLoop();
  autoScrollLoop();
  console.log('[threads-bot-filter] bridge active. A relay popup should have opened — keep it open. Open your followers list and leave it open — it scrolls itself. Then check the local UI tab.');
})();
