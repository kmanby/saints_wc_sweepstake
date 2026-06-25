# Implementation Plan — Points-Based Third-Place Qualification (Option A)

**Branch:** `claude/s4c-third-place-weights`
**Date:** 2026-06-25
**Author:** Claude (for Kit / Saints CC)

## 1. Objective & scope

Remove **Elo** from the third-place qualification logic and base it on **points**
— actual points where a group is decided, plus Sports4cast's points-based
projection (`p3q`) for groups still live. Make the **R32 third-slot projection**
fall out of the *same* computation so the two always agree.

**In scope:**
- `sim/simulate.mjs` — replace Elo-weighted third selection with a `p3q`-weighted
  one; lock decided groups from real points; emit a fresh `third_slot_dists`;
  pass `p3q` through to `daily-sim.json`.
- `site/wallchart.html` — `getThirdTeams`/`auto8` rank by `p3q`; read
  `third_slot_dists` from `daily-sim.json` instead of the stale baked-in const.

**Out of scope (unchanged):**
- Elo stays for **knockout match win probabilities** (`winProb`) — Option A is
  third-place qualification only.
- The R32 "draft preview" feature (still a later branch).

## 2. Key decisions & why (answers to the open questions)

- **No live browser feed needed.** The browser only reads `daily-sim.json`.
- **No live match-odds source exists for us.** Verified: S4C's `wc2026` feed
  exposes only aggregated outputs — `team_data` (incl. `pts`, `p3q`), `elo_data`,
  `fifa_pts`. **No group fixtures, no per-match W/D/L.** So we *cannot* build our
  own match-by-match points predictor without Elo. The realistic, Elo-free
  "predicted points" signal is **`p3q`**, which is itself S4C's "current +
  predicted points → best-8 third" probability, computed server-side.
- **`pts` + marginals come from the feed we already fetch in CI** — current
  points and decided-vs-live state are both derivable from `team_data` (a group
  is decided when its position marginals round to 100). **No openfootball
  dependency added to the sim** (avoids the team-name-mapping silent-failure
  risk flagged in CLAUDE.md; the feed's `pts` is the authoritative current
  points). openfootball stays where it is — index.html's live fixtures.

## 3. The blend (Option A), precisely

For each group, classify from the feed's marginals:
- **DECIDED** — exactly one team has `p3 ≈ 100`: that team is the locked third;
  its `pts` are final.
- **LIVE** — third not yet certain.

**Per-team best-8 qualification probability** = **`p3q`** (S4C's points-based
projection; current as of the feed; consistent across decided + live). Decided
thirds keep their *identity* locked from real results; `p3q` still supplies the
"do my points make the cut?" probability (e.g. Scotland, 3 pts, ≈34% — not the
≈82% the Elo model gave).

**R32 third-slot distribution** (the alignment requirement): a Monte Carlo
selects the 8 qualifying thirds **weighted by `p3q`** (one per group,
Efraimidis–Spirakis — same machinery as today, new weight), assigns them to R32
slots via the static FIFA `THIRD_COMBOS` table (all 495 combos present), and
aggregates per-slot team frequencies. Because qualification *and* placement are
both driven by the same `p3q` weights, they align by construction.

## 4. Changes

### 4A. `sim/simulate.mjs` — Elo → `p3q` for third selection

`sampleQualifyingThirds()` (`sim/simulate.mjs:132`). Replace the Elo weight:

```js
// OLD
const w = Math.exp(effElo(team) / 120);
// NEW — S4C's points-based third-qualification weight, with a safe fallback
const td = TD[team];
const w = Math.max(0.0001, (td.p3q ?? td.p3 ?? 0));
```

Thread `TD` into the function (it currently only takes `effElo`); drop the
`effElo` argument from this call site (`:176`). `effElo` stays in the model for
`winProb` — only the thirds use of it is removed.

### 4B. `sim/simulate.mjs` — emit `third_slot_dists`

