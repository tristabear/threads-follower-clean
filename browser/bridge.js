/* threads-bot-filter browser bridge
 *
 * Paste this whole file into the DevTools console while you're on
 * https://www.threads.net (or threads.com), logged in as yourself.
 *
 * What it does, and does NOT do:
 *  - It wraps this tab's fetch()/XMLHttpRequest so it can also forward a copy
 *    of same-site JSON traffic to your local threads-bot-filter server
 *    (http://127.0.0.1:__LOCAL_SERVER_PORT__), running on YOUR machine.
 *  - threads.net's own Content-Security-Policy blocks this tab from making
 *    network requests straight to 127.0.0.1, so instead this opens a small
 *    same-origin "relay" popup (served by your local tool) and talks to it
 *    via postMessage, which CSP doesn't govern. The relay does the actual
 *    localhost fetch on its own same-origin page. Leave that popup open.
 *  - It never reads or transmits your cookies. It doesn't need to: because
 *    it runs inside the real threads.net tab, the browser attaches your
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

  // --- Relay popup + postMessage RPC (threads.net's CSP blocks direct fetch
  // from this tab to 127.0.0.1, so we go through a same-origin popup instead) ---
  let relayWindow = null;
  let rpcCounter = 0;
  const pendingRpcs = new Map();

  function openRelay() {
    relayWindow = window.open(`${BASE}/relay.html`, 'tf-relay', 'width=420,height=260');
    if (!relayWindow) {
      console.error('[threads-bot-filter] popup blocked. Allow popups for threads.net, then run __tfBridge.openRelay() again.');
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

  function looksInteresting(url, contentType) {
    if (url.startsWith(BASE)) return false; // never loop back on ourselves
    if (contentType && !contentType.includes('json')) return false;
    return true;
  }

  function safeIngest(payload) {
    rpc('ingest', payload).catch((err) => console.warn('[threads-bot-filter] ingest relay failed:', err));
  }

  // --- fetch() wrapper ---
  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
      const contentType = response.headers.get('content-type') || '';
      if (looksInteresting(url, contentType)) {
        response.clone().json().then((json) => {
          safeIngest({
            method,
            url,
            requestHeaders: headersToObject(init && init.headers),
            requestBody: init && init.body,
            responseBody: json,
            ts: Date.now(),
          });
        }).catch(() => {});
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
          if (looksInteresting(meta.url, contentType)) {
            const json = JSON.parse(this.responseText);
            safeIngest({
              method: meta.method,
              url: meta.url,
              requestHeaders: meta.headers,
              requestBody: body,
              responseBody: json,
              ts: Date.now(),
            });
          }
        } catch {
          // not JSON or parse failed, ignore
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

  // These run as ordinary requests from the threads.net tab to threads.net's
  // own API — same-origin, so unaffected by the CSP issue the relay works
  // around. No relay needed here.
  async function runTemplate(template, target) {
    const url = substitute(template.url, target.pk, target.username);
    const body = template.body !== undefined ? substitute(template.body, target.pk, target.username) : undefined;
    const res = await originalFetch(url, {
      method: template.method,
      headers: template.headers,
      body: template.method === 'GET' ? undefined : body,
      credentials: 'include',
    });
    let snippet = '';
    try {
      snippet = (await res.clone().text()).slice(0, 300);
    } catch {
      // ignore
    }
    return { ok: res.ok, status: res.status, snippet };
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
              safeCompleteJob(job.jobId, result.ok ? 'success' : 'failed', `HTTP ${result.status}: ${result.snippet}`);
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
  console.log(`[threads-bot-filter] bridge active. A relay popup should have opened — keep it open. Scroll your followers list to capture accounts, then check the local UI tab.`);
})();
