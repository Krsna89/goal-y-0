# Goal-y-o (formerly Gratyent-lite)

A stripped-down rebuild: two daily habit taps, a weekly weigh-in, and one nominated person who can see your streak and send encouragement. No accounts beyond name+email, no forms, no build step.

Fully self-contained — plain Node.js + built-in SQLite (`node:sqlite`), vanilla HTML/JS frontend. No `npm install` needed.

## Run it

Requires Node.js 22.5+ (for built-in SQLite support).

```
node server.js
```

Then open http://localhost:3000

Data is stored in `gratyent.db` (created automatically next to `server.js`) — that file is your whole database. Back it up or delete it to reset.

## Testing the two-person flow on one computer

Since accountability needs two identities, use two browser contexts at once — e.g. a normal window signed in as the person building habits, and an incognito/private window for the nominated partner. On the home screen, tap "Invite someone," copy the link, and open it in the second window.

## Getting it in front of your brother-in-law and his wife (long-term testing)

For real, ongoing testing — where the data needs to survive for weeks, not just a demo — use Render.com's paid Starter tier with a persistent disk (~$7–8/month total). Free hosting tiers (Render free, Fly.io, Glitch) either got discontinued or wipe local files on every restart, which would silently delete their habit data. This path uses the app exactly as-is, no code changes beyond what's already here.

**1. Put the code on GitHub (no git command line needed):**
- Go to github.com, sign in (or create a free account), click "New repository," name it `gratyent-lite`, create it.
- On the new repo's page, click "uploading an existing file," then drag in every file from this folder (`server.js`, `db.js`, `package.json`, the `public` folder, this `README.md`) — but **not** `gratyent.db`, that's your local data file, not code. Commit.

**2. Create the Render service:**
- Go to render.com, sign up (you can sign in with your GitHub account directly).
- New → Web Service → connect the `gratyent-lite` repo you just created.
- Runtime: Node. Build command: leave blank. Start command: `node server.js`.
- Choose the Starter plan (paid tier — needed for the persistent disk option).

**3. Add a persistent disk:**
- In the service's settings, add a Disk. Give it a mount path like `/var/data`.
- Add an environment variable: `DB_PATH` = `/var/data/gratyent.db`.
- Deploy.

Render will give you a URL like `https://gratyent-lite.onrender.com` — that's what you text or WhatsApp to your brother-in-law and his wife. It'll stay up and keep their data, independent of your own computer being on.

## What's deliberately not here

No wheel-of-life, no journal, no AI coach chat, no SMART-goal forms. Just the loop: tap a habit, see a streak, someone notices if you go quiet. Everything else from the original build was cut so feedback tells you whether *this* works before you add anything back.