In `simulateOnce` (`:169`), after `sampleQualifyingThirds` yields the qualifying
groups and `thirdMap` (the combo assignment), tally which third-place **team**
lands in each R32 third-slot. Aggregate across all sims into a
`third_slot_dists` map (`{ r32_id: { team: prob, … } }`, same shape as S4C's),
and add it to the `daily-sim.json` output object (`main()`, ~`:295-310`).

### 4C. `sim/simulate.mjs` — `modalScenario` thirds by `p3q`

`modalScenario()` (`:221`) currently picks the best-8 thirds by `p3`:

```js
.map(g => ({ g, p: TD[third[g]].p3 }))
// →
.map(g => ({ g, p: TD[third[g]].p3q ?? TD[third[g]].p3 }))
```

Keeps the modal playthrough consistent with the wall chart's `auto8`.

### 4D. `sim/simulate.mjs` — `p3q` passthrough

`team_data` is already copied verbatim (`TD = d.team_data`), so `p3q` flows
through automatically **once the feed serves it**. Add a one-line guard/log if
`p3q` is absent across all teams (so a feed regression is visible, not silent),
and leave the `p3 ?? ` fallbacks (4A/4C) so the sim still runs on legacy data.

### 4E. `site/wallchart.html` — rank thirds by `p3q`

`getThirdTeams()` (`site/wallchart.html:1487`):

```js
.map(g=>({group:g,team:sel[g][3],prob:TEAM_DATA[sel[g][3]].p3}));
// →
.map(g=>{const td=TEAM_DATA[sel[g][3]];return {group:g,team:sel[g][3],prob:td.p3q??td.p3};});
```

`auto8` (`:1493`) is unchanged — it already sorts by `prob` and takes the top 8;
now that `prob` is `p3q`, the best-8 selection is points-based.

### 4F. `site/wallchart.html` — `THIRD_SLOT_DISTS` from daily-sim

The baked-in `const THIRD_SLOT_DISTS` (`:917`) is frozen/stale. After the
`daily-sim.json` fetch sets `TEAM_DATA`, also apply
`if (d.third_slot_dists) THIRD_SLOT_DISTS = d.third_slot_dists;` (keep the
baked-in value as the offline fallback). This makes the hover projection / R32
third-slots reflect today's run and align with the qualification section.

## 5. Testing & verification

1. **`p3q` fixture.** Our committed `daily-sim.json` predates `p3q`, and the
   sandbox can't reach the live feed. Build a fixture by injecting the new
   widget's `p3q` values into a copy of `team_data`, and run the sim against it
   to validate logic end-to-end.
2. **Sim run** (`node sim/simulate.mjs` against the fixture):
   - `extractModel` still succeeds; no Elo in the thirds path.
   - `third_slot_dists` emitted; **each team's qualify rate ≈ Σ of its
     slot-dist entries** (internal alignment check).
   - Sanity: a decided low-points third (Scotland, 3 pts) lands near its `p3q`
     (~a third), **not** the Elo ~82%.
   - Restore: `git checkout -- site/data/daily-sim.json` (never commit a
     sandbox-regenerated data file).
3. **Render check** (`npx netlify dev --offline` + `node tools/render-check.mjs`):
   zero page errors; third-place section + R32 cards render; owner labels intact.
4. **Graceful degradation:** confirm the page and sim still work when `p3q` /
   `third_slot_dists` are absent (legacy `daily-sim.json`) — fall back to `p3`
   and the baked-in dists.

## 6. Data / rollout

- `daily-sim.json` gains `team_data[*].p3q` (passthrough) and a top-level
  `third_slot_dists`. It regenerates in CI (`daily-sim.yml`); the new fields
  appear at the next run. The browser degrades gracefully until then.
- **Live confirmation:** the sandbox can't verify the feed currently serves
  `p3q`; the new widget is strong evidence it does. Confirm at the next
  daily-sim run (or a manual `workflow_dispatch`).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Feed doesn't (yet) serve `p3q` | `p3 ??` fallbacks keep sim+page working; absence is logged, not silent. |
| Qualify prob and slot-dist drift apart | Both driven by the same `p3q` Monte Carlo; test asserts Σ(slot-dist) ≈ qualify rate. |
| Committing a stale regenerated `daily-sim.json` | Mandatory `git checkout --` after the sim test; reviewer checks the data file isn't in the diff. |
| Removing Elo breaks knockout odds | Elo untouched for `winProb`; only the thirds weight changes. |
| Stale baked-in `THIRD_SLOT_DISTS` shown | Overridden by `d.third_slot_dists`; baked value is fallback only. |

## 8. Commit & push

- One commit on `claude/s4c-third-place-weights`:
  `Third-place qualification: points-based (p3q), drop Elo; align R32 slot dist`
- Files: `sim/simulate.mjs`, `site/wallchart.html`, `plans/third-place-points.md`.
  **Not** `site/data/daily-sim.json`.
- `git push -u origin claude/s4c-third-place-weights`. No PR unless asked.

## 9. Follow-ups

- Confirm `p3q` in the live feed at the next CI run; if absent, chase S4C.
- R32 "draft preview" feature (separate branch) can reuse the fresh
  `third_slot_dists` this adds.
