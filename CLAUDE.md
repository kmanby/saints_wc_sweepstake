# Saints CC — FIFA World Cup 2026 Sweepstake Tracker

Club sweepstake site for Saints CC (amateur cricket club). 48 tickets, 48 teams,
£180 pot. The draw happened 2026-06-11; the tournament is now running.

Prizes: £100 holder of the team that wins the final · £50 loses the final ·
£25 wins the third-place playoff · £5 wooden spoon (tournament's bottom team
by points → GD → GF → GA → fair play → FIFA ranking). The sim CANNOT compute
the spoon (it produces finishing orders, not scorelines/cards) — decision
agreed 2026-06-12: hard-code the spoon holder from real results once the
group stage finishes; do not simulate it. LOCKED 28 Jun: **Iraq, held by Ed
Marsh** (bottom of all 48 on GD, −11) — see roadmap item 5.

## Repo layout
- `site/` — static pages (Netlify publish dir)
  - `index.html` — main page: Saints-branded board of all 48 teams with ticket
    holders, click-through fun facts, win-probability badges. Was the pre-draw
    countdown page; being evolved into the live tournament tracker. Its fixtures
    panel lists today's matches (from openfootball) with an "on TV in the UK"
    line per upcoming match, sourced from `data/tv-uk.json` (see below). Its
    "Recent Results" panel (yesterday's matches) renders the score via
    `scoreHtml(score)`: a knockout tie decided in extra time / on penalties shows
    the after-extra-time score marked `AET` with the shootout score underneath
    (`score.et`/`score.p` from openfootball) — so a 1–1 penalty tie no longer
    reads as an unresolved draw.
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
  - `data/tv-uk.json` — **curated** UK free-to-air broadcaster per match, keyed
    by the openfootball `num` (1–104). Each entry `{channel, stream?}` e.g.
    `{"channel":"BBC One","stream":"BBC iPlayer"}`; `"TBC"` renders a muted
    "UK channel to be confirmed" hint, a missing entry renders nothing.
    index.html's fixtures panel shows it as the "on TV" line under each upcoming
    match. There is **no open feed** carrying this (decision 29 Jun, after
    confirming openfootball has no broadcaster field and TheSportsDB's is
    sparse/crowdsourced + rate-limited), so it's hand-curated from the BBC/ITV
    confirmations (broadcastnow.co.uk / live-footballontv.com) — same pattern as
    facts.json and the hard-coded spoon. BBC & ITV split the 104 games 50/50 and
    both show the final. R32 (num 73–88) is confirmed (8 BBC / 8 ITV); R16
    (89–96), QF (97–100), SF (101–102) and 3rd place (103) stay `"TBC"` until
    broadcasters confirm them round-by-round; the Final (104) is on both. Keyed
    by `num` (not teams) so it survives knockout placeholders like "W74".
  - `wallchart.html` — interactive groups + bracket. People-first labels:
    owner names label group rows, bracket cards and the champion box; the
    country lives in a hover/tap "team card" (flag, country, holder, champion
    % from daily-sim.json with the in-page Elo model as fallback, fun fact).
    Tapping a FLAG pins the card; tapping the rest of a bracket row still
    advances the team — keep that split, it's what preserves tap-to-advance
    on touch. **Real knockout results lock the bracket**: on load it fetches
    openfootball's `worldcup.json` (same feed index.html uses), and
    `buildKoResults`/`applyKoResults` match each played tie (match `num` ≥ 73)
    to its bracket slot by team-pair, lock the real winner into `kwins` and the
    score into `koScore[slotId]` (`{a,b,aet,pa,pb}`), re-locking on every
    `renderKO()`. Locked ties are immutable — `pickWinner` and the KO autosim
    (`_koAfSet`/`_koAfClear`) skip any slot with a `koScore`, and `applyKoResults`
    runs before the init autosim so an upset (e.g. a penalty winner) propagates
    into the R16+ pre-fill instead of the model's favourite. A played card shows
    the real goals (after extra time if it went to ET), the shootout score in
    parens and a small `aet` tag instead of the win %. worldcup.json carries
    `score.ft`/`score.et`/`score.p`; three team names differ from ours, mapped by
    `OF_NAME` (Bosnia & Herzegovina / Curaçao / Czech Republic). On load it `postMessage`s the parent two things: `s4c-height`
    (iframe auto-height) and `s4c-champ-dist` (its champion distribution, feed
    if loaded else the in-page model) — the latter is index.html's middle-tier
    odds fallback (see Daily sim subsystem). Group finishing positions are set
    by clicking probability cells directly (`assignPosition`); there is no
    separate position-picker modal.
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
- **Children of `.chart-wrap` must NOT reuse its `max-width:760px;width:94vw`.**
  That sizing is for the panel itself; the panel has `1.4rem` side padding, so a
  child forced to the same width can't fit its content box — its `auto` margins
  collapse to a negative right margin and it overflows ~45px to the right. Let
  panel children fill the content box (`width:auto`), like `#chartRows`. It bit
  the spoon-watch pill once (the solid maroon `.locked` bg made the spill loud).
- **Grid/flex items need `min-width:0` or they overflow narrow screens.** A grid
  item defaults to `min-width:auto`, so a `1fr` track can't shrink below its
  content's min-content — text with `overflow:hidden`+`text-overflow:ellipsis`
  never truncates and the columns blow past the viewport. It bit the 3rd-place
  `.t3btn` grid on mobile (3 cols ran ~32px off the right). Fix: `min-width:0`
  on the grid/flex item itself, not just the inner `.t3-name`.
- Pages embed logo + flags (self-contained rendering) but index.html and
  wallchart.html now FETCH same-origin data: `data/facts.json`,
  `data/daily-sim.json`, `data/tv-uk.json` (+ the GCS wc2026.json) — and both
  also fetch openfootball's `worldcup.json` (index for fixtures/results,
  wallchart for the real KO ties). All fetches degrade gracefully — facts modal
  shows a fallback line, champion % falls back to the in-page model, chart falls
  back to the snapshot, the TV line just doesn't render, and without worldcup.json
  the bracket just stays on the model's prediction. Keep it that way.

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
   labels + team cards. [DONE 30 Jun] **Real knockout results lock in** from
   openfootball's `worldcup.json` (not `/api/fixtures` — that proxy is dead on
   the burned key, and worldcup.json already carries `ft`/`et`/`p` per match):
   `buildKoResults`/`applyKoResults` join played ties to bracket slots and lock
   the winner + score (incl. extra-time + penalty). index.html's "Recent Results"
   shows AET / penalty scores via `scoreHtml`. Group standings still come from the
   daily-sim p1–p4 (already collapsed to 0/100 once a group finishes), which is
   what lines the R32 matchups up with the real ties.
