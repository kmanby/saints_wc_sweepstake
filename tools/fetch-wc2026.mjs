#!/usr/bin/env node
// Saints CC sweepstake — capture a real Sports4cast wc2026.json
//
// Why: we have never confirmed the live schema (roadmap item #1). This grabs a
// real payload so we can pin the field names — team_data, chances
// {r32,r16,qf,sf,final,win}, p1-p4, p3q, pts, r32_opp, num_sims, generated,
// elo_data — BEFORE building the official-sim integration. Joining on a wrong
// team string silently yields 0%, so we build against a confirmed response.
//
// It replicates the two-step signed-URL fetch sim/simulate.mjs already uses:
//   1. GET the signed-URL map for the requested file key(s)  (URLs ~60s lived)
//   2. immediately GET the signed URL it hands back
//
// Run it somewhere with network access to sports4cast.com — NOT the Claude
// sandbox, which is egress-blocked from that host — then upload the JSON.
//
// Usage (Node 18+):
//   node tools/fetch-wc2026.mjs                        # -> ./wc2026.json
//   node tools/fetch-wc2026.mjs out.json               # custom outfile
//   node tools/fetch-wc2026.mjs caps.json wc2026 squad_values
//
// If it fails with 401/403 (referer/cookie gating), use the browser-console
// fallback: open https://sports4cast.com in a tab and run the same two fetches
// there so its session cookie applies (see chat).

import { writeFile } from "node:fs/promises";

const SIGN_ENDPOINT = "https://sports4cast.com/wp-json/football/v1/signed-urls";

const argv = process.argv.slice(2);
const OUT = argv[0] && argv[0].endsWith(".json") ? argv[0] : "wc2026.json";
const KEYS = (argv[0] && argv[0].endsWith(".json") ? argv.slice(1) : argv)
  .filter((k) => /^[a-z0-9_-]+$/i.test(k));
if (KEYS.length === 0) KEYS.push("wc2026");

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts });
  if (r.status === 429) throw new Error("429 rate-limited — wait ~60s and retry");
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return r.text();
}

// Print just enough of the shape to confirm the schema at a glance.
function summarise(name, raw) {
  let d;
  try { d = JSON.parse(raw); }
  catch { console.log(`  (${name}: ${raw.length} bytes, not valid JSON?)`); return; }
  console.log(`  top-level keys: ${Object.keys(d).join(", ")}`);
  if (d.generated != null) console.log(`  generated: ${d.generated}`);
  if (d.num_sims != null)  console.log(`  num_sims:  ${d.num_sims}`);
  const td = d.team_data;
  if (td && typeof td === "object") {
    const teams = Object.keys(td);
    const sample = teams.find((t) => td[t] && td[t].chances) || teams[0];
    console.log(`  team_data: ${teams.length} teams`);
    if (sample) console.log(`  sample "${sample}": ${JSON.stringify(td[sample])}`);
  }
  if (d.elo_data && typeof d.elo_data === "object")
    console.log(`  elo_data: ${Object.keys(d.elo_data).length} entries`);
}

async function main() {
  const qs = KEYS.map((k) => "files[]=" + encodeURIComponent(k)).join("&");
  console.log(`→ requesting signed URLs for: ${KEYS.join(", ")}`);

  const signRaw = await fetchText(`${SIGN_ENDPOINT}?${qs}`, {
    headers: {
      referer: "https://sports4cast.com/",
      "user-agent": "saints-wc-sweepstake/fetch-wc2026",
    },
  });
  let signMap;
  try { signMap = JSON.parse(signRaw); }
  catch { throw new Error(`signed-URL endpoint returned non-JSON: ${signRaw.slice(0, 200)}`); }

  let wrote = 0;
  for (const k of KEYS) {
    const url = signMap[k];
    if (!url) {
      console.error(`✗ no signed URL for "${k}" (returned keys: ${Object.keys(signMap).join(", ") || "none"})`);
      continue;
    }
    const raw = await fetchText(url); // signed GCS URL: no auth/headers needed
    const outfile = KEYS.length === 1 ? OUT : `${k}.json`;
    await writeFile(outfile, raw);
    console.log(`✓ ${k} → ${outfile} (${raw.length.toLocaleString()} bytes)`);
    summarise(k, raw);
    wrote++;
  }
  if (!wrote) process.exit(1);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
