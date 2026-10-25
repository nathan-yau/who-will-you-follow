# Who Will You Follow? 你會跟隨誰？

Mobile web game, page 1: the player welcome screen.

Plain static site (no build step): `index.html`, `css/style.css`, `assets/img/`.
Netlify publishes the repo root (`netlify.toml`).

Local preview: `python3 -m http.server 8000`, then open http://localhost:8000

- **角色選擇** → `characters/` (relative link, page not built yet)

Layout: the original 576×1024 composition is always fully visible ("contain", scaled by
`min(width/576, height/1024)`), and the rest of the screen is covered by the same artwork extended
outward on every side (`assets/img/scene-<width>.webp`, content-aware seam insertion; the narrowest
one that covers the screen is picked per aspect ratio). Below the original bushes the canvas
continues with the bushes' rounded bases sitting on the meadow, and `assets/img/ground.png`
(meadow + grass tufts, tiled) fills the rest down to the physical bottom of the screen
(100lvh, i.e. also under iOS Safari's translucent toolbars).
No element is `position: fixed` (iOS 26 Safari would paint that element's background colour
behind its toolbars instead of the artwork); the page never scrolls (`overflow: hidden` on
html/body plus a touch/scroll lock script).
Asset URLs carry `?v=N` for cache-busting; bump it on each visual change.

## Page 2 — Character Select (`characters/`)

- `characters/index.html`, `css/characters.css`, `js/characters.js` (cache-bust `?v=6`).
- Characters are rendered from `data/characters.json` (`{"characters":[{"id","name","tagline"}]}`);
  images come from the id: `assets/characters/<id>/stale1.webp` / `stale2.webp` (idle loop).
  Add/remove entries freely — thumbnail pages = ceil(n / 5).
- Selection is saved in `localStorage["wwyf.character"]`; 「加入遊戲」 goes to `../join/`.
- Same background treatment as page 1 (page-1 artwork on top, bushes + meadow to the physical
  bottom, no `position: fixed`, no scrolling), laid out on a 474 x 1024 grid scaled to fit.

## Backend (Netlify)

The real app runs on **https://who-will-you-follow.netlify.app/** (GitHub Pages stays a static preview that talks to the same backend via CORS).

| Page | URL |
|---|---|
| Player start | `/` |
| Character select | `/characters/` |
| Waiting room | `/lobby/` |
| Host dashboard | `/admin/` |

* `netlify/functions/api.mjs` – one Functions v2 handler mounted at `/api/*`, state in Netlify Blobs (store `wwyf-game`, strong consistency). One game at a time; characters are claimed with `onlyIfNew` so a character can never be taken twice.
* Environment variables (set in Netlify, never in this repo): `ADMIN_PASSWORD` (host PIN), `SESSION_SECRET` (HMAC key for 12 h admin sessions).
* Failed admin logins are rate-limited: 5 per IP / 10 min → 10 min lockout; 30 overall / 10 min → 5 min lockout.

### API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/lobby` | anyone | `{gameId, taken[], joined, capacity}` – no roles |
| POST | `/api/join` | player | `{characterId, nickname?}` → `{player, token}`; send `X-Player-Id`/`X-Player-Token` to reconnect or switch character; `409 taken` |
| GET | `/api/me` | player | own status (`assigned` flag; role only after reveal) |
| POST | `/api/heartbeat` | player | keep-alive |
| POST | `/api/admin/login` | host | `{password}` → `{token}` (send as `X-Admin-Token`) |
| GET | `/api/admin/state` | host | players, online, roles, counts, archive list |
| POST | `/api/admin/role` | host | `{playerId, role\|null, leader?}` (limits enforced, leaders A–D) |
| POST | `/api/admin/random` | host | random roles, 4 leaders get A–D |
| POST | `/api/admin/clear-roles` | host | |
| POST | `/api/admin/kick` | host | `{playerId}` |
| POST | `/api/admin/reset` | host | archive current game, start a new empty one |
| GET | `/api/admin/archive?key=` | host | archived game |
| POST | `/api/admin/config` | host | `{roles:{…}}` role counts |
| POST | `/api/admin/reveal` | host | `{revealed}` (no UI yet) |

Default roles (17): 真正領袖 1 · 假領袖 3 · 真領袖支持者 1 · 假領袖支持者 2 · 平民 10.

Deploy: `npm i && netlify deploy --prod`.
