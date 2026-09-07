// In-memory state for one review session, with a periodic JSON snapshot to
// disk (.threads-bot-filter/state.json) so you don't lose everything if the
// server restarts mid-review. This file never sees your Threads password or
// session cookie — only the account data your own browser tab captures
// (usernames, bios, counts) and the request *shapes* for block/report.

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.cwd(), '.threads-bot-filter');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const KNOWN_DEFAULT_AVATAR_SUBSTRINGS = [
  // Extend this if you spot Threads' current default-avatar asset URL.
];

function keyFor(obj) {
  if (obj.pk !== undefined && obj.pk !== null) return `pk:${obj.pk}`;
  if (obj.id !== undefined && obj.id !== null) return `pk:${obj.id}`;
  if (obj.username) return `un:${String(obj.username).toLowerCase()}`;
  return null;
}

function isDefaultAvatar(profilePicUrl) {
  if (!profilePicUrl) return true;
  return KNOWN_DEFAULT_AVATAR_SUBSTRINGS.some((s) => profilePicUrl.includes(s));
}

// Recursively walk arbitrary JSON looking for "user-like" objects: anything
// with a string `username` field. This is deliberately schema-agnostic so it
// keeps working even if Threads changes its response shape — we don't need
// to know the exact API contract, just that user objects have a `username`.
function extractUserLikeObjects(node, out, depth) {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) extractUserLikeObjects(item, out, depth + 1);
    return;
  }
  if (typeof node.username === 'string' && node.username.length > 0) {
    out.push(normalizeUserObject(node));
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') extractUserLikeObjects(value, out, depth + 1);
  }
}

// We don't know Threads' actual field name for "About this profile"'s date
// joined (it's not documented anywhere, unofficial or otherwise), so scan
// broadly by key-name pattern instead of a fixed whitelist — this keeps
// working even if we guessed wrong the first time or Threads renames it.
const JOIN_DATE_KEY_RE = /joined|join_date|date_joined|created_at|creation_date|account_created|member_since|registered/i;

