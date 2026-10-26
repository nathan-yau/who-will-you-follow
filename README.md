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
* Environment variables (set in Netlify, never in this repo): `ADMIN_PASSWORD` (host PIN), `SESSION_SECRET` (HMAC key for 12 h admin sessions).
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
| GET | `/api/mini/state` | anyone | TV poll (every 250 ms): `{phase, gameId, joined, players:[{id, characterId, nickname, joinedAt, push, dodge}], leaders? (round screens), reveal?:{revealed, total} (身份揭曉 screen)}` |
| POST | `/api/vote` | player | `{characterId, round?}` cast / change own ballot in the open round → `{round, sealed, mine:{characterId, line}}`; `403 no_vote` (leaders), `400 bad_target`, `409 vote_closed` (closed / sealed / other round) |
| POST | `/api/knock` | 真正領袖 | 私下敲門 for the latest closed round (once per round; server picks the targets) → `{round, count}` only |
| POST | `/api/knock-ack` | player | `{round}` dismiss a received 叩叩 |
| POST | `/api/admin/vote` | host | `{round:'r1'\|'r2'\|'r3', duration:30\|45\|60\|90\|0}` open (or restart — clears that round's ballots) a vote; 0 = 無限; needs phase started + revealed |
| POST | `/api/admin/vote-end` | host | close the open vote now |
| POST | `/api/admin/speak` | host | `{round, duration:30\|60\|90\|120\|0}` start the 發言 timer for a round (0 = 不限) |
| POST | `/api/admin/speak-end` | host | `{round}` end the 發言 now (→ 提問時間); opening a vote also ends it |
| POST | `/api/quiz/answer` | player | `{index, choice:0-3}` answer / change the open Round 3 question → `{index, mine}`; `403 no_answer` (leaders), `409 quiz_closed` |
| GET / POST | `/api/admin/content` | host | game content (persists across games): `{r2:{mystery:{all, true, fake}}, r3:{threshold, need, clue, questions:[5 × {q, options[4], answer}]}}` → `{ok, content}` |
| POST | `/api/admin/quiz-open` | host | `{index:0-4, duration:0\|20\|30\|45\|60\|90}` open a question (snapshotted; reopening clears its result); needs started + revealed |
| POST | `/api/admin/quiz-close` | host | close the open question now (the timer also closes it) → result |
| POST | `/api/admin/quiz-reset` | host | clear all question results / answers |
| POST | `/api/admin/final` | host | 最終揭曉: `{action:'enter'}` (TV → `final`; also `admin/screen {screen:'final'}`), `{action:'flip', playerId}`, `{action:'supporter', playerId}` (after flip; `409 no_supporter` / `not_flipped`), `{action:'all'}` (flip the rest, 700 ms stagger), `{action:'reset'}`, `{action:'votes', on}`; flip / supporter / all need the TV on `final` (`409 not_final`) → `{ok, screen, final}` |
| POST | `/api/admin/start` | host | phase → `started` (stops the mini-game) |
| POST | `/api/admin/lobby` | host | phase → `lobby` (clears mini-game counters) |

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
* 私下敲門: after a round's vote closes, only the 真正領袖's phone (vote ended screen or identity wait screen) shows 「私下敲門」 once per round (tap twice). The server picks: 2 random voters of ONE fake leader that has ≥ 2 voters (that fake leader chosen at random); otherwise 1 random fake-leader voter; otherwise nobody (「這一輪沒有需要敲門的人。」). Non-voters and true-leader voters are never knocked. The leader only sees 「已敲門」 (`KNOCK_SHOW_TARGETS = false` in api.mjs). Knocked phones get a private 「叩叩……」 card via `/api/me` until 知道了; the copy never names or hints at any leader. Fake leaders' phones look identical at idle; the TV and public endpoints never mention knocks. Records: `meta.knocks[round]` (cleared by 新一場).
* Texts: `data/texts.json` (knock button / hints, 叩叩 title, `bodies` = subtle variants, one picked per knock, note, dismiss).

### 回合頁 (phone while the TV is on Round 1 / 2 / 3)

* Phone `round/` (`css/round.css`, `js/round.js`), one page for r1 / r2 / r3: Round pill, 發言 pill + clock (準備中 `--:--` → 發言中 + countdown → 提問時間 / 發言結束), title with a brush stroke, description, the round's leaders (character names) peeking out of paw-print pots, 小提示 box and 「前往投票」. Copy: `data/texts.json` → `rounds.<r>` (`title`, `desc` with `{n}` = 一 / 二 / 三 / 四 leaders, `tip`) and `round.*` (pill / button / follower labels). r2 / r3 copy is placeholder.
* Routing: lobby / identity send a revealed player who has seen their identity to `round/` on a round screen (not seen yet → `identity/`); 「再看一次身份」 opens `identity/#card` and 知道了 returns to `round/`. There is NO auto-jump to the vote: 前往投票 is disabled (「等待投票開始」) until the host opens the vote, then the player taps it; after the vote it reads 「本輪投票已結束」 and the vote page returns to `round/`.
* Leaders (true and fake, identical layout, gender-neutral copy from `LEADER_TEXT` in api.mjs, sent via `/api/me` only to that leader): their own desc / tip, and instead of the vote button a 「跟隨你的人數」 box — 「投票結束後公佈」 while the vote is open, then their own count (no names; never on the TV or anyone else's phone). After the round's vote closes, the 真正領袖's page swaps the tip box for 「私下敲門」 (the existing once-per-round knock; 「已敲門」 after use); fake leaders keep the tip box (no knock). Knocked players get the 叩叩 card on this page too.
* Host: admin 「TV／遊戲」 → 發言 row (duration chip 30 / 60 / 90 / 120 / 不限, 開始發言 / 結束發言); the 投票 box shows 「Round N 跟隨人數」 per leader by character name — 即時 while voting (refreshed every 2 s), 最終 after close; 投票結果 lists 跟隨 N 人.
* TV: while no vote is shown, a 「發言中 · mm:ss」 pill under the cards (aggregate only).
* Polling: `/api/me` every 2 s while 發言 or a vote is live, else 3 s; the clock ticks locally.

### Round 2 神秘描述 + Round 3 破解密碼 (quiz)

* Host guide (Traditional Chinese): `docs/HOST-GUIDE.md`.
* Content: admin 「遊戲內容」 edits the Round 2 mystery texts — 平民版 `all` (required; 平民 + both supporter roles), 真領袖版 `true`, 假領袖版 `fake` (empty → 平民版) — the Round 3 threshold % (default 60), success count (default 3), the final clue and 5 questions (A–D + answer). Stored server-side (`content` blob), kept by 新一場.
* r2 phone: same round page, title 誰是真領袖？, a 「神秘描述」 card (`/api/me` `round.mystery` = only the caller's version; the TV / `mini/state` never get it); speak / vote / knock as in r1.
* r3 phone: 解鎖進度 (5 circles) + question card (問題 i/5, question, A–D, status). Every non-leader must answer: an unanswered phone shows a pulsing 「請作答」 until it answers. The question auto-closes the moment everyone has answered (`q.auto`), or at the optional timer; players change answers until close; leaders read-only. After close: correct option + 成功 / 未達標 + %. Once `need` questions succeed and no question is open: the clue card. `/api/me` `round.quiz` = summary + `canAnswer` + `q` (`mine`; `answer` / `result` only after close). pct = correct / all non-leader players.
* Admin 「Round 3 問答」: per-question status, picker, duration chip, 開始第 N 題 / 結束作答, live 已作答 / 答對 / %, 未作答 N 人 (names, admin only — `q.missing`), 全部已作答，自動結束; a forced 結束作答 takes two taps and warns 「X 人未作答」; 重設問答進度 (tap twice). Enabled while the TV is on Round 3.
* TV r3: while a question exists (or the clue is unlocked) a panel replaces the leader cards: 問題 i/5, progress dots, 作答中 + countdown, question, A–D, 已作答 X / N; after close the correct option + 成功 / 未達標 + %; then the clue. Hidden while a vote is shown. `/api/mini/state` `quiz` never carries the answer or choices while open.

### 最終揭曉 (TV screen `final`)

* Admin 「最終揭曉」: 進入最終揭曉, 顯示最後投票結果 toggle (r3 vote closed only), one tile per leader (name, role, supporters — host only) with 翻卡 (any order) and 揭曉支持者 (disabled 沒有支持者 when none), 全部翻開 / 重設揭曉 (two taps each). State `meta.final {flipped, supp, votes}`, cleared by 新一場.
* TV (`js/tv.js`, `css/tv.css`): face-down cards (sprite + name + 「?」 badge) → flip: fake = 「假領袖」 stamp; true = 「真正領袖」 stamp + crown + glow + confetti; supporters pop out from behind the card with 「原來一直暗中支持！」 + role tag. Animations play only for changes seen live (`at` / `suppAt` timestamps); `prefers-reduced-motion` → simple fades. `/api/mini/state` `final.cards[]` carries `role` / `supporters` only for flipped / revealed cards.
* Phone `round/` (data-r `final`): 「請看 TV！」 + the list of leaders with 未翻開 / 假領袖 / 真正領袖 and 原來一直暗中支持：<names> once revealed (copy: `data/texts.json` → `final`).

Default roles (17): 真正領袖 1 · 假領袖 3 · 真領袖支持者 1 · 假領袖支持者 2 · 平民 10.

Deploy: `npm i && netlify deploy --prod`.
