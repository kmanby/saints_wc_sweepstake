#!/usr/bin/env node
// Saints CC sweepstake — daily tournament Monte Carlo
//
// Simulates the full World Cup N times and writes site/data/daily-sim.json,
// which drives the odds leaderboard (and anything else that wants stage
// probabilities). Run by GitHub Action each morning, or manually:
//   node sim/simulate.mjs [--sims 10000] [--seed 20260612]
//
// Single source of truth: the model functions (Elo table, win probability,
// co-host boost, bracket slots, third-place allocation table) are extracted
// at runtime from site/wallchart.html, so the sim can never drift from the
// wall chart users see.
//
// Honest approximations:
// - Group finishing orders are sampled sequentially from Sports4cast's daily
//   p1–p4 marginals (1st from p1; 2nd from renormalised p2 among the rest...).
//   This respects the marginals approximately, not the full joint.
// - Which 8 of the 12 third-placed teams qualify is sampled weighted by Elo
//   (stronger thirds more likely through), then routed to bracket slots with
//   the official FIFA allocation table. Knockouts have no draws: winProb is
//   the probability of advancing.

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

// 8 of 12 thirds qualify, weighted by Elo (Efraimidis–Spirakis without replacement)
function sampleQualifyingThirds(thirdByGroup, effElo) {
  const entries = Object.entries(thirdByGroup).map(([g, team]) => {
    const w = Math.exp(effElo(team) / 120);
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
function simulateOnce(M, TD, groupTeams, tally) {
  const first = {}, second = {}, third = {};
  for (const g of M.GROUPS) {
    const [a, b, c] = sampleGroupOrder(groupTeams[g], TD);
    first[g] = a; second[g] = b; third[g] = c;
  }

  const qualGroups = sampleQualifyingThirds(third, M.effElo);
  const comboKey = qualGroups.join("");
  const thirdMap = M.THIRD_COMBOS[comboKey];
  if (!thirdMap) throw new Error("No third-place combo for " + comboKey);

  const resolveSide = makeResolveSide(first, second, third, thirdMap);

  const winners = {};

  for (const [sid, def] of Object.entries(M.R32_SLOT_DEFS)) {
    const A = resolveSide(def, "a"), B = resolveSide(def, "b");
    if (!A || !B) throw new Error("Unresolved R32 side in " + sid);
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

// ---------- the single most-likely playthrough ----------
// Mirrors the wall chart's autosim exactly: groups ranked by p1, best 8
// thirds by p3, every knockout match (and the playoff) to the favourite —
// so the index chart's "simulated draw" matches the pre-filled wall chart.
function modalScenario(M, TD, groupTeams) {
  const first = {}, second = {}, third = {};
  for (const g of M.GROUPS) {
    const ranked = [...groupTeams[g]].sort((a, b) => TD[b].p1 - TD[a].p1);
    first[g] = ranked[0]; second[g] = ranked[1]; third[g] = ranked[2];
  }

  const qualGroups = M.GROUPS
    .map(g => ({ g, p: TD[third[g]].p3 }))
    .sort((a, b) => b.p - a.p).slice(0, 8).map(e => e.g).sort();
  const thirdMap = M.THIRD_COMBOS[qualGroups.join("")];
  if (!thirdMap) throw new Error("No third-place combo for modal scenario");

  const resolveSide = makeResolveSide(first, second, third, thirdMap);
  const favourite = (A, B) => M.winProb(A, B) >= 0.5 ? A : B;

  const winners = {};
  for (const [sid, def] of Object.entries(M.R32_SLOT_DEFS)) {
    winners[sid] = favourite(resolveSide(def, "a"), resolveSide(def, "b"));
  }
  for (const [mid, [fa, fb]] of Object.entries(M.FEEDERS)) {
    winners[mid] = favourite(winners[fa], winners[fb]);
  }
  return podium(winners, M, favourite);
}

// ---------- main ----------
async function main() {
  const repoRoot = process.cwd();
  const wallchartPath = path.join(repoRoot, "site", "wallchart.html");
  const outPath = path.join(repoRoot, "site", "data", "daily-sim.json");

  const M = extractModel(wallchartPath);

  // live daily data, with the wall chart's embedded snapshot as fallback
  // Two-step: get a 60-second signed URL, then fetch the actual data
  let TD = M.TEAM_DATA_FALLBACK, source = "fallback-snapshot", sourceUpdated = null;
  try {
    const sigR = await fetch(SIGNED_URL_ENDPOINT, { signal: AbortSignal.timeout(10000) });
    if (sigR.ok) {
      const sigD = await sigR.json();
      const signedUrl = sigD.wc2026;
      if (signedUrl) {
        const r = await fetch(signedUrl, { signal: AbortSignal.timeout(15000) });
        if (r.ok) {
          const d = await r.json();
          if (d && d.team_data) {
            TD = d.team_data;
            source = "sports4cast-live";
            sourceUpdated = d.updated ?? d.last_updated ?? null;
          }
        }
      }
    }
  } catch { /* fallback stands */ }

  const teams = Object.keys(TD);
  if (teams.length !== 48) throw new Error("Expected 48 teams, got " + teams.length);
  const groupTeams = {};
  for (const g of M.GROUPS) groupTeams[g] = teams.filter(t => TD[t].group === g);
  for (const g of M.GROUPS) if (groupTeams[g].length !== 4)
    throw new Error(`Group ${g} has ${groupTeams[g].length} teams`);

  const tally = Object.fromEntries(teams.map(t =>
    [t, { r32: 0, r16: 0, qf: 0, sf: 0, f: 0, win: 0, runnerUp: 0, third: 0 }]));
  for (let i = 0; i < SIMS; i++) simulateOnce(M, TD, groupTeams, tally);

  const modal = modalScenario(M, TD, groupTeams);

  const pct = n => +(n / SIMS * 100).toFixed(2);
  const sortedPctMap = key => Object.fromEntries(
    teams.map(t => [t, pct(tally[t][key])]).sort((a, b) => b[1] - a[1]));
  const out = {
    generated: new Date().toISOString(),
    seed: SEED, sims: SIMS, source, source_updated: sourceUpdated,
    method: "Monte Carlo over official bracket; groups from Sports4cast p1-p4 marginals; knockouts (incl. third-place playoff) from wall-chart Elo model; modal = single most-likely playthrough, matching the wall chart's autosim",
    team_data: TD,
    elo_data: M.ELO ?? null,
    champion: sortedPctMap("win"),
    runnerUp: sortedPctMap("runnerUp"),
    third: sortedPctMap("third"),
    modal,
    stages: Object.fromEntries(teams.map(t => [t, {
      r32: pct(tally[t].r32), r16: pct(tally[t].r16), qf: pct(tally[t].qf),
      sf: pct(tally[t].sf), f: pct(tally[t].f), win: pct(tally[t].win),
      runnerUp: pct(tally[t].runnerUp), third: pct(tally[t].third),
    }])),
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
