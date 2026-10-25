# Who Will You Follow? 你會跟隨誰？

Mobile web game, page 1: the player welcome screen.

Plain static site (no build step): `index.html`, `css/style.css`, `assets/img/`.
Netlify publishes the repo root (`netlify.toml`).

Local preview: `python3 -m http.server 8000`, then open http://localhost:8000

- **開始** → `/play` (not built yet)
- **進入角色選擇** → `/characters` (placeholder)

Layout is drawn on a 576×1024 design grid (container query units) and scales to any portrait phone;
on tablets and desktops a content-aware widened version of the artwork (`assets/img/scene-wide-*.webp`) fills the full width.
