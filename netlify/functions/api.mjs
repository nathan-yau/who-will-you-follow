// Who Will You Follow? — game backend (Netlify Functions v2 + Netlify Blobs).
// One game at a time. State lives in the "wwyf-game" blob store:
//   meta                 { gameId, startedAt, revealed, phase: 'lobby'|'started', phaseAt,
//                          tvScreen: 'lobby'|'r1'|'r2'|'r3'|'reveal' }   (what the TV shows; set by POST admin/screen)
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
const FAKE_LEADER = '假領袖', FAKE_SUPPORTER = '假領袖支持者';
const ALLOWED_ORIGINS = ['https://nathan-yau.github.io'];
const ONLINE_MS = 15000;
const SESSION_MS = 12 * 3600 * 1000;
const CHAR_RE = /^character_\d{2}$/;
const LOBBY = 'lobby', STARTED = 'started';
const phaseOf = (m) => (m && m.phase === STARTED ? STARTED : LOBBY);
const ROUND_SCREENS = ['r1', 'r2', 'r3'];
const REVEAL = 'reveal';   // 身份揭曉 stage
const SCREENS = [...ROUND_SCREENS, REVEAL];
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
async function getRoleCounts(s) {
  const c = await s.get('config', { type: 'json' });
  const saved = (c && c.roles) || {};
  const out = {};
  for (const r of SPECIAL_ROLES) out[r] = Number.isInteger(saved[r]) ? saved[r] : DEFAULT_ROLES[r];
  return out;
}
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
  // a phone only ever gets its OWN role, and only once the host has started the 身份揭曉 stage
  if (meta.revealed) {
    out.seen = !!p.revealedAt;
    Object.assign(out, await roleView(s, normalize(p)));
  }
  return out;
}

/** What a phone may know about its OWN role:
    - leaders: their letter
    - 假領袖支持者: the one 假領袖 they back (letter + character), from syncPairs()
    - 假領袖: only a yes/no "someone secretly helps you" (never who) */
