# Implementation Plan — Wall Chart Group-Sorting Fix

**Branch:** `claude/lucid-babbage-0zkfz4`
**Date:** 2026-06-25
**Author:** Claude (for Kit / Saints CC)

## 1. Objective & scope

Port the **group-sorting fix** from the latest Sports4cast wall-chart build
(`b4e68d0e-wc2026widget.html`, supplied by Kit) into our customised
`site/wallchart.html`, and update the daily sim to match.

**In scope (this branch):**
- Fix group finishing-order logic (display + autosim).
- Auto-lock teams that are 100% certain of a position into the bracket
  (Kit approved 2026-06-25).
- Update `sim/simulate.mjs` `modalScenario()` to mirror the new autosim
  (required by the CLAUDE.md "modal must match autosim" contract).

**Explicitly out of scope (separate follow-up branch):**
- The new R32 **"draft preview"** feature (`draftTeam` + `.mt.draft`) that
  shows the most-likely *uncertain* team faintly in empty bracket slots.
  Kit: "Fix the group sorting — then we will move onto the R32 draft preview."

## 2. Why this is a port, not a file swap

The attached file is the **vanilla Sports4cast widget** with none of our
Saints customisation. It must NOT be dropped in. We keep our file and graft
only the fixed group logic. Things in the new file we deliberately **do not**
bring over:

| New-file element | Why we reject it |
|---|---|
| `s4cGet` / `s4cSlug` / `_s4cTTL` + `s4cGet('wc2026')` boot | Calls Sports4cast **directly** — violates architecture rule #2. We load `data/daily-sim.json` same-origin. |
| Emoji `FLAGS` | Render as letter codes on Windows; we use embedded base64 PNGs. |
| Country-code row labels (`teamLabel`, `code()`) | We use **owner names** (`ownLabel`) + `wireTeamCard` (people-first design). |
| `draftTeam` + `.mt.draft` buildMatchCard branch | Deferred to the follow-up branch. |

Things we **must preserve** while editing: base64 flags, `ownLabel`/`OWNER`,
`wireTeamCard`/team cards, `champPctFor` champion %, `postMessage`
height-sync (`sendH`), branding, and the `daily-sim.json` data layer.

## 3. Root cause (for reviewers)

In our current file, both the group display sort (`buildGroupCard`,
`wallchart.html:1247`) and the autosim (`autoFillGroups`, `wallchart.html:1416`)
rank unlocked teams by **`p1` only**:

```js
[...teams].sort((a,b)=> TEAM_DATA[b].p1 - TEAM_DATA[a].p1)
```

So "2nd place" shows the team with the second-highest *1st-place* probability,
not the team most likely to finish *2nd*. Wrong for almost every group. The
fix ranks each slot by its own marginal (slot 1 by `p1`, slot 2 by `p2`, …)
and auto-locks mathematically-certain positions so they flow into the bracket.

## 4. Changes

### 4A. `site/wallchart.html` — add two helpers + auto-lock

Insert after `doneCount()` (currently `wallchart.html:1221`), before the
`// ─── RENDER GROUPS` banner. (Ported verbatim from the new build,
`:996`–`:1027`; logic is UI-agnostic so no re-skinning needed.)

