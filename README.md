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
- Sprite centring in circles: `js/sprite-fit.js` holds a per-character horizontal offset `--dx` (head-weighted visual centre from the stale1 alpha; vote cards, TV leader cards, identity) and the alpha bbox `WWYF_SPRITE_BOX` (mean of both idle frames; the big 你目前選擇 circle centres it exactly). Regenerate after adding or changing art: `python3 tools/sprite-fit.py` (needs Pillow + numpy), then bump its `?v=`.
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
| TV (waiting-room bubble battle / rounds / 身份揭曉 progress) | `/tv/` |
| Identity reveal (phone) | `/identity/` |
| Round vote (phone) | `/vote/` |

* `netlify/functions/api.mjs` – one Functions v2 handler mounted at `/api/*`, state in Netlify Blobs (store `wwyf-game`, strong consistency). One game at a time; characters are claimed with `onlyIfNew` so a character can never be taken twice.
* Environment variables (set in Netlify, never in this repo): `ADMIN_PASSWORD` (host PIN), `SESSION_SECRET` (HMAC key for 12 h admin sessions), optional `ABLY_API_KEY` (即時連線, see below).
* Failed admin logins are rate-limited: 5 per IP / 10 min → 10 min lockout; 30 overall / 10 min → 5 min lockout.

