#!/usr/bin/env node
// Render check — executes each page's JS in jsdom against a running dev
// server (default http://localhost:8888) and reports console/page errors
// plus key DOM assertions. Not a layout test; it catches broken JS, failed
// joins and missing data the way a browser would.
//   npx netlify dev --offline   (in another shell)
//   node tools/render-check.mjs [baseUrl]

import jsdom from "jsdom";
const { JSDOM, VirtualConsole } = jsdom;
// Note: subresources (incl. the wall-chart iframe) are not loaded — jsdom's
// default — which is what we want: the wall chart gets its own standalone
// check, where the beforeParse polyfills can actually reach its window.

const BASE = process.argv[2] || "http://localhost:8888";
let failures = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function loadPage(path) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    // jsdom has no layout/canvas; CSS parse noise is not a page bug
    if (/Could not parse CSS/.test(e.message)) return;
    errors.push(e.message + (e.detail ? ` :: ${e.detail}` : ""));
  });
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // jsdom ships neither fetch, canvas nor document.fonts; pages need all three
      window.fetch = (url, opts) =>
        globalThis.fetch(new URL(url, window.location.href).href, opts);
      window.document.fonts = { ready: Promise.resolve(), addEventListener() {} };
      const ctxStub = new Proxy(function () {}, {
        get: (t, p) => (p === Symbol.toPrimitive ? () => 0 : ctxStub),
        apply: () => ctxStub,
        set: () => true,
      });
      window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
    },
  });
  // let fetch().then chains and timers settle
  await new Promise((r) => setTimeout(r, 2500));
  return { dom, errors, doc: dom.window.document, win: dom.window };
}

