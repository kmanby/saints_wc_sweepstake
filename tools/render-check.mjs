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

async function checkIndex() {
  console.log("\nindex.html");
  const { dom, errors, doc } = await loadPage("/");
  check("no page JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const rows = doc.querySelectorAll("#chartRows .crow");
  check("odds chart rendered (33 people)", rows.length === 33, `${rows.length} rows`);

  const src = doc.getElementById("oddsSrc")?.textContent || "";
  check("odds source is the daily sim", /Monte Carlo/.test(src), src.trim());
  check("no unmatched-team warning", !/unmatched/.test(src), src.trim());

  const grid = doc.querySelectorAll("#flagGrid .nation");
  check("48 nation tiles", grid.length === 48, `${grid.length}`);

  const iframe = doc.getElementById("wallchartFrame");
  check("wallchart iframe src", iframe?.getAttribute("src") === "wallchart.html",
    iframe?.getAttribute("src"));

  dom.window.close();
}

async function checkWallchart() {
  console.log("\nwallchart.html");
  const { dom, errors, doc } = await loadPage("/wallchart.html");
  check("no page JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const groupCards = doc.querySelectorAll(".gc");
  check("12 group cards", groupCards.length === 12, `${groupCards.length}`);

  const matchCards = doc.querySelectorAll("[data-matchid]");
  check("31 knockout match cards", matchCards.length === 31, `${matchCards.length}`);

  const champ = doc.getElementById("champBox")?.textContent?.trim() || "";
  check("champion box populated (autosim)", champ.length > 0 && !/TBD/.test(champ), champ);

  dom.window.close();
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

await checkIndex();
await checkWallchart();
await checkDraw();

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
