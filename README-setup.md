# Saints CC World Cup Tracker — deploy guide

## What's in here
- `site/` — the static pages (index.html = tracker, draw.html = draw machine)
- `netlify/functions/sports4cast.mjs` — the API proxy (key stays server-side)
- `netlify.toml` — tells Netlify where everything lives

## One-time setup
1. **Rotate the Sports4cast key first.** The old one has been shared in chat — treat it as burned.
2. Create a GitHub repo (private is fine) and push this folder to it:
   ```
   git init && git add -A && git commit -m "Saints WC tracker"
   git remote add origin git@github.com:YOURUSER/saints-wc-tracker.git
   git push -u origin main
   ```
   (Or upload the folder via GitHub's web UI.)
3. In Netlify: **Add new site → Import an existing project → GitHub** → pick the repo.
   Build settings are read from netlify.toml automatically (no build command needed).
4. In Netlify: **Site configuration → Environment variables → Add variable**
   - Key: `SPORTS4CAST_KEY`
   - Value: your NEW rotated key
   - Scope: Functions
5. Deploy. Every future `git push` redeploys automatically — this is the GitHub connection.

## Test it
```
curl https://YOUR-SITE.netlify.app/api/chances
```
You should get the WC2026 chances JSON back — with no key anywhere in your pages or repo.
Also available: `/api/fixtures` and `/api/rankings`.

## Notes
- **Netlify Drop (drag-and-drop) does NOT support functions** — git deploy or `netlify deploy` CLI only.
- Responses are CDN-cached until the next 06:30 UK, so Sports4cast sees ~1 call/day.
- Local development: `netlify dev` with a `.env` file containing `SPORTS4CAST_KEY=...`
  (`.env` is gitignored — never commit it).
