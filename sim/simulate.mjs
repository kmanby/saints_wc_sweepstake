#!/usr/bin/env node
// Saints CC sweepstake — daily odds builder
//
// Writes site/data/daily-sim.json, which drives the odds leaderboard and the
// wall chart's champion %. Run by GitHub Action each morning, or manually:
//   node sim/simulate.mjs [--sims 10000] [--seed 20260612]
//
// With an official Sports4cast feed (the normal case) we DON'T simulate the
// tournament: champion, runner-up and every exit-stage chance come straight
// from the feed's 10,000-run figures, and the predicted bracket (the modal
// podium + the wall chart's autosim) advances whoever the feed gives a better
// chance of WINNING THE CUP (chances.win) at every knockout. The ONLY match we
// model ourselves is the third-place playoff between the two semi-final losers —
// the feed carries no head-to-head for it — using the Elo win prob.
//
// Single source of truth: the model functions (Elo table, win probability,
// co-host boost, bracket slots, third-place allocation table) are extracted
// at runtime from site/wallchart.html, so the sim can never drift from the
// wall chart users see.
//
// Honest approximations:
// - Group finishing orders / qualifying thirds are sampled from the feed's daily
//   p1–p4 and p3q marginals only to project the third-place R32 slot distribution
//   (a hover aid), then raked back to p3q. No knockout matches are played.
// - Deep fallback ONLY (feed unreachable for >3 days): a full Monte Carlo off the
//   wall chart's Elo snapshot — groups from p1-p4, knockouts from winProb with no
//   draws — so the page still has numbers when Sports4cast goes dark.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// ---------- args ----------
const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SIMS = parseInt(arg("sims", "10000"), 10);
const today = new Date().toISOString().slice(0, 10);
const SEED = parseInt(arg("seed", today.replace(/-/g, "")), 10);
const SIGNED_URL_ENDPOINT = "https://sports4cast.com/wp-json/football/v1/signed-urls?files[]=wc2026";
// How many days old the saved fixture may be before we abandon official numbers
// and fall all the way back to our own Monte Carlo. The daily action rewrites the
// fixture on every successful live fetch, so this only bites after 3+ dead days.
const STALE_DAYS = 3;

// ---------- deterministic PRNG (identical everywhere, unlike Math.random) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);

