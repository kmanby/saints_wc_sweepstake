# Saints CC — FIFA World Cup 2026 Sweepstake Tracker

Club sweepstake site for Saints CC (amateur cricket club). 48 tickets, 48 teams,
£180 pot, winner = holder of the World Cup-winning team. The draw happened
2026-06-11; the tournament is now running.

## Repo layout
- `site/` — static pages (Netlify publish dir)
  - `index.html` — main page: Saints-branded board of all 48 teams with ticket
    holders, click-through fun facts, win-probability badges. Was the pre-draw
    countdown page; being evolved into the live tournament tracker.
  - `draw.html` — the Draw Machine used live on draw day (slot-machine reveal,
    crypto-random, no-repeat pool, localStorage persistence). Job done; keep
    for posterity.
  - `data/sweepstake.json` — **source of truth for the draw result**: tickets,
    people (grouped), team names + flag codes. Build new features from this,
    not by scraping the HTML.
  - `data/facts.json` — single copy of the 48 fun facts, keyed by SIM team
    name ("Turkey", "Curacao"), each entry `{code, name, fact}` carrying the
    flagcdn code + display name ("Türkiye", "Curaçao"). Both pages fetch it;
    don't reintroduce inline copies.
  - `wallchart.html` — interactive groups + bracket. People-first labels:
    owner names label group rows, bracket cards and the champion box; the
    country lives in a hover/tap "team card" (flag, country, holder, champion
    % from daily-sim.json with the in-page Elo model as fallback, fun fact).
    Tapping a FLAG pins the card; tapping the rest of a bracket row still
    advances the team — keep that split, it's what preserves tap-to-advance
    on touch.
- `netlify/functions/sports4cast.mjs` — API proxy (see Security)
- `netlify.toml` — publish dir + functions dir

## Architecture rules
1. **Static site + one serverless proxy. No other backend.** Keep costs at £0
   (Netlify free tier).
2. The browser NEVER calls Sports4cast directly. It calls `/api/chances`
   (also `/api/fixtures`, `/api/rankings`) on same-origin, served by the proxy.
3. The proxy CDN-caches until the next **06:30 Europe/London** (upstream data
   refreshes ~04:00). Target ~1 upstream call/day. Don't add schedulers or
   storage; the cache header approach is deliberate.
4. The proxy is a closed allowlist of three endpoints — never make it an open
   relay.

## Security — non-negotiable
- API key lives ONLY in Netlify env var `SPORTS4CAST_KEY` (locally: `.env`,
  which is gitignored). Never in code, never in git history, never client-side,
  never echoed in errors or logs.
