// Who Will You Follow? — game backend (Netlify Functions v2 + Netlify Blobs).
// One game at a time. State lives in the "wwyf-game" blob store:
//   meta                 { gameId, startedAt, revealed }
//   config               { roles: { <role>: count } }
//   players/<playerId>   { id, tokenHash, characterId, nickname, joinedAt, role, leader, gameId }
//   claims/<characterId> { playerId, at }      (created with onlyIfNew -> one player per character)
//   seen/<playerId>      { t }                 (heartbeats; separate key so they never clobber roles)
//   archive/<ts>-<gameId> previous games (player list + roles)
import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const config = { path: '/api/*' };

const LEADER_ROLES = ['真正領袖', '假領袖'];
const LEADER_LABELS = ['A', 'B', 'C', 'D'];
const DEFAULT_ROLES = { '真正領袖': 1, '假領袖': 3, '真領袖支持者': 1, '假領袖支持者': 2, '平民': 10 };
const ROLE_ORDER = Object.keys(DEFAULT_ROLES); // also the priority when there are fewer players than roles
const ALLOWED_ORIGINS = ['https://nathan-yau.github.io'];
const ONLINE_MS = 15000;
const SESSION_MS = 12 * 3600 * 1000;
const CHAR_RE = /^character_\d{2}$/;

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
    h['Access-Control-Max-Age'] = '600';
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
    m = { gameId: rid(6), startedAt: now(), revealed: false };
    const r = await s.setJSON('meta', m, { onlyIfNew: true });
    if (!r.modified) m = await s.get('meta', { type: 'json' });
  }
  return m;
}
async function getRoleCounts(s) {
  const c = await s.get('config', { type: 'json' });
  return { ...DEFAULT_ROLES, ...(c && c.roles || {}) };
}
const totalRoles = (counts) => Object.values(counts).reduce((a, b) => a + (+b || 0), 0);

async function listKeys(s, prefix) {
  const out = [];
  for await (const page of s.list({ prefix, paginate: true })) out.push(...page.blobs.map((b) => b.key));
  return out;
}
async function allPlayers(s) {
  const keys = await listKeys(s, 'players/');
  const ps = await Promise.all(keys.map((k) => s.get(k, { type: 'json' })));
  return ps.filter(Boolean);
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
  return a.length === e.length && timingSafeEqual(a, e) ? p : null;
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
  const [taken, counts, meta, players] = await Promise.all([takenCharacters(s), getRoleCounts(s), getMeta(s), listKeys(s, 'players/')]);
  return { gameId: meta.gameId, taken, joined: players.length, capacity: totalRoles(counts) };
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
  const p = { id, tokenHash: sha(token), characterId, nickname, joinedAt: now(), role: null, leader: null, gameId: meta.gameId };
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
  const out = { player: publicPlayer(p), assigned: !!p.role, revealed: !!meta.revealed, joined: info.joined, capacity: info.capacity, gameId: meta.gameId };
  if (meta.revealed && p.role) { out.role = p.role; if (p.leader) out.leader = p.leader; }
  return out;
}

async function adminState(s) {
  const [players, counts, meta] = await Promise.all([allPlayers(s), getRoleCounts(s), getMeta(s)]);
  const seen = await Promise.all(players.map((p) => s.get('seen/' + p.id, { type: 'json' })));
  const t = now();
  const list = players.map((p, i) => ({
    id: p.id, characterId: p.characterId, nickname: p.nickname || '', joinedAt: p.joinedAt,
    lastSeen: seen[i] ? seen[i].t : null, online: !!(seen[i] && t - seen[i].t < ONLINE_MS),
    role: p.role || null, leader: p.leader || null,
  })).sort((a, b) => a.joinedAt - b.joinedAt);
  const assigned = Object.fromEntries(ROLE_ORDER.map((r) => [r, 0]));
  for (const p of list) if (p.role) assigned[p.role] = (assigned[p.role] || 0) + 1;
  const archive = (await listKeys(s, 'archive/')).sort().reverse().slice(0, 20);
  return { meta, roles: counts, roleOrder: ROLE_ORDER, leaderRoles: LEADER_ROLES, leaderLabels: LEADER_LABELS, assigned, capacity: totalRoles(counts), players: list, archive, serverTime: t };
}

