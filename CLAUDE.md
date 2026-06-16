# Saints CC — FIFA World Cup 2026 Sweepstake Tracker

Club sweepstake site for Saints CC (amateur cricket club). 48 tickets, 48 teams,
£180 pot. The draw happened 2026-06-11; the tournament is now running.

Prizes: £100 holder of the team that wins the final · £50 loses the final ·
£25 wins the third-place playoff · £5 wooden spoon (tournament's bottom team
by points → GD → GF → GA → fair play → FIFA ranking). The sim CANNOT compute
the spoon (it produces finishing orders, not scorelines/cards) — decision
agreed 2026-06-12: hard-code the spoon holder from real results once the
group stage finishes; do not simulate it.

## Repo layout
- `site/` — static pages (Netlify publish dir)
  - `index.html` — main page: Saints-branded board of all 48 teams with ticket
    holders, click-through fun facts, win-probability badges. Was the pre-draw
    countdown page; being evolved into the live tournament tracker.
  - `draw.html` — the Draw Machine used live on draw day (slot-machine reveal,
    crypto-random, no-repeat pool, localStorage persistence). Job done; keep
    for posterity.
  - `favicon.png` — 64px Saints crest on maroon (`#5C1224`), linked by all
    three pages. Regenerate from the crest with the snippet in tools/ if the
    crest changes; it's the one non-embedded image asset.
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
- Pages embed logo + flags (self-contained rendering) but index.html and
  wallchart.html now FETCH same-origin data: `data/facts.json`,
  `data/daily-sim.json` (+ the GCS wc2026.json). All fetches degrade
  gracefully — facts modal shows a fallback line, champion % falls back to
  the in-page model, chart falls back to the snapshot. Keep it that way.

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
2. [DONE 12 Jun] **"Who's winning" chart**: one gold bar per person = summed
   champion %. The sim's modal podium pays out 🏆 £100 / 🥈 £50 / 🥉 £25,
   shown as a medal (left) + £ amount (beside the name) on the three holders
   only. The payout still drives the sort (prize-winners first, then by bar)
   — it is NOT drawn as a second bar (tried it; cream Bar B added noise, Kit
   cut it 12 Jun). Collapsed to the top 20 with a "Show all 33" toggle
   (`#chartRows.collapsed` + `#chartMore` button; `chartExpanded` persists
   across re-renders). Fun-fact badges hydrate from daily-sim.json, falling
   back to static `WINPROB`. Possible later toggle: "chance of holding a
   finalist" from stage probabilities.
3. [DONE — built from Kit's supplied HTML] **Wall chart** with people-first
   labels + team cards. Next phase: real results lock in as the tournament
   progresses (`.tr.locked` CSS hooks exist); may auto-populate from
   `/api/fixtures` if it carries results — confirm first.
4. Retire countdown remnants on index.html as tracker features land.
5. **[WAITS for group stage end ~27 Jun]** Wooden spoon: hard-code bottom
   team + holder from real results (see prize note at top), add 🥄 + £5 row
   styling to the chart.

## Daily sim subsystem
- `sim/simulate.mjs` runs a deterministic Monte Carlo of the whole tournament
  (default 10,000 sims, seed = today's date) and writes
  `site/data/daily-sim.json`. `.github/workflows/daily-sim.yml` runs it
  ~05:14 UK daily (deliberately early — GitHub often dispatches scheduled
  runs hours late) and commits the result, which redeploys Netlify.
- The sim EXTRACTS its model from site/wallchart.html at runtime (vm + DOM
  stubs) — Elo, winProb, co-host boost, bracket slots, third-place allocation.
  One source of truth: never duplicate those tables into the sim.
- Group orders are sampled from Sports4cast's daily p1–p4 marginals (live GCS
  JSON, embedded snapshot as fallback); qualifying thirds are Elo-weighted;
  knockout advancement uses winProb directly (no draws). The two losing
  semifinalists meet in a third-place playoff. Documented approximations —
  refine, don't silently change.
- daily-sim.json records per team: `champion`, `runnerUp`, `third` (each map
  sums to 100 — never renormalise) plus `stages` (incl. runnerUp/third) and
  `modal` = {champion, runnerUp, third} of the single most-likely playthrough.
- `modalScenario()` in the sim deliberately REPLICATES the wall chart's
  autosim (groups by p1, best-8 thirds by p3, favourite wins every KO match)
  so the pre-filled wall chart and the index chart's "simulated draw" bar
  always tell the same story. If the autosim logic in wallchart.html changes,
  change modalScenario to match.
- index.html odds-chart source priority: daily-sim.json → wall-chart
  postMessage champion dist → hard-coded snapshot. Medals + £ render only
  when `modal` is present (fallback sources draw the bar alone, no podium).

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
