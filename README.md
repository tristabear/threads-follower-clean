# threads-bot-filter

A local tool to flag likely bot/spam followers on **your own** Threads
account, and bulk block (or block + report) the ones you select — after you
review them.

## Read this first: how it actually works, and the risk

Meta doesn't publish a followers list, block, or report API for Threads. The
two well-known reverse-engineered client libraries for it
(`junhoyeo/threads-api`, `Danie1/threads-api`) were both taken down/archived
in 2023 — one after Meta sent the maintainer a takedown notice. So this tool
doesn't depend on either of them, and doesn't ship any hard-coded private API
endpoints of its own.

Instead, it works entirely through **your own already-logged-in browser
tab**:

1. You paste a small script (`browser/bridge.js`, served from the local
   tool) into your DevTools console while on threads.com. It runs inside
   that page, so it never touches your password or session cookie — the
   browser attaches those automatically to requests, exactly like it does
   when you click a button.
2. threads.com's own Content-Security-Policy blocks that tab from making
   network requests straight to `127.0.0.1`, so the script opens a small
   same-origin "relay" popup (served by the local tool itself) and talks to
   it via `postMessage`, which CSP doesn't govern. The relay does the actual
   localhost fetch on its own same-origin page. Allow the popup and leave it
   open (it can be minimized).
3. As you scroll your followers list, the script forwards the JSON your own
   tab is already receiving, through the relay, to the local server on your
   machine (`http://127.0.0.1:4173`), which extracts follower profile data
   from it.
4. To learn how *your current app version* actually blocks/reports someone,
   you perform each action **once, manually** — but you don't have to go
   find a raw request table to do it. The first time you click "Block" (or
   "Report") on a selection in the local UI, it walks you through it: it
   tells you which one account (from your selection) to act on by hand on
   threads.com, watches for that action, and tags it automatically the
   moment it sees it. Every click after that just works. Later bulk actions
   replay that captured template with a different target ID — nothing is
   guessed or hard-coded.
5. Everything that mutates your account (block, report) happens as a fetch
   from your real threads.com tab straight to threads.com's own API — that
   part is same-origin, so it doesn't need the relay, and it's rate-limited
   with randomized delays between actions to look and behave like normal
   manual use.
6. A block replay returning HTTP 200 doesn't reliably mean the block
   actually took effect — the same reference project linked below runs an
   "adaptive verification system... to counter false successes" for exactly
   this reason. So after each block, the tool re-fetches the target's own
   profile info and checks whether it now actually reports you as blocking
   them before calling it a success; if that can't be confirmed (no
   profile_info template yet) it's marked "success (unverified)", and if the
   re-check explicitly contradicts it, it's marked failed so you know to
   look again rather than assuming it worked.

**Caveats you should actually read:**

- This still counts as automating the platform in a way Meta's terms of
  service don't sanction. Nobody outside Meta can tell you with certainty
  where they draw the line between "a person reviewing their own followers
  and clicking block a lot" and "an automated client." Use it at your own
  risk, on your own account, at a reasonable pace (the defaults are
  deliberately conservative — a few seconds between each action).
- It can break at any time if Threads changes its response shapes or web
  app internals. The generic extractor and the "record your own action"
  design are meant to make that less likely than a tool with hard-coded
  endpoints, but there's no guarantee.
- **Nothing here is proof of bot behavior.** These are pattern-matching
  heuristics for *you* to review, not an auto-ban system. Real people
  occasionally match rule (a) or (c) by coincidence. Always glance at an
  account before blocking it, and be extra careful before reporting one —
  reporting a real person is a real cost to them.