4. Retire countdown remnants on index.html as tracker features land.
5. [DONE 28 Jun] **Wooden spoon** locked from real results. All six bottom
   teams finished the group stage on 0 pts, so goal difference settled it:
   **Iraq −11** (GF 1, GA 12) — one goal worse than Tunisia (−10) — holder
   **Ed Marsh**. Hard-coded as `FINAL_SPOON` in `sim/simulate.mjs` (`spoon.final
   = true`, per-candidate gf/ga/gd from the real tables, scorelines in the code
   comment, cross-checked vs ESPN/FIFA/Sky/Al Jazeera). index.html: the
   spoon-watch banner switches to the locked £5 result when `spoon.final`, and
   the holder gets a 🥄 + £5 badge on a `.crow.spoon` row pinned to the bottom
   of the odds chart (kept visible when collapsed via `:not(.spoon)`). If real
   results are ever found to differ, edit `FINAL_SPOON` and rerun the sim.

## Daily sim subsystem
- `sim/simulate.mjs` builds the daily odds (default 10,000 sims, seed =
  today's date) and writes `site/data/daily-sim.json`. With an official feed it
  takes the headline numbers straight from Sports4cast and does NOT simulate the
  tournament; the full Monte Carlo runs only in deep fallback (see below).
  `.github/workflows/daily-sim.yml` runs it ~05:14 UK daily (deliberately early
  — GitHub often dispatches scheduled runs hours late) and commits the result,
  which redeploys Netlify.
- The sim EXTRACTS its model from site/wallchart.html at runtime (vm + DOM
  stubs) — Elo, winProb, co-host boost, bracket slots, third-place allocation.
  One source of truth: never duplicate those tables into the sim.
- With a feed present (the normal case): champion, runner-up and every exit
  stage come straight from the feed's `chances.*`; the predicted bracket and the
  `modal` podium advance each knockout by the feed's **reach-next-round**
  probability — the chance of winning THAT match, which Sports4cast itself shows.
  It's read off the chances exit-distribution (group/r32/r16/qf/sf/final/win sum
  to 100): an R32 winner's strength is `r16+qf+sf+final+win` (reach the R16), an
  R16 winner's is `qf+sf+final+win`, … and the final's is `win`. Do NOT use
  `chances.win` for a match — that's the whole-tournament odds and makes every
  favourite look near-certain (Argentina 100% over Cape Verde vs the feed's ~89%).
  The champion is still the feed's predicted winner (the final's strength IS
  `chances.win`). The ONLY match the sim resolves itself is the third-place
  playoff between the two losing semifinalists (our one-match Elo model — the feed
  gives no head-to-head for it). Group orders / qualifying thirds (weighted by
  p3q) are still sampled from the daily p1–p4/p3q marginals, but ONLY to project
  the R32 third-slot hover distribution (raked back to p3q) — no knockout is
  simulated. NB the feed exposes no per-match head-to-head, so these reconstructed
  paths/percentages won't exactly equal Sports4cast's joint sim — close matches
  can flip and even ties differ by a few points.
