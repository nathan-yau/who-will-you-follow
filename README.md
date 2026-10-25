# Who Will You Follow? 你會跟隨誰？

Mobile web game, page 1: the player welcome screen.

Plain static site (no build step): `index.html`, `css/style.css`, `assets/img/`.
Netlify publishes the repo root (`netlify.toml`).

Local preview: `python3 -m http.server 8000`, then open http://localhost:8000

- **角色選擇** → `characters/` (relative link, page not built yet)

Layout: the original 576×1024 composition is always fully visible ("contain", scaled by
`min(width/576, height/1024)`), and the rest of the screen is covered by the same artwork extended
outward on every side (`assets/img/scene-<width>.webp`, content-aware seam insertion; the narrowest
one that covers the screen is picked per aspect ratio). The page never scrolls.
Asset URLs carry `?v=N` for cache-busting; bump it on each visual change.