- Rule (d) needs your account's "About this profile" data to know when a
  candidate joined Threads (field name guessed by scanning for join/created
  -like keys, since it's undocumented) — it stays "unknown" for a candidate
  until that's been captured. It still can't confirm the *linked Instagram
  account's* own age automatically: Instagram exposes no reliable
  creation-date signal (official or unofficial) reachable from a
  Threads-only browser session. The tool surfaces the Instagram
  handle/link for you so checking that part is one click.
- Block/report "success" is now a best-effort verified claim, not a
  guarantee — see point 6 above. Always spot-check a few afterward,
  especially if you see "(unverified)" a lot (it means you haven't used
  "Fetch details" yet, so there's no profile_info template to double-check
  with). A verified block/report gets recorded on the account itself (not
  just in that browser tab's memory), so it survives page reloads and stays
  hidden/skipped in future runs.
- If the bridge disconnects mid-action (closed tab, page reload, closed
  relay popup), that job doesn't just vanish — after ~45s of silence it's
  automatically put back in the queue and retried on the next connection,
  up to 3 attempts, before giving up and marking it failed with an
  explanation (hover the Status cell to see it).
- Captured data (other people's usernames, bios, etc.) is written to
  `.threads-bot-filter/state.json` on your machine so you don't lose
  progress on restart. It's gitignored. Don't publish or share it.

## Setup

```bash
npm install
npm start
```

Then open **http://127.0.0.1:4173** — the page walks you through 3 steps:

1. **Connect your browser** — copy the bridge script, paste it into
   DevTools console on threads.com. Watch the banner at the top of the page
   turn green ("Bridge: connected") — if it doesn't, nothing past this point
   will work, so that's the first thing to check if something seems stuck.
2. **Capture your followers** — open your followers list on threads.com and
   leave it open; the bridge scrolls it automatically (keep that tab in the
   foreground, not backgrounded — see the throttling note below). Watch the
   counters go up on the local page. Click **"Fetch details for accounts
   missing data"** to backfill follower/following counts, photo, and bio
   (needed for rules c and d). For rule d specifically, also open "About
   this profile" on a candidate at least once so their Threads join-date
   can be captured.
3. **Filter, select, and act** — the list already only shows accounts
   matching at least one rule, with already-blocked/reported accounts
   hidden by default; check specific rule boxes (a-e) to narrow it further,
   pick "any" or "all", select the accounts you want, and click **Block
   selected** or **Block + Report selected**. Re-running this on a
   selection that includes already-done accounts just skips them — it
   won't re-queue or re-teach anything for them. There's a **Refresh**
   button next to Select all/none if you want to force an immediate
   re-check instead of waiting for the automatic ~3s poll.

That's genuinely it for day-to-day use. The "teach it your block/report"
step isn't a separate thing you have to understand — it only shows up
*inside* step 2/3, the first time you click a button that needs it: a modal
tells you exactly which one account to act on manually on threads.com, and
detects and learns from it automatically. If it ever seems to learn the
wrong thing (rare, but Threads batches several network calls per click),
there's a small **"Reset what this tool has learned"** link at the bottom of
the page — one click clears it and you'll be walked through teaching it
again next time you need it.

### "Bridge: not responding" but the tab and popup are both open

This is almost always browser tab throttling, not an actual break: browsers
slow down JavaScript timers in tabs you're not actively looking at, to save
battery/CPU. If you switch away from the threads.com tab (e.g.
to look at this local page), its poll loop can go quiet for well past the
few-seconds cadence it normally runs at — the banner will show amber
("slow to respond") first, and only turns red after a much longer silence.
Click back into that tab for a few seconds and it'll catch back up. There's
no code-level fix for this — it's a deliberate browser power-saving
behavior that affects any tool built this way (a pasted script has no way
to keep its own tab "awake"). Keeping the threads.com tab visible (even in
a side-by-side window instead of switching between full-screen tabs) avoids
it entirely.

If the banner stays red for a long time even with the tab focused, check:
the relay popup hasn't thrown an error (open its own DevTools console),
you re-pasted the bridge script after the last `git pull` (an old pasted
copy doesn't update itself), and popups are actually allowed for
threads.com in your browser's site settings.

## The five rules

| Rule | What it flags |
|---|---|
| a | Username matches an animal name + number pattern (e.g. `tiger8842`, `gecko.52078145`) |
| b | Username or display name matches one letter + Taiwan mobile format (e.g. `a0912345678`) |
| c | 0 followers, following exactly 48 or 49, no profile photo |
| d | Threads account joined **this year** (from "About this profile") AND bio links an Instagram account — flagged for you to manually check whether that IG account also looks freshly created |
| e | Username looks like an auto-generated "firstname.lastname+digits" handle and the display name was never customized away from it (e.g. username `daisy.clark18`, name `daisy.clark18`) |

Rule (a)'s word list lives in `src/animalNames.js` — it's a plain JS array,
extend it (e.g. more Chinese animal words) as you spot new bot patterns.
Rules live in `src/heuristics.js` if you want to tune the thresholds.

## Project layout

```
bin/cli.js          entry point — starts the local server
src/server.js        Express app: status/accounts/tagging/job APIs
src/store.js          in-memory account store + generic JSON extractor
src/heuristics.js     the 5 detection rules
src/animalNames.js    word list for rule (a)
browser/bridge.js     the console script pasted into threads.com
public/index.html,app.js,style.css   the local web UI
public/relay.html,relay.js            same-origin popup that gets the
                                       bridge past threads.com's CSP
```

## Prior art

[skiseiju/ThreadsBlocker_Project](https://github.com/skiseiju/ThreadsBlocker_Project)
is a similar tool worth knowing about — it takes a different approach
(simulates real UI clicks rather than replaying API calls, ships as a
userscript/extension) and its own docs note it needs an "adaptive
verification system" to catch cases where a block *looks* successful but
isn't, which is exactly the failure mode this tool's block-verification
step (see above) is also guarding against.

## Turning this into a Chrome extension later

Possible, but not recommended as a Chrome Web Store submission — Meta has a
track record of pursuing takedowns against distributed automation tools
targeting Threads specifically, and Chrome Web Store review tends to reject
tools that automate a third-party site's private endpoints. An **unpacked,
personal-use-only** extension would work and would end up doing roughly the
same thing this bridge script does (content script + your own click), just
with more moving parts (manifest, background worker, install step) for
limited benefit over "paste this script." If you outgrow the console-paste
workflow, that's the natural next step — happy to build it.