function parseJoinYear(value) {
  let date;
  if (typeof value === 'number') {
    date = new Date(value > 1e12 ? value : value * 1000); // ms vs unix-seconds
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else {
    return undefined;
  }
  const year = date.getFullYear();
  if (Number.isNaN(date.getTime()) || year < 2000 || year > 2100) return undefined;
  return year;
}

function findJoinYear(raw) {
  for (const [key, value] of Object.entries(raw)) {
    if (!JOIN_DATE_KEY_RE.test(key)) continue;
    const year = parseJoinYear(value);
    if (year) return year;
  }
  return undefined;
}

function normalizeUserObject(raw) {
  const followerCount = firstDefined(
    raw.follower_count,
    raw.edge_followed_by?.count,
    raw.followerCount,
  );
  const followingCount = firstDefined(
    raw.following_count,
    raw.edge_follow?.count,
    raw.followingCount,
  );
  const bioLinks = Array.isArray(raw.bio_links) ? raw.bio_links : undefined;
  const hasAvatarKey = 'profile_pic_url' in raw || 'profilePicUrl' in raw;
  const profilePicUrl = firstDefined(raw.profile_pic_url, raw.profilePicUrl);

  const obj = {
    pk: firstDefined(raw.pk, raw.id, raw.user_id),
    username: raw.username,
    full_name: firstDefined(raw.full_name, raw.fullName),
    biography: firstDefined(raw.biography, raw.bio),
    external_url: firstDefined(raw.external_url, raw.externalUrl),
    bio_links: bioLinks,
    profile_pic_url: profilePicUrl,
    is_private: raw.is_private,
    is_verified: raw.is_verified,
  };
  if (followerCount !== undefined) obj.follower_count = followerCount;
  if (followingCount !== undefined) obj.following_count = followingCount;
  // profile_pic_url being explicitly null/absent-but-keyed IS the signal for
  // "no photo" (rule c) — don't lose that by only checking truthiness.
  if (hasAvatarKey) obj.is_default_avatar = isDefaultAvatar(profilePicUrl);
  const joinYear = findJoinYear(raw);
  if (joinYear) obj.threads_joined_year = joinYear;
  return obj;
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

class Store {
  constructor() {
    this.accounts = new Map(); // key -> account
    this.actionRequests = []; // captured non-follower-list requests, for tagging
    this.taggedTemplates = { block: null, report: null, profile_info: null };
    this.profileFetchQueue = []; // usernames pending a profile-info fetch
    this.actionJobs = []; // {jobId, role, target:{pk,username}, status}
    this.recording = null; // {role, targetUsername, startedAt} while "teach it" is armed
    this.lastIngestAt = null; // updated on every /api/ingest
    this.lastPollAt = null; // updated on every /api/pending-jobs poll — the
    // bridge polls this every ~4s regardless of browsing activity, so it's
    // the reliable "is the bridge actually still connected" signal
    this._nextId = 1;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      this.accounts = new Map(parsed.accounts || []);
      this.taggedTemplates = parsed.taggedTemplates || { block: null, report: null, profile_info: null };
    } catch {
      // no prior state, start fresh
    }
  }

  persist() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({
          accounts: Array.from(this.accounts.entries()),
          taggedTemplates: this.taggedTemplates,
        }, null, 2),
      );
    } catch (err) {
      console.error('[store] failed to persist state:', err.message);
    }
  }

  // Merge fields into an existing account record without clobbering good
  // data with undefined/null from a lighter-weight response.
  mergeAccount(partial) {
    const key = keyFor(partial);
    if (!key) return;
    const existing = this.accounts.get(key) || {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    this.accounts.set(key, merged);
  }

  ingestJson(json) {
    const found = [];
    extractUserLikeObjects(json, found, 0);
    for (const obj of found) this.mergeAccount(obj);
    return found.length;
  }

  recordActionRequest(entry) {
    const id = this._nextId++;
    const record = { id, taggedRole: null, ...entry };
    this.actionRequests.push(record);
    // keep only the most recent 50 to avoid unbounded growth
    if (this.actionRequests.length > 50) this.actionRequests.shift();
    return record;
  }

  tagActionRequest(requestId, role, target) {
    const req = this.actionRequests.find((r) => r.id === requestId);
    if (!req) throw new Error(`no captured request with id ${requestId}`);
    if (!['block', 'report', 'profile_info'].includes(role)) {
      throw new Error('role must be "block", "report", or "profile_info"');
    }

    const targetId = target.pk !== undefined && target.pk !== null ? String(target.pk) : null;
    const targetUsername = target.username || null;

    const template = {
      method: req.method,
      url: substitute(req.url, targetId, targetUsername),
      headers: req.requestHeaders || {},
      body: req.requestBody ? substitute(req.requestBody, targetId, targetUsername) : req.requestBody,
    };
    req.taggedRole = role;
    this.taggedTemplates[role] = template;
    this.persist();
    return template;
  }

  startRecording(role, targetUsername) {
    if (!['block', 'report', 'profile_info'].includes(role)) {
      throw new Error('role must be "block", "report", or "profile_info"');
    }
    this.recording = { role, targetUsername, startedAt: Date.now() };
  }

  cancelRecording() {
    this.recording = null;
  }

  clearTemplate(role) {
    if (!['block', 'report', 'profile_info'].includes(role)) {
      throw new Error('role must be "block", "report", or "profile_info"');
    }
    this.taggedTemplates[role] = null;
    this.persist();
  }

  listAccounts() {
    return Array.from(this.accounts.values());
  }

  getAccountByUsername(username) {
    return this.accounts.get(`un:${username.toLowerCase()}`)
      || this.listAccounts().find((a) => a.username?.toLowerCase() === username.toLowerCase());
  }

  queueProfileFetch(usernames) {
    const existing = new Set(this.profileFetchQueue);
    for (const u of usernames) if (!existing.has(u)) this.profileFetchQueue.push(u);
  }

  drainProfileFetchQueue(max) {
    return this.profileFetchQueue.splice(0, max);
  }

  queueActionJobs(role, targets) {
    const jobs = targets.map((t) => ({
      jobId: this._nextId++,
      role,
      target: t,
      status: 'pending',
    }));
    this.actionJobs.push(...jobs);
    return jobs;
  }

  drainActionJobs(max) {
    const pending = this.actionJobs.filter((j) => j.status === 'pending').slice(0, max);
    for (const j of pending) j.status = 'dispatched';
    return pending;
  }

  completeActionJob(jobId, status, detail) {
    const job = this.actionJobs.find((j) => j.jobId === jobId);
    if (job) {
      job.status = status;
      job.detail = detail;
    }
    return job;
  }
}

function substitute(text, targetId, targetUsername) {
  let out = text;
  if (targetId) out = out.split(new RegExp(`\\b${escapeRe(targetId)}\\b`, 'g')).join('{{TARGET_ID}}');
  if (targetUsername) out = out.split(targetUsername).join('{{TARGET_USERNAME}}');
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { Store, extractUserLikeObjects, normalizeUserObject };