### API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/lobby` | anyone | `{gameId, taken[], joined, capacity}` – no roles |
| POST | `/api/join` | player | `{characterId, nickname?}` → `{player, token}`; send `X-Player-Id`/`X-Player-Token` to reconnect or switch character; `409 taken` |
| GET | `/api/me` | player | own status (`assigned` flag; `phase` lobby/started; `screen`; once revealed: `role`, `supports:{characterId}\|null` (假領袖支持者; no leader letter), `helped` (假領袖), `seen`; on a round screen `round:{screen, leaders, speak}` + for leaders only `leaderText:{desc, tip}` and `followers:{count\|null}` (own count, null until the vote closes)) |
| POST | `/api/reveal-ack` | player | marks the caller's identity as seen (returns the same role view + `seen:true`); reset whenever their role/pairing/helped changes (a leader-slot change alone does not reset it) |
| POST | `/api/heartbeat` | player | keep-alive |
| POST | `/api/admin/login` | host | `{password}` → `{token}` (send as `X-Admin-Token`) |
| GET | `/api/admin/state` | host | players, online, roles, counts, archive list |
| POST | `/api/admin/role` | host | `{playerId, role\|null, leader?}` (limits enforced; `leader` = internal TV card slot A–D, never displayed) |
| POST | `/api/admin/random` | host | random roles, 4 leaders get internal slots A–D (TV card order/colour only) |
| POST | `/api/admin/clear-roles` | host | |
| POST | `/api/admin/kick` | host | `{playerId}` |
| POST | `/api/admin/reset` | host | archive current game, start a new empty one |
| GET | `/api/admin/archive?key=` | host | archived game |
| POST | `/api/admin/config` | host | `{roles:{…}}` role counts |
| POST | `/api/admin/reveal` | host | `{revealed}` (legacy flag) |
| POST | `/api/admin/reveal-stage` | host | `{on}` start/end the 身份揭曉 stage (start = phase started, `revealed`, TV screen `reveal`, fake pairs synced); `admin/screen {screen:'reveal'}` also starts it |
| POST | `/api/mini/act` | player | `{push, dodge, seq}` batched TV mini-game input (≤ every 250 ms); stored in `mini/<playerId>`; `409 started` once the game has started |
| GET | `/api/mini/state` | anyone | TV poll (every 150 ms in the lobby — 1 s while 即時連線 (Ably) is live — 1 s once started; never two in flight): `{phase, gameId, rt? (true = try Ably: switch on + key set + lobby), joined, players:[{id, characterId, nickname, joinedAt, push, dodge}], leaders? (round screens), reveal?:{revealed, total} (身份揭曉 screen), howto?:{page, pages, threshold, quiz:{n, threshold, need}} (玩法說明 screen)}` |
| POST | `/api/vote` | player | `{characterId, round?}` cast / change own ballot in the open round → `{round, sealed, mine:{characterId, line}}`; `403 no_vote` (leaders), `400 bad_target`, `409 vote_closed` (closed / sealed / other round) |
| POST | `/api/knock` | 真正領袖 | 私下敲門 for the latest closed round (once per round; server picks the targets) → `{round, count}` only |
| POST | `/api/knock-ack` | player | `{round}` dismiss a received 叩叩 |
| POST | `/api/admin/vote` | host | `{round:'r1'\|'r2'\|'r3', duration:30\|45\|60\|90\|0}` open (or restart — clears that round's ballots) a vote; 0 = 無限; needs phase started + revealed |
| POST | `/api/admin/vote-end` | host | close the open vote now |
| POST | `/api/admin/speak` | host | `{round, duration:30\|60\|90\|120\|0}` start the 發言 timer for a round (0 = 不限) |
| POST | `/api/admin/speak-end` | host | `{round}` end the 發言 now (→ 提問時間); opening a vote also ends it |
| POST | `/api/quiz/answer` | player | `{index, choice:0-3}` answer / change the open Round 3 question → `{index, mine}`; `403 no_answer` (leaders), `409 quiz_closed` |
| GET / POST | `/api/admin/content` | host | game content (persists across games): `{r2:{mystery:{all, true, fake}}, r3:{threshold, need, clue, questions:[5 × {q, options[4], answer}]}, end:{threshold}}` (`end.threshold` 1–100, default 70; `400 bad_end_threshold`) → `{ok, content}` |
| POST | `/api/admin/quiz-open` | host | `{index:0-4, duration:0\|5\|8\|10\|20\|30\|45\|60\|90}` open a question (one at a time: an open one is closed first; the admin default is 10 s) (snapshotted; reopening clears its result); needs started + revealed |
| POST | `/api/admin/quiz-close` | host | close the open question now (the timer also closes it) → result |
| POST | `/api/admin/quiz-reset` | host | clear all question results / answers |
| POST | `/api/admin/final` | host | 最終揭曉: `{action:'enter'}` (TV → `final`; also `admin/screen {screen:'final'}`), `{action:'flip', playerId}`, `{action:'supporter', playerId}` (after flip; `409 no_supporter` / `not_flipped`), `{action:'all'}` (flip the rest, 700 ms stagger), `{action:'reset'}`, `{action:'votes', on}`, `{action:'ending'}` (TV → `ending`; also `admin/screen {screen:'ending'}`; `409 vote_not_closed` until the r3 vote exists and is closed; `enter` = 返回揭曉); flip / supporter / all need the TV on `final` (`409 not_final`) → `{ok, screen, final}` |
| POST | `/api/admin/howto` | host | 玩法說明: `{action:'enter'\|'exit'\|'next'\|'prev'\|'go', page?}` (7 pages, 0–6, clamped; `go` needs an integer `page` else `400 bad_page`). `enter` = phase started + TV screen `howto` (also `admin/screen {screen:'howto'}`); `exit` returns to the previous phase (lobby / started). Only before 身份揭曉: `409 revealed` after; `409 not_howto` for next/prev/go when not on `howto` → admin state `howto:{on, allowed, page, pages}` |
| GET | `/api/rt-token` | player / `?as=tv` anyone | 即時連線: `{channel, tokenRequest}` — an Ably TokenRequest signed on the server (HMAC-SHA256) from `ABLY_API_KEY`; phone = `{"wwyf:<gameId>:lobby":["publish"]}` with `clientId` = player id; TV = `{"wwyf:<gameId>:lobby":["subscribe"]}`; ttl 1 h. `503 rt_no_key`, `409 rt_off`, `409 started` |
| POST | `/api/rt-status` | anyone (the TV) | `{state:'ably'\|'poll', reason, gameId}`: the TV's Ably link (re-sent every 10 s while live; fresh = < 25 s) → stored in `rt/tv`; `/api/me` adds `rt:{active}` in the lobby when the switch is on + key set |
| POST | `/api/admin/realtime` | host | 即時連線 (Ably) switch `{on}` (default on; `meta.rtOff`, kept across 新一場) → admin state `rt:{on, hasKey, active, reason}` (reason: `no_key`, `off`, `started`, `no_tv`, `token`, `connect`, `drop`, `quota`, `sdk`) |
| POST | `/api/admin/start` | host | phase → `started` (stops the mini-game) |
| POST | `/api/admin/lobby` | host | phase → `lobby` (clears mini-game counters) |

### 即時連線 (Ably) — lobby bubble battle

* Optional. Without `ABLY_API_KEY`, or with the admin switch 「即時連線 (Ably)」 off, everything is exactly the polling path: phones send batched taps to `/api/mini/act`, the TV polls `/api/mini/state` every 150 ms.
* With the key + switch on (default): the TV (`js/rt.js`, Ably SDK v2 from `cdn.ably.com`, loaded only then) gets a subscribe-only token, subscribes to `wwyf:<gameId>:lobby`, reports `ably` to `/api/rt-status`, and polls `mini/state` every 1 s (joins, screens). Phones see `/api/me` `rt.active` on their 3 s poll, get a publish-only token (clientId = player id) and publish `{s: page-load id, p: total pushes, d: total dodges}` instead of calling `mini/act`. The TV keeps the tally from those running totals with the same caps (2 pushes / s, 0.9 s dodge cooldown); `mini/act` taps (fallback phones) still count from the poll. No snapshot to the server (the tally is lobby fun only; a TV reload just restarts counting).
* The key never leaves the server: only signed TokenRequests are returned. Each token can only narrow the key: phones cannot subscribe or publish elsewhere, the TV cannot publish, and a phone cannot pretend to be another player (clientId is signed).
* Auto-fallback to polling (TV 150 ms, phones `mini/act`) when: no key; token rejected; SDK not loadable; no connection within 8 s; connection dropped > 4 s; Ably 429 / 429xx (quota / rate limit). The TV reports the reason; admin shows 「使用中 Ably」 or 「輪詢 (後備)」 + why. The TV retries after 20 s (quota: 2 min); switching 關 → 開 in admin retries at once. Phones whose own publish fails send that batch via `mini/act`. Switching 關 takes effect live: the TV goes back to 150 ms polling at once (stays subscribed 5 s so phones still on Ably for their next ≤ 3 s poll are not lost).
* **Owner setup:** 1) create a free account at ably.com and an app (any name, e.g. `wwyf`); 2) in the app → **API Keys**, use the root key or create a key with capabilities **Publish** + **Subscribe** (resource/channels: `wwyf:*`, or all channels) — `{"wwyf:*":["publish","subscribe"]}`; copy the full key `<appId>.<keyId>:<secret>`; 3) Netlify → Site configuration → Environment variables → add `ABLY_API_KEY` = that key (scope: Functions) and redeploy. Never put the key in the repo or a page. Free plan limits (6 M messages / month, 200 connections, 500 msgs/s) are far above a party game (~2–4 msgs/s per tapping phone).

