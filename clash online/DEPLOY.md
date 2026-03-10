# 🚀 CLASH — Deploy Guide for CrazyGames.com

## Architecture Overview

```
Players (Browser)
     │  WebSocket (Socket.io)
     ▼
Node.js Server (Express + Socket.io)
  ├── Matchmaking Queue
  ├── Game Rooms
  ├── ELO Engine
  └── Leaderboard (in-memory)
```

---

## STEP 1 — Deploy the Server (Free Options)

### Option A: Render.com (RECOMMENDED — Free tier works great)
1. Push your project to GitHub
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Name**: clash-rps
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
5. Click **Deploy** → You get a URL like `https://clash-rps.onrender.com`

### Option B: Railway.app
1. Go to https://railway.app → New Project → Deploy from GitHub
2. It auto-detects Node.js
3. Set env var: `PORT=3000`
4. Click Deploy → Get URL like `https://clash-rps.up.railway.app`

### Option C: Fly.io (Best performance, free tier available)
```bash
npm install -g flyctl
fly auth login
fly launch          # Follow prompts, it creates fly.toml auto
fly deploy
```

---

## STEP 2 — Update the Frontend

After deploying, update ONE line in `public/index.html`:

```javascript
// Change this line (~line 5 of <script>):
const SERVER_URL = window.location.origin;
// To your deployed URL:
const SERVER_URL = 'https://clash-rps.onrender.com';
```

(If frontend is served FROM the same server, leave as `window.location.origin` — it already works!)

---

## STEP 3 — Submit to CrazyGames.com

### Prepare for CrazyGames SDK (Optional but recommended for ads/score)
Add to `public/index.html` head:
```html
<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>
```

Then add after socket connects:
```javascript
// Init CrazyGames SDK
window.CrazyGames?.SDK?.init();

// Show ad between matches (before queue):
async function joinQueue() {
  try { await window.CrazyGames?.SDK?.ad?.requestAd('midgame'); } catch(e){}
  // ... rest of joinQueue
}

// Happy time (when player wins)
function showGameOver(data) {
  if (iWon) window.CrazyGames?.SDK?.game?.happytime();
  // ... rest of showGameOver
}
```

### CrazyGames Submission Steps:
1. Go to https://developer.crazygames.com
2. Create Developer Account
3. Submit new game:
   - **Category**: Multiplayer / Casual
   - **Tags**: rock-paper-scissors, multiplayer, competitive, online
   - **Description**: Focus on "real players", "ELO ranking", "addictive"
4. Upload your game (zip of `public/` folder, or provide URL)
5. Review takes 1-2 weeks

---

## STEP 4 — Make it More Addictive (Retention Features)

### Add Daily Challenge (Bonus code to add to server.js)
```javascript
// Daily challenge: "Win 5 in a row today!"
let dailyChallenge = { type: 'streak', target: 5, reward: 50 };
```

### Add to frontend for returning players:
```javascript
// Check daily streak in localStorage
const lastPlayed = localStorage.getItem('clash_lastPlayed');
const today = new Date().toDateString();
if (lastPlayed !== today) {
  showToast('🎯 Daily Challenge: Win 5 in a row for +50 ELO!', '#ffd700');
  localStorage.setItem('clash_lastPlayed', today);
}
```

---

## STEP 5 — Scale Up (When you get traffic)

### Replace in-memory with Redis + PostgreSQL:
```bash
npm install ioredis pg
```

```javascript
// server.js — replace Maps with Redis
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

// Store leaderboard:
await redis.zadd('leaderboard', elo, playerId);
// Get top 20:
const top = await redis.zrevrange('leaderboard', 0, 19, 'WITHSCORES');
```

### Environment Variables to set on your host:
```
PORT=3000
NODE_ENV=production
REDIS_URL=redis://...        (if using Redis)
DATABASE_URL=postgresql://...  (if using PostgreSQL)
```

---

## Project File Structure

```
clash-online/
├── server.js          ← Node.js + Socket.io backend
├── package.json       ← Dependencies
├── render.yaml        ← Render.com auto-deploy config
└── public/
    └── index.html     ← Complete frontend (HTML + CSS + JS)
```

---

## Quick Test Locally

```bash
cd clash-online
npm install
node server.js
# Open http://localhost:3000 in TWO browser tabs
# Both players connect → matchmaking → play!
```

---

## Addiction Features Already Built In

| Feature | Effect |
|---------|--------|
| ELO ranking system | Players want to climb (Bronze → Legend) |
| Live online count | Social proof — "others are playing!" |
| Rank-up celebration | Dopamine hit on promotion |
| Rematch system | "Best of 5? Go again!" |
| Taunt system | Social engagement, rivalry |
| Combo streaks | Streak bonus = keep playing |
| Fast matchmaking | No friction, instant games |
| History chips | Visual progress in each session |

---

## Estimated CrazyGames Revenue (once live)

- CPM on CrazyGames: ~$3-8 per 1000 ad views
- Each game = 1 midgame ad (~30s)
- 100 daily players × 5 games = 500 ads/day = ~$1.50-4/day
- Goal: 1000+ DAU = $15-40/day passively

*Focus on: fast matches, rematch loop, and rank climbing to maximize session length*