async function roleView(s, p) {
  const out = { role: p.role };
  if (p.leader && LEADER_ROLES.includes(p.role)) out.leader = p.leader;
  if (p.role === FAKE_SUPPORTER || p.role === FAKE_LEADER) {
    const players = (await allPlayers(s)).map(normalize);
    if (p.role === FAKE_SUPPORTER) {
      const l = players.find((q) => q.id === p.supports && q.role === FAKE_LEADER);
      out.supports = l ? { leader: l.leader || null, characterId: l.characterId } : null;
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
  return { meta, roles: counts, civilian: CIVILIAN, roleOrder: ROLE_ORDER, leaderRoles: LEADER_ROLES, leaderLabels: LEADER_LABELS, assigned, players: list, reveal, archive, serverTime: t };
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
      if (!LEADER_LABELS.includes(b.leader)) fail(400, 'bad_leader', '領袖代號只能是 A–D');
      if (used.has(b.leader)) fail(409, 'leader_taken', `領袖 ${b.leader} 已被使用`);
      leader = b.leader;
    } else if (LEADER_ROLES.includes(target.role) && target.leader && !used.has(target.leader)) {
      leader = target.leader;
    } else {
      leader = LEADER_LABELS.find((l) => !used.has(l)) || null;
    }
  }
  await update(s, 'players/' + target.id, (p) => {
    if (p.role !== role || (p.leader || null) !== leader) p.revealedAt = null;   // changed -> the phone shows 揭曉 again
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
  const labels = shuffle([...LEADER_LABELS]);
  let li = 0;
  await Promise.all(players.map((pl, i) => {
    const role = roles[i];
    const leader = LEADER_ROLES.includes(role) ? (labels[li++] || null) : null;
    return update(s, 'players/' + pl.id, (p) => { if (p.role !== role || (p.leader || null) !== leader) p.revealedAt = null; p.role = role; p.leader = leader; p.supports = null; return p; });
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
  const keys = [...await listKeys(s, 'players/'), ...await listKeys(s, 'claims/'), ...await listKeys(s, 'seen/'), ...await listKeys(s, 'mini/')];
  await Promise.all(keys.map((k) => s.delete(k)));
  const next = { gameId: rid(6), startedAt: t, revealed: false, phase: LOBBY, phaseAt: t };
  await s.setJSON('meta', next);
  return { ok: true, archived: players.length, gameId: next.gameId };
}

async function setConfig(req, s) {
  const b = await body(req);
  const roles = {};
  for (const r of SPECIAL_ROLES) {
    const n = b.roles && Number.isInteger(b.roles[r]) ? b.roles[r] : DEFAULT_ROLES[r];
    if (n < 0 || n > 20) fail(400, 'bad_count', '人數需介於 0–20');
    roles[r] = n;
  }
  await s.setJSON('config', { roles });
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

/* TV poll (4x/s): list players/ and m* (meta + mini/*) once each, then fetch only the blobs whose
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
const ACTIVE_MS = 20000, ACTIVE_MAX = 12;
function activeMiniKeys() {
  const t = now(), out = [];
  for (const [k, c] of blobCache) if (k.startsWith('mini/') && c.data && t - (c.data.t || 0) < ACTIVE_MS) out.push([k, c.data.t]);
  return out.sort((a, b) => b[1] - a[1]).slice(0, ACTIVE_MAX).map((x) => x[0]);
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
    // rv = this player has tapped 揭曉 on the phone (a yes/no only — the TV never learns any role)
    return { id: p.id, characterId: p.characterId, nickname: p.nickname || '', joinedAt: p.joinedAt, push: m.push || 0, dodge: m.dodge || 0, pt: m.pt || 0, dt: m.dt || 0, rv: p.revealedAt ? 1 : 0 };
  }).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  const screen = screenOf(meta);
  const out = { phase: phaseOf(meta), screen, gameId: meta.gameId, joined: list.length, players: list, t: now() };
  // round screens: the 4 leader cards (letter + character only — never the true/fake role)
  if (ROUND_SCREENS.includes(screen)) out.leaders = leaderCards(players.filter(Boolean).map(normalize));
  if (screen === REVEAL) out.reveal = { done: list.filter((p) => p.rv).length, total: list.length };
  return out;
}
/** leader cards for the TV, in A–D order. The letter is the one the host assigned (setRole/randomAssign),
    so the same leader keeps the same slot/colour on every round screen. Leaders without a letter fill
    free slots in join order; empty slots are null (the TV shows a '?' card). */
function leaderCards(players) {
  const slots = [null, null, null, null];
  const leaders = players.filter((p) => LEADER_ROLES.includes(p.role)).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  const rest = [];
  for (const p of leaders) {
    const i = LEADER_LABELS.indexOf(p.leader);
    if (i >= 0 && !slots[i]) slots[i] = { letter: p.leader, characterId: p.characterId }; else rest.push(p);
  }
  for (const p of rest) { const i = slots.indexOf(null); if (i < 0) break; slots[i] = { letter: LEADER_LABELS[i], characterId: p.characterId }; }
  return slots;
}
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

const ROUTES = {
  'GET lobby': (req, s) => lobby(s),
  'POST join': join,
  'GET me': (req, s) => me(req, s, false),
  'POST heartbeat': (req, s) => me(req, s, true),
  'POST mini/act': miniAct,
  'POST reveal-ack': revealAck,
  'GET mini/state': (req, s) => miniState(s),
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
};

export default async (req, context) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const route = ROUTES[`${req.method} ${path}`];
  if (!route) return json(req, 404, { error: 'not_found', message: '找不到此 API' });
  try {
    if (path.startsWith('admin/') && path !== 'admin/login') verifyAdmin(req);
    return json(req, 200, await route(req, store(), context));
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.code, message: e.message });
    console.error(e);
    return json(req, 500, { error: 'server_error', message: '伺服器錯誤，請稍後再試' });
  }
};