### 玩法說明 (TV screen `howto`, before 身份揭曉)

Game flow: **等候 → 玩法說明 (optional) → 身份揭曉 → Round 1 → Round 2 → Round 3 → 最終揭曉 → 結局**.

* Host: admin section 「玩法說明」 (collapsible, above 身份揭曉) → 開始玩法說明 / 結束, then 上一頁 / 下一頁 with 「第 N / 7 頁」. Disabled once identities are revealed (`409 revealed`).
* TV: 7 slides — 玩法說明 cover (characters, ~15 分鐘) · 遊戲目標 · 角色 · Round 1 聽佢講 · Round 2 誰是真領袖？ · Round 3 破解密碼 · 最終揭曉. Big text, ≤ 2 lines per slide, SVG / character art (never cropped), leader cards are mystery 「？」 cards — no names, no roles, no per-player data.
* Numbers come from 遊戲內容: `{t}` = 最後投票勝利門檻 (`end.threshold`), `{q}` / `{need}` = Round 3 每題門檻 / 需要成功題數, `{n}` = 題數. Copy lives in `data/texts.json` → `howto[7]` (`title, sub, l1, l2`).
* The slides only mention 領袖 and 平民 — the secret supporter role and tips (敲門 / 改票 / 封票) are deliberately never mentioned.
* Phones (lobby page): 「請睇 TV 玩法說明」 / 「主持人會逐頁講解玩法，請留意 TV！」 while the TV is on `howto`. Entering stops the bubble battle (phase `started`); 結束 restores the previous phase.
* Tests: `pwt/instr-test.mjs`.

