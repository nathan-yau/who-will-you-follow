// Who Will You Follow? — game backend (Netlify Functions v2 + Netlify Blobs).
// One game at a time. State lives in the "wwyf-game" blob store:
//   meta                 { gameId, startedAt, revealed, phase: 'lobby'|'started', phaseAt,
//                          tvScreen: 'lobby'|'howto'|'r1'|'r2'|'r3'|'reveal'|'final'|'ending' }   (what the TV shows; set by POST admin/screen)
//                        howto = { page, from: 'lobby'|'started', auto: {on, sec 6|10|15, at} }   玩法說明 slideshow (POST admin/howto), only before 身份揭曉
//                        revealed = phones may see their own role (turned on by the 身份揭曉 stage, stays on until 新一場);
//                        tvScreen 'reveal' = the 身份揭曉 stage itself (POST admin/reveal-stage)
//   config               { roles: { <special role>: max } }   (平民 has no limit)
//   players/<playerId>   { id, tokenHash, characterId, nickname, joinedAt, role, leader, supports, gameId, revealedAt }
//                        supports = (假領袖支持者 only) player id of the 假領袖 they secretly back — see syncPairs()
//                        (revealedAt: the player tapped 揭曉 on the phone; cleared when the host changes the role)
//   claims/<characterId> { playerId, at }      (created with onlyIfNew -> one player per character)
//   seen/<playerId>      { t }                 (heartbeats; separate key so they never clobber roles)
//   mini/<playerId>      { push, dodge, seq, pt, dt, t }  waiting-room mini game: cumulative action counters
//                        (one key per player -> phone writes never contend; the TV diffs the counters)
//   archive/<ts>-<gameId> previous games (player list + roles)
//   ballots/<round>/<playerId> { target, characterId, at, pool, li }   one vote per player per round (see "votes")
//                        meta.votes = { r1|r2|r3: { id, openedAt, duration, deadline, closedAt, sealed, leaders } }, meta.vote = current round
//                        meta.knocks = { r1|r2|r3: { at, by, vid, targets: [playerId], fake: fakeLeaderId, seen: { playerId: t } } }   私下敲門 records (see "knocks")
//                        meta.speaks = { r1|r2|r3: { id, startedAt, duration, deadline, endedAt } }   發言 timers (see "speaking")
//                        meta.quiz = Round 3 問答 state (see "Round 3 問答"); answers/<index>/<playerId> { choice, at, qid }
//   content              editable game content (Round 2 神秘描述, Round 3 questions / threshold / clue) — kept across games
import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const config = { path: '/api/*' };

const LEADER_ROLES = ['真正領袖', '假領袖'];
const LEADER_LABELS = ['A', 'B', 'C', 'D'];
// No player cap (the only natural limit is the number of characters). Everyone joins as 平民 (unlimited);
// the special roles below have per-game limits (overridable via POST admin/config).
const CIVILIAN = '平民';
const DEFAULT_ROLES = { '真正領袖': 1, '假領袖': 3, '真領袖支持者': 1, '假領袖支持者': 2 };
const SPECIAL_ROLES = Object.keys(DEFAULT_ROLES);  // also the priority when there are too few players for all of them
const ROLE_ORDER = [...SPECIAL_ROLES, CIVILIAN];
const isRole = (r) => r === CIVILIAN || SPECIAL_ROLES.includes(r);
const FAKE_LEADER = '假領袖', FAKE_SUPPORTER = '假領袖支持者', TRUE_SUPPORTER = '真領袖支持者';
const ALLOWED_ORIGINS = ['https://nathan-yau.github.io'];
const ONLINE_MS = 15000;
const SESSION_MS = 12 * 3600 * 1000;
const CHAR_RE = /^character_\d{2}$/;
const LOBBY = 'lobby', STARTED = 'started';
const phaseOf = (m) => (m && m.phase === STARTED ? STARTED : LOBBY);
const ROUND_SCREENS = ['r1', 'r2', 'r3'];
const REVEAL = 'reveal';   // 身份揭曉 stage
const FINAL = 'final';     // 最終揭曉 (host flips the leader cards in any order)
const ENDING = 'ending';   // 結局 (after 最終揭曉: did the group follow the true leader in the final vote?)
const HOWTO = 'howto';    // 玩法說明 slideshow (before 身份揭曉; the host pages through it)
const HOWTO_PAGES = 8;    // 0 標題頁 (Who Will You Follow? · 遊戲玩法) · 1 玩法說明 (約 15 分鐘) · 2 遊戲目標 · 3 角色 · 4 Round 1 · 5 Round 2 · 6 Round 3 · 7 最終揭曉 — the copy lives in js/tv.js
const SCREENS = [...ROUND_SCREENS, REVEAL, FINAL, ENDING, HOWTO];
// round / reveal screens only make sense once the game has started (lobby -> always the bubble battle)
const screenOf = (m) => (phaseOf(m) === STARTED && SCREENS.includes(m.tvScreen) ? m.tvScreen : LOBBY);
const MINI_MAX_PUSH = 4;   // per request; the phone sends at most every 250 ms and caps taps at 2/s

const store = () => getStore({ name: 'wwyf-game', consistency: 'strong' });

/* ---------------- helpers ---------------- */
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 9) => randomBytes(n).toString('base64url');
const now = () => Date.now();

function cors(req) {
  const o = req.headers.get('origin');
  const h = { 'Vary': 'Origin' };
  if (o && ALLOWED_ORIGINS.includes(o)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Player-Id, X-Player-Token, X-Admin-Token';
    h['Access-Control-Max-Age'] = '7200';   // cache preflights as long as browsers allow (Chrome caps at 2 h)
  }
  return h;
}
const json = (req, status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) },
});
class HttpError extends Error { constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; } }
const fail = (status, code, msg) => { throw new HttpError(status, code, msg); };