```js
// Effective position locks for a group: user selections (sel[g]) plus
// auto-locks for any team certain (rounds to 100%) of a position. {team: pos}.
function groupLocks(g){
  const m = {}, slot = {};
  for(const [p,t] of Object.entries(sel[g])){ const pos=parseInt(p); m[t]=pos; slot[pos]=t; }
  for(const t of groupTeams(g)){
    if(m[t]) continue;
    for(let pos=1; pos<=4; pos++){
      if(Math.round(TEAM_DATA[t]["p"+pos]||0)>=100 && !slot[pos]){ m[t]=pos; slot[pos]=t; break; }
    }
  }
  return m;
}

// Order a group's four teams into finishing slots 1→4. Locked teams take their
// exact slot; the rest fill remaining slots greedily — for each open slot take
// the unlocked team most likely to finish there (sort by 1st, then 2nd, 3rd, 4th).
function orderedGroup(g, lockedMap){
  lockedMap = lockedMap || {};
  const teams = groupTeams(g);
  const slotTeam = {};
  for(const t of teams){ if(lockedMap[t]) slotTeam[lockedMap[t]] = t; }
  const pool = teams.filter(t=>!lockedMap[t]);
  const out = [];
  for(let pos=1; pos<=4; pos++){
    if(slotTeam[pos]){ out.push(slotTeam[pos]); continue; }
    let bestIdx=-1, bestP=-1;
    pool.forEach((t,idx)=>{ const p=TEAM_DATA[t]["p"+pos]||0; if(p>bestP){ bestP=p; bestIdx=idx; } });
    if(bestIdx>=0){ out.push(pool[bestIdx]); pool.splice(bestIdx,1); }
  }
  pool.forEach(t=>out.push(t)); // safety: append any leftover
  return out;
}

// Persist auto-locks (teams certain of a position) into sel, so they behave
// like a user pick everywhere downstream — including the R32 bracket, which
// reads group placements straight from sel.
function applyAutoLocks(){
  if(!TEAM_DATA) return;
  GROUPS.forEach(g=>{
    const placed = new Set(Object.values(sel[g]));
    const taken  = {};
    for(const [p,t] of Object.entries(sel[g])) taken[parseInt(p)] = t;
    for(const t of groupTeams(g)){
      if(placed.has(t)) continue;
      for(let pos=1; pos<=4; pos++){
        if(Math.round(TEAM_DATA[t]["p"+pos]||0)>=100 && !taken[pos]){
          sel[g][pos]=t; taken[pos]=t; placed.add(t); break;
        }
      }
    }
  });
}
```

### 4B. `site/wallchart.html` — call `applyAutoLocks()` in `renderGroups`

`renderGroups()` (`wallchart.html:1225`) — add as the **first** statement of
the body (mirrors new build `:1052`), so `sel` is populated before group cards
*and* the subsequent `renderKO()` read it:

```js
function renderGroups(){
  applyAutoLocks();                       // <-- ADD
  if(!groupCollapseInit && window.innerWidth <= 600){
  ...
```

`onGroupChange()` and `initPage()` both call `renderGroups()` before
`renderKO()`, so auto-locks re-apply after every edit and on load. No other
call-site changes needed.

### 4C. `site/wallchart.html` — swap the sort in `buildGroupCard`

`buildGroupCard()` (`wallchart.html:1242`). Replace the inline sort block
(`:1243`–`:1251`):

```js
  const teams = groupTeams(g);
  const lockedMap = {};
  for(const [p,t] of Object.entries(sel[g])) lockedMap[t]=parseInt(p);

  const sorted=[...teams].sort((a,b)=>{
    const la=lockedMap[a]||99, lb=lockedMap[b]||99;
    if(la!==lb) return la-lb;
    return TEAM_DATA[b].p1-TEAM_DATA[a].p1;
  });
```

with:

```js
  const lockedMap = groupLocks(g);
  const sorted = orderedGroup(g, lockedMap);
```

**Preserve** the rest of `buildGroupCard` unchanged — critically the
owner-label row render and team-card wiring (`wallchart.html:1291`–`1292`):

```js
row.innerHTML=`<span class="tn"><span class="tn-flag">${flag(team)}</span><span class="tn-own">${ownLabel(team)}</span></span>${ptsVal}${pcSpans.join("")}${badge}`;
wireTeamCard(row.querySelector(".tn"), team, { tapWholeEl: true });
```

(`teams` local is now unused there — remove it; `orderedGroup` calls
`groupTeams(g)` internally.)

### 4D. `site/wallchart.html` — swap the sort in `autoFillGroups`

`autoFillGroups()` (`wallchart.html:1414`). Replace (`:1416`):

```js
    const ranked=[...groupTeams(g)].sort((a,b)=>TEAM_DATA[b].p1-TEAM_DATA[a].p1);
```

with:

```js
    const ranked=orderedGroup(g);
```

### 4E. `sim/simulate.mjs` — match `modalScenario()` to the new autosim

`modalScenario()` (`sim/simulate.mjs:214`). Replace the group loop (`:216`–`:219`)
and its comment (`:211`–`:213`) so the single most-likely playthrough uses the
same greedy slot-fill as `orderedGroup`:

```js
// Mirrors the wall chart's autosim exactly: each slot filled by its own
// marginal (1st by p1, 2nd by p2, 3rd by p3 among the teams not yet placed),
// best-8 thirds by p3, every knockout match (and playoff) to the favourite —
// so the index chart's "simulated draw" matches the pre-filled wall chart.
function modalScenario(M, TD, groupTeams) {
  const first = {}, second = {}, third = {};
  for (const g of M.GROUPS) {
    const pool = [...groupTeams[g]];
    const take = key => {
      let bi = 0, bp = -1;
      pool.forEach((t, i) => { const p = TD[t][key] || 0; if (p > bp) { bp = p; bi = i; } });
      return pool.splice(bi, 1)[0];
    };
    first[g] = take("p1"); second[g] = take("p2"); third[g] = take("p3");
  }
  ...
```

The rest of `modalScenario` (thirds-by-p3, favourite-wins KO) is unchanged.
Note: the Monte Carlo sampler `sampleGroupOrder()` already uses proper
sequential marginals, so the daily `champion`/`runnerUp`/`third` distributions
are **unaffected** — only the `modal` field changes.

## 5. Testing & verification

1. **Render check (required after any page edit).**
   ```sh
   npm install
   npx netlify dev --offline   # background; serves site/
   node tools/render-check.mjs # executes page JS in jsdom
   ```
   Must report group cards, bracket cards, champion box, and **zero page
   errors**. This catches any missed CSS class or broken reference.

2. **Manual spot-check** of the rendered wall chart (today's `daily-sim.json`):
   - A group where a team's best finish is 2nd (e.g. an unlocked group) now
     lists that team in the **2nd** row, not ordered purely by `p1`.
   - Settled positions (`p=100`) show with the `lk-*` left-border and appear
     pre-filled in the **R32 bracket on load** (no autosim click needed).
   - Owner names still label rows; tapping a flag still opens the team card;
     PTS column still shows points.

3. **Sim logic check (non-destructive).** Verify extraction still works and the
   modal is sane **without clobbering the committed live data**:
   ```sh
   node sim/simulate.mjs            # writes site/data/daily-sim.json
   # inspect: jq '.modal' site/data/daily-sim.json
   git checkout -- site/data/daily-sim.json   # discard regenerated file
   ```
   - If this sandbox can't reach the live GCS feed, the sim falls back to the
     **embedded pre-tournament snapshot** (no points). In that case the
     regenerated file is wrong — the `git checkout` above is mandatory; **do
     not commit a locally-regenerated `daily-sim.json`.**
   - We only need to confirm: `extractModel` succeeds and `modal.champion`
     is a real team. The correct live regeneration happens in CI (below).

## 6. `daily-sim.json` regeneration & drift note

We do **not** commit a regenerated `daily-sim.json` from this branch. It is a
generated artifact owned by `.github/workflows/daily-sim.yml` (~05:14 UK),
which has live-data access. Until that next run, the live site's index
"simulated draw" bar keeps the old `modal` while the wall chart shows the new
order — a ≤1-day cosmetic drift on one bar.

To eliminate the drift immediately after merge, manually dispatch the
`daily-sim` workflow (`workflow_dispatch`) so it regenerates `daily-sim.json`
with the new `modalScenario` against live data. (Optional — confirm with Kit.)

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Edit breaks page JS (silent in browser) | `tools/render-check.mjs` asserts zero errors + all sections present. |
| Sim extraction breaks (vm sandbox) | Run `node sim/simulate.mjs`; `extractModel` throws loudly if `M` changes — we only add UI functions, not model exports. |
| Accidentally committing stale `daily-sim.json` | Explicit `git checkout --` step; reviewer checks the diff excludes `daily-sim.json`. |
| Auto-lock changes "blank canvas" feel | Approved by Kit 2026-06-25; documented behaviour change. |
| Owner-label render accidentally reverted to country code | Diff review: `buildGroupCard` row render must keep `ownLabel` + `wireTeamCard`. |

## 8. Commit & push

- Single commit on `claude/lucid-babbage-0zkfz4`:
  `Fix wall-chart group finishing-order (per-slot marginals + auto-lock); match sim modal`
- Files changed: `site/wallchart.html`, `sim/simulate.mjs`, `plans/plan.md`.
  (NOT `site/data/daily-sim.json`.)
- `git push -u origin claude/lucid-babbage-0zkfz4` (retry w/ backoff on network
  error). No PR unless Kit asks.

## 9. Follow-up (next branch, not now)

R32 **"draft preview"**: port `draftTeam` + the `buildMatchCard` empty-slot
branch + `.mt.draft` CSS from the new build, re-skinned to our
`infoFlag`/`ownLabel`/`wireTeamCard` style, so empty bracket slots show the
most-likely *uncertain* team faintly and clickably.