### 身份揭曉 (identity reveal)

Game flow: **等候 (bubble battle) → 身份揭曉 → Round 1 → Round 2 → Round 3**.

* Host: admin section 「身份揭曉」 → 開始揭曉 (tap twice to confirm) / 結束揭曉; shows 已揭曉 X / N and who has looked (host only, authenticated).
* Phone `identity/` (`css/identity.css`, `js/identity.js`): silhouette + 「揭曉我的身份」 → flip → role pill + description → 「知道了」 → 「再看一次身份」 (re-viewable for the rest of the game). The lobby jumps here once `revealed`.
* TV screen `reveal`: pill 「秘密身份」, banner 「身份揭曉」/「請看你的手機，揭曉你的秘密身份！」, a calm animated phone illustration and the aggregate 「已揭曉 X / N」 with a progress bar — NO per-player icons, names or checks. `/api/mini/state` (public) adds only `reveal:{revealed, total}` on that screen; no per-player seen flags.
* Starting Round 1: admin 「TV／遊戲」 shows a compact 「開始 Round 1」 next to 已揭曉 X / N during the reveal stage. Once every joined player has revealed (X == N, N > 0) it glows and one tap starts Round 1; before that it is locked and reads 「X / N 已揭曉」 — tap once to arm 「仍然開始」 (3 s) and tap again to start anyway (e.g. a dead phone). Starting = `admin/screen {screen:'r1'}`: the reveal stage ends, phones can still re-view their card. The round segmented control is still used for later rounds; going back to 等候 / restarting the reveal still needs a confirm.
* TV Round 1 is the first public reveal of the leaders: `leaders` is only in `/api/mini/state` on round screens (never in lobby / reveal, never in `/api/lobby`). The first time a game reaches r1 the cards drop in face-down, then flip one by one with a sparkle burst (~4 s), then idle; it plays once per gameId (remembered in the TV's localStorage, so reloads or r2→r1 don't replay; a new game does).
* Phone identity page heading: 「你的身份」 (Chinese; only the game logo stays English).
* Leader letters (A–D) are internal only and never shown to anyone: phones, TV round cards and the admin pairing badge use the character name from `data/characters.json`; admin shows the slot as a colour dot.
* Texts: `data/roles.json` — `desc` per role; 假領袖 `helperLine` (appended only for a fake leader who has a fake supporter); 假領袖支持者 `supportsLabel` (「你支持：{name}」, shown with that leader's icon); `leaderLabel` (「{name}」 = the leader's own character name). Entries with `placeholder:true` are draft copy.
* Fake-supporter pairing (`syncPairs` in api.mjs, server-side, stored as `player.supports` = the fake leader's player id): runs after every role change / random / kick and when the stage starts. Existing pairs are kept while the target is still a 假領袖; every unpaired 假領袖支持者 (in join order) takes the 假領袖 with the fewest supporters, ties → internal slot order, then join order — so supporters get distinct fake leaders while possible and only share once every fake leader has one. No fake leaders → `supports:null`. Admin tiles show it as a small `→<character name>` badge (truncated).

### 投票 (round votes) + 封票 + 私下敲門

* Rounds: `r1` (Round 1), `r2` (Round 2), `r3` (最後投票). Host: admin 「TV／遊戲」 → 投票 row: round picker (defaults to the TV round), duration chip (tap to cycle 30 / 45 / 60 / 90 秒 / 無限; remembered on that device), 開始投票 / 結束投票 (tap twice), live 「投票中 · 剩 mm:ss · X / N 已投」. Restarting a round that already has ballots asks first and clears that round's ballots. Section 「投票結果」: per-round collapsible tally (真/假 tag, character name, count, voters, 未投票) and the 私下敲門 record (targets, 已讀/未讀, the fake leader they voted for) — host only.
* Who votes: every non-leader; 真正領袖 / 假領袖 don't vote (neutral 「投票進行中」 waiting screen, identical for true and fake). The leader cards are snapshotted when the vote opens (TV slot order + colours, character names only). The server closes the vote at the deadline.
* Phone `vote/` (`css/vote.css`, `js/vote.js`): reached from 「前往投票」 on `round/` (no auto-jump). Grid → 確認投票 → 「你目前選擇」 + bubble + 更改投票 (allowed until close; preselects the current pick). The bubble line comes from the server (`HINTS` in api.mjs, re-picked on every change, never the same line twice in a row): a vote for a fake leader gets one of the `f` lines (gently mentions 更改投票), a vote for the true leader one of the neutral `t` lines — a quiet easter egg. Polls `/api/me` every 2 s while open (3 s otherwise) + exactly at the deadline. After close: 「投票已結束」 + the final choice for ~10 s, then back to `round/`.
* 封票: once every eligible player has voted the vote seals at once (server-side): changes are rejected, phones hide 更改投票 and show 「所有人已完成投票，票已封存。」, the TV shows 已封票 (hint lines are only sent while a change is still possible).
* TV (round screens): pill under the cards 「投票中 / 最後投票 · mm:ss · 已投票 X / N」 + progress bar, then 已封票 — aggregate only (the ballot list is read at most 1×/s). Lambs easter egg = one integer from the server: r1 = 1; r2 = votes for the true leader in r1; r3 = votes for the true leader in r2 (max 20; > 5 → two smaller rows).
* 私下敲門: after a round's vote closes, only the 真正領袖's phone shows 「私下敲門」 once per round (tap twice) — **on that round's vote page only** (the round / identity pages send a phone with a pending knock there; the vote page stays until the knock is used / the 叩叩 is dismissed, then returns ~4 s later). Once the TV moves on to another round (or 最終揭曉 / 結局), `/api/me` no longer carries that round's `knock` / `knocked` at all (`knockLive` in api.mjs); each round's knock is independent. The server picks: 2 random voters of ONE fake leader that has ≥ 2 voters (that fake leader chosen at random); otherwise 1 random fake-leader voter; otherwise nobody (「這一輪沒有需要敲門的人。」). Non-voters and true-leader voters are never knocked. The leader only sees 「已敲門」 (`KNOCK_SHOW_TARGETS = false` in api.mjs). Knocked phones get a private 「叩叩……」 card (vote page) via `/api/me` until 知道了 or until the TV moves to the next round; the copy never names or hints at any leader. Fake leaders' phones look identical at idle; the TV and public endpoints never mention knocks. Records: `meta.knocks[round]` (cleared by 新一場).
* Texts: `data/texts.json` (knock button / hints, 叩叩 title, `bodies` = subtle variants, one picked per knock, note, dismiss).

### 回合頁 (phone while the TV is on Round 1 / 2 / 3)

* Phone `round/` (`css/round.css`, `js/round.js`), one page for r1 / r2 / r3: Round pill, 發言 pill + clock (準備中 `--:--` → 發言中 + countdown → 提問時間 / 發言結束), title with a brush stroke, description, the round's leaders (character names) peeking out of paw-print pots, 小提示 box and 「前往投票」. Copy: `data/texts.json` → `rounds.<r>` (`title`, `desc` with `{n}` = 一 / 二 / 三 / 四 leaders, `tip`) and `round.*` (pill / button / follower labels). r2 / r3 copy is placeholder.
* Routing: lobby / identity send a revealed player who has seen their identity to `round/` on a round screen (not seen yet → `identity/`); 「再看一次身份」 opens `identity/#card` and 知道了 returns to `round/`. There is NO auto-jump to the vote: 前往投票 is disabled (「等待投票開始」) until the host opens the vote, then the player taps it; after the vote it reads 「本輪投票已結束」 and the vote page returns to `round/`.
* Leaders (true and fake, identical layout, gender-neutral copy from `LEADER_TEXT` in api.mjs, sent via `/api/me` only to that leader): their own desc / tip, and instead of the vote button a 「跟隨你的人數」 box — 「投票結束後公佈」 while the vote is open, then their own count (no names; never on the TV or anyone else's phone). After the round's vote closes, the 真正領袖 is taken to the vote page for 「私下敲門」 (「已敲門」 after use, then back here with the count); the round page itself never shows any knock UI. Knocked players likewise see the 叩叩 card only on the vote page.
* Host: admin 「TV／遊戲」 → 發言 row (duration chip 30 / 60 / 90 / 120 / 不限, 開始發言 / 結束發言); the 投票 box shows 「Round N 跟隨人數」 per leader by character name — 即時 while voting (refreshed every 2 s), 最終 after close; 投票結果 lists 跟隨 N 人.
* TV: while no vote is shown, a 「發言中 · mm:ss」 pill under the cards (aggregate only).
* Polling: `/api/me` every 2 s while 發言 or a vote is live, else 3 s; the clock ticks locally.

### Round 2 神秘描述 + Round 3 破解密碼 (quiz)

* Host guide (Traditional Chinese): `docs/HOST-GUIDE.md`.
* Content: admin 「遊戲內容」 edits Round 2 — 神秘描述 `r2.mystery.all` (required, ≤400; 平民 + both supporter roles), 真領袖詞語 `true` (required, ≤20) and 假領袖詞語 `fakes[0..2]` (≤20; [0] required; one per fake leader by TV leader-slot order, empty / 4th+ fake → `fakes[0]`). Labels show the assigned character (`adminState.fakeWords`), else the slot; fields still equal to the built-in example (`examples.r2` from admin/content) get a 例子 tag. Old stored `{true,fake}` description texts migrate: kept as a word only if ≤20 chars and different from `all`, else the example — the Round 3 threshold % (default 60), success count (default 3), the final clue and 5 questions (A–D + answer). Stored server-side (`content` blob), kept by 新一場.
* r2 phone: same round page, title 誰是真領袖？. 平民 / supporters: a 「神秘描述」 card (`/api/me` `round.mystery`, no words). Leaders: a 「你的詞語」 card (`round.word` = only their own word; no `mystery`) + the same desc / tip for true and fake, identical layout. The TV / `mini/state` never get any of it. Speak / vote / knock as in r1.
* r3 phone: 解鎖進度 (5 circles) + question card (問題 i/5, question, A–D, status). Every non-leader must answer: an unanswered phone shows a pulsing 「請作答」 until it answers. The question auto-closes the moment everyone has answered (`q.auto`), or at the optional timer; players change answers until close; leaders read-only. After close: correct option + 成功 / 未達標 + %. Once `need` questions succeed and no question is open: the clue card. `/api/me` `round.quiz` = summary + `canAnswer` + `q` (`mine`; `answer` / `result` only after close). pct = correct / all non-leader players.
* Admin 「Round 3 問答」: per-question status, picker, duration chip, 開始第 N 題 / 結束作答, live 已作答 / 答對 / %, 未作答 N 人 (names, admin only — `q.missing`), 全部已作答，自動結束; a forced 結束作答 takes two taps and warns 「X 人未作答」; 重設問答進度 (tap twice). Enabled while the TV is on Round 3.
* TV r3: while a question exists (or the clue is unlocked) a panel replaces the leader cards: 問題 i/5, progress dots, 作答中 + countdown, question, A–D, 已作答 X / N; after close the correct option + 成功 / 未達標 + %; then the clue. Hidden while a vote is shown. `/api/mini/state` `quiz` never carries the answer or choices while open.

### 最終揭曉 (TV screen `final`)

* Admin 「最終揭曉」: 進入最終揭曉, 顯示最後投票結果 toggle (r3 vote closed only), one tile per leader (name, role, supporters — host only) with 翻卡 (any order) and 揭曉支持者 (disabled 沒有支持者 when none), 全部翻開 / 重設揭曉 (two taps each). State `meta.final {flipped, supp, votes}`, cleared by 新一場.
* TV (`js/tv.js`, `css/tv.css`): face-down cards (sprite + name + 「?」 badge) → flip: fake = 「假領袖」 stamp; true = 「真正領袖」 stamp + crown + glow + confetti; supporters pop out beside the card (sprite + small name label only; no caption or role text). Animations play only for changes seen live (`at` / `suppAt` timestamps); `prefers-reduced-motion` → simple fades. `/api/mini/state` `final.cards[]` carries `role` / `supporters` only for flipped / revealed cards.
* Phone `round/` (data-r `final`): 「請看 TV！」 + the list of leaders with 未翻開 / 假領袖 / 真正領袖 and the supporter names (no label or role text) once revealed (copy: `data/texts.json` → `final`).

### 結局 (TV screen `ending`)

* Win rule: the group wins when ≥ `content.end.threshold` % (default 70, admin 「遊戲內容」) of the final-vote (r3) voters chose the true leader. Voters = non-leaders with an r3 ballot for a leader; `win = n > 0 && x*100 >= threshold*n` (n = 0 → lose).
* Admin 「最終揭曉」 → 結局 box: host-only preview (X / N, %, 勝利 / 假領袖勝出) once the r3 vote is closed; 「顯示結局」 (two taps while the true leader card is still face-down) and 「返回揭曉」 (back to `final`). `admin/state` → `final.ending {on, ready, trueFlipped, result}`. State `meta.tvScreen = 'ending'` + `meta.endingAt`; 新一場 clears it.
* Data only after the trigger: `/api/mini/state` `ending:{win, x, n, pct, threshold, leaders:[{characterId, role:'true'|'fake', votes}], at, el, order, plan:{t, result}, resultAt}` (aggregate only, no player ids / nicknames; `order` = the r3 ballots as leader characterIds, shuffled deterministically per game (seed = gameId + vote id); `plan.t` = ms after `at` of each ballot, `el` = server ms since `at`) and `/api/me` `round:{screen:'ending', leaders, ending, mine}` — `mine` = `{voted, true}` for a voter, `{voted:null}` for a non-voter, `{leader:'true'|'fake', votes, won}` for a leader (a fake leader "wins" when the group loses).
* Counting sync (`endingPlan` in `api.mjs`, the TV just plays it): 0.9 s intro, one ballot every 0.6 s → 0.35 s (accelerating, steps capped at 9 s total), a 1.1 s pause before the ballot that reaches the target (else before the last one), 0.5 s settle → 20 voters ≈ 11.5 s. `resultAt = at + plan.result + 1.5 s`. Until then `/api/me` returns `{screen:'ending', leaders, ending:null, mine:null, wait:{in: ms}}` (server-enforced: no result data) and the phone shows 「點票中… / 請看 TV，正在點票…」 with a one-shot poll at `wait.in`. A TV reload resumes from `el` (or shows the final state, no replay); 返回揭曉 + 顯示結局 sets a new `at` and restarts both.
* TV (`js/tv.js` `renderEnding`, `css/tv.css` `.en-*`): ballots counted one by one — each pops that leader chip's 「N 票」, a true-leader ballot steps the bar + X / N up; the target line pulses during the pause; the result is revealed after the count: win = 「勝利！」 + crowned true leader + rays + walking lambs + confetti; lose = 「差一點點…」 + bouncing fake leaders + the true leader's `hit2` sprite with a sweat drop. Chips: leader name + 真正領袖 / 假領袖 + 「N 票」. Reduced motion → final state at once, no confetti (phones still wait for `resultAt`).
* Phone `round/` (data-r `ending`): result title/line, mini meter + target, the personal line (「你跟隨了真正的領袖 🎉」 / 「你跟隨了 <name>」 / 沒有投票; leaders: their own side's result + 「最後投票有 N 人跟隨你」), the 4 leaders with counts and 「多謝參與幸福小組！」. Copy: `data/texts.json` → `ending`.

Default roles (17): 真正領袖 1 · 假領袖 3 · 真領袖支持者 1 · 假領袖支持者 2 · 平民 10.

Deploy: `npm i && netlify deploy --prod`.
