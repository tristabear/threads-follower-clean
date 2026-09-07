// The four suspicious-follower heuristics.
//
// Each rule function takes an `account` object (see src/store.js for the
// shape) and returns either:
//   - null            -> rule doesn't match / doesn't apply
//   - { unknown:true } -> rule can't be evaluated yet (missing data, e.g. we
//                         haven't fetched this account's full profile info)
//   - { label, detail } -> rule matches, with a short human label and detail
//
// NONE of this is certain proof of bot behavior. These are pattern-matching
// heuristics for a human to review, not an auto-ban system. Always eyeball
// the account before blocking, and especially before reporting.

const { ALL_ANIMAL_WORDS } = require('./animalNames');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ANIMAL_ALTERNATION = ALL_ANIMAL_WORDS.map(escapeRegExp).join('|');
// e.g. "tiger123", "tiger_123", "tiger.42", "貓咪99", "gecko.52078145" — animal
// word optionally followed by a separator, then 1-10 digits (bot-factory
// suffixes run longer than a typical handmade "123"), anchored to the whole
// username (allowing a leading/trailing underscore/dot which Threads
// usernames allow).
const ANIMAL_NUMBER_RE = new RegExp(
  `^[_.]?(${ANIMAL_ALTERNATION})[_.]?\\d{1,10}[_.]?$`,
  'i',
);

// Rule a: animal name + number, e.g. "tiger8842", "panda_071"
function ruleAnimalPlusNumber(account) {
  const uname = account.username || '';
  if (ANIMAL_NUMBER_RE.test(uname)) {
    return { label: 'animal+number', detail: `username "${uname}" matches animal-name+number pattern` };
  }
  return null;
}

// Rule b: one letter + Taiwan mobile phone format (09XXXXXXXX, 10 digits).
// Matches things like "a0912345678", "x_0987654321", "b.0911222333".
// Applied to both username and full display name since bots sometimes put
// the phone-like string in the display name instead of the handle.
const TW_MOBILE_RE = /^[A-Za-z][-_.]?09\d{8}$/;

function ruleLetterPlusTaiwanPhone(account) {
  const uname = account.username || '';
  const fullName = account.full_name || '';
  if (TW_MOBILE_RE.test(uname)) {
    return { label: 'letter+TW-phone', detail: `username "${uname}" matches letter+Taiwan-mobile pattern` };
  }
  if (TW_MOBILE_RE.test(fullName.replace(/\s+/g, ''))) {
    return { label: 'letter+TW-phone', detail: `display name "${fullName}" matches letter+Taiwan-mobile pattern` };
  }
  return null;
}

// Rule c: 0 followers + following 48 or 49 + no profile photo.
// Needs follower_count/following_count/profile_pic_url to have been fetched
// (the lightweight followers-list response usually doesn't include counts).
function ruleEmptyFreshBot(account) {
  const hasCounts = typeof account.follower_count === 'number'
    && typeof account.following_count === 'number';
  const hasAvatarInfo = account.is_default_avatar !== undefined;
  if (!hasCounts || !hasAvatarInfo) {
    return { unknown: true };
  }
  const matches = account.follower_count === 0
    && (account.following_count === 48 || account.following_count === 49)
    && account.is_default_avatar === true;
  if (matches) {
    return {
      label: '0-followers/48-49-following/no-photo',
      detail: `0 followers, following ${account.following_count}, no profile photo`,
    };
  }
  return null;
}

// Rule d: links Instagram in bio, and (per your own judgment) that Instagram
// account looks like it was created this year and/or around the same time as
// the Threads account. Instagram doesn't expose account-creation date via any
// official or reliable unofficial signal, so this tool can only do the first
// half automatically (detect the IG link/handle) — you have to eyeball the
// linked IG profile yourself to judge account age. We surface the extracted
// handle/link prominently so that's a one-click check.
const IG_LINK_RE = /instagram\.com\/([a-zA-Z0-9._]{1,30})/i;
const IG_HANDLE_MENTION_RE = /(?:^|\s)(?:ig|instagram)\s*[:@]\s*@?([a-zA-Z0-9._]{1,30})/i;

function extractInstagramHandle(account) {
  const bio = account.biography || '';
  const links = [
    account.external_url,
    ...(Array.isArray(account.bio_links) ? account.bio_links.map((l) => (typeof l === 'string' ? l : l.url)) : []),
  ].filter(Boolean);

  for (const url of links) {
    const m = IG_LINK_RE.exec(url);
    if (m) return m[1];
  }
  const linkInBio = IG_LINK_RE.exec(bio);
  if (linkInBio) return linkInBio[1];
  const mention = IG_HANDLE_MENTION_RE.exec(bio);
  if (mention) return mention[1];
  return null;
}

function ruleInstagramInBio(account) {
  const hasBioData = account.biography !== undefined && account.biography !== null;
  if (!hasBioData) {
    return { unknown: true };
  }
  const handle = extractInstagramHandle(account);
  if (handle) {
    return {
      label: 'ig-in-bio',
      detail: `bio links Instagram @${handle} — open it and check the account age yourself (Threads gives us no reliable creation-date signal)`,
      instagramHandle: handle,
    };
  }
  return null;
}

// Rule e: username looks like an auto-generated "firstname.lastname + digits"
// handle (e.g. "daisy.clark18"), AND the display name is essentially just
// that same name restated — the bot never bothered to customize it. Compare
// only the alphabetic "first last" portion so near-misses like username
// "grace.jackson107" / name "grace.jackson10" (same base name, different
// trailing digits) still count — that mismatch is itself part of the
// bot-factory fingerprint, not a reason to treat them as unrelated.
const NAME_HANDLE_RE = /^[a-z]{2,}\.[a-z]{2,}\d{0,6}$/i;

function nameBase(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\d+$/, '')
    .replace(/[._]+/g, ' ')
    .trim();
}

function ruleGeneratedNamePattern(account) {
  const uname = account.username || '';
  const fullName = account.full_name;
  if (fullName === undefined) {
    return { unknown: true };
  }
  if (!NAME_HANDLE_RE.test(uname)) return null;
  const base = nameBase(uname);
  if (!base || !fullName) return null;
  if (base === nameBase(fullName)) {
    return {
      label: 'generated-name',
      detail: `username "${uname}" and display name "${fullName}" are the same auto-generated name — display name was never customized`,
    };
  }
  return null;
}

const RULES = [
  { id: 'a', name: 'Animal name + number', fn: ruleAnimalPlusNumber },
  { id: 'b', name: 'Letter + Taiwan mobile format', fn: ruleLetterPlusTaiwanPhone },
  { id: 'c', name: '0 followers / 48-49 following / no photo', fn: ruleEmptyFreshBot },
  { id: 'd', name: 'Instagram linked in bio', fn: ruleInstagramInBio },
  { id: 'e', name: 'Generated name, username = display name', fn: ruleGeneratedNamePattern },
];

// Evaluate all rules against an account. Returns:
// { matches: [{id,name,label,detail}], unknownRules: ['c','d'] }
function evaluateAccount(account) {
  const matches = [];
  const unknownRules = [];
  for (const rule of RULES) {
    const result = rule.fn(account);
    if (!result) continue;
    if (result.unknown) {
      unknownRules.push(rule.id);
      continue;
    }
    matches.push({ id: rule.id, name: rule.name, ...result });
  }
  return { matches, unknownRules };
}

module.exports = {
  RULES,
  evaluateAccount,
  extractInstagramHandle,
  ANIMAL_NUMBER_RE,
  TW_MOBILE_RE,
};
