// Saints CC sweepstake — Sports4cast proxy
// The API key lives ONLY in the Netlify environment variable SPORTS4CAST_KEY.
// Responses are CDN-cached until the next 06:30 UK time (data refreshes upstream at ~04:00).

const UPSTREAM = "https://sports4cast-api-oxtgcqhyuq-nw.a.run.app";

// Closed allowlist — this is a proxy to three known endpoints, not an open relay.
const ROUTES = {
  chances:  "/wc2026/chances",
  fixtures: "/fixtures",
  rankings: "/rankings",
};

export default async (req) => {
  const url = new URL(req.url);
  const name = url.pathname.replace(/\/+$/, "").split("/").pop();
  const path = ROUTES[name];
  if (!path) {
    return Response.json({ error: "Unknown endpoint" }, { status: 404 });
  }

  const key = process.env.SPORTS4CAST_KEY;
  if (!key) {
    // Never echo anything about the key itself.
    return Response.json({ error: "Server not configured" }, { status: 500 });
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + path, { headers: { "x-api-key": key } });
  } catch {
    return Response.json({ error: "Upstream unreachable" }, { status: 502 });
  }
  if (!upstream.ok) {
    // Deliberately generic: no upstream status bodies that might leak details.
    return Response.json({ error: "Upstream error", status: upstream.status }, { status: 502 });
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Browsers always revalidate with the CDN; the CDN holds it until next 06:30 UK.
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": `public, s-maxage=${secondsToNext630London()}, stale-while-revalidate=3600`,
    },
  });
};

function secondsToNext630London() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const [h, m, s] = fmt.format(now).split(":").map(Number);
  const sinceMidnight = h * 3600 + m * 60 + s;
  const target = 6 * 3600 + 30 * 60; // 06:30 London wall clock
  let diff = target - sinceMidnight;
  if (diff <= 0) diff += 24 * 3600;
  return Math.max(diff, 60);
}

export const config = { path: "/api/*" };
