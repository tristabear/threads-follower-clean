// Relays RPC calls from the threads.net bridge script (which can't reach
// 127.0.0.1 directly due to threads.net's own CSP) to this server, via
// window.postMessage — postMessage isn't subject to CSP's connect-src, and
// this page's own fetch() calls are same-origin so they aren't either.

const ALLOWED_ORIGINS = /^https:\/\/(www\.)?threads\.(net|com)$/;

const logEl = document.getElementById('log');
function log(line) {
  logEl.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

window.addEventListener('message', async (event) => {
  if (!ALLOWED_ORIGINS.test(event.origin)) return;
  const { rpcId, type, payload } = event.data || {};
  if (!rpcId || !type) return;

  let result;
  try {
    result = await handle(type, payload);
  } catch (err) {
    result = { error: String(err) };
  }
  event.source.postMessage({ rpcId, result }, event.origin);
});

async function handle(type, payload) {
  if (type === 'ping') return { ok: true };

  if (type === 'ingest') {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  if (type === 'pending-jobs') {
    const res = await fetch('/api/pending-jobs');
    return res.json();
  }

  if (type === 'complete-job') {
    const res = await fetch('/api/complete-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  throw new Error(`unknown rpc type "${type}"`);
}

log('relay ready, waiting for the threads.net tab...');
