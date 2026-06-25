# Plan — adopt the official Sports4cast sim, keep ours for the gaps

Status: **implemented (2026-06-25)**. Supersedes the "run our own Monte Carlo
for everything" approach. Grounded in a verified live `wc2026.json` capture
(`sim/fixtures/wc2026.json`). Champion/runner-up now come straight from the
official feed; third place is our one-match playoff model; the full Monte Carlo
is the deep fallback only. A provisional wooden-spoon *watch* shipped alongside
(see §6). All steps below are done bar the post-27-Jun spoon lock-in.

## Verified facts (from the real payload)

- It is the official **10,000-run** sim (`num_sims: 10000`), regenerated daily
  (`generated` ISO timestamp; today's was 09:01Z).
- Per-team `team_data[T].chances = {win, final, sf, qf, r16, r32, group}` are
  **exact exit-stage** probabilities — they sum to **100.00** per team, NOT
  cumulative "reach" probabilities. (The widget's "reach each round" wording
  is a display transform it applies; the raw feed is exit-stage.)
- Aggregate invariants hold: Σ`win` = 100, Σ`final` = 100, Σ`sf` = 200.
- **Team-name join is clean**: the 48 `team_data` keys equal our 48
  `facts.json` keys exactly. **No normalisation map required.** (Join on
  facts.json / sim names — `sweepstake.json` uses display names and must not be
  the join key.)
- Bonus fields we didn't have before: `pts` (live group points), `fifa_pts`
  (FIFA ranking points, all 48 — the wooden-spoon final tiebreak), `r32_opp`,
  `elo_data`, and `p3q` (already used).

### Prize → field mapping (all direct, no subtraction)

| Prize | Source | Notes |
|---|---|---|
| Champion £100 | `chances.win` | Σ = 100, never renormalise |
| Loses final £50 | `chances.final` | Σ = 100 (one runner-up) |
| Plays 3rd-place playoff | `chances.sf` | Σ = 200 (two semi-final losers) |
| Wins 3rd-place playoff £25 | **computed** | `chances.sf` split by one Elo match |
| Eliminated in group | `chances.group` | P(qualify) = 1 − group |

> Correction to earlier advice: P(semi-final loser) is `chances.sf` **directly**,
> not `sf − final`. `sf` already means "eliminated at the semi-final".

## The CI fetch question — answered

**Yes, the daily GitHub Action pulls fresh `wc2026.json` every day, and already
does.** The committed `daily-sim.json` shows `source: sports4cast-live`.

The CORS error Kit hit in the browser is a **browser-only** rule — it blocks
*JavaScript* from reading a cross-origin response. A Node process in CI has no
"origin" and is not subject to CORS; the signed URL returns 200 to any HTTP
client. (The egress block we saw was specific to the Claude sandbox, not GitHub
Actions.) `simulate.mjs:308-319` already performs the two-step signed-URL fetch
server-side and it works.

Small bug to fix along the way: `source_updated` is `null` because the sim reads
`d.updated ?? d.last_updated`, but the feed's timestamp field is `generated`.
Map `source_updated = feed.generated`.

## Design

### 1. Data source + fallback chain (3 states)

1. **Live** — fetch today's feed via the signed URL (as now). `source =
   "sports4cast-live"`.
2. **Stale-but-official** — live fetch fails OR returns no `chances` OR
   `generated` is older than the run date → load `sim/fixtures/wc2026.json`.
   Still official numbers, just not today's. `source = "fixture-fallback"`;
   pages show a soft "official data from <date>" note.
3. **Model fallback** — fixture missing or older than a threshold (default 3
   days) → run our **full Monte Carlo** off the wall-chart snapshot, exactly as
   today. `source = "sim-fallback"`; pages show a loud "live data lost — showing
   our own model" banner. This is Kit's "use our sim in its entirety and
   highlight that the connection is lost" state.

"Missing" must include **stale**, not just a failed fetch — their feed silently
rotted once before (the dead `wc2026_chances.json`).

**Auto-refresh (decided ON):** the daily action rewrites
`sim/fixtures/wc2026.json` on every successful live fetch and commits it
alongside `daily-sim.json`, so the backup is never more than a day old and
state 3 only triggers after 3+ consecutive days of feed failure. The fixture
becomes a rolling latest-good copy (git history keeps the daily snapshots).
Accepted trade-off: it republishes the friend's feed into git daily.

### 2. Champion & runner-up — official, direct

`daily-sim.json.champion[T] = chances.win[T]`, `runnerUp[T] = chances.final[T]`.
No simulation. Both already sum to 100 — keep as-is, never renormalise.

### 3. Third place — the one-match model

Compute `third[T]` (wins the 3rd-place playoff) from official marginals + the
wall-chart Elo `winProb`, not a full tournament sim:

```
third[X] = chances.sf[X] · Σ_{Y in opposite half}  sfhat[Y] · winProb(X, Y)
```

where `sfhat[Y]` = `chances.sf[Y]` normalised within Y's half (the other half
yields exactly one semi-final loser). This sums to 100 across teams (one playoff
winner) — never renormalise.

Bracket halves come from `M.FEEDERS["final"] = [sfA, sfB]`: trace each
semifinal back through the QF/R16/R32 tree to partition teams into the two
halves. Where the bracket is locked (knockouts) this is exact; during the group
stage, assign halves from the **modal bracket** (`modalScenario()` already
builds one — groups by p1, best-8 thirds by p3q). Documented approximation that
sharpens as the bracket firms up; third-place odds are speculative pre-knockout
anyway.

**Modal third** (the single 🥉 podium): keep `modalScenario()` unchanged — its
single most-likely bracket already determines the two semi-final losers and runs
one favourite-wins match, and it stays consistent with the wall-chart autosim.

### 4. `daily-sim.json` output

Keep the existing shape so `index.html` / `wallchart.html` need no consumer
changes — only the numbers' provenance changes:

- `champion`, `runnerUp` ← official `win` / `final`.
- `third` ← one-match model (§3).
- `stages[T]` ← official exact-stage `chances` (richer than before: real
  group/r32/r16/qf/sf/final/win breakdown) + computed `third`.
- `modal` ← `modalScenario()` (unchanged).
- `source`, `source_updated` (= `generated`), `num_sims`, `seed`, `method`
  (reworded to say champion/runner-up are official, third is our playoff model).
- `elo_data` stays (`M.ELO`). `third_slot_dists` (R32 slot rake to p3q) can stay
  as-is; revisit later if we want it off official numbers.

### 5. Pages

- Add a `source`-driven banner in `index.html` + `wallchart.html`: hidden for
  `sports4cast-live`, soft note for `fixture-fallback`, loud for `sim-fallback`.
- **Revive index.html odds**: its `elo_data` fetch points at the dead
  `sports4cast-public/.../wc2026.json` (now 404). Repoint to the signed-URL
  scheme, or read `elo_data` from `daily-sim.json` (the sim already has it).
- `wallchart.html` champion %: already reads `daily-sim.json` champion (now
  official) with the in-page Elo model as fallback — keep.

### 6. Wooden spoon (~27 Jun)

Cannot be *forecast*: the spoon needs points → GD → GF → GA → fair play → FIFA
ranking, and neither our sim nor the feed produces scorelines or cards (the
12 Jun "don't simulate it" decision still holds). The feed only supplies points
(`pts`, partial until the last group games) and the FIFA tiebreak (`fifa_pts`).

But the "hard-code from real results" step can now be **automated** once the
group stage finishes: compute points/GD/GF/GA for all 48 from the real
scorelines we already fetch (openfootball, plus Sports4cast `results.json`),
rank them, take the bottom team, with `fifa_pts` as the FIFA-ranking tiebreak.
Only **fair play (cards)** stays manual — and only matters in an exact
points+GD+GF+GA tie, so it's a rare manual override, not a daily task.

**Shipped (provisional):** `spoonWatch()` ranks all 48 by `pts` → `p4` →
`fifa_pts` and writes a `spoon` block (`final:false`, `pick`, top-6 `candidates`,
a not-final `note`) into `daily-sim.json`; `index.html` shows a dashed 🥄
"Spoon watch" badge naming the holder + team, clearly flagged not-final. Today's
pick: **Haiti** (0 pts, p4 = 100% in Group C, lowest FIFA points of the cellar) —
but several 0-point teams are still separated only by GD/GF/GA we don't yet have,
which is exactly why it stays a *watch* until the group stage locks it (step 7).

## Implementation order

1. [done] Wire the 3-state source + fallback chain into `simulate.mjs`
   (`loadOfficialFeed` live→fixture→model; `STALE_DAYS=3` staleness check;
   `source` values; `source_updated = feed.generated`; auto-refresh the fixture
   on every live run).
2. [done] Champion/runner-up straight from official `chances.win` / `.final`.
3. [done] Third-place one-match model (§3): `thirdPlaceModel` + `bracketHalves`
   half partition walked from `M.FEEDERS`, halves assigned via the modal bracket.
4. [done] Emit richer `stages` from official exact-stage chances (+ computed
   third); added `source_sims` and a `spoon` block to `daily-sim.json`.
5. [done] `render-check` passes offline against the fixture (fixture-fallback
   path); source + spoon-watch assertions added.
6. [done] Pages: 3-state source banner (hidden / soft / loud) + provisional
   spoon-watch badge on `index.html`; repointed the dead `wc2026.json` Elo fetch
   to `daily-sim.json`'s `elo_data`. Workflow commits the refreshed fixture.
7. [later] Spoon lock-in after 27 Jun: replace the watch with the real
   bottom-team computation (points → GD/GF/GA from results → `fifa_pts` tiebreak).

## Testing

- `node sim/simulate.mjs` offline must use the fixture and produce a valid
  `daily-sim.json` with all sum-to-100 invariants intact.
- `node tools/render-check.mjs` against a dev server — chart rows, podium,
  group/bracket cards, champion box, zero page errors.
- Spot-check: official `champion` top teams match the feed's `win` ordering;
  `third` sums to 100; banner renders per simulated `source`.

## Decisions (locked 2026-06-25, Kit)

1. **Third-place method**: the lightweight one-match model (§3).
2. **Stale threshold**: 3 days before dropping to the full-model fallback.
3. **Auto-refresh the fixture** on every successful live run: yes (see §1).

Spoon: keep it out of the forecast (can't be simulated), but automate the
"from real results" computation after 27 Jun, fair-play tiebreak aside (§6).