async function setRole(req, s) {
  const b = await body(req);
  const counts = await getRoleCounts(s);
  const role = b.role || null;
  if (role !== null && !(role in counts)) fail(400, 'bad_role', '未知的角色');
  const players = await allPlayers(s);
  const target = players.find((p) => p.id === b.playerId);
  if (!target) fail(404, 'no_player', '找不到此玩家');
  const others = players.filter((p) => p.id !== target.id);
  if (role && others.filter((p) => p.role === role).length >= counts[role]) fail(409, 'role_full', `「${role}」已達上限 ${counts[role]} 人`);
  let leader = null;
  if (role && LEADER_ROLES.includes(role)) {
    const used = new Set(others.filter((p) => LEADER_ROLES.includes(p.role) && p.leader).map((p) => p.leader));
    if (b.leader) {
      if (!LEADER_LABELS.includes(b.leader)) fail(400, 'bad_leader', '領袖代號只能是 A–D');
      if (used.has(b.leader)) fail(409, 'leader_taken', `領袖 ${b.leader} 已被使用`);
      leader = b.leader;
    } else if (target.role && LEADER_ROLES.includes(target.role) && target.leader && !used.has(target.leader)) {
      leader = target.leader;
    } else {
      leader = LEADER_LABELS.find((l) => !used.has(l)) || null;
    }
  }
  await update(s, 'players/' + target.id, (p) => { p.role = role; p.leader = leader; return p; });
  return { ok: true, role, leader };
}

async function randomAssign(s) {
  const counts = await getRoleCounts(s);
  const players = shuffle(await allPlayers(s));
  const pool = [];
  for (const r of ROLE_ORDER) for (let i = 0; i < (counts[r] || 0); i++) pool.push(r);
  for (const r of Object.keys(counts)) if (!ROLE_ORDER.includes(r)) for (let i = 0; i < counts[r]; i++) pool.push(r);
  // fewer players than roles: keep the most important roles (pool is in priority order)
  const roles = shuffle(pool.slice(0, players.length));
  const labels = shuffle([...LEADER_LABELS]);
  let li = 0;
  await Promise.all(players.map((pl, i) => {
    const role = roles[i] || null;
    const leader = role && LEADER_ROLES.includes(role) ? (labels[li++] || null) : null;
    return update(s, 'players/' + pl.id, (p) => { p.role = role; p.leader = leader; return p; });
  }));
  return { ok: true, assigned: Math.min(players.length, pool.length), unassigned: Math.max(0, players.length - pool.length), missingRoles: Math.max(0, pool.length - players.length) };
}

async function clearRoles(s) {
  const players = await allPlayers(s);
  await Promise.all(players.map((pl) => update(s, 'players/' + pl.id, (p) => { p.role = null; p.leader = null; return p; })));
  return { ok: true };
}

async function kick(req, s) {
  const b = await body(req);
  const p = await s.get('players/' + b.playerId, { type: 'json' });
  if (!p) fail(404, 'no_player', '找不到此玩家');
  await s.delete('players/' + p.id);
  await s.delete('seen/' + p.id);
  await release(s, p.characterId, p.id);
  return { ok: true };
}

async function reset(s) {
  const meta = await getMeta(s);
  const players = await allPlayers(s);
  const t = now();
  if (players.length) {
    await s.setJSON(`archive/${t}-${meta.gameId}`, {
      gameId: meta.gameId, startedAt: meta.startedAt, endedAt: t,
      players: players.sort((a, b) => a.joinedAt - b.joinedAt).map((p) => ({ characterId: p.characterId, nickname: p.nickname || '', joinedAt: p.joinedAt, role: p.role || null, leader: p.leader || null })),
    });
  }
  const keys = [...await listKeys(s, 'players/'), ...await listKeys(s, 'claims/'), ...await listKeys(s, 'seen/')];
  await Promise.all(keys.map((k) => s.delete(k)));
  const next = { gameId: rid(6), startedAt: t, revealed: false };
  await s.setJSON('meta', next);
  return { ok: true, archived: players.length, gameId: next.gameId };
}

async function setConfig(req, s) {
  const b = await body(req);
  const roles = {};
  for (const r of ROLE_ORDER) {
    const n = b.roles && Number.isInteger(b.roles[r]) ? b.roles[r] : DEFAULT_ROLES[r];
    if (n < 0 || n > 20) fail(400, 'bad_count', '人數需介於 0–20');
    roles[r] = n;
  }
  await s.setJSON('config', { roles });
  return { ok: true, roles };
}

async function setRevealed(req, s) {
  const b = await body(req);
  const m = await update(s, 'meta', (m) => { m.revealed = !!b.revealed; return m; });
  return { ok: true, revealed: m.revealed };
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