async function checkIndex({ sim, sweep }) {
  console.log("\nindex.html");
  const { dom, errors, doc, win } = await loadPage("/");
  check("no page JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const rows = [...doc.querySelectorAll("#chartRows .crow")];
  check("odds chart rendered (33 people)", rows.length === 33, `${rows.length} rows`);

  const src = doc.getElementById("oddsSrc")?.textContent || "";
  check("odds source is the daily sim", /Monte Carlo/.test(src), src.trim());
  check("no unmatched-team warning", !/unmatched/.test(src), src.trim());

  // two-bar mode: every row has both bars; the modal podium holders (derived
  // independently from daily-sim.json + sweepstake.json) lead with medals + £
  check("every row has two bars", rows.every((r) => r.querySelector(".cbar.a") && r.querySelector(".cbar.b")));
  const holderOf = (team) => sweep.tickets.find((t) => t.team === team)?.person;
  const expected = [
    [holderOf(sim.modal.champion), "🏆", "£100"],
    [holderOf(sim.modal.runnerUp), "🥈", "£50"],
    [holderOf(sim.modal.third), "🥉", "£25"],
  ];
  expected.forEach(([person, medal, amount], i) => {
    const row = rows[i];
    const ok = row.querySelector(".nm")?.textContent === person
      && row.querySelector(".cmedal")?.textContent.includes(medal)
      && row.querySelector(".cbar.b .cval")?.textContent === amount;
    check(`row ${i + 1}: ${medal} ${amount} for ${person}`, ok,
      `got ${row.querySelector(".nm")?.textContent} ${row.querySelector(".cmedal")?.textContent} ${row.querySelector(".cbar.b .cval")?.textContent || "no £"}`);
  });
  const paidRows = rows.filter((r) => r.querySelector(".cbar.b .cval"));
  check("£ labels on exactly the podium rows", paidRows.length === new Set(expected.map((e) => e[0])).size,
    `${paidRows.length}`);
  const rest = rows.slice(3);
  const sums = rest.map((r) => parseFloat(r.querySelector(".cbar.a .cval").textContent) || 0);
  check("rest sorted by Bar A desc", sums.every((v, i) => i === 0 || sums[i - 1] >= v));

  const grid = doc.querySelectorAll("#flagGrid .nation");
  check("48 nation tiles", grid.length === 48, `${grid.length}`);

  const iframe = doc.getElementById("wallchartFrame");
  check("wallchart iframe src", iframe?.getAttribute("src") === "wallchart.html",
    iframe?.getAttribute("src"));

  // fun-fact modal pulls from the shared facts.json
  doc.querySelector("#flagGrid .nation").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const fact = doc.getElementById("cardFact")?.textContent || "";
  check("modal fact loaded from facts.json", fact.length > 40 && !/unavailable/.test(fact),
    fact.slice(0, 60) + "…");
  const prob = doc.getElementById("cardProb")?.textContent || "";
  check("modal probability hydrated", /Win probability: .+%/.test(prob), prob);

  dom.window.close();
}

async function checkWallchart() {
  console.log("\nwallchart.html");
  const { dom, errors, doc, win } = await loadPage("/wallchart.html");
  check("no page JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const groupCards = doc.querySelectorAll(".gc");
  check("12 group cards", groupCards.length === 12, `${groupCards.length}`);

  const matchCards = doc.querySelectorAll("[data-matchid]");
  check("31 knockout match cards", matchCards.length === 31, `${matchCards.length}`);

  const champ = doc.getElementById("champBox")?.textContent?.trim() || "";
  check("champion box populated (autosim)", champ.length > 0 && !/TBD/.test(champ), champ);

  // people-first labels: group rows + bracket rows carry owner names, not countries
  const tnTexts = [...doc.querySelectorAll(".tn .tn-own")].map((e) => e.textContent);
  check("group rows labelled by owner", tnTexts.length === 48 && tnTexts.includes("Benjy Briant"),
    `${tnTexts.length} rows, sample: ${tnTexts[0]}`);
  const mtTexts = [...doc.querySelectorAll(".mt-name")].map((e) => e.textContent.trim());
  const countryLeak = mtTexts.filter((t) => /^(Spain|France|Brazil|Germany|England)$/.test(t));
  check("bracket rows labelled by owner", mtTexts.length > 0 && countryLeak.length === 0,
    countryLeak.length ? `country labels leaked: ${countryLeak.join(",")}` : `${mtTexts.length} rows`);
  check("champion box labelled by owner", /Jamie Briant|wins the £100/.test(champ), champ);

  // wait for the facts/daily-sim fetches to land before exercising the card
  for (let i = 0; i < 20 && win.eval("Object.keys(FACTS).length") === 0; i++)
    await new Promise((r) => setTimeout(r, 250));

  // team card: tapping a bracket flag pins the card without advancing the team
  const aRow = [...doc.querySelectorAll("[data-matchid] .mt")].find((r) => r.querySelector(".info-tap"));
  const before = doc.getElementById("champBox").textContent;
  aRow.querySelector(".info-tap").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const card = doc.querySelector(".team-card");
  check("flag tap pins team card", card?.classList.contains("on") && card?.classList.contains("pinned"));
  const factTxt = card.querySelector(".tc-fact")?.textContent || "";
  check("card shows country + holder + odds + fact",
    /Held by/.test(card.textContent) && /Champion chance/.test(card.textContent) && factTxt.length > 40,
    (card.textContent || "").slice(0, 110).replace(/\s+/g, " "));
  check("flag tap did not advance bracket", doc.getElementById("champBox").textContent === before);

  // tap-to-advance still works: click the final's losing row, champion flips
  const finalCard = doc.querySelector('[data-matchid="final"]');
  const loser = [...finalCard.querySelectorAll(".mt")].find((r) => r.classList.contains("lst"));
  loser.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const after = doc.getElementById("champBox").textContent;
  check("row tap still advances (final flipped)", after !== before, `${before.trim()} -> ${after.trim()}`);

  dom.window.close();
}

async function checkFacts() {
  console.log("\ndata/facts.json");
  const facts = await (await fetch(BASE + "/data/facts.json")).json();
  const sweep = await (await fetch(BASE + "/data/sweepstake.json")).json();
  const entries = Object.values(facts);
  check("48 fact entries", entries.length === 48, `${entries.length}`);
  const sweepCodes = new Set(sweep.tickets.map((t) => t.teamCode));
  const factCodes = new Set(entries.map((e) => e.code));
  const missing = [...sweepCodes].filter((c) => !factCodes.has(c));
  check("codes join sweepstake.json", missing.length === 0, missing.join(","));
  const sim = await (await fetch(BASE + "/data/daily-sim.json")).json();
  const simMissing = Object.keys(sim.champion).filter((t) => !facts[t]);
  check("keys join daily-sim.json teams", simMissing.length === 0, simMissing.join(","));

  for (const key of ["champion", "runnerUp", "third"]) {
    const sum = Object.values(sim[key] || {}).reduce((s, v) => s + v, 0);
    check(`${key}% sums to 100`, Math.abs(sum - 100) < 0.5, sum.toFixed(2));
  }
  const m = sim.modal || {};
  check("modal podium is 3 distinct teams",
    new Set([m.champion, m.runnerUp, m.third]).size === 3 && [m.champion, m.runnerUp, m.third].every((t) => sim.champion[t] !== undefined),
    JSON.stringify(m));
  return { sim, sweep };
}

async function checkDraw() {
  console.log("\ndraw.html");
  const { dom, errors } = await loadPage("/draw.html");
  check("no page JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  dom.window.close();
}

const probe = await fetch(BASE + "/").catch(() => null);
if (!probe || !probe.ok) {
  console.error(`Dev server not reachable at ${BASE} — start it with: npx netlify dev --offline`);
  process.exit(2);
}

const data = await checkFacts();
await checkIndex(data);
await checkWallchart();
await checkDraw();

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