- The original key was exposed in chat during development → treated as burned.
  The owner (a friend of Kit's) is issuing a fresh one. **Current status: the
  old key returns 403 from upstream — expected. Do not debug this; it needs the
  new key in the env var.**
- If a key is ever pasted into a chat/commit/log again: rotate it.

## External API (friend's service — Sports4cast)
- Base: `https://sports4cast-api-oxtgcqhyuq-nw.a.run.app`
- Auth: `x-api-key` header.
- `GET /wc2026/chances` — per-team tournament advancement probabilities.
  **Schema not yet confirmed** — no successful call has been made. First task
  once a working key exists: capture a real response and pin down field names.
- `GET /fixtures`, `GET /rankings` — shapes also unconfirmed.

## Known gotchas (learned the hard way)
- **Team-name mapping is the #1 silent-failure risk.** The API's team strings
  may differ from ours ("Turkey"/"Türkiye", "Korea Republic"/"South Korea",
  "Côte d'Ivoire"/"Ivory Coast", "Czech Republic"/"Czechia",
  "Bosnia-Herzegovina"/"Bosnia & Herz.", "United States"/"USA",
  "Congo DR"/"DR Congo"). Build a normalisation map keyed from the REAL
  response, and make the UI display unmatched teams loudly — never default a
  missed join to 0%.
- Emoji flags render as letter codes on Windows — that's why all 48 flags are
  embedded base64 PNGs in the pages. Keep it that way (works offline too).
- `draw.html` uses localStorage (key `saints-wc-draw-v1`) to survive refreshes.
- Both pages are fully self-contained single files (embedded logo + flags);
  only Google Fonts load externally, with graceful fallback.

## Branding (use these, don't invent)
- Maroon primary `#5C1224` / deep `#43091A`; green secondary `#0E2A1F` /
  panel `#0A1F16`; cream `#F2EAD3`; gold trim `#D9A93C` / soft `#B8902F`.
- Fonts: Tangerine (Monotype Corsiva stand-in) for display; Saira Condensed
  for labels/uppercase; Spectral for body.
- Tone: cricket-club scoreboard aesthetic, gold-highlighted key words.
  In-jokes that are canon: "Lambrini Moment" (worst moment award),
  Jaffa (the dog) holds Australia.

## Roadmap (in order)
1. **[BLOCKED on new API key]** Capture real `/wc2026/chances` response;
   build team-name normaliser + unmatched-team warning.
2. [LARGELY DONE — now driven by daily-sim.json] **Cumulative win-odds chart** on index.html: one bar per PERSON (33 people,
   teams summed — data in `site/data/sweepstake.json` → `people`), sorted
   descending by summed outright-win probability. Gold World Cup trophy icon
   above 1st, silver medal 2nd, bronze 3rd. Refresh from `/api/chances` on
   load. Also hydrate the existing fun-fact win-probability badges from live
   data, falling back to the static `WINPROB` values (snapshot ~11 Jun 2026)
   if the fetch fails. Possible later toggle: "chance of holding a finalist"
   using stage probabilities, if the API provides them.
3. **Wall chart** (groups + bracket, fills in as tournament progresses).
   Kit will supply example HTML to build from — DO NOT design speculatively.
   May auto-populate from `/api/fixtures` if it carries results; confirm first.
4. Retire countdown remnants on index.html as tracker features land.

## Daily sim subsystem
- `sim/simulate.mjs` runs a deterministic Monte Carlo of the whole tournament
  (default 10,000 sims, seed = today's date) and writes
  `site/data/daily-sim.json`. `.github/workflows/daily-sim.yml` runs it at
  06:35 UK daily and commits the result, which redeploys Netlify.
- The sim EXTRACTS its model from site/wallchart.html at runtime (vm + DOM
  stubs) — Elo, winProb, co-host boost, bracket slots, third-place allocation.
  One source of truth: never duplicate those tables into the sim.
- Group orders are sampled from Sports4cast's daily p1–p4 marginals (live GCS
  JSON, embedded snapshot as fallback); qualifying thirds are Elo-weighted;
  knockout advancement uses winProb directly (no draws). Documented
  approximations — refine, don't silently change.
- index.html odds-chart source priority: daily-sim.json → wall-chart
  postMessage champion dist → hard-coded snapshot. Champion %s in the JSON
  already sum to 100; never renormalise them.

## Dev workflow
- Local: `npm install`, then `npx netlify dev --offline` (add `.env` with
  `SPORTS4CAST_KEY=...` for a working proxy; without it `/api/*` returns the
  deliberate "Server not configured" 500).
- netlify-cli insists on a Deno binary for its edge-functions proxy (we have
  none) — the npm `deno` devDependency satisfies it in sandboxes where
  dl.deno.land is blocked.
- Render check: `node tools/render-check.mjs` against the running dev server —
  executes each page's JS in jsdom and asserts chart rows, group cards,
  bracket cards, champion box, and zero page errors. Run it after touching
  any page; it caught nothing less than everything string-patching broke.
- Test proxy: `curl http://localhost:8888/api/chances` (or the deployed
  `https://<site>.netlify.app/api/chances`).
- Deploy: push to `main` → Netlify auto-deploys (site imported from this repo).
- Netlify Drop is NOT usable (no functions support).

## Owner
Kit (kmanby) — Saints CC captain. Prefers being told trade-offs straight,
likes the gold-trim branding, will spot a wrong cap number at forty paces.