async function body(req) {
  if (req.method !== 'POST') return {};
  try { const b = await req.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
}
function cleanNick(n) {
  if (typeof n !== 'string') return '';
  return n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = randomBytes(4).readUInt32LE() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** read-modify-write a JSON key with an ETag guard (retries on concurrent writes) */
async function update(s, key, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await s.getWithMetadata(key, { type: 'json' });
    if (!cur) return null;
    const next = fn(structuredClone(cur.data));
    if (next === undefined) return cur.data;
    const r = await s.setJSON(key, next, { onlyIfMatch: cur.etag });
    if (r.modified) return next;
  }
  fail(409, 'busy', '伺服器忙碌，請再試一次');
}

async function getMeta(s) {
  let m = await s.get('meta', { type: 'json' });
  if (!m) {
    m = { gameId: rid(6), startedAt: now(), revealed: false, phase: LOBBY };
    const r = await s.setJSON('meta', m, { onlyIfNew: true });
    if (!r.modified) m = await s.get('meta', { type: 'json' });
  }
  return m;
}
let roleCache = null;   // { t, data } — the configured role counts, 3 s in the warm instance (fresh for role edits)
async function getRoleCounts(s, cached) {
  if (cached && roleCache && now() - roleCache.t < 3000) return roleCache.data;
  const c = await s.get('config', { type: 'json' });
  const saved = (c && c.roles) || {};
  const out = {};
  for (const r of SPECIAL_ROLES) out[r] = Number.isInteger(saved[r]) ? saved[r] : DEFAULT_ROLES[r];
  roleCache = { t: now(), data: out };
  SLOT_N = slotCount(out);
  return out;
}
/** how many leader cards the TV / phones show = configured 真正領袖 + 假領袖 (1–4, max = LEADER_LABELS) */
const slotCount = (c) => Math.max(1, Math.min(LEADER_LABELS.length, (c[TRUE_LEADER] || 0) + (c[FAKE_LEADER] || 0)));
let SLOT_N = LEADER_LABELS.length;   // refreshed (cached) at the start of every request
/** migrate on read: players stored before "everyone starts as 平民" (role null/unknown) become 平民 */
function normalize(p) {
  if (p && !isRole(p.role)) { p.role = CIVILIAN; p.leader = null; }
  return p;
}

async function listKeys(s, prefix) {
  const out = [];
  for await (const page of s.list({ prefix, paginate: true })) out.push(...page.blobs.map((b) => b.key));
  return out;
}
async function allPlayers(s) {
  const keys = await listKeys(s, 'players/');
  const ps = await Promise.all(keys.map((k) => s.get(k, { type: 'json' })));
  return ps.filter(Boolean).map(normalize);
}
async function takenCharacters(s) {
  return (await listKeys(s, 'claims/')).map((k) => k.slice(7));
}

/* ---------------- player auth ---------------- */
async function playerFrom(req, s, b = {}) {
  const id = req.headers.get('x-player-id') || b.playerId;
  const token = req.headers.get('x-player-token') || b.token;
  if (!id || !token || typeof id !== 'string' || typeof token !== 'string' || id.length > 40) return null;
  const p = await s.get('players/' + id, { type: 'json' });
  if (!p) return null;
  const a = Buffer.from(sha(token)), e = Buffer.from(p.tokenHash);
  return a.length === e.length && timingSafeEqual(a, e) ? normalize(p) : null;
}
const publicPlayer = (p) => ({ id: p.id, characterId: p.characterId, nickname: p.nickname || '', joinedAt: p.joinedAt });

/** claim a character for playerId; returns true on success. Repairs stale claims (owner no longer exists). */
async function claim(s, characterId, playerId) {
  const key = 'claims/' + characterId;
  const r = await s.setJSON(key, { playerId, at: now() }, { onlyIfNew: true });
  if (r.modified) return true;
  const cur = await s.getWithMetadata(key, { type: 'json' });
  if (!cur) return claim(s, characterId, playerId);
  if (cur.data.playerId === playerId) return true;
  const owner = await s.get('players/' + cur.data.playerId, { type: 'json' });
  const stale = !owner || owner.characterId !== characterId;
  if (stale && now() - (cur.data.at || 0) > 10000) {   // grace period covers an in-flight join
    const w = await s.setJSON(key, { playerId, at: now() }, { onlyIfMatch: cur.etag });
    return w.modified;
  }
  return false;
}
async function release(s, characterId, playerId) {
  const key = 'claims/' + characterId;
  const cur = await s.getWithMetadata(key, { type: 'json' });
  if (cur && cur.data.playerId === playerId) await s.delete(key);
}

/* ---------------- admin auth ---------------- */
function sign(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(p).digest('base64url');
  return p + '.' + sig;
}
function verifyAdmin(req) {
  const t = req.headers.get('x-admin-token') || '';
  const [p, sig] = t.split('.');
  if (!p || !sig || !process.env.SESSION_SECRET) fail(401, 'unauthorized', '請重新登入');
  const exp = createHmac('sha256', process.env.SESSION_SECRET).update(p).digest('base64url');
  const a = Buffer.from(sig), e = Buffer.from(exp);
  if (a.length !== e.length || !timingSafeEqual(a, e)) fail(401, 'unauthorized', '請重新登入');
  let data; try { data = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { fail(401, 'unauthorized'); }
  if (!data.exp || data.exp < now()) fail(401, 'expired', '登入已過期，請重新登入');
}

/* ---------------- routes ---------------- */
async function lobby(s) {
  const [taken, meta, players] = await Promise.all([takenCharacters(s), getMeta(s), listKeys(s, 'players/')]);
  return { gameId: meta.gameId, taken, joined: players.length, phase: phaseOf(meta) };
}

async function join(req, s) {
  const b = await body(req);
  const characterId = b.characterId;
  if (typeof characterId !== 'string' || !CHAR_RE.test(characterId)) fail(400, 'bad_character', '角色不存在');
  const nickname = cleanNick(b.nickname);
  const meta = await getMeta(s);
  const existing = await playerFrom(req, s, b);
  if (existing) {
    // reconnect (same character) or switch to another free character
    if (existing.characterId !== characterId) {
      if (!(await claim(s, characterId, existing.id))) fail(409, 'taken', '這個角色已被其他玩家選走了');
      const old = existing.characterId;
      await update(s, 'players/' + existing.id, (p) => { p.characterId = characterId; if (b.nickname !== undefined) p.nickname = nickname; return p; });
      await release(s, old, existing.id);
    } else if (b.nickname !== undefined && nickname !== existing.nickname) {
      await update(s, 'players/' + existing.id, (p) => { p.nickname = nickname; return p; });
    }
    await s.setJSON('seen/' + existing.id, { t: now() });
    const p = await s.get('players/' + existing.id, { type: 'json' });
    return { player: publicPlayer(p), token: b.token || req.headers.get('x-player-token'), rejoined: true };
  }
  const id = rid(9), token = rid(24);
  if (!(await claim(s, characterId, id))) fail(409, 'taken', '這個角色已被其他玩家選走了');
  const p = { id, tokenHash: sha(token), characterId, nickname, joinedAt: now(), role: CIVILIAN, leader: null, gameId: meta.gameId };
  await s.setJSON('players/' + id, p);
  await s.setJSON('seen/' + id, { t: now() });
  return { player: publicPlayer(p), token, rejoined: false };
}

async function me(req, s, heartbeatOnly) {
  const p = await playerFrom(req, s);
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  await s.setJSON('seen/' + p.id, { t: now() });
  if (heartbeatOnly) return { ok: true };
  const [meta, info] = await Promise.all([getMeta(s), lobby(s)]);
  // everyone holds 平民 from the start, so "assigned" only becomes meaningful once the host reveals roles
  const out = { player: publicPlayer(p), assigned: false, revealed: !!meta.revealed, joined: info.joined, gameId: meta.gameId, phase: phaseOf(meta), screen: screenOf(meta) };
  // 即時連線: phones publish taps over Ably only while the TV reports a live Ably connection for this game
  if (out.phase === LOBBY && !meta.revealed && rtWanted(meta)) out.rt = { active: rtActive(meta, await rtTv(s)) };
  // a phone only ever gets its OWN role, and only once the host has started the 身份揭曉 stage
  if (meta.revealed) {
    out.seen = !!p.revealedAt;
    Object.assign(out, await roleView(s, normalize(p)));
  }
  // the current (or most recent) round vote: open/closed, countdown, this phone's own ballot only
  const v = currentVote(meta);
  if (v && meta.revealed) out.vote = await voteView(s, p, v);
  // round screens (r1–r3): the phone's round page — the TV's leader cards (character only, same slot order) + the 發言 timer
  if (meta.revealed && ROUND_SCREENS.includes(out.screen)) {
    const pl = await listWithEtags(s, 'players/');   // etag-cached gets: a poll only re-reads players that changed
    const ps = (await cachedGet(s, pl)).filter(Boolean).map(normalize);
    out.round = { screen: out.screen, leaders: leaderCards(ps), speak: speakView(meta, out.screen) };
    const me1 = normalize(p);
    if (out.screen === 'r2') {
      // Round 2 (誰是真領袖？, undercover style): leaders get ONLY their own word (never the description / another word);
      // everyone else (平民 + both supporter roles) gets ONLY the 神秘描述 (never a word)
      const c2 = await getContent(s);
      if (LEADER_ROLES.includes(me1.role)) out.round.word = wordFor(c2, me1, ps);
      else out.round.mystery = c2.r2.mystery.all;
    }
    if (out.screen === 'r3') out.round.quiz = await quizForPhone(s, await quizSettle(s, meta), await getContent(s), me1);
    if (LEADER_ROLES.includes(me1.role)) {
      // leaders only, about themselves only: their instructions (by role; the copy never reaches other phones) and,
      // once this round's vote has closed, how many players follow them (a number — never who)
      const lt = LEADER_TEXT[out.screen] && LEADER_TEXT[out.screen][me1.role];
      if (lt) out.round.leaderText = { desc: lt.desc, tip: lt.tip };
      out.round.followers = await followersOf(s, meta, me1, out.screen, ps);
    }
  }
  if (meta.revealed && out.screen === FINAL) {
    // phones on 最終揭曉: 「請看 TV」 + what has been revealed so far (same public data as the TV)
    const ps = (await cachedGet(s, await listWithEtags(s, 'players/'))).filter(Boolean).map(normalize);
    out.round = { screen: FINAL, leaders: leaderCards(ps), final: await finalView(s, meta, ps) };
  }
  if (meta.revealed && out.screen === ENDING) {
    // 結局: the public result (same as the TV) + this phone's OWN line (who it followed / its own leader result)
    const ps = (await cachedGet(s, await listWithEtags(s, 'players/'))).filter(Boolean).map(normalize);
    const tally = await endingTally(s, meta, ps);
    const ending = endingView(meta, await getContent(s), ps, tally);
    // phones get NOTHING about the result until the TV has finished counting (resultAt) — only how long to wait
    const wait = ending ? ending.resultAt - now() : 0;
    out.round = wait > 0 || !ending ? { screen: ENDING, leaders: leaderCards(ps), ending: null, mine: null, wait: { in: Math.max(0, wait) } }
      : { screen: ENDING, leaders: leaderCards(ps), ending: phoneEnding(ending), mine: endingMine(normalize(p), ps, tally, ending) };
  }
  if (meta.revealed) {
    const kv = knockView(meta, normalize(p));
    if (kv) out.knock = kv;                    // 真正領袖 only
    const kin = knocksFor(meta, p);
    if (kin.length) out.knocked = kin;         // a private 叩叩 for this phone only
  }
  return out;
}

/** What a phone may know about its OWN role (never a leader letter — the slot letter is internal only;
    phones/TV show character names from data/characters.json):
    - 假領袖支持者: the one 假領袖 they back (character only), from syncPairs()
    - 真領袖支持者: the 真正領袖 they back (character only) — same shape as a fake supporter's, so the cards look alike
    - 假領袖: only a yes/no "someone secretly helps you" (never who) */
async function roleView(s, p) {
  const out = { role: p.role };
  if (p.role === FAKE_SUPPORTER || p.role === FAKE_LEADER || p.role === TRUE_SUPPORTER) {
    const players = (await allPlayers(s)).map(normalize);
    if (p.role === TRUE_SUPPORTER) {
      const l = players.find((q) => q.role === TRUE_LEADER);
      out.supports = l ? { characterId: l.characterId } : null;
    } else if (p.role === FAKE_SUPPORTER) {
      const l = players.find((q) => q.id === p.supports && q.role === FAKE_LEADER);
      out.supports = l ? { characterId: l.characterId } : null;
    } else {
      out.helped = players.some((q) => q.role === FAKE_SUPPORTER && q.supports === p.id);
    }
  }
  return out;
}

/** Pair every 假領袖支持者 with exactly one 假領袖 (server-side, deterministic, stable).
    - an existing pairing is kept as long as that player is still a 假領袖
    - unpaired supporters (oldest join first) take the 假領袖 with the fewest supporters; ties -> letter A–D,
      then join order. So with ≤ as many supporters as fake leaders everyone backs a DIFFERENT fake leader;
      extra supporters double up only once every fake leader has one.
    - no 假領袖 at all -> supports = null
    Any player whose card content changes (supporter's leader, fake leader gaining/losing a helper) gets
    revealedAt cleared so the phone shows 揭曉 again. Called after every role change and when the stage starts. */
async function syncPairs(s) {
  const players = (await allPlayers(s)).map(normalize);
  const order = (a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : 1);
  const letterIdx = (p) => { const i = LEADER_LABELS.indexOf(p.leader); return i < 0 ? 99 : i; };
  const leaders = players.filter((p) => p.role === FAKE_LEADER).sort((a, b) => letterIdx(a) - letterIdx(b) || order(a, b));
  const sups = players.filter((p) => p.role === FAKE_SUPPORTER).sort(order);
  const load = new Map(leaders.map((l) => [l.id, 0]));
  const want = new Map();
  for (const sp of sups) if (load.has(sp.supports)) { want.set(sp.id, sp.supports); load.set(sp.supports, load.get(sp.supports) + 1); }
  for (const sp of sups) {
    if (want.has(sp.id)) continue;
    let best = null;
    for (const l of leaders) if (!best || load.get(l.id) < load.get(best.id)) best = l;
    want.set(sp.id, best ? best.id : null);
    if (best) load.set(best.id, load.get(best.id) + 1);
  }
  const helpedBefore = new Set(players.filter((p) => p.role === FAKE_SUPPORTER && p.supports).map((p) => p.supports));
  const helpedAfter = new Set([...want.values()].filter(Boolean));
  const jobs = [];
  for (const p of players) {
    const next = p.role === FAKE_SUPPORTER ? (want.get(p.id) || null) : null;
    const helpFlip = p.role === FAKE_LEADER && helpedBefore.has(p.id) !== helpedAfter.has(p.id);
    if ((p.supports || null) === next && !helpFlip) continue;
    jobs.push(update(s, 'players/' + p.id, (q) => {
      if ((q.supports || null) !== next || helpFlip) q.revealedAt = null;
      q.supports = next; return q;
    }));
  }
  await Promise.all(jobs);
  return Object.fromEntries([...want].filter(([, v]) => v));
}

/** POST /api/reveal-ack — the player tapped 揭曉我的身份 (only while roles are revealed). */
async function revealAck(req, s) {
  const p0 = await playerFrom(req, s);
  if (!p0) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  const meta = await getMeta(s);
  if (!meta.revealed) fail(409, 'not_revealed', '主持人還沒開始身份揭曉');
  const p = await update(s, 'players/' + p0.id, (q) => { if (!q.revealedAt) q.revealedAt = now(); return q; });
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  return { ok: true, ...(await roleView(s, normalize(p))), seen: true };
}

async function adminState(s) {
  const [players, counts, meta] = await Promise.all([allPlayers(s), getRoleCounts(s), getMeta(s)]);
  const seen = await Promise.all(players.map((p) => s.get('seen/' + p.id, { type: 'json' })));
  const t = now();
  const list = players.map((p, i) => ({
    id: p.id, characterId: p.characterId, nickname: p.nickname || '', joinedAt: p.joinedAt,
    lastSeen: seen[i] ? seen[i].t : null, online: !!(seen[i] && t - seen[i].t < ONLINE_MS),
    role: p.role, leader: p.leader || null, seen: !!p.revealedAt,
    supports: p.role === FAKE_SUPPORTER ? (p.supports || null) : null,   // admin-only: which 假領袖 (player id) they back
  })).sort((a, b) => a.joinedAt - b.joinedAt);
  const assigned = Object.fromEntries(ROLE_ORDER.map((r) => [r, 0]));
  for (const p of list) assigned[p.role] = (assigned[p.role] || 0) + 1;
  const archive = (await listKeys(s, 'archive/')).sort().reverse().slice(0, 20);
  const reveal = { stage: screenOf(meta) === REVEAL, revealed: !!meta.revealed, done: list.filter((p) => p.seen).length, total: list.length };
  const votes = await adminVotes(s, meta, players);
  const sc = screenOf(meta), speak = ROUND_SCREENS.includes(sc) ? speakView(meta, sc) : null;
  const quiz = await adminQuiz(s, await quizSettle(s, meta), players, await getContent(s));
  const final = await adminFinal(s, meta, players.map(normalize));
  // 遊戲內容: which character currently holds 假領袖詞語 1–3 (null = not assigned yet -> admin labels it by slot)
  const fakeWords = fakeOrder(players.map(normalize)).slice(0, FAKE_WORDS).map((q) => q.characterId);
  const hv = sc === HOWTO ? await howtoView(s, meta) : null;
  const howto = { on: sc === HOWTO, allowed: !meta.revealed, page: hv ? hv.page : 0, pages: HOWTO_PAGES, auto: hv ? hv.auto : howtoAuto({ auto: { sec: meta.howto && meta.howto.auto && meta.howto.auto.sec } }, t) };
  const rt = rtStatus(meta, await rtTv(s, true));
  return { meta, votes, quiz, final, howto, rt, fakeWords, voteDurations: VOTE_DURATIONS, speak, speakDurations: SPEAK_DURATIONS, roles: counts, civilian: CIVILIAN, roleOrder: ROLE_ORDER, leaderRoles: LEADER_ROLES, leaderLabels: LEADER_LABELS.slice(0, slotCount(counts)), leaderSlots: slotCount(counts), maxLeaders: LEADER_LABELS.length, fakeWordSlots: FAKE_WORDS, assigned, players: list, reveal, archive, serverTime: t };
}

async function setRole(req, s) {
  const b = await body(req);
  const counts = await getRoleCounts(s);
  const role = b.role == null ? CIVILIAN : b.role;   // there is no "unassigned" any more
  if (!isRole(role)) fail(400, 'bad_role', '未知的角色');
  const players = await allPlayers(s);
  const target = players.find((p) => p.id === b.playerId);
  if (!target) fail(404, 'no_player', '找不到此玩家');
  const others = players.filter((p) => p.id !== target.id);
  if (role !== CIVILIAN && others.filter((p) => p.role === role).length >= counts[role]) fail(409, 'role_full', `「${role}」已達上限 ${counts[role]} 人`);
  let leader = null;
  if (LEADER_ROLES.includes(role)) {
    const used = new Set(others.filter((p) => LEADER_ROLES.includes(p.role) && p.leader).map((p) => p.leader));
    if (b.leader) {
      if (!LEADER_LABELS.includes(b.leader)) fail(400, 'bad_leader', 'bad leader slot');
      if (used.has(b.leader)) fail(409, 'leader_taken', '這個領袖位置（顏色）已被使用');
      leader = b.leader;
    } else if (LEADER_ROLES.includes(target.role) && target.leader && !used.has(target.leader)) {
      leader = target.leader;
    } else {
      leader = LEADER_LABELS.find((l) => !used.has(l)) || null;
    }
  }
  await update(s, 'players/' + target.id, (p) => {
    if (p.role !== role) p.revealedAt = null;   // role changed -> the phone shows 揭曉 again (the internal slot is never shown, so moving it doesn't)
    p.role = role; p.leader = leader; return p;
  });
  await syncPairs(s);
  return { ok: true, role, leader };
}

async function randomAssign(s) {
  const counts = await getRoleCounts(s);
  const players = shuffle(await allPlayers(s));
  // special roles go to random players; everyone else is 平民. With too few players the
  // most important special roles are filled first (pool is in priority order).
  const pool = [];
  for (const r of SPECIAL_ROLES) for (let i = 0; i < (counts[r] || 0); i++) pool.push(r);
  const special = pool.slice(0, players.length);
  const roles = shuffle([...special, ...Array(Math.max(0, players.length - special.length)).fill(CIVILIAN)]);
  const labels = shuffle(LEADER_LABELS.slice(0, Math.max(slotCount(counts), special.filter((r) => LEADER_ROLES.includes(r)).length)));
  let li = 0;
  await Promise.all(players.map((pl, i) => {
    const role = roles[i];
    const leader = LEADER_ROLES.includes(role) ? (labels[li++] || null) : null;
    return update(s, 'players/' + pl.id, (p) => { if (p.role !== role) p.revealedAt = null; p.role = role; p.leader = leader; p.supports = null; return p; });
  }));
  await syncPairs(s);   // fresh deal -> fresh pairing
  const missing = pool.slice(special.length);
  return {
    ok: true, special: special.length, civilians: players.length - special.length,
    missingRoles: missing.length, missing: Object.fromEntries(SPECIAL_ROLES.map((r) => [r, missing.filter((x) => x === r).length]).filter(([, n]) => n)),
  };
}

async function clearRoles(s) {
  const players = await allPlayers(s);
  await Promise.all(players.map((pl) => update(s, 'players/' + pl.id, (p) => { if (p.role !== CIVILIAN || p.leader) p.revealedAt = null; p.role = CIVILIAN; p.leader = null; p.supports = null; return p; })));
  return { ok: true };
}

async function kick(req, s) {
  const b = await body(req);
  const p = await s.get('players/' + b.playerId, { type: 'json' });
  if (!p) fail(404, 'no_player', '找不到此玩家');
  await s.delete('players/' + p.id);
  await s.delete('seen/' + p.id);
  await s.delete('mini/' + p.id);
  await release(s, p.characterId, p.id);
  if (p.role === FAKE_LEADER || p.role === FAKE_SUPPORTER) await syncPairs(s);   // re-pair around the removed player
  return { ok: true };
}

async function reset(s) {
  const meta = await getMeta(s);
  const players = await allPlayers(s);
  const t = now();
  if (players.length) {
    await s.setJSON(`archive/${t}-${meta.gameId}`, {
      gameId: meta.gameId, startedAt: meta.startedAt, endedAt: t,
      players: players.sort((a, b) => a.joinedAt - b.joinedAt).map((p) => ({ characterId: p.characterId, nickname: p.nickname || '', joinedAt: p.joinedAt, role: p.role, leader: p.leader || null, supports: (players.find((q) => q.id === p.supports) || {}).characterId || null })),
    });
  }
  const keys = [...await listKeys(s, 'players/'), ...await listKeys(s, 'claims/'), ...await listKeys(s, 'seen/'), ...await listKeys(s, 'mini/'), ...await listKeys(s, 'ballots/'), ...await listKeys(s, 'answers/')];
  await Promise.all(keys.map((k) => s.delete(k)));
  const next = { gameId: rid(6), startedAt: t, revealed: false, phase: LOBBY, phaseAt: t };
  if (meta.rtOff) next.rtOff = true;               // the 即時連線 switch survives a new game
  await s.setJSON('meta', next);
  return { ok: true, archived: players.length, gameId: next.gameId };
}

async function setConfig(req, s) {
  const b = await body(req);
  if ((await getMeta(s)).revealed) fail(409, 'revealed', '身份已揭曉：新一場才可更改身份人數');
  const roles = {};
  for (const r of SPECIAL_ROLES) {
    const n = b.roles && Number.isInteger(b.roles[r]) ? b.roles[r] : DEFAULT_ROLES[r];
    if (n < 0 || n > 20) fail(400, 'bad_count', '人數需介於 0–20');
    roles[r] = n;
  }
  if (roles[TRUE_LEADER] + roles[FAKE_LEADER] > LEADER_LABELS.length) fail(400, 'bad_count', `領袖（真正領袖 + 假領袖）最多 ${LEADER_LABELS.length} 位`);
  if (roles[TRUE_LEADER] + roles[FAKE_LEADER] < 1) fail(400, 'bad_count', '最少要有 1 位領袖');
  await s.setJSON('config', { roles });
  roleCache = { t: now(), data: roles }; SLOT_N = slotCount(roles);
  return { ok: true, roles };
}

async function setRevealed(req, s) {
  const b = await body(req);
  const m = await update(s, 'meta', (m) => {
    m.revealed = !!b.revealed;
    if (!m.revealed && m.tvScreen === REVEAL) m.tvScreen = LOBBY;   // hiding roles also ends the stage
    return m;
  });
  return { ok: true, revealed: m.revealed, phase: phaseOf(m), screen: screenOf(m) };
}

/* 身份揭曉 stage. on: phones may see their own role (meta.revealed = true, stays on for the rest of
   the game), the game counts as started (mini game stops) and the TV shows the reveal progress.
   off: TV back to the "Let's play" screen; roles stay viewable on the phones. */
async function setRevealStage(req, s) {
  const b = await body(req);
  return revealStage(s, b.on !== false);
}
async function revealStage(s, on) {
  const m = await update(s, 'meta', (m) => {
    if (on) {
      if (m.phase !== STARTED) m.phaseAt = now();
      m.phase = STARTED; m.tvScreen = REVEAL; m.revealed = true;
    } else if (m.tvScreen === REVEAL) m.tvScreen = LOBBY;
    return m;
  });
  if (!m) { await getMeta(s); return revealStage(s, on); }
  if (on) await syncPairs(s);   // safety net: every 假領袖支持者 is paired before phones can reveal
  return { ok: true, phase: phaseOf(m), screen: screenOf(m), revealed: !!m.revealed };
}

/* ---------------- votes (per round; r3 = 最後投票) ----------------
   admin/vote {round, duration} opens a vote: meta.votes[round] = { id, openedAt, duration (s, 0 = 無限), deadline (0 = none),
   closedAt, leaders (snapshot of the leader cards: [{id, characterId} | null] x 4) }, meta.vote = round.
   A vote closes at its deadline — checked on every read/write, no cron — or early via admin/vote-end.
   Opening a round again restarts it (that round's ballots are cleared; its 私下敲門 stays once per round); 新一場 clears everything.
   Leaders (真正領袖 / 假領袖) don't vote; everyone else votes once per round and may change it until it closes.
   ballots/<round>/<playerId> = { target (leader player id), characterId, at, pool, li }.
   After a vote the phone shows one hint line, picked HERE (the pools never reach the client): a vote for a 假領袖 gets a
   line that mentions 「更改投票」, a vote for the 真正領袖 gets an equally plain line that doesn't. Re-picked on every
   vote/change, stored in the ballot so a reload shows the same line. Once the vote is closed (timer, admin or 封票)
   no hint line is returned at all, so an F line never invites a change that is no longer possible.
   封票: as soon as every eligible player has voted the vote seals (closedAt + sealed) even with time left. */
const VOTE_DURATIONS = [30, 45, 60, 90, 0];
const HINTS = {
  f: [
    '你仍可點擊「更改投票」重新選擇。',
    '改變主意了？點擊「更改投票」即可重選。',
    '投票結束前，隨時可以「更改投票」。',
    '再想一想也無妨，可點擊「更改投票」。',
    '如有疑慮，可點擊「更改投票」重新選擇。',
    '時間結束前，你都可以「更改投票」喔。',
  ],
  t: [
    '好好留意大家接下來的發言吧。',
    '投票結果將於本輪結束後公佈。',
    '請耐心等候其他玩家完成投票。',
    '相信自己的判斷，靜待結果吧。',
    '記住你的選擇，看看誰跟你一樣。',
    '留意 TV，主持人即將進行下一步。',
  ],
};
const TRUE_LEADER = '真正領袖';
const canVote = (p) => !!p && !LEADER_ROLES.includes(p.role);
const voteOpen = (v, t = now()) => !!v && !v.closedAt && (!v.deadline || t < v.deadline);
const voteEndAt = (v) => (v ? v.closedAt || (v.deadline && now() >= v.deadline ? v.deadline : 0) : 0);
function currentVote(m) {
  if (phaseOf(m) !== STARTED || !m.revealed) return null;   // back to 等候 / un-revealed -> no vote anywhere
  const r = m.vote, v = r && m.votes && m.votes[r];
  return v ? { round: r, ...v } : null;
}
const ballotKeys = (s, r) => listKeys(s, 'ballots/' + r + '/');
async function ballotsOf(s, r) {
  const keys = await ballotKeys(s, r);
  const bs = await Promise.all(keys.map((k) => s.get(k, { type: 'json' })));
  return keys.map((k, i) => bs[i] && { voter: k.slice(k.lastIndexOf('/') + 1), ...bs[i] }).filter(Boolean);
}

/** what a phone may know about the current vote (its own ballot only; never counts or other players' votes) */
async function voteView(s, p, v) {
  const t = now(), open = voteOpen(v, t), end = voteEndAt(v);
  const out = { id: v.id, round: v.round, final: v.round === 'r3', open, sealed: !!v.sealed, eligible: canVote(p),
    remain: open && v.deadline ? Math.max(0, v.deadline - t) : null, endedAgo: open ? null : t - end,
    leaders: (v.leaders || []).map((l) => (l ? { characterId: l.characterId } : null)), mine: null };
  if (out.eligible && (open || t - end < 10 * 60e3)) {
    const b = await s.get(`ballots/${v.round}/${p.id}`, { type: 'json' });
    if (b && (v.leaders || []).some((l) => l && l.id === b.target)) out.mine = { characterId: b.characterId, line: open ? (HINTS[b.pool] || HINTS.t)[b.li] || '' : '' };   // the hint only while a change is still possible
  }
  return out;
}

/** POST /api/vote {characterId} — cast or change this player's vote in the open round */
async function castVote(req, s) {
  const b = await body(req);
  const [p, meta] = await Promise.all([playerFrom(req, s, b), getMeta(s)]);
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  const v = currentVote(meta);
  if (!v || !voteOpen(v)) fail(409, 'vote_closed', '投票已結束');
  if (b.round && b.round !== v.round) fail(409, 'vote_closed', '投票已結束');
  if (!canVote(p)) fail(403, 'no_vote', '領袖不參與投票');
  const slot = (v.leaders || []).find((l) => l && l.characterId === b.characterId);
  if (!slot) fail(400, 'bad_target', '請選擇一位領袖');
  if (slot.id === p.id) fail(400, 'self_vote', '不能投給自己');
  const target = await s.get('players/' + slot.id, { type: 'json' });
  const pool = target && target.role === TRUE_LEADER ? 't' : 'f';
  const key = `ballots/${v.round}/${p.id}`;
  const r = await upsert(s, key, (old) => {
    const n = HINTS[pool].length;
    let li = randomBytes(4).readUInt32LE() % n;
    if (old && old.pool === pool && n > 1 && li === old.li) li = (li + 1 + randomBytes(4).readUInt32LE() % (n - 1)) % n;   // a change always shows a new line
    return { target: slot.id, characterId: slot.characterId, at: now(), vid: v.id, pool, li };
  });
  if (!r) fail(409, 'busy', '伺服器忙碌，請再試一次');
  // everyone eligible has voted -> 封票: the vote closes at once (no more changes), even with time left
  const sealed = await sealIfDone(s, v, await allPlayers(s));
  return { ok: true, round: v.round, sealed, mine: { characterId: r.characterId, line: sealed ? SEALED_LINE : HINTS[r.pool][r.li] } };
}

/** 封票: once every eligible (non-leader) player has a ballot in the open vote, close it (closedAt + sealed).
    Called after each vote and from the TV poll (covers a kick / role change that completes the set). */
const SEALED_LINE = '所有人已完成投票，票已封存。';
async function sealIfDone(s, v, players, keys) {
  if (!voteOpen(v)) return !!v.sealed;
  const elig = new Set(players.filter(canVote).map((p) => p.id));
  if (!elig.size) return false;
  keys = keys || await ballotKeys(s, v.round);
  const voted = new Set(keys.map((k) => k.slice(k.lastIndexOf('/') + 1)).filter((id) => elig.has(id)));
  if (voted.size < elig.size) return false;
  const t = now();
  const m = await update(s, 'meta', (m) => {
    const x = m.votes && m.votes[v.round];
    if (!x || x.id !== v.id || !voteOpen(x, t)) return undefined;
    x.closedAt = t; x.sealed = true; return m;
  });
  const x = m && m.votes && m.votes[v.round];
  return !!(x && x.sealed);
}

/** POST /api/admin/vote {round, duration} — open (or restart) the vote for a round; closes any other open vote */
async function openVote(req, s) {
  const b = await body(req);
  if (!ROUND_SCREENS.includes(b.round)) fail(400, 'bad_round', '未知的回合');
  const duration = b.duration == null ? 45 : Number(b.duration);
  if (!VOTE_DURATIONS.includes(duration)) fail(400, 'bad_duration', '不支援的投票時間');
  const meta0 = await getMeta(s);
  if (phaseOf(meta0) !== STARTED || !meta0.revealed) fail(409, 'not_started', '請先完成身份揭曉再開始投票');
  const players = await allPlayers(s);
  const leaders = leaderSlots(players).map((p) => (p ? { id: p.id, characterId: p.characterId } : null));
  if (!leaders.some(Boolean)) fail(409, 'no_leaders', '還沒有領袖，無法投票');
  // (re)starting a round is a fresh vote: that round's earlier ballots are cleared (a 私下敲門 stays once per round)
  if (meta0.votes && meta0.votes[b.round]) await Promise.all((await ballotKeys(s, b.round)).map((k) => s.delete(k)));
  const t = now();
  const m = await update(s, 'meta', (m) => {
    m.votes = m.votes || {};
    for (const r of Object.keys(m.votes)) if (voteOpen(m.votes[r], t)) m.votes[r].closedAt = t;
    const sp = m.speaks && m.speaks[b.round];
    if (speakLive(sp, t)) sp.endedAt = t;   // the vote starts -> that round's 發言 is over
    m.votes[b.round] = { id: rid(4), openedAt: t, duration, deadline: duration ? t + duration * 1000 : 0, closedAt: 0, leaders };
    m.vote = b.round;
    return m;
  });
  return { ok: true, vote: currentVote(m) };
}
/* Leader instructions on the phone's round page (served by /api/me to that leader only, by their own role).
   True and fake read the same layout / length; gender-neutral. Rounds without an entry fall back to data/texts.json. */
const LEADER_TEXT = {
  r1: {
    '真正領袖': { desc: '輪到你時，分享三句關於自己的說話——三句都必須是真的。', tip: '小心！你的另一半最了解你，別讓對方輕易猜中。' },
    '假領袖': { desc: '輪到你時，分享三句關於自己的說話——兩句真、一句假。', tip: '另一半最清楚你，假的那句要編得巧妙，別讓對方一聽就拆穿！' },
  },
  // Round 2: true and fake read EXACTLY the same copy (only the word in the 「你的詞語」 card differs)
  r2: {
    '真正領袖': { desc: '輪到你時，描述你的詞語，但不可以直接說出來，盡力說服大家你就是真領袖。', tip: '描述要貼近你的詞語，但別說得太白；也留意其他領袖怎樣說。' },
    '假領袖': { desc: '輪到你時，描述你的詞語，但不可以直接說出來，盡力說服大家你就是真領袖。', tip: '描述要貼近你的詞語，但別說得太白；也留意其他領袖怎樣說。' },
  },
  r3: {
    '真正領袖': { desc: '領袖不參與作答。輪到你時，按主持人指示發言。', tip: '留意討論，想好怎樣說服大家跟隨你！', placeholder: true },
    '假領袖': { desc: '領袖不參與作答。輪到你時，按主持人指示發言。', tip: '留意討論，想好怎樣說服大家跟隨你！', placeholder: true },
  },
};
/** a leader's own follower count for a round: { state: 'none' (no vote yet) | 'open' | 'closed', count (closed only) }.
    Closed votes never change -> cached per vote id + leader (+ player set) in the warm instance. */
const followCache = new Map();
async function followersOf(s, meta, p, round, players) {
  const v = meta.votes && meta.votes[round];
  if (!v) return { state: 'none', count: null };
  if (voteOpen(v)) return { state: 'open', count: null };
  const key = `${meta.gameId}:${round}:${v.id}:${v.closedAt || v.deadline}:${p.id}:${players.map((q) => q.id + q.role).join(',')}`;
  if (!followCache.has(key)) {
    const byId = new Map(players.map((q) => [q.id, q]));
    const n = (await ballotsOf(s, round)).filter((x) => x.target === p.id && byId.has(x.voter) && canVote(byId.get(x.voter))).length;
    if (followCache.size > 200) followCache.clear();
    followCache.set(key, n);
  }
  return { state: 'closed', count: followCache.get(key), sealed: !!v.sealed };
}

/* ---------------- speaking (發言 timer, per round) ----------------
   admin/speak {round, duration} starts (or restarts) a round's 發言 timer: meta.speaks[round] = { id, startedAt,
   duration (s, 0 = 不限), deadline (0 = none), endedAt }. admin/speak-end {round} ends it early; opening that round's
   vote ends it too. Computed on read (no cron). Phones (/me -> round.speak) and the TV (mini/state -> speak) get
   { round, state: 'ready' | 'live' | 'done', remain (ms, null = 不限), duration } — nothing else. */
const SPEAK_DURATIONS = [30, 60, 90, 120, 0];
const speakLive = (x, t = now()) => !!x && !x.endedAt && (!x.deadline || t < x.deadline);
function speakView(m, r) {
  const x = m && m.speaks && m.speaks[r], t = now();
  if (!x) return { round: r, state: 'ready', remain: null, duration: null };
  if (speakLive(x, t)) return { round: r, id: x.id, state: 'live', remain: x.deadline ? Math.max(0, x.deadline - t) : null, duration: x.duration };
  return { round: r, id: x.id, state: 'done', remain: 0, duration: x.duration };
}
/** POST /api/admin/speak {round, duration} — start (or restart) the 發言 timer for a round */
async function startSpeak(req, s) {
  const b = await body(req);
  const meta0 = await getMeta(s);
  const round = b.round || screenOf(meta0);
  if (!ROUND_SCREENS.includes(round)) fail(400, 'bad_round', '未知的回合');
  const duration = b.duration == null ? 60 : Number(b.duration);
  if (!SPEAK_DURATIONS.includes(duration)) fail(400, 'bad_duration', '不支援的發言時間');
  if (phaseOf(meta0) !== STARTED) fail(409, 'not_started', '請先開始遊戲');
  const t = now();
  const m = await update(s, 'meta', (m) => {
    m.speaks = m.speaks || {};
    m.speaks[round] = { id: rid(4), startedAt: t, duration, deadline: duration ? t + duration * 1000 : 0, endedAt: 0 };
    return m;
  });
  return { ok: true, speak: speakView(m, round) };
}
/** POST /api/admin/speak-end {round} — end a round's 發言 early (default: the round on the TV) */
async function endSpeak(req, s) {
  const b = await body(req);
  const meta0 = await getMeta(s);
  const round = b.round || screenOf(meta0);
  if (!ROUND_SCREENS.includes(round)) fail(400, 'bad_round', '未知的回合');
  const t = now();
  const m = await update(s, 'meta', (m) => {
    const x = m.speaks && m.speaks[round];
    if (!speakLive(x, t)) return undefined;
    x.endedAt = t; return m;
  });
  return { ok: true, speak: speakView(m || meta0, round) };
}

/** POST /api/admin/vote-end — close the current vote early */
async function endVote(s) {
  const t = now();
  const m = await update(s, 'meta', (m) => {
    const v = m.vote && m.votes && m.votes[m.vote];
    if (!voteOpen(v, t)) return undefined;
    v.closedAt = t; return m;
  });
  return { ok: true, vote: currentVote(m) };
}
/** admin-only: every round's ballots (who voted for whom) + counts */
async function adminVotes(s, meta, players) {
  const t = now(), byId = new Map(players.map((p) => [p.id, p]));
  const eligible = players.filter(canVote);
  const out = {};
  for (const r of ROUND_SCREENS) {
    const v = meta.votes && meta.votes[r];
    if (!v) continue;
    const list = (await ballotsOf(s, r)).filter((x) => byId.has(x.voter) && canVote(byId.get(x.voter)));
    const tally = {};
    for (const x of list) tally[x.target] = (tally[x.target] || 0) + 1;
    out[r] = { id: v.id, open: voteOpen(v, t), sealed: !!v.sealed, openedAt: v.openedAt, duration: v.duration, deadline: v.deadline || 0, endedAt: voteEndAt(v),
      remain: voteOpen(v, t) && v.deadline ? Math.max(0, v.deadline - t) : null, leaders: v.leaders || [],
      ballots: list.map((x) => ({ voter: x.voter, target: x.target, characterId: x.characterId, at: x.at })), tally,
      voted: list.length, total: eligible.length };
  }
  return out;
}

/* ---------------- knocks (私下敲門) ----------------
   Once a round's vote has closed (封票 / timer / admin), the 真正領袖 — and only them — may knock ONCE for that round:
   the server picks the targets (see pickKnock: 2 voters of the SAME fake leader, else 1 fake-leader voter, else none);
   the true leader cannot choose. The notification only hints "you may not be following the right leader" — it never
   says who the true leader is, nor which fake leader they followed (admin sees both). Stored in meta.knocks[round] (kept for the
   final reveal; cleared by 新一場). The knocked players see a private notification via their own /me poll until they
   dismiss it (POST /api/knock-ack). Fake leaders see nothing extra; the TV and the public endpoints never mention knocks.
   KNOCK_SHOW_TARGETS: whether the true leader's phone is told WHO was knocked (default: no — only 「已敲門」). */
const KNOCK_COUNT = 2;
const KNOCK_SHOW_TARGETS = false;
function knockRound(meta) {
  const v = currentVote(meta);
  return v && !voteOpen(v) ? v : null;   // the most recent vote, once it's closed
}
/** who gets knocked: voters of ONE fake leader. A 假領袖 with >= KNOCK_COUNT voters this round is picked at random
    among those that qualify, then KNOCK_COUNT of its voters at random. If none has that many: exactly 1 random player
    who voted for any fake leader. Nobody voted for a fake leader -> nobody. Non-voters are never knocked. */
function pickKnock(players, ballots, trueId) {
  const byId = new Map(players.map((q) => [q.id, q]));
  const by = new Map();   // fake leader id -> [voter ids]
  for (const b of ballots) {
    const voter = byId.get(b.voter), target = byId.get(b.target);
    if (!canVote(voter) || !target || target.id === trueId || target.role !== FAKE_LEADER) continue;
    if (!by.has(target.id)) by.set(target.id, []);
    by.get(target.id).push(voter.id);
  }
  const ok = [...by.keys()].filter((id) => by.get(id).length >= KNOCK_COUNT);
  if (ok.length) {
    const fake = shuffle(ok)[0];
    return { fake, targets: shuffle([...by.get(fake)]).slice(0, KNOCK_COUNT) };
  }
  const all = [...by.entries()].flatMap(([f, vs]) => vs.map((x) => [f, x]));
  if (!all.length) return { fake: null, targets: [] };
  const [fake, one] = shuffle(all)[0];
  return { fake, targets: [one] };
}
/** the knock UI (真正領袖's 私下敲門 / 已敲門, the knocked player's 叩叩) lives only while the game is still on the round it
    happened in: once the TV moves on to another round (or 最終揭曉 / 結局) it is no longer shown to anyone. Each round's knock is
    independent; meta.knocks keeps the record (for the admin / final reveal) — only the phone view is scoped. */
const KNOCK_GONE = [...ROUND_SCREENS, FINAL, ENDING];
const knockLive = (meta, round) => { const sc = screenOf(meta); return !(KNOCK_GONE.includes(sc) && sc !== round); };
/** the true leader's own knock status for the latest closed vote (no other player's info unless KNOCK_SHOW_TARGETS) */
function knockView(meta, p) {
  if (!p || p.role !== TRUE_LEADER) return undefined;
  const v = knockRound(meta);
  if (!v || !knockLive(meta, v.round)) return undefined;
  const k = meta.knocks && meta.knocks[v.round];
  if (k && k.vid !== v.id) return { round: v.round, available: false, done: false };   // an older run of this round
  const out = { round: v.round, available: !k, done: !!k, count: k ? k.targets.length : 0 };
  if (k && KNOCK_SHOW_TARGETS) out.targets = k.targets;
  return out;
}
/** knocks addressed to this player that they haven't dismissed yet (round + time only — never who knocked) */
function knocksFor(meta, p) {
  const out = [];
  const v = knockRound(meta);   // only the round still in play (its vote closed, TV not yet on another round)
  for (const r of ROUND_SCREENS) {
    if (!v || v.round !== r || !knockLive(meta, r)) continue;
    const k = meta.knocks && meta.knocks[r];
    if (k && k.targets.includes(p.id) && !(k.seen && k.seen[p.id])) out.push({ round: r, at: k.at });
  }
  return out;
}
/** POST /api/knock — the true leader knocks (server picks the targets) */
async function knock(req, s) {
  const [p, meta0] = await Promise.all([playerFrom(req, s), getMeta(s)]);
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  if (normalize(p).role !== TRUE_LEADER) fail(403, 'not_allowed', '你不能使用這個功能');
  const v = knockRound(meta0);
  if (!v) fail(409, 'not_ready', '投票結束後才能敲門');
  const old = meta0.knocks && meta0.knocks[v.round];
  if (old) {
    if (old.vid !== v.id) fail(409, 'not_ready', '投票結束後才能敲門');
    return { ok: true, round: v.round, done: true, count: old.targets.length, ...(KNOCK_SHOW_TARGETS ? { targets: old.targets } : {}) };
  }
  const [players, ballots] = await Promise.all([allPlayers(s), ballotsOf(s, v.round)]);
  const pick = pickKnock(players, ballots, p.id);
  const m = await update(s, 'meta', (m) => {
    m.knocks = m.knocks || {};
    if (m.knocks[v.round]) return undefined;   // a concurrent tap already knocked: keep the first
    m.knocks[v.round] = { at: now(), by: p.id, vid: v.id, targets: pick.targets, fake: pick.fake, seen: {} };
    return m;
  });
  const k = m.knocks[v.round];
  return { ok: true, round: v.round, done: true, count: k.targets.length, ...(KNOCK_SHOW_TARGETS ? { targets: k.targets } : {}) };
}
/** POST /api/knock-ack {round} — the knocked player dismissed the notification */
async function knockAck(req, s) {
  const b = await body(req);
  const p = await playerFrom(req, s, b);
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  if (!ROUND_SCREENS.includes(b.round)) fail(400, 'bad_round', '未知的回合');
  await update(s, 'meta', (m) => {
    const k = m.knocks && m.knocks[b.round];
    if (!k || !k.targets.includes(p.id) || (k.seen && k.seen[p.id])) return undefined;
    k.seen = k.seen || {}; k.seen[p.id] = now(); return m;
  });
  return { ok: true };
}

/* ---------------- waiting-room mini game ----------------
   All physics runs on the TV page; phones only send batched inputs. */
async function miniAct(req, s) {
  const b = await body(req);
  const pid = req.headers.get('x-player-id') || b.playerId;
  const key = 'mini/' + (typeof pid === 'string' && pid.length <= 40 ? pid : '_');
  // latency: auth, phase and the current counters are read in ONE parallel round, then one write
  // (was: auth+meta, then read counters, then write = 3 sequential blob round trips)
  const [p, meta, cur] = await Promise.all([playerFrom(req, s, b), getMeta(s), s.getWithMetadata(key, { type: 'json' })]);
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  const id = p.id;
  if (phaseOf(meta) === STARTED) fail(409, 'started', '遊戲已開始');
  const push = Math.max(0, Math.min(MINI_MAX_PUSH, Math.floor(Number(b.push) || 0)));
  const dodge = b.dodge ? 1 : 0;
  const seq = Math.floor(Number(b.seq) || 0);   // phone uses a time-based increasing seq (survives reloads)
  if (!push && !dodge) return { ok: true, phase: LOBBY };
  const t = now();
  const apply = (m) => {
    m = m || { push: 0, dodge: 0, seq: 0, pt: 0, dt: 0 };
    if (seq && seq <= m.seq) return m;          // duplicate / retried batch (rewrites the same value)
    m.push += push; m.dodge += dodge; if (seq) m.seq = seq;
    if (push) m.pt = t; if (dodge) m.dt = t;
    m.t = t;
    return m;
  };
  let r = apply(cur ? structuredClone(cur.data) : null);
  const w = await s.setJSON('mini/' + id, r, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  if (!w.modified) r = await upsert(s, 'mini/' + id, apply);   // rare: two writes from the same phone raced
  if (!r) fail(409, 'busy', '伺服器忙碌，請再試一次');
  return { ok: true, phase: LOBBY, push: r.push, dodge: r.dodge };
}

/* TV poll (~6-7x/s): list players/ and m* (meta + mini/*) once each, then fetch only the blobs whose
   etag changed since this warm function instance last saw them. */
const blobCache = new Map();   // key -> { etag, data }
async function listWithEtags(s, prefix) {
  const out = [];
  for await (const page of s.list({ prefix, paginate: true })) out.push(...page.blobs);
  return out;
}
async function cachedGet(s, blobs) {
  return Promise.all(blobs.map(async ({ key, etag }) => {
    const c = blobCache.get(key);
    if (c && etag && c.etag === etag) return c.data;
    if (c && c.spec) { c.spec = false; return c.data; }   // fetched speculatively in this poll: same or newer
    const r = await s.getWithMetadata(key, { type: 'json' });
    if (r) blobCache.set(key, { etag: r.etag || etag, data: r.data });
    return r ? r.data : null;
  }));
}
// Players who tapped recently: their mini/<id> blob is fetched speculatively IN PARALLEL with the
// list calls, so a tap usually reaches the TV in one blob round trip instead of two (list -> get).
// Only while the cached meta says LOBBY (taps only change mini/* there) and only for taps in the last 3 s:
// after a player stops tapping the TV stops re-reading their blob almost at once (was 20 s of wasted gets).
const ACTIVE_MS = 3000, ACTIVE_MAX = 8;
function activeMiniKeys() {
  const t = now(), out = [], mc = blobCache.get('meta');
  if (mc && mc.data && phaseOf(mc.data) !== LOBBY) return out;
  for (const [k, c] of blobCache) if (k.startsWith('mini/') && c.data && t - (c.data.t || 0) < ACTIVE_MS) out.push([k, c.data.t]);
  return out.sort((a, b) => b[1] - a[1]).slice(0, ACTIVE_MAX).map((x) => x[0]);
}
/* ---------------- 即時連線 (Ably) for the lobby bubble battle ----------------
   ABLY_API_KEY ("<appId>.<keyId>:<secret>") stays on the server: we only hand out signed Ably TokenRequests
   (HMAC-SHA256, same format as the Ably SDK's createTokenRequest), each limited to this game's lobby channel:
   a phone may only PUBLISH, as clientId = its player id; the TV may only SUBSCRIBE. The TV keeps the tally.
   Admin switch: meta.rtOff (default on). Anything wrong -> everyone falls back to the polling path. */
const RT_FRESH_MS = 25000;            // the TV re-reports 'ably' every 10 s; older than this = not connected
const RT_TTL_MS = 60 * 60 * 1000;
const RT_REASONS = ['off', 'started', 'token', 'connect', 'drop', 'quota', 'sdk'];
function rtKey() {
  const k = process.env.ABLY_API_KEY || '', i = k.indexOf(':');
  return i > 0 && k.slice(0, i).includes('.') && i < k.length - 1 ? { name: k.slice(0, i), secret: k.slice(i + 1) } : null;
}
const rtWanted = (meta) => !meta.rtOff && !!rtKey();
const rtChannel = (meta) => `wwyf:${meta.gameId}:lobby`;
let rtTvCache = null;
async function rtTv(s, fresh) {
  if (!fresh && rtTvCache && now() - rtTvCache.t < 2000) return rtTvCache.data;
  const data = await s.get('rt/tv', { type: 'json' }).catch(() => null);
  rtTvCache = { t: now(), data };
  return data;
}
const rtActive = (meta, tv) => rtWanted(meta) && phaseOf(meta) === LOBBY && !!tv && tv.state === 'ably' && tv.gameId === meta.gameId && now() - tv.at < RT_FRESH_MS;
function rtStatus(meta, tv) {
  const out = { on: !meta.rtOff, hasKey: !!rtKey(), active: rtActive(meta, tv), reason: '' };
  if (!out.hasKey) out.reason = 'no_key';
  else if (!out.on) out.reason = 'off';
  else if (phaseOf(meta) !== LOBBY) out.reason = 'started';
  else if (!out.active) out.reason = tv && tv.gameId === meta.gameId && tv.state === 'poll' && now() - tv.at < 10 * 60 * 1000 ? tv.reason : 'no_tv';
  return out;
}
function tokenRequest(k, clientId, capability) {
  const tr = { keyName: k.name, ttl: RT_TTL_MS, capability: JSON.stringify(capability), timestamp: now(), nonce: randomBytes(16).toString('hex') };
  if (clientId) tr.clientId = clientId;
  const text = [tr.keyName, tr.ttl, tr.capability, tr.clientId || '', tr.timestamp, tr.nonce, ''].join('\n');
  tr.mac = createHmac('sha256', k.secret).update(text).digest('base64');
  return tr;
}
/** GET /api/rt-token (phone: player headers) or /api/rt-token?as=tv -> { channel, tokenRequest } */
async function rtToken(req, s) {
  const k = rtKey();
  if (!k) fail(503, 'rt_no_key', '未設定即時連線');
  const meta = await getMeta(s);
  if (meta.rtOff) fail(409, 'rt_off', '即時連線已關閉');
  if (phaseOf(meta) !== LOBBY) fail(409, 'started', '遊戲已開始');
  const channel = rtChannel(meta);
  if (new URL(req.url).searchParams.get('as') === 'tv') return { channel, tokenRequest: tokenRequest(k, null, { [channel]: ['subscribe'] }) };
  const p = await playerFrom(req, s);
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  return { channel, tokenRequest: tokenRequest(k, p.id, { [channel]: ['publish'] }) };
}
/** POST /api/rt-status { state: 'ably'|'poll', reason, gameId } — the TV says whether its Ably link is live */
async function rtReport(req, s) {
  const b = await body(req);
  const state = b.state === 'ably' ? 'ably' : 'poll';
  const reason = state === 'poll' && RT_REASONS.includes(b.reason) ? b.reason : '';
  const meta = await getMeta(s);
  if (b.gameId !== meta.gameId) return { ok: false };
  const data = { state, reason, gameId: meta.gameId, at: now() };
  await s.setJSON('rt/tv', data);
  rtTvCache = { t: now(), data };
  return { ok: true };
}
/** POST /api/admin/realtime { on } — the host's 即時連線 (Ably) switch */
async function setRealtime(req, s) {
  const b = await body(req);
  const on = b.on !== false;
  await update(s, 'meta', (m) => { if (!m.rtOff === on) return undefined; if (on) delete m.rtOff; else m.rtOff = true; return m; });
  const meta = await getMeta(s);
  return { ok: true, rt: rtStatus(meta, await rtTv(s, true)) };
}

async function miniState(s) {
  const spec = activeMiniKeys();
  const [pl, ml, ...sp] = await Promise.all([listWithEtags(s, 'players/'), listWithEtags(s, 'm'),
    ...spec.map((k) => s.getWithMetadata(k, { type: 'json' }).catch(() => null))]);
  spec.forEach((k, i) => { if (sp[i]) blobCache.set(k, { etag: sp[i].etag, data: sp[i].data, spec: true }); });
  const live = new Set([...pl, ...ml].map((b) => b.key));
  for (const k of blobCache.keys()) if (!live.has(k)) blobCache.delete(k);
  const metaBlob = ml.filter((b) => b.key === 'meta');
  const miniBlobs = ml.filter((b) => b.key.startsWith('mini/'));
  const [players, minis, metas] = await Promise.all([cachedGet(s, pl), cachedGet(s, miniBlobs), cachedGet(s, metaBlob)]);
  const meta = metas[0] || (await getMeta(s));
  const mini = new Map(miniBlobs.map((b, i) => [b.key.slice(5), minis[i]]));
  const list = players.filter(Boolean).map((p) => {
    const m = mini.get(p.id) || {};
    // no per-player reveal info here: this endpoint is public (TV) and must not say WHO has looked (only the aggregate out.reveal)
    return { id: p.id, characterId: p.characterId, nickname: p.nickname || '', joinedAt: p.joinedAt, push: m.push || 0, dodge: m.dodge || 0, pt: m.pt || 0, dt: m.dt || 0 };
  }).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  const screen = screenOf(meta);
  const out = { phase: phaseOf(meta), screen, gameId: meta.gameId, joined: list.length, players: list, t: now() };
  // 即時連線 (Ably): the TV should try realtime for the lobby bubble battle (switch on + key set + still in the lobby)
  if (phaseOf(meta) === LOBBY && rtWanted(meta)) out.rt = true;
  // 身份揭曉 screen: aggregate count ONLY (how many have looked) — never per-player flags, never roles
  if (screen === REVEAL) out.reveal = { revealed: players.filter((p) => p && p.revealedAt).length, total: list.length };
  // 玩法說明: the page + the configured numbers the slides quote (thresholds etc.) — general rules only, nothing per player
  if (screen === HOWTO) out.howto = await howtoView(s, meta);
  // round screens: the 4 leader cards (character only, in stable slot order — no letter, never the true/fake role)
  if (ROUND_SCREENS.includes(screen)) {
    const ps = players.filter(Boolean).map(normalize);
    out.leaders = leaderCards(ps);
    // lambs easter egg: r1 = 1; r2 / r3 = how many voted for the 真正領袖 in the previous round's (closed) vote — one integer, nothing else
    out.lambs = screen === 'r1' ? 1 : await trueVotes(s, meta, screen === 'r2' ? 'r1' : 'r2', ps);
    out.speak = speakView(meta, screen);   // 發言 timer: state + countdown only
    if (screen === 'r3') out.quiz = await quizForTv(s, await quizSettle(s, meta), await getContent(s), ps.filter(canVote).length);   // question + answered count; result after close
  }
  // 最終揭曉: the leader cards + ONLY what the host has already flipped / revealed (no roles of unflipped cards)
  if (screen === FINAL) out.final = await finalView(s, meta, players.filter(Boolean).map(normalize));
  // 結局: aggregate result only (X / N, %, win, per-leader counts by character) — never who voted for whom
  if (screen === ENDING) { const ps = players.filter(Boolean).map(normalize); out.ending = endingView(meta, await getContent(s), ps, await endingTally(s, meta, ps)); if (out.ending) out.ending.el = out.t - out.ending.at; }
  // an open vote: countdown + aggregate count only (never who voted, never for whom)
  // just sealed (everyone voted): keep showing 已封票 + the full count for a while
  const v = currentVote(meta);
  if (v && (voteOpen(v) || (v.sealed && now() - v.closedAt < 60e3))) {
    const ps = players.filter(Boolean).map(normalize), elig = new Set(ps.filter(canVote).map((p) => p.id));
    const keys = await cachedBallotKeys(s, v.round + ':' + v.id + ':' + (v.sealed ? 1 : 0));
    const voted = keys.filter((k) => elig.has(k.slice(k.lastIndexOf('/') + 1))).length;
    let sealed = !!v.sealed;
    if (!sealed && elig.size && voted >= elig.size) sealed = await sealIfDone(s, v, ps, keys);
    out.vote = { round: v.round, final: v.round === 'r3', sealed, remain: sealed ? 0 : v.deadline ? Math.max(0, v.deadline - now()) : null,
      voted, total: elig.size };
  }
  return out;
}
// open vote count for the TV: list ballots/<round>/ at most once a second per warm instance (the TV polls up to ~7x/s)
const ballotListCache = new Map();   // round -> { t, keys }
async function cachedBallotKeys(s, r) {
  const c = ballotListCache.get(r);
  if (c && now() - c.t < 1000) return c.keys;
  const keys = await ballotKeys(s, r.split(':')[0]);
  if (ballotListCache.size > 20) ballotListCache.clear();
  ballotListCache.set(r, { t: now(), keys });
  return keys;
}
// closed votes never change: their 真正領袖 count is cached per vote id (+ who the true leader is now)
const tallyCache = new Map();
async function trueVotes(s, meta, r, players) {
  const v = meta.votes && meta.votes[r];
  if (!v || voteOpen(v)) return 0;
  const tl = players.filter((p) => p.role === TRUE_LEADER).map((p) => p.id).sort().join(',');
  const key = `${meta.gameId}:${r}:${v.id}:${v.closedAt || v.deadline}:${tl}:${players.length}`;
  if (tallyCache.has(key)) return tallyCache.get(key);
  const byId = new Map(players.map((p) => [p.id, p]));
  const n = (await ballotsOf(s, r)).filter((x) => canVote(byId.get(x.voter)) && byId.has(x.target) && byId.get(x.target).role === TRUE_LEADER).length;
  if (tallyCache.size > 50) tallyCache.clear();
  tallyCache.set(key, n);
  return n;
}
/** leader cards for the TV: N slots (N = configured 真正領袖 + 假領袖, max 4) in the order of the host-assigned internal slot (player.leader, A–D —
    never displayed), so the same leader keeps the same position/colour on every round screen. The TV
    labels each card with the character name. Leaders without a slot fill free ones in join order;
    empty slots are null (the TV shows a '?' card). */
function leaderSlots(players) {
  const slots = LEADER_LABELS.map(() => null);
  const leaders = players.filter((p) => LEADER_ROLES.includes(p.role)).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  const rest = [];
  for (const p of leaders) {
    const i = LEADER_LABELS.indexOf(p.leader);
    if (i >= 0 && !slots[i]) slots[i] = p; else rest.push(p);
  }
  for (const p of rest) { const i = slots.indexOf(null); if (i < 0) break; slots[i] = p; }
  // only as many cards as configured leaders (or assigned ones, if more): drop empty slots from the end first
  const n = Math.max(SLOT_N, leaders.length);
  for (let i = slots.length - 1; slots.length > n && i >= 0; i--) if (!slots[i]) slots.splice(i, 1);
  return slots;
}
const leaderCards = (players) => leaderSlots(players).map((p) => (p ? { characterId: p.characterId } : null));
/* Phase + TV screen. 開始遊戲 (admin/start) -> started, TV shows the "Let's play!" screen;
   回到等候 (admin/lobby) -> lobby + bubble battle (mini counters cleared);
   admin/screen r1|r2|r3 -> started (implies 開始遊戲, the mini game stops) + that round's title screen;
   admin/screen lobby -> same as 回到等候; admin/screen reveal -> same as admin/reveal-stage {on:true}. */
async function setPhase(s, phase, screen) {
  const m = await update(s, 'meta', (m) => {
    if (m.phase !== phase) m.phaseAt = now();
    m.phase = phase;
    m.tvScreen = phase === LOBBY ? LOBBY : (screen || LOBBY);
    return m;
  });
  if (!m) { await getMeta(s); return setPhase(s, phase, screen); }
  if (phase === LOBBY) await Promise.all((await listKeys(s, 'mini/')).map((k) => s.delete(k)));
  return { ok: true, phase: m.phase, screen: screenOf(m) };
}
async function setScreen(req, s) {
  const b = await body(req);
  if (b.screen === LOBBY) return setPhase(s, LOBBY);
  if (b.screen === REVEAL) return revealStage(s, true);
  if (b.screen === HOWTO) return howtoAction(s, { action: 'enter' });
  if (b.screen === FINAL) return finalAction(s, { action: 'enter' });
  if (b.screen === ENDING) return finalAction(s, { action: 'ending' });
  if (!ROUND_SCREENS.includes(b.screen)) fail(400, 'bad_screen', '未知的畫面');
  return setPhase(s, STARTED, b.screen);
}

/* Brute-force protection for the (short) admin PIN:
   per IP: 5 failed attempts within 10 min -> locked for 10 min;
   global: 30 failed attempts within 10 min -> all logins locked for 5 min. */
const RL_IP = { max: 5, window: 10 * 60e3, lock: 10 * 60e3 };
const RL_ALL = { max: 30, window: 10 * 60e3, lock: 5 * 60e3 };
function clientIp(req, context) {
  return (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}
function lockedFor(rec) { return rec && rec.until && rec.until > now() ? rec.until - now() : 0; }
function lockMsg(ms) { return `嘗試次數過多，請在 ${Math.max(1, Math.ceil(ms / 60e3))} 分鐘後再試`; }
async function upsert(s, key, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await s.getWithMetadata(key, { type: 'json' });
    const next = fn(cur ? structuredClone(cur.data) : null);
    const r = await s.setJSON(key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (r.modified) return next;
  }
  return null;
}
async function noteFailure(s, key, rule) {
  return upsert(s, key, (r) => {
    const t = now();
    if (!r || t - r.first > rule.window) r = { first: t, fails: 0, until: 0 };
    r.fails += 1;
    if (r.fails >= rule.max) { r.until = t + rule.lock; r.first = t; r.fails = 0; }
    return r;
  });
}

async function adminLogin(req, s, context) {
  const b = await body(req);
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || !process.env.SESSION_SECRET) fail(500, 'not_configured', '伺服器尚未設定管理密碼');
  const ipKey = 'rl/ip-' + sha(clientIp(req, context)).slice(0, 32);
  const [ipRec, allRec] = await Promise.all([s.get(ipKey, { type: 'json' }), s.get('rl/all', { type: 'json' })]);
  const wait = Math.max(lockedFor(ipRec), lockedFor(allRec));
  if (wait) fail(429, 'locked', lockMsg(wait));
  const a = Buffer.from(sha(b.password || '')), e = Buffer.from(sha(pw));
  if (!timingSafeEqual(a, e)) {
    const [ipR] = await Promise.all([noteFailure(s, ipKey, RL_IP), noteFailure(s, 'rl/all', RL_ALL)]);
    await new Promise((r) => setTimeout(r, 600));
    if (lockedFor(ipR)) fail(429, 'locked', lockMsg(lockedFor(ipR)));
    fail(401, 'bad_password', '密碼錯誤');
  }
  if (ipRec) await s.delete(ipKey);
  return { token: sign({ role: 'admin', iat: now(), exp: now() + SESSION_MS, n: rid(6) }), expiresIn: SESSION_MS };
}


/* ---------------- game content (admin 「遊戲內容」; editable without code) ----------------
   blob `content` (kept across games, NOT cleared by 新一場):
     { r2: { mystery: { all, true, fakes: [3] } },                   Round 2 (undercover style): all = 神秘描述 (平民 + both supporter
                                                                     roles only); true = 真領袖詞語 (fully matches it); fakes = 假領袖詞語
                                                                     1–3 (each mostly matches it), one per fake leader in TV slot order
                                                                     ('' -> 詞語 1). Leaders never see the description.
       r3: { threshold (%), need (successes to unlock), clue, questions: [{ q, options: [4], answer: 0-3 }] x 5 },
       end: { threshold (%) } }                                       結局: the group wins if >= threshold % of the final-vote
                                                                     voters chose the 真正領袖 */
const QUIZ_N = 5;
const QUIZ_DURATIONS = [0, 5, 8, 10, 20, 30, 45, 60, 90];   // seconds per question (0 = 不限時); the host taps through these
const DEFAULT_CONTENT = {
  r2: { mystery: {   // 例子 (admin shows 「例子」 until edited)
    all: '我係香港一間連鎖米線店，以雲南風味米線為主打，可以自由選擇配料同辣度。我同另一間名字相似嘅米線店有歷史淵源，但我哋係兩個唔同品牌。',   // 神秘描述 (平民 + both supporter roles)
    true: '譚仔雲南米線',                                  // 真領袖詞語: fully matches the description
    fakes: ['譚仔三哥米線', '雲南過橋米線', '車仔麵'],     // 假領袖詞語 1–3: each mostly matches it
  } },
  r3: { threshold: 60, need: 3, clue: '（最後的線索：請在管理頁「遊戲內容」填寫）', questions: [
    { q: '以下哪個數字最接近一小時的秒數？', options: ['360', '600', '3600', '6000'], answer: 2 },
    { q: '（範例）一星期有幾多日？', options: ['5', '6', '7', '8'], answer: 2 },
    { q: '（範例）一打雞蛋有幾多隻？', options: ['6', '10', '12', '20'], answer: 2 },
    { q: '（範例）香港的國際電話區號是？', options: ['+852', '+853', '+86', '+886'], answer: 0 },
    { q: '（範例）彩虹通常有幾多種顏色？', options: ['5', '6', '7', '8'], answer: 2 },
  ] },
  end: { threshold: 70 },
};
const str = (v, max, d = '') => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : d);
function cleanContent(b, base) {
  const out = structuredClone(base);
  if (b.r2 && b.r2.mystery != null) {
    const m = b.r2.mystery, o = out.r2.mystery;
    // string = the 神秘描述 only; object = { all (神秘描述), true (真領袖詞語), fakes: [假領袖詞語 1–3] } (legacy `fake` = 詞語 1)
    if (typeof m === 'string') o.all = str(m, 400, o.all);
    else if (m && typeof m === 'object') {
      if (m.all != null) o.all = str(m.all, 400, o.all);
      if (m.true != null) o.true = str(m.true, WORD_MAX, '');
      const fk = [...o.fakes];
      if (Array.isArray(m.fakes)) for (let i = 0; i < FAKE_WORDS; i++) fk[i] = str(m.fakes[i], WORD_MAX, '');
      else if (m.fake != null) fk[0] = str(m.fake, WORD_MAX, '');
      o.fakes = fk;
    }
    if (!o.all) fail(400, 'bad_mystery', '神秘描述不可留空');
    if (!o.true) fail(400, 'bad_word', '真領袖詞語不可留空');
    if (!o.fakes[0]) fail(400, 'bad_word', '假領袖詞語 1 不可留空');
    delete o.byRole; delete o.fake;
  }
  if (b.r3) {
    const z = b.r3, o = out.r3;
    if (z.threshold != null) { const n = Math.round(Number(z.threshold)); if (!(n >= 1 && n <= 100)) fail(400, 'bad_threshold', '門檻需為 1–100%'); o.threshold = n; }
    if (z.need != null) { const n = Math.round(Number(z.need)); if (!(n >= 1 && n <= QUIZ_N)) fail(400, 'bad_need', `成功題數需為 1–${QUIZ_N}`); o.need = n; }
    if (z.clue != null) o.clue = str(z.clue, 300, o.clue);
    if (Array.isArray(z.questions)) {
      if (z.questions.length !== QUIZ_N) fail(400, 'bad_questions', `需要 ${QUIZ_N} 道題目`);
      o.questions = z.questions.map((q, i) => {
        const opts = Array.isArray(q && q.options) ? q.options.slice(0, 4).map((x) => str(x, 30)) : [];
        const a = Number(q && q.answer);
        const qq = str(q && q.q, 90);
        if (!qq || opts.length !== 4 || opts.some((x) => !x)) fail(400, 'bad_question', `第 ${i + 1} 題：題目及四個選項都要填寫`);
        if (!(a >= 0 && a <= 3)) fail(400, 'bad_answer', `第 ${i + 1} 題：請選擇正確答案`);
        return { q: qq, options: opts, answer: a };
      });
    }
  }
  if (b.end && b.end.threshold != null) {
    const n = Math.round(Number(b.end.threshold));
    if (!(n >= 1 && n <= 100)) fail(400, 'bad_end_threshold', '結局門檻需為 1–100%');
    out.end.threshold = n;
  }
  return out;
}
let contentCache = null;   // { t, data } — 3 s in the warm instance (phones poll /me every 2–3 s)
async function getContent(s, fresh) {
  if (!fresh && contentCache && now() - contentCache.t < 3000) return contentCache.data;
  const c = (await s.get('content', { type: 'json' })) || {};
  const data = { r2: { mystery: migrateR2((c.r2 && c.r2.mystery) || {}) }, r3: { ...DEFAULT_CONTENT.r3, ...(c.r3 || {}) }, end: { ...DEFAULT_CONTENT.end, ...(c.end || {}) } };
  contentCache = { t: now(), data };
  return data;
}
async function saveContent(req, s) {
  const b = await body(req);
  const next = cleanContent(b, await getContent(s, true));
  await s.setJSON('content', next);
  contentCache = { t: now(), data: next };
  return { ok: true, content: next, examples: { r2: DEFAULT_CONTENT.r2.mystery } };
}
const WORD_MAX = 20, FAKE_WORDS = 3;
/** stored Round 2 content -> { all, true, fakes[3] }. The old shape { all, true, fake } held DESCRIPTIONS per role group
    (真領袖版 / 假領袖版): `all` stays the 神秘描述; an old leader version is kept as a word only if it is word-sized
    (<= WORD_MAX) and not just the description, otherwise the 例子 default word is used. */
function migrateR2(m) {
  const D = DEFAULT_CONTENT.r2.mystery;
  const all = typeof m.all === 'string' && m.all.trim() ? m.all : D.all;
  const w = (x, d) => (typeof x === 'string' && x.trim() && x.trim().length <= WORD_MAX && x.trim() !== all.trim() ? x.trim() : d);
  if (Array.isArray(m.fakes)) return { all, true: w(m.true, D.true), fakes: D.fakes.map((d, i) => (typeof m.fakes[i] === 'string' ? m.fakes[i].trim().slice(0, WORD_MAX) : d)) };
  return { all, true: w(m.true, D.true), fakes: [w(m.fake, D.fakes[0]), D.fakes[1], D.fakes[2]] };
}
/** the fake leaders in TV slot order -> 假領袖詞語 1, 2, 3 (a 4th+ fake leader, or an empty word -> 詞語 1) */
const fakeOrder = (players) => leaderSlots(players).filter((q) => q && q.role === FAKE_LEADER);
/** Round 2: a leader's OWN word (true -> 真領袖詞語; fake -> its own 假領袖詞語). Served by /api/me to that leader only —
    never the description, never another leader's word, never to civilians / supporters / the TV. */
function wordFor(c, p, players) {
  const m = c.r2.mystery;
  if (p.role === TRUE_LEADER) return m.true;
  const i = fakeOrder(players).findIndex((q) => q.id === p.id);
  return (i >= 0 && i < FAKE_WORDS && m.fakes[i]) || m.fakes[0];
}

/* ---------------- Round 3 問答 (破解密碼) ----------------
   meta.quiz = { cur: index | null, qs: { <index>: { id, openedAt, duration, deadline, closedAt, snap: { q, options, answer },
                 result: { correct, answered, total, pct, success, threshold } } } }
   answers/<index>/<playerId> { choice, at, qid }   one answer per player per question (changeable while open).
   admin/quiz-open {index, duration} opens a question (the question is snapshotted, so later edits don't change a live one);
   admin/quiz-close (or the timer) closes it: pct = correct / all non-leader players (leaders never answer), success = pct >= threshold.
   Phones see the question + their own choice; the correct answer and the result only after close. The TV sees the
   question, the answered count (never who / what) and, after close, the result. The clue unlocks after `need` successes. */
const qOpen = (x, t = now()) => !!x && !x.closedAt && !x.result && (!x.deadline || t < x.deadline);
const answerKeys = (s, i) => listKeys(s, 'answers/' + i + '/');
async function answersOf(s, i, qid) {
  const keys = await answerKeys(s, i);
  const as = await Promise.all(keys.map((k) => s.get(k, { type: 'json' })));
  return keys.map((k, j) => as[j] && { player: k.slice(k.lastIndexOf('/') + 1), ...as[j] }).filter((x) => x && (!qid || x.qid === qid));
}
async function quizTally(s, x, i, players) {
  const elig = new Set(players.filter(canVote).map((p) => p.id));
  const list = (await answersOf(s, i, x.id)).filter((a) => elig.has(a.player));
  const correct = list.filter((a) => a.choice === x.snap.answer).length;
  return { answered: list.length, correct, total: elig.size, pct: elig.size ? Math.round((correct / elig.size) * 100) : 0 };
}
async function closeQuestion(s, meta0, players) {
  const z = meta0.quiz, i = z && z.cur, x = z && z.qs && z.qs[i];
  if (i == null || !x || x.result) return meta0;
  const c = await getContent(s);
  const r = await quizTally(s, x, i, players || (await allPlayers(s)).map(normalize));
  r.threshold = c.r3.threshold;
  r.success = r.total > 0 && r.pct >= c.r3.threshold;
  const t = now();
  return (await update(s, 'meta', (m) => {
    const y = m.quiz && m.quiz.qs && m.quiz.qs[i];
    if (!y || y.id !== x.id || y.result) return undefined;
    y.closedAt = y.closedAt || (y.deadline && y.deadline < t ? y.deadline : t);
    y.result = r;
    return m;
  })) || meta0;
}
/** the timer ran out -> settle the result once (called from the polls; no cron) */
async function quizSettle(s, meta) {
  const z = meta.quiz, x = z && z.cur != null && z.qs && z.qs[z.cur];
  if (!x || x.result || qOpen(x)) return meta;
  return closeQuestion(s, meta);
}
function quizSummary(meta, c) {
  const z = meta.quiz || { cur: null, qs: {} }, t = now();
  const states = [];
  for (let i = 0; i < QUIZ_N; i++) {
    const x = z.qs && z.qs[i];
    states.push(!x ? 'none' : qOpen(x, t) ? 'open' : x.result ? (x.result.success ? 'ok' : 'fail') : 'closing');
  }
  const solved = states.filter((st) => st === 'ok').length, left = states.filter((st) => st === 'none' || st === 'open' || st === 'closing').length;
  const unlocked = solved >= c.r3.need;
  return { total: QUIZ_N, threshold: c.r3.threshold, need: c.r3.need, states, solved, unlocked, lost: !unlocked && solved + left < c.r3.need, clue: unlocked ? c.r3.clue : null };
}
function quizQuestion(meta) {
  const z = meta.quiz, i = z && z.cur;
  const x = i != null && z.qs && z.qs[i];
  if (!x) return null;
  const t = now(), open = qOpen(x, t);
  const q = { index: i, id: x.id, q: x.snap.q, options: x.snap.options, open, duration: x.duration,
    remain: open && x.deadline ? Math.max(0, x.deadline - t) : null };
  if (!open && x.result) { q.auto = !!x.auto; q.answer = x.snap.answer; q.result = { success: x.result.success, pct: x.result.pct, correct: x.result.correct, total: x.result.total }; }
  return q;
}
async function quizForPhone(s, meta, c, p) {
  const out = quizSummary(meta, c), q = quizQuestion(meta);
  out.canAnswer = canVote(p);
  if (q) {
    if (out.canAnswer) {
      const a = await s.get(`answers/${q.index}/${p.id}`, { type: 'json' });
      q.mine = a && a.qid === q.id ? a.choice : null;
    }
    out.q = q;
  }
  return out;
}
const answerListCache = new Map();
async function quizForTv(s, meta, c, eligible) {
  const out = quizSummary(meta, c), q = quizQuestion(meta);
  if (q) {
    const key = q.index + ':' + q.id;
    let e = answerListCache.get(key);
    if (!e || (q.open && now() - e.t > 1000)) {
      const keys = await answerKeys(s, q.index);
      e = { t: now(), keys };
      if (answerListCache.size > 20) answerListCache.clear();
      answerListCache.set(key, e);
    }
    q.eligible = eligible || 0;   // how many can answer (non-leaders) — a count only
    q.answered = e.keys.length;   // aggregate only (may include stale keys for a moment; the result uses the real count)
    out.q = q;
  }
  return out;
}
async function answerQuiz(req, s) {
  const b = await body(req);
  const [p, meta] = await Promise.all([playerFrom(req, s, b), getMeta(s)]);
  if (!p) fail(404, 'not_joined', '尚未加入或已被移出遊戲');
  if (!canVote(p)) fail(403, 'no_answer', '領袖不參與作答');
  const z = meta.quiz, i = z && z.cur, x = i != null && z.qs && z.qs[i];
  if (!x || !qOpen(x) || (b.index != null && Number(b.index) !== i)) fail(409, 'quiz_closed', '作答已結束');
  const choice = Number(b.choice);
  if (!(choice >= 0 && choice <= 3) || !Number.isInteger(choice)) fail(400, 'bad_choice', '請選擇一個答案');
  await s.setJSON(`answers/${i}/${p.id}`, { choice, at: now(), qid: x.id });
  // 所有人都必須作答: once every non-leader has answered this question it closes at once (like 封票) and the result shows
  const players = (await allPlayers(s)).map(normalize);
  const t = await quizTally(s, x, i, players);
  let closed = false;
  if (t.total > 0 && t.answered >= t.total) {
    await update(s, 'meta', (m) => { const y = m.quiz && m.quiz.qs && m.quiz.qs[i]; if (!y || y.id !== x.id || y.closedAt || y.result) return undefined; y.closedAt = now(); y.auto = true; return m; });
    await closeQuestion(s, await getMeta(s), players);
    closed = true;
  }
  return { ok: true, index: i, mine: choice, closed };
}
async function openQuestion(req, s) {
  const b = await body(req);
  const i = Number(b.index);
  if (!(Number.isInteger(i) && i >= 0 && i < QUIZ_N)) fail(400, 'bad_index', '未知的題目');
  const duration = b.duration == null ? 0 : Number(b.duration);
  if (!QUIZ_DURATIONS.includes(duration)) fail(400, 'bad_duration', '不支援的作答時間');
  let meta = await getMeta(s);
  if (phaseOf(meta) !== STARTED || !meta.revealed) fail(409, 'not_started', '請先完成身份揭曉');
  const players = (await allPlayers(s)).map(normalize);
  meta = await closeQuestion(s, meta, players);   // another question still open -> settle it first
  const c = await getContent(s, true), src = c.r3.questions[i];
  await Promise.all((await answerKeys(s, i)).map((k) => s.delete(k)));   // (re)opening = a fresh question
  const t = now();
  const m = await update(s, 'meta', (m) => {
    m.quiz = m.quiz || { cur: null, qs: {} };
    m.quiz.qs = m.quiz.qs || {};
    m.quiz.cur = i;
    m.quiz.qs[i] = { id: rid(4), openedAt: t, duration, deadline: duration ? t + duration * 1000 : 0, closedAt: 0, snap: { q: src.q, options: src.options.slice(), answer: src.answer } };
    return m;
  });
  return { ok: true, quiz: quizSummary(m, c), q: quizQuestion(m) };
}
async function closeQuestionReq(req, s) {
  const meta = await getMeta(s);
  const z = meta.quiz, x = z && z.cur != null && z.qs && z.qs[z.cur];
  if (!x) fail(409, 'no_question', '沒有進行中的題目');
  if (qOpen(x)) await update(s, 'meta', (m) => { const y = m.quiz.qs[z.cur]; if (y.closedAt) return undefined; y.closedAt = now(); return m; });
  const m = await closeQuestion(s, await getMeta(s));
  return { ok: true, quiz: quizSummary(m, await getContent(s)), q: quizQuestion(m) };
}
async function resetQuiz(s) {
  await Promise.all((await listKeys(s, 'answers/')).map((k) => s.delete(k)));
  await update(s, 'meta', (m) => { if (!m.quiz) return undefined; delete m.quiz; return m; });
  return { ok: true };
}
/** admin-only live view: the current question's answered / correct counts while open; every question's result */
async function adminQuiz(s, meta, players, c) {
  const out = quizSummary(meta, c), q = quizQuestion(meta);
  out.results = {};
  for (const [i, x] of Object.entries((meta.quiz && meta.quiz.qs) || {})) if (x.result) out.results[i] = x.result;
  if (q) {
    const x = meta.quiz.qs[q.index];
    q.answer = x.snap.answer;
    const ps = players.map(normalize);
    q.live = await quizTally(s, x, q.index, ps);
    q.auto = !!x.auto;   // closed by itself because everyone answered
    // admin only: who still has to answer (non-leaders without an answer to this question)
    const done = new Set((await answersOf(s, q.index, x.id)).map((a) => a.player));
    q.missing = ps.filter((p) => canVote(p) && !done.has(p.id)).sort((a, b) => a.joinedAt - b.joinedAt).map((p) => ({ id: p.id, characterId: p.characterId, nickname: p.nickname || '' }));
    out.q = q;
  }
  out.durations = QUIZ_DURATIONS;
  return out;
}

/* ---------------- 最終揭曉 (TV screen 'final') ----------------
   meta.final = { flipped: { <leaderPlayerId>: t }, supp: { <leaderPlayerId>: t }, votes: bool }  (新一場 replaces meta -> cleared)
   The host flips the leader cards in ANY order (admin/final {action:'flip', playerId}); after a flip, 揭曉支持者 shows the
   supporter(s) who backed that leader all along: 假領袖 -> their 假領袖支持者 (player.supports), 真正領袖 -> every 真領袖支持者.
   Public views (TV mini/state + phones /me) only ever carry roles / supporters of cards that are already flipped. */
function supportersOf(leader, players) {
  if (!leader) return [];
  if (leader.role === FAKE_LEADER) return players.filter((p) => p.role === FAKE_SUPPORTER && p.supports === leader.id);
  if (leader.role === TRUE_LEADER) return players.filter((p) => p.role === TRUE_SUPPORTER);
  return [];
}
const finalVoteCache = new Map();
/** final-vote (r3, closed) follower count per player id — only when the host turned 顯示最後投票結果 on */
async function finalVotes(s, meta, players) {
  const v = meta.votes && meta.votes.r3;
  if (!v || voteOpen(v)) return null;
  const key = `${meta.gameId}:${v.id}:${v.closedAt || v.deadline}:${players.length}`;
  if (finalVoteCache.has(key)) return finalVoteCache.get(key);
  const byId = new Map(players.map((p) => [p.id, p])), n = {};
  for (const b of await ballotsOf(s, 'r3')) if (canVote(byId.get(b.voter)) && byId.has(b.target)) n[b.target] = (n[b.target] || 0) + 1;
  if (finalVoteCache.size > 20) finalVoteCache.clear();
  finalVoteCache.set(key, n);
  return n;
}
async function finalView(s, meta, players) {
  const f = meta.final || {}, fl = f.flipped || {}, sp = f.supp || {};
  const votes = f.votes ? await finalVotes(s, meta, players) : null;
  const cards = leaderSlots(players).map((p) => {
    if (!p) return null;
    const c = { characterId: p.characterId, flipped: !!fl[p.id] };
    if (c.flipped) {
      c.role = p.role === TRUE_LEADER ? 'true' : 'fake';
      c.at = fl[p.id];
      if (sp[p.id]) { c.supporters = supportersOf(p, players).map((q) => ({ characterId: q.characterId })); c.suppAt = sp[p.id]; }
    }
    if (votes) c.votes = votes[p.id] || 0;
    return c;
  });
  return { cards, showVotes: !!votes, t: now() };
}
async function adminFinal(s, meta, players) {
  const f = meta.final || {}, fl = f.flipped || {}, sp = f.supp || {};
  const v = meta.votes && meta.votes.r3;
  const tl = leaderSlots(players).filter((p) => p && p.role === TRUE_LEADER);
  const ready = !!v && !voteOpen(v);
  return {
    on: screenOf(meta) === FINAL, votes: !!f.votes, voteReady: ready,
    // 結局 (host preview of the result; the TV / phones only get it once the host shows the ending)
    ending: { on: screenOf(meta) === ENDING, ready, trueFlipped: tl.length > 0 && tl.every((p) => !!fl[p.id]),
      result: ready ? endingView(meta, await getContent(s), players, await endingTally(s, meta, players)) : null, t: now() },
    leaders: leaderSlots(players).map((p) => p && {
      id: p.id, characterId: p.characterId, nickname: p.nickname || '', role: p.role, flipped: !!fl[p.id], suppRevealed: !!sp[p.id],
      supporters: supportersOf(p, players).map((q) => ({ id: q.id, characterId: q.characterId, nickname: q.nickname || '', role: q.role })),
    }),
  };
}
/* ---------------- 結局 (TV screen 'ending', after 最終揭曉) ----------------
   Win rule: the group wins if >= content.end.threshold % (default 70) of the voters in the FINAL vote (r3, closed;
   non-leaders who voted) chose the 真正領袖. Public view = X / N, %, win, per-leader counts (character only). */
const endingCache = new Map();
async function endingTally(s, meta, players) {
  const v = meta.votes && meta.votes.r3;
  if (!v || voteOpen(v)) return null;
  const key = `${meta.gameId}:${v.id}:${v.closedAt || v.deadline}:` + sha(players.map((p) => p.id + '=' + p.role).sort().join(','));
  if (endingCache.has(key)) return endingCache.get(key);
  const byId = new Map(players.map((p) => [p.id, p])), per = {}, mine = {}, counted = [];
  let x = 0, n = 0;
  for (const b of await ballotsOf(s, 'r3')) {
    const vt = byId.get(b.voter), tg = byId.get(b.target);
    if (!canVote(vt) || !tg || !LEADER_ROLES.includes(tg.role)) continue;
    n++; per[tg.id] = (per[tg.id] || 0) + 1; mine[vt.id] = tg.id; counted.push([vt.id, tg.characterId]);
    if (tg.role === TRUE_LEADER) x++;
  }
  // the TV counts the ballots one by one in a shuffled order: random, but fixed per game + vote (seeded), so every
  // TV / reload sees the same sequence. Only leader characterIds — never who cast which ballot.
  counted.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const order = counted.map((c) => c[1]);
  let seed = parseInt(sha(meta.gameId + ':' + v.id).slice(0, 8), 16) >>> 0;
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const out = { x, n, per, mine, order };
  if (endingCache.size > 20) endingCache.clear();
  endingCache.set(key, out);
  return out;
}
/**
 * The TV's 點票 timeline (ms after 顯示結局) — the ONE formula; the TV plays exactly these times and phones wait for
 * `result` + ENDING_BUFFER. 0.9 s intro, then one ballot every 0.6 s -> 0.35 s (accelerating; scaled so all the steps
 * fit in 9 s), a 1.1 s pause right before the ballot that takes the bar over the target (or before the last ballot
 * if it never gets there), 0.5 s settle, then the result. 20 voters ≈ 11.5 s.
 */
const ENDING_BUFFER = 1500;
function endingPlan(order, trueCid, thr) {
  const n = order.length, START = 900, PAUSE = 1100, SETTLE = 500;
  const base = order.map((_, i) => 600 - 250 * (n > 1 ? i / (n - 1) : 0));
  const sum = base.reduce((a, b) => a + b, 0), k = sum > 9000 ? 9000 / sum : 1;
  let x = 0, c = n - 1;
  for (let i = 0; i < n; i++) if (order[i] === trueCid && ++x * 100 >= thr * n) { c = i; break; }
  const t = [];
  let at = START;
  for (let i = 0; i < n; i++) { if (i === c) at += PAUSE; t.push(Math.round(at)); at += base[i] * k; }
  return { t, result: Math.round(at + SETTLE) };
}
function endingView(meta, content, players, tally) {
  if (!tally) return null;
  const thr = (content.end && content.end.threshold) || 70, { x, n } = tally;
  const leaders = leaderSlots(players).filter(Boolean).map((p) => ({ characterId: p.characterId, role: p.role === TRUE_LEADER ? 'true' : 'fake', votes: tally.per[p.id] || 0 }));
  const tl = leaders.find((l) => l.role === 'true'), plan = endingPlan(tally.order, tl && tl.characterId, thr);
  return {
    win: n > 0 && x * 100 >= thr * n, x, n, pct: n ? Math.round((x * 100) / n) : 0, threshold: thr, leaders,
    at: meta.endingAt || 0, order: tally.order, plan, resultAt: (meta.endingAt || 0) + plan.result + ENDING_BUFFER,
  };
}
const phoneEnding = (e) => ({ win: e.win, x: e.x, n: e.n, pct: e.pct, threshold: e.threshold, leaders: e.leaders, at: e.at });
/** this phone only: leaders -> their own side's result + own count; voters -> who THEY followed; else none */
function endingMine(p, players, tally, view) {
  if (LEADER_ROLES.includes(p.role)) {
    const isTrue = p.role === TRUE_LEADER;
    return { leader: isTrue ? 'true' : 'fake', votes: tally.per[p.id] || 0, won: isTrue ? view.win : !view.win };
  }
  const t = tally.mine[p.id], tg = t && players.find((q) => q.id === t);
  return tg ? { voted: tg.characterId, true: tg.role === TRUE_LEADER } : { voted: null };
}
async function finalAction(s, b) {
  const a = b && b.action;
  const meta = await getMeta(s);
  if (phaseOf(meta) !== STARTED || !meta.revealed) fail(409, 'not_started', '請先完成身份揭曉');
  const players = (await allPlayers(s)).map(normalize);
  const leaders = leaderSlots(players).filter(Boolean);
  const lp = a === 'flip' || a === 'supporter' ? leaders.find((p) => p.id === b.playerId) : null;
  if ((a === 'flip' || a === 'supporter') && !lp) fail(400, 'bad_leader', '找不到這位領袖');
  if (a === 'supporter' && !supportersOf(lp, players).length) fail(409, 'no_supporter', '這位領袖沒有支持者');
  if (!['enter', 'flip', 'supporter', 'all', 'reset', 'votes', 'ending'].includes(a)) fail(400, 'bad_action', '未知的操作');
  if (a === 'ending') { const v = meta.votes && meta.votes.r3; if (!v || voteOpen(v)) fail(409, 'vote_not_closed', '最後投票尚未結束'); }
  // flips only while the TV shows the final screen, so every reveal is seen (and animated) live
  if (['flip', 'supporter', 'all'].includes(a) && screenOf(meta) !== FINAL) fail(409, 'not_final', '請先進入最終揭曉');
  const t = now();
  const m = await update(s, 'meta', (m) => {
    m.final = m.final || { flipped: {}, supp: {}, votes: false };
    const f = m.final; f.flipped = f.flipped || {}; f.supp = f.supp || {};
    if (a === 'enter') { m.phase = STARTED; m.tvScreen = FINAL; }
    else if (a === 'ending') { if (m.tvScreen === ENDING) return undefined; m.phase = STARTED; m.tvScreen = ENDING; m.endingAt = t; }
    else if (a === 'flip') { if (f.flipped[lp.id]) return undefined; f.flipped[lp.id] = t; }
    else if (a === 'supporter') { if (!f.flipped[lp.id]) fail(409, 'not_flipped', '請先翻開這張卡'); if (f.supp[lp.id]) return undefined; f.supp[lp.id] = t; }
    else if (a === 'all') { let k = 0; for (const p of leaders) if (!f.flipped[p.id]) f.flipped[p.id] = t + 700 * k++; }   // staggered so the TV plays them one by one
    else if (a === 'reset') { m.final = { flipped: {}, supp: {}, votes: false }; }
    else if (a === 'votes') f.votes = !!b.on;
    return m;
  });
  const mm = m || (await getMeta(s));
  return { ok: true, screen: screenOf(mm), final: await adminFinal(s, mm, players) };
}

/* ---------------- 玩法說明 (TV slideshow, before 身份揭曉) ----------------
   admin/howto {action: 'enter'|'exit'|'next'|'prev'|'go'|'auto', page, on, sec}. enter: TV -> screen 'howto' at page 0 (the game counts as
   started so the lobby mini game stops; phones show 「請睇 TV 玩法說明」); exit: back to where it came from (等候 / 遊戲開始).
   Only before 身份揭曉 (meta.revealed) — the slides never say who the leaders are or mention any secret role. */
// 自動播放: meta.howto.auto = {on, sec, at}. While on, `page` is the slide the run started from and `at` its start time; the
// current slide = (page + whole intervals since at) mod HOWTO_PAGES (loops back to slide 1, so it can run while people join).
// Clients get the derived page + `left` (ms until the next slide) — relative, so the TV needs no clock sync.
const HOWTO_AUTO_SECS = [6, 10, 15], HOWTO_AUTO_DEF = 10;
function howtoNow(h, t) {
  const page = Math.max(0, Math.min(HOWTO_PAGES - 1, (h && h.page) | 0)), a = h && h.auto;
  if (!a || !a.on) return { page, left: 0 };
  const ms = (HOWTO_AUTO_SECS.includes(a.sec) ? a.sec : HOWTO_AUTO_DEF) * 1000, el = Math.max(0, t - (a.at || t));
  return { page: (page + Math.floor(el / ms)) % HOWTO_PAGES, left: ms - (el % ms) };
}
function howtoAuto(h, t) {
  const a = (h && h.auto) || {}, sec = HOWTO_AUTO_SECS.includes(a.sec) ? a.sec : HOWTO_AUTO_DEF;
  return { on: !!a.on, sec, left: a.on ? howtoNow(h, t).left : 0, secs: HOWTO_AUTO_SECS };
}
async function howtoView(s, meta) {
  const c = await getContent(s), h = meta.howto || {}, t = now();
  const rc = await getRoleCounts(s, true), L = slotCount(rc);
  // leader counts for 遊戲目標 (leaders only — supporters are never mentioned on the slides)
  const leaders = { total: L, true: Math.min(rc[TRUE_LEADER] || 0, L), fake: Math.max(0, L - Math.min(rc[TRUE_LEADER] || 0, L)) };
  return { page: howtoNow(h, t).page, pages: HOWTO_PAGES, auto: howtoAuto(h, t), threshold: c.end.threshold, quiz: { n: QUIZ_N, threshold: c.r3.threshold, need: c.r3.need }, leaders };
}
async function howtoAction(s, b) {
  const a = b && b.action;
  if (!['enter', 'exit', 'next', 'prev', 'go', 'auto'].includes(a)) fail(400, 'bad_action', '未知的操作');
  const meta = await getMeta(s);
  if (a === 'exit') {
    if (meta.tvScreen !== HOWTO) return { ok: true, screen: screenOf(meta), howto: null };
    const from = meta.howto && meta.howto.from === STARTED ? STARTED : LOBBY;
    const r = await setPhase(s, from);
    return { ...r, howto: null };
  }
  if (meta.revealed) fail(409, 'revealed', '身份已揭曉：玩法說明只可在身份揭曉之前顯示');
  if (a !== 'enter' && screenOf(meta) !== HOWTO) fail(409, 'not_howto', '請先開始玩法說明');
  if (a === 'go' && !(Number.isInteger(b.page) && b.page >= 0 && b.page < HOWTO_PAGES)) fail(400, 'bad_page', '頁數無效');
  if (a === 'auto' && b.sec != null && !HOWTO_AUTO_SECS.includes(b.sec)) fail(400, 'bad_sec', '自動播放間隔無效');
  const t = now();
  const m = await update(s, 'meta', (m) => {
    if (a === 'enter') {
      const from = phaseOf(m) === STARTED ? STARTED : LOBBY;
      if (m.tvScreen === HOWTO) return undefined;   // already on: keep the page
      if (m.phase !== STARTED) m.phaseAt = t;
      // a fresh run always starts with 自動播放 off (the interval choice is remembered)
      const sec = m.howto && m.howto.auto && HOWTO_AUTO_SECS.includes(m.howto.auto.sec) ? m.howto.auto.sec : HOWTO_AUTO_DEF;
      m.phase = STARTED; m.tvScreen = HOWTO; m.howto = { page: 0, from, auto: { on: false, sec } };
      return m;
    }
    const h = m.howto || { page: 0, from: LOBBY }, cur = howtoNow(h, t).page, au = howtoAuto(h, t);
    if (a === 'auto') {
      // on: start from the current slide now · off: stay on the current slide · sec only: change the interval (restarts the timer)
      const on = b.on == null ? au.on : !!b.on, sec = b.sec != null ? b.sec : au.sec;
      if (on === au.on && sec === au.sec) return undefined;
      m.howto = { ...h, page: cur, auto: { on, sec, at: on ? t : 0 } };
      return m;
    }
    // (自動播放 loops, so 下一頁 on the last slide goes back to slide 1 while it is on)
    const page = a === 'go' ? b.page : au.on && a === 'next' && cur === HOWTO_PAGES - 1 ? 0 : Math.max(0, Math.min(HOWTO_PAGES - 1, cur + (a === 'next' ? 1 : -1)));
    // manual paging while 自動播放 is on: jump there and restart the timer from that slide
    if (page === cur && !au.on) return undefined;
    m.howto = { ...h, page, auto: { on: au.on, sec: au.sec, at: au.on ? t : 0 } };
    return m;
  });
  const mm = m || (await getMeta(s));
  return { ok: true, screen: screenOf(mm), howto: await howtoView(s, mm) };
}

const ROUTES = {
  'GET lobby': (req, s) => lobby(s),
  'POST join': join,
  'GET me': (req, s) => me(req, s, false),
  'POST heartbeat': (req, s) => me(req, s, true),
  'POST mini/act': miniAct,
  'POST reveal-ack': revealAck,
  'POST vote': castVote,
  'POST knock': knock,
  'POST knock-ack': knockAck,
  'GET mini/state': (req, s) => miniState(s),
  'GET rt-token': rtToken,
  'POST rt-status': rtReport,
  'POST admin/realtime': setRealtime,
  'POST admin/login': adminLogin,
  'GET admin/state': (req, s) => adminState(s),
  'GET admin/archive': async (req, s) => {
    const key = new URL(req.url).searchParams.get('key') || '';
    if (!key.startsWith('archive/')) fail(400, 'bad_key');
    return (await s.get(key, { type: 'json' })) || fail(404, 'not_found');
  },
  'POST admin/role': setRole,
  'POST admin/random': (req, s) => randomAssign(s),
  'POST admin/clear-roles': (req, s) => clearRoles(s),
  'POST admin/kick': kick,
  'POST admin/reset': (req, s) => reset(s),
  'POST admin/config': setConfig,
  'POST admin/reveal': setRevealed,
  'POST admin/reveal-stage': setRevealStage,
  'POST admin/start': (req, s) => setPhase(s, STARTED),
  'POST admin/lobby': (req, s) => setPhase(s, LOBBY),
  'POST admin/screen': setScreen,
  'POST admin/vote': openVote,
  'POST admin/vote-end': (req, s) => endVote(s),
  'POST admin/speak': startSpeak,
  'POST admin/speak-end': endSpeak,
  'POST quiz/answer': answerQuiz,
  'GET admin/content': async (req, s) => ({ content: await getContent(s, true), quizN: QUIZ_N, examples: { r2: DEFAULT_CONTENT.r2.mystery } }),
  'POST admin/content': saveContent,
  'POST admin/quiz-open': openQuestion,
  'POST admin/quiz-close': closeQuestionReq,
  'POST admin/quiz-reset': (req, s) => resetQuiz(s),
  'POST admin/final': async (req, s) => finalAction(s, await body(req)),
  'POST admin/howto': async (req, s) => howtoAction(s, await body(req)),
};

export default async (req, context) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const route = ROUTES[`${req.method} ${path}`];
  if (!route) return json(req, 404, { error: 'not_found', message: '找不到此 API' });
  try {
    if (path.startsWith('admin/') && path !== 'admin/login') verifyAdmin(req);
    const st = store();
    await getRoleCounts(st, true);   // keeps SLOT_N (number of leader cards) current — one cached read per 3 s
    return json(req, 200, await route(req, st, context));
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.code, message: e.message });
    console.error(e);
    return json(req, 500, { error: 'server_error', message: '伺服器錯誤，請稍後再試' });
  }
};
