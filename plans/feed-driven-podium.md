# Plan — stop re-simulating the podium; take everything but 3rd place from the feed

Status: **investigation / not started** (2026-06-25). Follow-up correction to
`official-sim-integration.md`. Pick this up fresh.

## The principle (Kit, 2026-06-25, verbatim intent)

> We should now **only be simulating 3rd place**. Everything else should come
> from the data feed, which **already takes into account paths to the final**.

The official Sports4cast feed is a 10,000-run Monte Carlo. Its
`team_data[T].chances = {win, final, sf, qf, r16, r32, group}` already encode
every team's probability of each finish, accounting for the whole bracket /
draw. So the champion, runner-up and every stage are **answered by the feed**.
The one prize the feed does NOT directly give is the **3rd-place playoff
winner** (it gives `chances.sf` = "loses the semi", i.e. reaches the playoff,
but not who wins it) — that single match is the only thing we should simulate
(the one-match Elo model already built in `thirdPlaceModel`).

## The bug: we re-simulate the tournament and contradict the feed

`sim/simulate.mjs` still runs `modalScenario()` — our own "favourite (higher
Elo) wins every match" playthrough — to pick a podium, and the pages render
medals/champion from THAT, not from the feed. Because "highest Elo" ≠ "best
draw", the two disagree:

- **Feed** most-likely champion (argmax `chances.win`): **Argentina 16.65%**
  (held by Jonny Ward Manning; his bar correctly shows 21.3% summed).
- **Our `modalScenario`** champion: **Spain** (highest Elo), held by Jamie Briant.

The 🏆 on the index chart sits on **Jamie/Spain**, while the feed says the
favourite is **Jonny/Argentina**. That is the "results not flowing through
correctly" Kit reported. The summed-probability *bars* are already correct
(straight from `chances.win`); only the **medals and the wall-chart champion
box / pre-filled bracket** are wrong, because they come from the Elo re-sim.

### Where the Elo re-sim leaks in (file:symbol references)

- `sim/simulate.mjs`
  - `modalScenario()` (~line 245) — Elo favourite-wins playthrough → podium.
  - `podium()` (~line 165) — champion/runnerUp/third of a given bracket.
  - Output `modal` field (~line 524) consumed by index.html for medals.
  - `champion`/`runnerUp` ARE already feed marginals (good); `third` is already
    the one-match model (good). Only `modal` is the offender.
- `site/index.html`
  - `PRIZES` (line 536) + medal assignment in `renderOddsChart` (lines 564–568):
    a person gets a medal iff `p.teams.includes(modal[pos])`.
  - `modal` is built from `d.modal.champion/runnerUp/third` (lines 672–675).
  - So medals follow `modalScenario`, NOT `chances.win`/`final`/our third.
- `site/wallchart.html`
  - The knockout **autosim** (`koAutoFill` → `winProb`, Elo) fills the bracket
    and the **champion box** with the Elo favourite — also Spain, also wrong.
  - Note: the per-team champion **% badges** already read the feed
    (`CHAMP_PCT = d.champion`); only the autosim WINNER contradicts it.
- `CLAUDE.md` documents that `modalScenario` *deliberately replicates* the wall
  chart autosim "so the pre-filled wall chart and the index chart tell the same
  story." That coupling is now the problem: they tell the same WRONG story.
  Both must move to the feed together, and this note must be rewritten.

## What it should become

| Prize | Marker should follow | Source |
|---|---|---|
| 🏆 £100 champion | argmax `chances.win` | feed (direct) |
| 🥈 £50 loses final | argmax `chances.final` | feed (direct) |
| 🥉 £25 wins 3rd playoff | argmax of our one-match `third` model | the ONLY sim |

The wall chart's pre-filled bracket + champion box should likewise reflect the
feed's most-likely outcome, not the Elo autosim.

## Open questions to resolve before coding

1. **Per-prize marginals vs one consistent scenario.** Marking each medal by its
   own argmax (win / final / third) is the literal "most likely to win each
   prize", and is almost certainly what Kit wants. But argmax-win and
   argmax-final could fall in the *same* bracket half (can't both reach the
   final in reality). Decide: independent per-prize marginals (simple, matches
   "who's most likely to win £X") — recommended — vs a single feed-consistent
   bracket. Document the choice.
2. **Wall-chart pre-filled bracket from feed marginals.** The feed gives
   marginals, not a concrete bracket. To pre-fill a single "most likely path":
   - Groups already come from `p1–p4` (feed) — keep.
   - For each knockout match A vs B, advance the team with the higher feed
     **P(reach the next round)** = Σ `chances` for stages at/after that round
     (e.g. decide an R16 tie by P(reach QF) = win+final+sf+qf). Verify this
     yields argmax-`win` as champion and stays internally consistent.
   - Keep Elo `winProb` ONLY for interactive "what-if" head-to-heads (the feed
     can't give odds for hypothetical matchups the user clicks into) — but the
     DEFAULT path must be feed-driven.
3. **Fate of `modalScenario` / the `modal` field.** Likely retire `modalScenario`
   and replace `daily-sim.json.modal` with a feed-derived podium
   `{champion: argmax win, runnerUp: argmax final, third: argmax third-model}`,
   OR drop `modal` and have index.html compute medals from `champion`/`runnerUp`/
   `third` maps directly. Pick one; update both producers and consumers.
4. **3rd-place medal source.** index.html currently uses `d.modal.third` (Elo).
   Switch to argmax of `d.third` (the one-match model). Confirm `d.third` is the
   playoff-winner distribution (it is).

## Suggested implementation order

1. Decide Q1 + Q3 (podium representation).
2. `simulate.mjs`: replace `modal` with feed-derived podium (or remove it);
   keep `champion`/`runnerUp` (feed) and `third` (one-match) as they are.
3. `index.html`: drive medals from feed podium (argmax win/final/third), not the
   Elo modal. Keep the bars as-is (already feed).
4. `wallchart.html`: make the default autosim path + champion box feed-driven
   (Q2); keep Elo only for interactive what-ifs.
5. `CLAUDE.md`: rewrite the "modalScenario replicates the autosim" note to "both
   the index podium and the wall-chart default come from the feed; only the
   3rd-place playoff is simulated."
6. `tools/render-check.mjs`: assert the 🏆 holder == holder of argmax
   `chances.win` (today: Jonny Ward Manning / Argentina), 🥈 == argmax
   `chances.final`, 🥉 == argmax `third`. This is the regression guard that
   would have caught this.

## Test case (today's live feed, 2026-06-25)

- argmax `chances.win` = **Argentina 16.65%** → 🏆 should be **Jonny Ward Manning**.
- Current (buggy) 🏆 = Jamie Briant (Spain, modalScenario). Fix flips it.
- Bars (summed `chances.win` per person) are already right — do not touch them.

## Out of scope / unchanged

- The fallback chain, banner, cron, spoon watch, group-completion ticks — all
  shipped and correct. This plan is only about the podium/medals + wall-chart
  default coming from the feed instead of the Elo re-sim.