- Deep fallback ONLY (feed unreachable >3 days, live GCS JSON → saved fixture →
  here): a full Monte Carlo off the wall chart's Elo snapshot — group orders from
  p1–p4, knockouts from winProb (no draws). Documented approximations — refine,
  don't silently change.
- daily-sim.json records per team: `champion`, `runnerUp`, `third` (each map
  sums to 100 — never renormalise) plus `stages` (incl. runnerUp/third) and
  `modal` = {champion, runnerUp, third} of the single most-likely playthrough.
- `modalScenario()` in the sim deliberately REPLICATES the wall chart's autosim
  (groups by p1, best-8 thirds by p3q, the higher reach-next-round team wins every
  KO match; only the third-place playoff goes to the Elo favourite) so the
  pre-filled wall chart and the index chart's "simulated draw" bar always tell
  the same story. The shared reach-next-round strength lives in `feedReachStrength`
  + `feedFavourite` (sim) / `feedReachStrength` + `feedPairProb` (wallchart.html),
  with identical per-stage formulas and tie-handling; Elo is only the tie / no-feed
  fallback. If the autosim logic in either file changes, change the other to match.
- index.html odds-chart source priority: daily-sim.json → wall-chart
  postMessage champion dist → hard-coded snapshot. Medals + £ render only
  when `modal` is present (fallback sources draw the bar alone, no podium).

## Dev workflow
- **ALWAYS keep this file (CLAUDE.md) current.** Any change to architecture,
  data flow, the sim, the pages, or a documented behaviour MUST update the
  matching section of CLAUDE.md as part of the same change — not a follow-up,
  not "later". Stale docs here have actively misled work (e.g. the section once
  said knockouts use Elo `winProb` long after they switched to the feed's
  `chances.win`). Treat the doc edit as part of the task's definition of done.
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