// ---------- extract the model from the wall chart (DOM-stubbed) ----------
function stubEl() {
  return new Proxy({
    innerHTML: "", style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    appendChild(c){ return c; }, append(){}, remove(){}, addEventListener(){},
    setAttribute(){}, getAttribute(){ return null; },
    querySelector(){ return stubEl(); }, querySelectorAll(){ return []; },
    getBoundingClientRect(){ return { top:0, left:0, width:100, height:100 }; },
    insertBefore(){}, removeChild(){},
  }, {
    get(t, p) {
      if (p in t) return t[p];
      if (["parentElement", "parentNode", "firstChild"].includes(p)) return null;
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function extractModel(wallchartPath) {
  const sandboxGlobals = {
    document: {
      getElementById: () => stubEl(), createElement: () => stubEl(),
      createElementNS: () => stubEl(), addEventListener(){},
      querySelectorAll: () => [], querySelector: () => stubEl(),
      body: stubEl(), documentElement: stubEl(), fonts: { ready: Promise.resolve() },
    },
    window: {
      innerWidth: 1200, innerHeight: 900, addEventListener(){},
      parent: { postMessage(){} }, self: {}, top: {},
      location: { hostname: "localhost" },
      matchMedia: () => ({ matches: false, addEventListener(){} }),
    },
    requestAnimationFrame: () => {},
    fetch: () => Promise.reject(new Error("sim: no widget fetch")),
    setTimeout, clearTimeout, console,
  };
  sandboxGlobals.location = sandboxGlobals.window.location;
  sandboxGlobals.globalThis = sandboxGlobals;

  const html = fs.readFileSync(wallchartPath, "utf8");
  const m = html.match(/<script>(?!<!--)([\s\S]*?)<\/script>/);
  if (!m) throw new Error("No script block found in " + wallchartPath);
  const code = m[1] + `
;globalThis.__MODEL = {
  GROUPS, ELO, R32_SLOT_DEFS, FEEDERS, THIRD_COMBOS,
  TEAM_DATA_FALLBACK,
  effElo: (typeof effectiveElo === "function") ? effectiveElo : null,
  winProb: (typeof winProb === "function") ? winProb : null,
};`;
  vm.createContext(sandboxGlobals);
  vm.runInContext(code, sandboxGlobals, { filename: "wallchart-script.js" });
  const M = sandboxGlobals.__MODEL;
  if (!M || !M.winProb || !M.effElo) throw new Error("Model extraction failed");
  return M;
}

// ---------- sampling helpers ----------
function sampleIndex(weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return Math.floor(rand() * weights.length);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// sequential sample of a group's finishing order from p1..p4 marginals
function sampleGroupOrder(teams, td) {
  const order = [];
  let pool = [...teams];
  for (let pos = 1; pos <= 4; pos++) {
    const ws = pool.map(t => Math.max(td[t]["p" + pos] ?? 0, 0.0001));
    const idx = sampleIndex(ws);
    order.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return order; // [1st, 2nd, 3rd, 4th]
}

// 8 of 12 thirds qualify, weighted by Sports4cast's points-based third-place
// qualification probability (Efraimidis–Spirakis without replacement). The
// weight is conditional — p3q/p3 = P(best-8 third | finished 3rd) — so the
// aggregate qualify rate reproduces S4C's unconditional p3q. Falls back to p3
// for legacy data that predates the p3q field. (Elo no longer used here.)
function sampleQualifyingThirds(thirdByGroup, TD) {
  const entries = Object.entries(thirdByGroup).map(([g, team]) => {
    const td = TD[team];
    const p3 = td.p3 ?? 0;
    const w = (td.p3q != null && p3 > 0)
      ? Math.max(1e-4, td.p3q / p3)
      : Math.max(1e-4, p3);
    return { g, key: Math.pow(rand(), 1 / w) };
  });
  entries.sort((a, b) => b.key - a.key);
  return entries.slice(0, 8).map(e => e.g).sort();
}

// ---------- bracket resolution shared by the sampled sims and the modal replay ----------
function makeResolveSide(first, second, third, thirdMap) {
  return (def, side) => {
    const s = def[side];
    if (s && s.pos === 1) return first[s.group];
    if (s && s.pos === 2) return second[s.group];
    // third-place side: routed via the official table, keyed by the 1st-placed partner
    const other = def[side === "a" ? "b" : "a"];
    const slot = thirdMap["1" + other.group];   // e.g. "3E"
    return third[slot.slice(1)];
  };
}

// final's loser is the runner-up; the two losing semifinalists meet in the
// third-place playoff (decide(A,B) returns the playoff winner)
function podium(winners, M, decide) {
  const champion = winners["final"];
  const [sfA, sfB] = M.FEEDERS["final"];
  const runnerUp = winners[sfA] === champion ? winners[sfB] : winners[sfA];
  const loserOf = sfid => {
    const [fa, fb] = M.FEEDERS[sfid];
    return winners[sfid] === winners[fa] ? winners[fb] : winners[fa];
  };
  const third = decide(loserOf(sfA), loserOf(sfB));
  return { champion, runnerUp, third };
}

// ---------- one full tournament ----------
function simulateOnce(M, TD, groupTeams, tally, slotTally) {
  const first = {}, second = {}, third = {};
  for (const g of M.GROUPS) {
    const [a, b, c] = sampleGroupOrder(groupTeams[g], TD);
    first[g] = a; second[g] = b; third[g] = c;
  }

  const qualGroups = sampleQualifyingThirds(third, TD);
  const comboKey = qualGroups.join("");
  const thirdMap = M.THIRD_COMBOS[comboKey];
  if (!thirdMap) throw new Error("No third-place combo for " + comboKey);

  const resolveSide = makeResolveSide(first, second, third, thirdMap);

  const winners = {};

  for (const [sid, def] of Object.entries(M.R32_SLOT_DEFS)) {
    const A = resolveSide(def, "a"), B = resolveSide(def, "b");
    if (!A || !B) throw new Error("Unresolved R32 side in " + sid);
    // record which third-place team landed in this R32 slot (for third_slot_dists)
    const thirdSide = def.a.third ? "a" : (def.b.third ? "b" : null);
    if (thirdSide && slotTally[sid]) {
      const tt = thirdSide === "a" ? A : B;
      slotTally[sid][tt] = (slotTally[sid][tt] || 0) + 1;
    }
    winners[sid] = rand() < M.winProb(A, B) ? A : B;
    tally[A].r32++; tally[B].r32++;
  }

  const roundOf = id => id.startsWith("r16") ? "r16" : id.startsWith("qf") ? "qf"
                      : id.startsWith("sf") ? "sf" : "f";
  for (const [mid, [fa, fb]] of Object.entries(M.FEEDERS)) {
    const A = winners[fa], B = winners[fb];
    winners[mid] = rand() < M.winProb(A, B) ? A : B;
    const r = roundOf(mid);
    tally[A][r]++; tally[B][r]++;
  }

  // NB: the playoff consumes one extra rand() per sim, so tallies for a given
  // seed differ slightly from the pre-playoff sim version (same model, shifted
  // stream) — a one-time discontinuity, not a model change
  const pod = podium(winners, M, (A, B) => rand() < M.winProb(A, B) ? A : B);
  tally[pod.champion].win++;
  tally[pod.runnerUp].runnerUp++;
  tally[pod.third].third++;
}

// ---------- group-stage-only sampler (feed path) ----------
// With an official feed we do NOT simulate the knockouts — paths come straight
// from the feed (see modalScenario / the headline block in main). The one thing
// the feed's per-team marginals don't directly give is the JOINT distribution of
// which group's third lands in each R32 third-slot (it depends on which 8 thirds
// qualify together, routed through the FIFA allocation table). So we sample only
// the GROUP STAGE — finishing orders from p1-p4, the best-8 thirds from p3q —
// and tally the slot each qualifying third fills. No matches are played here;
// the result is later raked to the feed's own p3q. This keeps "only the
// third-place playoff is simulated" true while preserving the slot hover aid.
function sampleThirdSlots(M, TD, groupTeams, slotTally) {
  const first = {}, second = {}, third = {};
  for (const g of M.GROUPS) {
    const [a, b, c] = sampleGroupOrder(groupTeams[g], TD);
    first[g] = a; second[g] = b; third[g] = c;
  }
  const qualGroups = sampleQualifyingThirds(third, TD);
  const thirdMap = M.THIRD_COMBOS[qualGroups.join("")];
  if (!thirdMap) throw new Error("No third-place combo for " + qualGroups.join(""));
  const resolveSide = makeResolveSide(first, second, third, thirdMap);
  for (const [sid, def] of Object.entries(M.R32_SLOT_DEFS)) {
    const thirdSide = def.a.third ? "a" : (def.b.third ? "b" : null);
    if (!thirdSide || !slotTally[sid]) continue;
    const tt = resolveSide(def, thirdSide);
    if (tt) slotTally[sid][tt] = (slotTally[sid][tt] || 0) + 1;
  }
}

// ---------- the single most-likely bracket (shared by modal podium + third model) ----------
// Fills each slot by its own marginal: 1st by p1, 2nd by p2, 3rd by p3 among the
// teams not yet placed; best 8 thirds by p3q. This IS the wall chart's autosim, so
// anything built on it stays consistent with the pre-filled wall chart.
function modalBracket(M, TD, groupTeams) {
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
  const qualGroups = M.GROUPS
    .map(g => ({ g, p: TD[third[g]].p3q ?? TD[third[g]].p3 }))
    .sort((a, b) => b.p - a.p).slice(0, 8).map(e => e.g).sort();
  const thirdMap = M.THIRD_COMBOS[qualGroups.join("")];
  if (!thirdMap) throw new Error("No third-place combo for modal bracket");
  return { resolveSide: makeResolveSide(first, second, third, thirdMap) };
}

const koRoundOf = id => id.startsWith("r32") ? "r32" : id.startsWith("r16") ? "r16"
                     : id.startsWith("qf") ? "qf" : id.startsWith("sf") ? "sf" : "final";

// Strength for a knockout round = the feed's probability the team REACHES THE NEXT
// ROUND (wins this match), from the chances exit-distribution
// (group/r32/r16/qf/sf/final/win sum to 100). Mirrors the wall chart's
// feedReachStrength so the modal podium and the autosim stay identical. This is
// the per-match quantity Sports4cast shows; chances.win (whole-tournament odds)
// would make every favourite look near-certain.
function feedReachStrength(TD, t, stage) {
  const c = TD[t] && TD[t].chances;
  if (!c) return null;
  switch (stage) {
    case "r32": return c.r16 + c.qf + c.sf + c.final + c.win;
    case "r16": return c.qf + c.sf + c.final + c.win;
    case "qf":  return c.sf + c.final + c.win;
    case "sf":  return c.final + c.win;
    case "final": return c.win;
    default:    return c.win;
  }
}

// Predicted-bracket winner from the feed at `stage`: the team more likely to reach
// the next round advances, so the predicted bracket follows the feed (and the
// champion is the feed's predicted winner). Elo fallback when the feed can't
// separate them (missing chances / exact tie).
function feedFavourite(M, TD, A, B, stage) {
  const sa = feedReachStrength(TD, A, stage), sb = feedReachStrength(TD, B, stage);
  if (sa == null || sb == null || sa === sb) return M.winProb(A, B) >= 0.5 ? A : B;
  return sa > sb ? A : B;
}

// ---------- the single most-likely playthrough ----------
// Every knockout match goes to the feed's predicted winner (feedFavourite) over
// the modal bracket — so the index chart's "simulated draw" matches the
// pre-filled wall chart, and both name the feed's champion. The third-place
// playoff is the ONLY match we still decide ourselves (the feed gives no
// head-to-head for it): it goes to the Elo favourite, our one-match model.
function modalScenario(M, TD, groupTeams) {
  const { resolveSide } = modalBracket(M, TD, groupTeams);
  const koWinner = (A, B, stage) => feedFavourite(M, TD, A, B, stage);
  const playoffWinner = (A, B) => M.winProb(A, B) >= 0.5 ? A : B;

  const winners = {};
  for (const [sid, def] of Object.entries(M.R32_SLOT_DEFS)) {
    winners[sid] = koWinner(resolveSide(def, "a"), resolveSide(def, "b"), "r32");
  }
  for (const [mid, [fa, fb]] of Object.entries(M.FEEDERS)) {
    winners[mid] = koWinner(winners[fa], winners[fb], koRoundOf(mid));
  }
  return podium(winners, M, playoffWinner);
}

// Partition the R32 slots into the tournament's two halves — the two semifinals
// feed the final from opposite halves — by walking the feeder tree to r32 leaves.
function bracketHalves(M) {
  const leaves = mid => M.R32_SLOT_DEFS[mid] ? [mid] : M.FEEDERS[mid].flatMap(leaves);
  const half = {};
  for (const sid of leaves("sf_1")) half[sid] = 1;
  for (const sid of leaves("sf_2")) half[sid] = 2;
  return half;
}

// ---------- third-place playoff: the lightweight one-match model ----------
// The playoff is a single match between the two halves' semi-final losers, so we
// don't sim a tournament for it. Using the official exit-at-semifinal marginals
// (chances.sf) and the modal bracket to assign each team to a half:
//   third[X] = sfhat[X] · Σ_{Y in opposite half} sfhat[Y] · winProb(X, Y)
// where sfhat normalises chances.sf within a half. Each half yields exactly one
// semi-final loser, so each half's sfhat sums to 1 and the result sums to 100
// across teams (one playoff winner) by construction — never renormalise.
// The half assignment is exact once the bracket locks; pre-knockout it follows the
// modal bracket (a documented approximation that sharpens as groups settle).
function thirdPlaceModel(M, TD, groupTeams, chancesSf) {
  const half = bracketHalves(M);
  const { resolveSide } = modalBracket(M, TD, groupTeams);
  const teamHalf = {};
  for (const [sid, def] of Object.entries(M.R32_SLOT_DEFS)) {
    const A = resolveSide(def, "a"), B = resolveSide(def, "b");
    if (A) teamHalf[A] = half[sid];   // both sides of an R32 tie sit in the same half
    if (B) teamHalf[B] = half[sid];
  }
  const sfOf = t => Math.max(chancesSf[t] ?? 0, 0);
  const H = { 1: [], 2: [] };
  for (const [t, h] of Object.entries(teamHalf)) if (h) H[h].push(t);
  const S = { 1: H[1].reduce((s, t) => s + sfOf(t), 0), 2: H[2].reduce((s, t) => s + sfOf(t), 0) };
  const sfhat = t => { const h = teamHalf[t]; return h && S[h] > 0 ? sfOf(t) / S[h] : 0; };

  const third = {};
  for (const t of Object.keys(TD)) {
    const h = teamHalf[t];
    if (!h) { third[t] = 0; continue; }   // not in the modal R32 (group casualty) → 0
    let p = 0;
    for (const y of (h === 1 ? H[2] : H[1])) p += sfhat(y) * M.winProb(t, y);
    third[t] = +(sfhat(t) * p * 100).toFixed(2);
  }
  return third;
}

// round a slot's {team: prob} to 4dp, drop zeros, sort descending
function sortRoundDist(dist) {
  return Object.fromEntries(Object.entries(dist)
    .map(([t, v]) => [t, +v.toFixed(4)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]));
}

// Rake the raw Monte-Carlo R32 third-slot distribution so each team's slot-total
// equals its p3q (the qualification probability) while each slot still sums to 1
// — iterative proportional fitting. Σp3q = 8 = number of variable third-slots,
// so the row and column marginals are consistent and IPF converges. This makes
// the R32 projection's per-team totals match the qualification section exactly.
// Skipped when p3q is absent (legacy data): the raw Monte-Carlo dists stand.
function rakeSlotDists(rawDists, TD) {
  const slots = Object.keys(rawDists);
  const teams = [...new Set(slots.flatMap(s => Object.keys(rawDists[s])))];
  if (!teams.some(t => TD[t]?.p3q != null))
    return Object.fromEntries(slots.map(s => [s, sortRoundDist(rawDists[s])]));

  const rowTarget = Object.fromEntries(teams.map(t => [t, (TD[t]?.p3q ?? 0) / 100]));
  const m = Object.fromEntries(slots.map(s => [s, { ...rawDists[s] }]));
  for (let iter = 0; iter < 100; iter++) {
    const rowSum = {};
    for (const s of slots) for (const [t, v] of Object.entries(m[s])) rowSum[t] = (rowSum[t] || 0) + v;
    for (const s of slots) for (const t of Object.keys(m[s]))
      if (rowSum[t] > 0) m[s][t] *= rowTarget[t] / rowSum[t];   // rows -> p3q
    for (const s of slots) {
      const colSum = Object.values(m[s]).reduce((a, b) => a + b, 0);
      if (colSum > 0) for (const t of Object.keys(m[s])) m[s][t] /= colSum;  // slots -> 1
    }
  }
  return Object.fromEntries(slots.map(s => [s, sortRoundDist(m[s])]));
}

// ---------- official feed: live → saved fixture → our own model ----------
// A usable feed is the official 10k-run payload with chances for all 48 teams.
function feedUsable(d) {
  if (!d || !d.team_data) return false;
  const teams = Object.keys(d.team_data);
  return teams.length === 48 && teams.every(t => d.team_data[t] && d.team_data[t].chances);
}

// Whole days between the feed's `generated` date and the run date (≥0 = stale).
function daysOld(generated, todayStr) {
  if (!generated) return Infinity;
  const g = Date.parse(String(generated).slice(0, 10) + "T00:00:00Z");
  const t = Date.parse(todayStr + "T00:00:00Z");
  return (Number.isNaN(g) || Number.isNaN(t)) ? Infinity : Math.round((t - g) / 86400000);
}

// Three-state source chain. "Missing" deliberately includes *stale*: their feed
// silently rotted once before, so a yesterday-dated payload is not "live".
async function loadOfficialFeed(fixturePath, todayStr) {
  // 1. live — two-step signed URL (60s-lived), same as the widget uses
  try {
    const sigR = await fetch(SIGNED_URL_ENDPOINT, { signal: AbortSignal.timeout(10000) });
    if (sigR.ok) {
      const signedUrl = (await sigR.json()).wc2026;
      if (signedUrl) {
        const r = await fetch(signedUrl, { signal: AbortSignal.timeout(15000) });
        if (r.ok) {
          const raw = await r.text();
          const d = JSON.parse(raw);
          // A successful live fetch IS the upstream's current truth — accept it
          // whatever its date. Their sim regenerates mid-morning (~09:00Z), AFTER
          // our early cron, so the feed is often still dated yesterday at run time;
          // a "must be today" check here would needlessly demote every cron run to
          // the cache and (since the fixture only refreshes on a live run) starve it
          // into the model fallback within days. Age is surfaced by the banner, not
          // by demoting the source.
          if (feedUsable(d))
            return { feed: d, source: "sports4cast-live", raw };
          console.warn("Live feed reached but unusable (missing chances?) — trying the saved fixture");
        }
      }
    }
  } catch (e) { console.warn("Live feed unreachable (" + e.message + ") — trying the saved fixture"); }

  // 2. fixture — the last good official payload (rewritten on every live run)
  try {
    const raw = fs.readFileSync(fixturePath, "utf8");
    const d = JSON.parse(raw);
    const age = daysOld(d.generated, todayStr);
    if (feedUsable(d) && age <= STALE_DAYS)
      return { feed: d, source: "fixture-fallback", raw: null };
    console.warn(`Saved fixture is ${age} day(s) old (> ${STALE_DAYS}) or unusable — using our own model`);
  } catch { console.warn("No usable saved fixture — using our own model"); }

  // 3. our own Monte Carlo off the wall-chart snapshot
  return { feed: null, source: "sim-fallback", raw: null };
}

// ---------- provisional wooden-spoon watch ----------
// The £5 spoon CANNOT be forecast: it needs points → GD → GF → GA → fair play →
// FIFA ranking, and the feed carries no scorelines or cards. This is a live
// *watch* only — ordered by what we do have (points, then likelihood of finishing
// bottom via p4, then FIFA points) — flagged not-final until the group stage ends.
function spoonWatch(feed, todayStr) {
  const td = feed.team_data, fifa = feed.fifa_pts || {};
  const ranked = Object.keys(td).map(t => ({
    team: t,
    group: td[t].group ?? null,
    pts: td[t].pts ?? null,
    p4: td[t].p4 ?? 0,
    fifa_pts: fifa[t] ?? null,
  })).sort((a, b) =>
    (a.pts ?? 99) - (b.pts ?? 99) ||           // fewest points
    (b.p4 ?? 0) - (a.p4 ?? 0) ||               // most locked into last place
    (a.fifa_pts ?? 9999) - (b.fifa_pts ?? 9999)); // weakest by FIFA points
  return {
    final: false,
    as_of: todayStr,
    pick: ranked[0]?.team ?? null,
    candidates: ranked.slice(0, 6),
    note: "Provisional. The £5 wooden spoon is decided by points, then goal difference, goals for/against, fair play and finally FIFA ranking — the feed only carries points and FIFA points, so this orders by points, then chance of finishing bottom (p4), then FIFA points. Locked from real results once the group stage ends (~27 Jun).",
  };
}

// ---------- main ----------
async function main() {
  const repoRoot = process.cwd();
  const wallchartPath = path.join(repoRoot, "site", "wallchart.html");
  const outPath = path.join(repoRoot, "site", "data", "daily-sim.json");

  const M = extractModel(wallchartPath);

  // Official daily feed, with a 3-state fallback chain (live → saved fixture →
  // our own model). champion/runner-up come straight from the feed's 10k-run
  // figures; only the third-place playoff and the deep fallback are ours.
  const fixturePath = path.join(repoRoot, "sim", "fixtures", "wc2026.json");
  const { feed, source, raw: liveRaw } = await loadOfficialFeed(fixturePath, today);
  const TD = feed ? feed.team_data : M.TEAM_DATA_FALLBACK;
  const sourceUpdated = feed ? (feed.generated ?? null) : null;

  // Auto-refresh the on-disk fixture from every successful live fetch so the
  // backup is never more than a day old (the workflow commits it alongside the
  // odds). git history keeps the daily snapshots.
  if (source === "sports4cast-live" && liveRaw) {
    try { fs.writeFileSync(fixturePath, liveRaw); console.log("Refreshed sim/fixtures/wc2026.json from live feed"); }
    catch (e) { console.warn("Could not refresh fixture: " + e.message); }
  }

  const teams = Object.keys(TD);
  if (teams.length !== 48) throw new Error("Expected 48 teams, got " + teams.length);
  const groupTeams = {};
  for (const g of M.GROUPS) groupTeams[g] = teams.filter(t => TD[t].group === g);
  for (const g of M.GROUPS) if (groupTeams[g].length !== 4)
    throw new Error(`Group ${g} has ${groupTeams[g].length} teams`);

  if (!teams.some(t => TD[t].p3q != null))
    console.warn("WARNING: feed has no p3q — third-place qualification falling back to p3 (legacy data)");

  const tally = Object.fromEntries(teams.map(t =>
    [t, { r32: 0, r16: 0, qf: 0, sf: 0, f: 0, win: 0, runnerUp: 0, third: 0 }]));
  // third-place R32 slot tally: { r32_id: { team: count } } for slots that take a third
  const thirdSlotIds = Object.entries(M.R32_SLOT_DEFS)
    .filter(([, d]) => d.a.third || d.b.third).map(([sid]) => sid);
  const slotTally = Object.fromEntries(thirdSlotIds.map(sid => [sid, {}]));
  // With a feed, only the GROUP STAGE is sampled (for the third-slot hover dist);
  // champion/runner-up/stages come from the feed and the predicted bracket from
  // chances.win, so the knockouts are never simulated. The full Monte Carlo runs
  // ONLY in deep fallback, where the Elo model is all we have.
  if (feed) {
    for (let i = 0; i < SIMS; i++) sampleThirdSlots(M, TD, groupTeams, slotTally);
  } else {
    for (let i = 0; i < SIMS; i++) simulateOnce(M, TD, groupTeams, tally, slotTally);
  }

  const modal = modalScenario(M, TD, groupTeams);

  const pct = n => +(n / SIMS * 100).toFixed(2);
  const sortedPctMap = key => Object.fromEntries(
    teams.map(t => [t, pct(tally[t][key])]).sort((a, b) => b[1] - a[1]));

  // R32 third-slot distribution: raw Monte-Carlo counts, then raked to the p3q
  // marginals so each team's slot-total matches its qualification probability.
  const rawSlotDists = Object.fromEntries(Object.entries(slotTally).map(([sid, counts]) =>
    [sid, Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, n / SIMS]))]));
  const thirdSlotDists = rakeSlotDists(rawSlotDists, TD);

  // Headline outputs. With an official feed (live or fixture) champion/runner-up
  // are the feed's own 10k-run figures and third is the one-match playoff model;
  // stages mirror the official exit-stage chances. Only in deep fallback do the
  // Monte-Carlo tallies above drive the headline numbers.
  let champion, runnerUp, third, stages, method, sourceSims;
  if (feed) {
    const officialMap = key => Object.fromEntries(
      teams.map(t => [t, +(feed.team_data[t].chances[key] ?? 0).toFixed(2)])
        .sort((a, b) => b[1] - a[1]));
    const sfByTeam = Object.fromEntries(teams.map(t => [t, feed.team_data[t].chances.sf ?? 0]));
    const thirdByTeam = thirdPlaceModel(M, TD, groupTeams, sfByTeam);
    champion = officialMap("win");
    runnerUp = officialMap("final");
    third = Object.fromEntries(Object.entries(thirdByTeam).sort((a, b) => b[1] - a[1]));
    stages = Object.fromEntries(teams.map(t => {
      const c = feed.team_data[t].chances;
      return [t, { group: c.group, r32: c.r32, r16: c.r16, qf: c.qf, sf: c.sf,
                   final: c.final, win: c.win, runnerUp: c.final, third: thirdByTeam[t] ?? 0 }];
    }));
    sourceSims = feed.num_sims ?? null;
    method = "Champion, runner-up & every stage are the official Sports4cast 10,000-run figures (chances.*); the predicted bracket and modal podium advance each knockout by the feed's reach-next-round probability (the per-match odds Sports4cast shows, derived from the chances exit-distribution), so the champion is the feed's predicted winner; the third-place playoff is the only match we model ourselves — a one-match Elo tie between the two semi-final losers; modal = the single most-likely playthrough, matching the wall chart's autosim";
  } else {
    champion = sortedPctMap("win");
    runnerUp = sortedPctMap("runnerUp");
    third = sortedPctMap("third");
    stages = Object.fromEntries(teams.map(t => [t, {
      r32: pct(tally[t].r32), r16: pct(tally[t].r16), qf: pct(tally[t].qf),
      sf: pct(tally[t].sf), f: pct(tally[t].f), win: pct(tally[t].win),
      runnerUp: pct(tally[t].runnerUp), third: pct(tally[t].third),
    }]));
    sourceSims = null;
    method = "Live feed unavailable beyond the staleness window — full Monte Carlo over the official bracket off the wall chart's snapshot; groups from p1-p4 marginals, knockouts from the Elo model; modal = single most-likely playthrough";
  }

  const out = {
    generated: new Date().toISOString(),
    seed: SEED, sims: SIMS, source, source_updated: sourceUpdated, source_sims: sourceSims,
    method,
    team_data: TD,
    elo_data: M.ELO ?? null,
    champion,
    runnerUp,
    third,
    modal,
    // Provisional wooden-spoon watch (not a forecast — see spoonWatch); only the
    // ranking inputs the feed actually carries, flagged not-final until ~27 Jun.
    spoon: feed ? spoonWatch(feed, today)
                : { final: false, pick: null, candidates: [],
                    note: "Live data unavailable — spoon watch needs official group points." },
    stages,
    // R32 third-place slot distribution: { r32_id: { team: prob 0-1 } }, raked so
    // each team's slot-total equals its p3q — aligned with the qualification section.
    third_slot_dists: thirdSlotDists,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`sims=${SIMS} seed=${SEED} source=${source}`);
  for (const key of ["champion", "runnerUp", "third"]) {
    const sum = Object.values(out[key]).reduce((s, v) => s + v, 0);
    console.log(`${key} total = ${sum.toFixed(2)}% (must be 100)`);
    if (Math.abs(sum - 100) > 0.5) throw new Error(key + " probabilities do not sum to 100");
  }
  console.log(`modal podium: 1st ${modal.champion}, 2nd ${modal.runnerUp}, 3rd ${modal.third}`);
  console.log("top 8:", Object.entries(out.champion).slice(0, 8)
    .map(([t, v]) => `${t} ${v}%`).join(", "));
}

main().catch(e => { console.error("SIM FAILED:", e.message); process.exit(1); });
