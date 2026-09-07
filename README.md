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
   tool) into your DevTools console while on threads.net. It runs inside
   that page, so it never touches your password or session cookie — the
   browser attaches those automatically to requests, exactly like it does
   when you click a button.
2. threads.net's own Content-Security-Policy blocks that tab from making
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
   threads.net, watches for that action, and tags it automatically the
   moment it sees it. Every click after that just works. Later bulk actions
   replay that captured template with a different target ID — nothing is
   guessed or hard-coded.
5. Everything that mutates your account (block, report) happens as a fetch
   from your real threads.net tab straight to threads.net's own API — that
   part is same-origin, so it doesn't need the relay, and it's rate-limited
   with randomized delays between actions to look and behave like normal
   manual use.

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
- Rule (d)'s "Instagram account created around the same time" half can't be
  automated: Instagram exposes no reliable creation-date signal (official or
  unofficial). The tool detects and surfaces the Instagram link/handle from
  the bio for you; you still have to open it and eyeball the account age
  yourself.
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
   DevTools console on threads.net.
2. **Capture your followers** — scroll your followers list on threads.net.
   Watch the counters go up on the local page. Click **"Fetch details for
   accounts missing data"** to backfill follower/following counts, photo,
   and bio (needed for rules c and d).
3. **Filter, select, and act** — check the rule boxes (a-e), pick "any" or
   "all", review the labeled table, select the accounts you want, and click
   **Block selected** or **Block + Report selected**.

That's genuinely it for day-to-day use. The "teach it your block/report"
step isn't a separate thing you have to understand — it only shows up
*inside* step 2/3, the first time you click a button that needs it: a modal
tells you exactly which one account to act on manually on threads.net, and
detects and learns from it automatically. If it ever seems to learn the
wrong thing (rare, but Threads batches several network calls per click), an
**Advanced** section at the bottom of the page lets you inspect exactly what
was captured and reset a learned action to try again.

## The five rules

| Rule | What it flags |
|---|---|
| a | Username matches an animal name + number pattern (e.g. `tiger8842`, `gecko.52078145`) |
| b | Username or display name matches one letter + Taiwan mobile format (e.g. `a0912345678`) |
| c | 0 followers, following exactly 48 or 49, no profile photo |
| d | Bio links an Instagram account — flagged for you to manually check if it looks freshly created |
| e | Username looks like an auto-generated "firstname.lastname+digits" handle and the display name was never customized away from it (e.g. username `daisy.clark18`, name `daisy.clark18`) |

Rule (a)'s word list lives in `src/animalNames.js` — it's a plain JS array,
extend it (e.g. more Chinese animal words) as you spot new bot patterns.
Rules live in `src/heuristics.js` if you want to tune the thresholds.

## Project layout

```
bin/cli.js          entry point — starts the local server
src/server.js        Express app: status/accounts/tagging/job APIs
src/store.js          in-memory account store + generic JSON extractor
src/heuristics.js     the 4 detection rules
src/animalNames.js    word list for rule (a)
browser/bridge.js     the console script pasted into threads.net
public/                the local web UI (plain HTML/CSS/JS, no build step)
```

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
