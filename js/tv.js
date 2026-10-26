/* TV page — waiting-room "bubble battle".
   The TV is the only place the physics runs (requestAnimationFrame). Phones only send counters
   (push / dodge totals) via POST /api/mini/act; the TV polls GET /api/mini/state every 250 ms
   (never overlapping, paused while the tab is hidden), diffs the counters and turns each new tap
   into an impulse. Nothing is scored or persisted. Design units: the 1024 x 576 stage. */
(function () {
  'use strict';
  var V = 6;                       // character asset version (same as lobby)
  var W = 1024, H = 576;
  var R0 = 54;                     // base bubble radius (design px) — shrinks when very crowded
  var POLL_MS = 250, POLL_STARTED_MS = 1000;
  // rules
  var PUSH_PER_SEC = 2;            // taps beyond 2 in any rolling second are ignored
  var DODGE_CD = 900;              // ms
  var MOMENTUM_MS = 1500;          // "recent tap power" window
  var POP_MS = 2000;               // popped: sit on the grass this long, then respawn
  var GROW = 0.24, GROW_MAX = 2.8; // +24 % of the original size per pop, capped at 2.8x
  var TIE = 0.15;                  // strengths within 15 % => elastic bounce
  // physics tuning
  var DRAG = 1.25;                 // 1/s exponential slow-down
  var DRIFT = 18;                  // idle drift speed (the bubble's terminal velocity when untouched)
  var PUSH_V = 330, PUSH_MOM = 105;// launch speed + extra per recent tap
  var TAP_POWER = 120;             // strength added per tap in the momentum window
  var MIN_POP = 200;               // a bubble needs at least this strength to pop another one
  var DODGE_SIDE = 380, DODGE_AWAY = 150;
  var VMAX = 900, RESTITUTION = 0.9, RUN_SPEED = 105;
  // where bubbles start: a staggered grid below the banner (6/5/6/5 = 22 slots)
  var SLOTS = [];
  [[195, 100, 6], [300, 182, 5], [405, 100, 6], [505, 182, 5]].forEach(function (r) {
    for (var i = 0; i < r[2]; i++) SLOTS.push({ x: r[1] + i * 165, y: r[0] });
  });

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), bubLayer = $('bubbles'), shLayer = $('shadows'), fxLayer = $('fx');
  var countEl = $('count'), emptyEl = $('empty'), connEl = $('conn');

  function img(cid, f) { return '../assets/characters/' + encodeURIComponent(cid) + '/' + f + '.webp?v=' + V; }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function el(tag, cls, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; }
  function now() { return performance.now(); }

  /* ---------- fit the 16:9 stage into any screen ---------- */
  function fit() {
    var k = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.setProperty('--k', String(k));
  }
  window.addEventListener('resize', fit);
  fit();

  /* ---------- bubbles ---------- */
  var bubbles = {};      // id -> bubble
  var slotOf = {};       // id -> slot index (kept while the player stays joined)
  var order = [];        // ids, joinedAt order
  var baseR = R0;

  function startPos(id) {
    var s = slotOf[id];
    if (s >= 0) return SLOTS[s];
    var h = hash(id);   // overflow (more players than slots): deterministic jitter
    return { x: 90 + (h % 845), y: 170 + ((h >>> 12) % 350) };
  }
  function assignSlots(list) {
    var used = {};
    list.forEach(function (p) { if (slotOf[p.id] >= 0) used[slotOf[p.id]] = 1; });
    list.forEach(function (p) {
      if (slotOf[p.id] !== undefined) return;
      var n = SLOTS.length, s = hash(p.id) % n, i;
      for (i = 0; i < n && used[s]; i++) s = (s + 7) % n;   // 7 is coprime with 22
      slotOf[p.id] = i < n ? s : -1;
      if (i < n) used[s] = 1;
    });
  }

  function setChar(b, cid) {
    b.cid = cid;
    b.imgs.forEach(function (im) { im.src = img(cid, im.getAttribute('data-n')); });
  }
  function makeBubble(p) {
    var st = startPos(p.id);
    var b = {
      id: p.id, cid: '', x: st.x, y: st.y, vx: 0, vy: 0, scale: 1, shown: 1, pops: 0,
      popped: false, popUntil: 0, taps: [], pushQ: [], dodgeAt: -1e9, dodgeQ: 0,
      phase: (hash(p.id) % 1000) / 1000 * Math.PI * 2, spin: (hash(p.id) & 1) ? 1 : -1,
      lastPush: null, lastDodge: null, face: 1, frame: '', lastHit: {}
    };
    b.el = el('div', 'bb spawn', bubLayer);
    var pop = el('div', 'bb__pop', b.el);
    b.lines = el('div', 'bb__lines', pop);
    for (var i = 0; i < 3; i++) el('i', '', b.lines);
    b.ball = el('div', 'bb__ball', pop);
    var spr = el('div', 'bb__spr', b.ball);
    b.imgs = [];
    [['s1', 'stale1'], ['s2', 'stale2'], ['r1', 'running1'], ['r2', 'running2']].forEach(function (f) {
      var im = el('img', 'f-' + f[0], spr); im.alt = ''; im.draggable = false; im.setAttribute('data-n', f[1]); b.imgs.push(im);
    });
    el('i', 'bb__glass', b.ball);
    b.sh = el('div', 'bb-sh', shLayer); el('i', '', b.sh);
    setChar(b, p.characterId);
    setTimeout(function () { b.el.classList.remove('spawn'); }, 500);
    return b;
  }
  function removeBubble(b) {
    b.el.classList.add('gone'); b.sh.remove();
    if (b.hitEl) b.hitEl.remove();
    setTimeout(function () { b.el.remove(); }, 450);
  }

  function nearest(b) {
    var best = null, bd = Infinity;
    for (var id in bubbles) {
      var o = bubbles[id];
      if (o === b || o.popped) continue;
      var d = (o.x - b.x) * (o.x - b.x) + (o.y - b.y) * (o.y - b.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function recentTaps(b, t) {
    while (b.taps.length && t - b.taps[0] > MOMENTUM_MS) b.taps.shift();
    return b.taps.length;
  }
  function strength(b, t) { return Math.hypot(b.vx, b.vy) + TAP_POWER * recentTaps(b, t); }

  function doPush(b, t) {
    var lastSec = 0;
    for (var i = 0; i < b.taps.length; i++) if (t - b.taps[i] < 1000) lastSec++;
    if (lastSec >= PUSH_PER_SEC) return false;                 // rate cap (also enforced on the phone)
    b.taps.push(t);
    var mom = recentTaps(b, t) - 1;
    var o = nearest(b), dx, dy;
    if (o) { dx = o.x - b.x; dy = o.y - b.y; }
    else { dx = W / 2 - b.x + Math.cos(b.phase) * 120; dy = H * 0.6 - b.y + Math.sin(b.phase) * 80; }
    var d = Math.hypot(dx, dy) || 1, sp = PUSH_V + PUSH_MOM * Math.min(mom, 4);
    b.vx = b.vx * 0.3 + dx / d * sp;
    b.vy = b.vy * 0.3 + dy / d * sp;
    b.target = o ? o.id : null;
    return true;
  }
  function doDodge(b, t) {
    if (t - b.dodgeAt < DODGE_CD) return false;                 // cooldown (also enforced on the phone)
    b.dodgeAt = t;
    var o = nearest(b), ax, ay;
    if (o) { ax = b.x - o.x; ay = b.y - o.y; } else { ax = Math.cos(b.phase); ay = Math.sin(b.phase); }
    var d = Math.hypot(ax, ay) || 1; ax /= d; ay /= d;
    var px = -ay, py = ax;                                       // perpendicular; pick the side facing the open field
    if (px * (W / 2 - b.x) + py * (H * 0.6 - b.y) < 0) { px = -px; py = -py; }
    b.vx = b.vx * 0.4 + px * DODGE_SIDE + ax * DODGE_AWAY;
    b.vy = b.vy * 0.4 + py * DODGE_SIDE + ay * DODGE_AWAY;
    return true;
  }

  function pop(loser, winner, t) {
    var r = baseR * loser.shown;
    burst(loser.x, loser.y, r);
    loser.popped = true; loser.popUntil = t + POP_MS;
    loser.el.style.display = 'none'; loser.sh.style.display = 'none';
    loser.vx = loser.vy = 0; loser.pops = 0; loser.scale = 1; loser.taps = []; loser.pushQ = []; loser.dodgeQ = 0;
    var h = el('div', 'bb-hit', fxLayer);
    h.style.transform = 'translate3d(' + loser.x.toFixed(1) + 'px,' + (loser.y + r * 0.35).toFixed(1) + 'px,0)';
    var hi = el('img', '', h);
    // character_05's hit1 source art is broken (outline only), so it always uses hit2
    var f = loser.cid === 'character_05' ? 'hit2' : (Math.random() < 0.5 ? 'hit1' : 'hit2');
    hi.src = img(loser.cid, f); hi.alt = ''; loser.hitFrame = f;
    el('b', '', h).innerHTML = DAZE;
    loser.hitEl = h;
    winner.pops++;
    winner.scale = Math.min(GROW_MAX, 1 + GROW * winner.pops);
    winner.vx *= 0.7; winner.vy *= 0.7;
    stats.pops++;
  }
  function respawn(b) {
    var st = startPos(b.id);
    b.popped = false; b.x = st.x; b.y = st.y; b.respawned = { x: st.x, y: st.y, at: now() }; b.vx = b.vy = 0; b.scale = 1; b.shown = 1; b.pops = 0;
    if (b.hitEl) { b.hitEl.remove(); b.hitEl = null; }
    b.el.style.display = ''; b.sh.style.display = '';
    b.el.classList.remove('spawn'); void b.el.offsetWidth; b.el.classList.add('spawn');
    setTimeout(function () { b.el.classList.remove('spawn'); }, 500);
  }

  var SPARK = '<svg viewBox="0 0 20 20"><path fill="currentColor" d="M10 0l2.4 7.6L20 10l-7.6 2.4L10 20l-2.4-7.6L0 10l7.6-2.4z"/></svg>';
  var STAR = '<svg viewBox="0 0 120 120"><defs><radialGradient id="tvbg"><stop offset="0" stop-color="#fffef6"/><stop offset=".55" stop-color="#fff3c8"/><stop offset="1" stop-color="#f3d98c"/></radialGradient></defs>' +
    '<polygon points="60.0,2.0 67.8,31.0 89.0,9.8 86.9,33.1 110.2,31.0 89.0,52.2 118.0,60.0 96.7,69.8 110.2,89.0 81.2,81.2 89.0,110.2 69.8,96.7 60.0,118.0 52.2,89.0 31.0,110.2 33.1,86.9 9.8,89.0 31.0,67.8 2.0,60.0 23.3,50.2 9.8,31.0 38.8,38.8 31.0,9.8 50.2,23.3" fill="url(#tvbg)" stroke="#f0d27e" stroke-width="1.5" stroke-linejoin="round" opacity=".95"/>' +
    '<g fill="none" stroke="#e9c86a" stroke-width="3" stroke-linecap="round">' + [20, 70, 160, 250, 300].map(function (a) { return '<path d="M60 4V-6" transform="rotate(' + a + ' 60 60)"/>'; }).join('') + '</g></svg>';
  var DAZE = '<svg viewBox="0 0 60 30"><g stroke="#3b2a1b" stroke-width="2.6" stroke-linecap="round"><path d="M6 22l-5-4"/><path d="M14 12l-3-6"/><path d="M46 12l3-6"/><path d="M54 22l5-4"/></g></svg>';
  function burst(x, y, r) {
    var f = el('div', 'fx', fxLayer), k = r / 50;
    f.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + k.toFixed(3) + ')';
    el('div', 'fx__ring', f);
    el('div', 'fx__star', f).innerHTML = STAR;
    for (var i = 0; i < 9; i++) {
      var d = el('i', 'fx__drop', f);
      d.style.setProperty('--a', (i * 40 + Math.random() * 20) + 'deg');
      d.style.setProperty('--d', (62 + Math.random() * 30) + 'px');
    }
    for (i = 0; i < 4; i++) {
      var s = el('i', 'fx__spark', f); s.innerHTML = SPARK; s.style.color = i % 2 ? '#f2c94c' : '#fff6cf';
      s.style.setProperty('--a', (i * 90 + 45) + 'deg'); s.style.setProperty('--d', '78px');
    }
    setTimeout(function () { f.remove(); }, 800);
  }

  /* ---------- physics ---------- */
  var lastT = 0, running = true;
  var stats = { pops: 0, bounces: 0, frames: 0 };
  function step(dt, t) {
    var ids = Object.keys(bubbles), i, j, b;
    var drag = Math.exp(-DRAG * dt);
    for (i = 0; i < ids.length; i++) {
      b = bubbles[ids[i]];
      if (b.popped) { if (t >= b.popUntil) respawn(b); else continue; }
      // queued inputs from the network
      while (b.pushQ.length && t - b.pushQ[0] > 1000) b.pushQ.shift();   // too old: ignored
      if (b.pushQ.length) { b.pushQ.shift(); doPush(b, t); }               // one launch per frame; rate cap inside
      if (b.dodgeQ) {
        if (t - b.dodgeAt >= DODGE_CD) { doDodge(b, t); b.dodgeQ = 0; }
        else if (t - b.dodgeQ > 300) b.dodgeQ = 0;                        // still cooling down: ignored
      }
      // drag + gentle idle drift (terminal velocity = DRIFT along a slowly turning heading)
      b.phase += dt * 0.35 * b.spin;
      b.vx = b.vx * drag + Math.cos(b.phase) * DRIFT * DRAG * dt;
      b.vy = b.vy * drag + Math.sin(b.phase) * DRIFT * DRAG * dt * 0.7;
      var sp = Math.hypot(b.vx, b.vy);
      if (sp > VMAX) { b.vx *= VMAX / sp; b.vy *= VMAX / sp; }
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.shown += (b.scale - b.shown) * Math.min(1, dt * 8);
      // rebound off the TV edges
      var r = baseR * b.shown;
      if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * RESTITUTION; b.edge = t; }
      else if (b.x > W - r) { b.x = W - r; b.vx = -Math.abs(b.vx) * RESTITUTION; b.edge = t; }
      if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * RESTITUTION; b.edge = t; }
      else if (b.y > H - r) { b.y = H - r; b.vy = -Math.abs(b.vy) * RESTITUTION; b.edge = t; }
    }
    // collisions
    for (i = 0; i < ids.length; i++) {
      var a = bubbles[ids[i]];
      if (a.popped) continue;
      for (j = i + 1; j < ids.length; j++) {
        b = bubbles[ids[j]];
        if (b.popped || a.popped) continue;
        var dx = b.x - a.x, dy = b.y - a.y, ra = baseR * a.shown, rb = baseR * b.shown;
        var dist = Math.hypot(dx, dy), min = ra + rb;
        if (dist >= min) continue;
        if (dist < 0.01) { dx = 1; dy = 0; dist = 1; }
        var nx = dx / dist, ny = dy / dist;
        var vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;   // < 0 => approaching
        if (vn < -25) {
          var sa = strength(a, t), sb = strength(b, t), hi = Math.max(sa, sb), lo = Math.min(sa, sb);
          if (hi >= MIN_POP && hi > lo * (1 + TIE)) {
            if (sa > sb) pop(b, a, t); else pop(a, b, t);
            continue;
          }
          // elastic bounce (masses ~ area)
          var ma = a.shown * a.shown, mb = b.shown * b.shown;
          var jimp = -2 * vn / (1 / ma + 1 / mb);
          a.vx -= jimp / ma * nx; a.vy -= jimp / ma * ny;
          b.vx += jimp / mb * nx; b.vy += jimp / mb * ny;
          stats.bounces++; a.lastBounce = b.lastBounce = t;
        }
        // separate overlapping bubbles
        var over = (min - dist), wa = (b.shown * b.shown) / (a.shown * a.shown + b.shown * b.shown);
        a.x -= nx * over * wa; a.y -= ny * over * wa;
        b.x += nx * over * (1 - wa); b.y += ny * over * (1 - wa);
      }
    }
  }

  function render(t) {
    var ids = Object.keys(bubbles);
    for (var i = 0; i < ids.length; i++) {
      var b = bubbles[ids[i]];
      if (b.popped) continue;
      var sp = Math.hypot(b.vx, b.vy), k = baseR * b.shown / 50;
      var bob = Math.sin(t / 1000 * 1.7 + b.phase * 3) * 4 * Math.max(0, 1 - sp / 200);
      var y = b.y + bob;
      b.el.style.transform = 'translate3d(' + b.x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + k.toFixed(3) + ')';
      b.el.style.zIndex = String(Math.round(b.y + baseR * b.shown));
      var shk = k * (1 - bob / 40);
      b.sh.style.transform = 'translate3d(' + b.x.toFixed(1) + 'px,' + (b.y + baseR * b.shown * 1.08).toFixed(1) + 'px,0) scale(' + shk.toFixed(3) + ')';
      // sprite: idle stale1/stale2, fast running1/running2 facing the travel direction
      var f;
      if (sp > RUN_SPEED) {
        if (Math.abs(b.vx) > 20) b.face = b.vx < 0 ? -1 : 1;
        f = (Math.floor(t / 110) % 2) ? 'r2' : 'r1';
      } else {
        b.face = 1;
        f = (Math.floor((t + b.phase * 300) / 480) % 2) ? 's2' : 's1';
      }
      if (f !== b.frame) { b.frame = f; b.el.setAttribute('data-f', f); }
      b.el.classList.toggle('flip', b.face < 0);
      // motion lines behind fast bubbles
      var lo = sp > 160 ? Math.min(1, (sp - 160) / 260) : 0;
      b.lines.style.opacity = lo.toFixed(2);
      if (lo > 0) b.lines.style.transform = 'rotate(' + Math.atan2(b.vy, b.vx).toFixed(3) + 'rad)';
    }
  }

  function frame(ts) {
    if (!running) return;
    var t = now();
    var dt = Math.min(0.05, Math.max(0, (t - (lastT || t)) / 1000));
    lastT = t;
    // fixed sub-steps keep fast bubbles from tunnelling
    var n = Math.max(1, Math.ceil(dt / 0.008));
    for (var i = 0; i < n; i++) step(dt / n, t);
    render(t);
    stats.frames++;
    requestAnimationFrame(frame);
  }
  function startLoop() { if (running) return; running = true; lastT = 0; requestAnimationFrame(frame); }
  function stopLoop() { running = false; }
  requestAnimationFrame(frame);

  /* ---------- network: GET /api/mini/state every 250 ms (1 s once the game has started) ---------- */
  var phase = 'lobby', inflight = false, lastPoll = 0, failures = 0, joined = -1, gameId = null;

  function applyState(s) {
    var t = now();
    if (s.gameId !== gameId) { gameId = s.gameId; }
    var list = (s.players || []).slice();
    order = list.map(function (p) { return p.id; });
    var seen = {};
    list.forEach(function (p) { seen[p.id] = 1; });
    for (var id in bubbles) if (!seen[id]) { removeBubble(bubbles[id]); delete bubbles[id]; delete slotOf[id]; }
    assignSlots(list);
    // bubbles shrink a little when the meadow gets crowded (never below 34)
    var n = Math.max(1, list.length);
    baseR = Math.max(34, Math.min(R0, Math.sqrt(0.30 * (W * (H - 130)) / (n * Math.PI))));
    list.forEach(function (p) {
      var b = bubbles[p.id];
      if (!b) { b = bubbles[p.id] = makeBubble(p); b.lastPush = p.push || 0; b.lastDodge = p.dodge || 0; return; }
      if (p.characterId !== b.cid) setChar(b, p.characterId);   // profile edit: keep position
      var push = p.push || 0, dodge = p.dodge || 0;
      if (push < b.lastPush || dodge < b.lastDodge) { b.lastPush = push; b.lastDodge = dodge; return; } // counters reset
      if (phase === 'lobby' && !b.popped) {
        for (var k = push - b.lastPush; k > 0 && b.pushQ.length < PUSH_PER_SEC; k--) b.pushQ.push(t);
        if (dodge > b.lastDodge) b.dodgeQ = t;
      }
      b.lastPush = push; b.lastDodge = dodge;
    });
    if (s.joined !== joined) {
      joined = s.joined;
      countEl.textContent = String(joined);
      countEl.classList.remove('bump'); void countEl.offsetWidth; countEl.classList.add('bump');
    }
    emptyEl.hidden = list.length > 0;
    var started = s.phase === 'started';
    // round title screen (r1–r3) only while started; an older backend without `screen` = placeholder
    setScreen(started && (ROUNDS[s.screen] || s.screen === 'reveal') ? s.screen : 'lobby', s.leaders, s);
    if (screen === 'reveal') renderRevealCount(s.reveal);
    // an open vote shows on any round screen; a just-sealed one only on its own round's screen
    renderVote(ROUNDS[screen] && s.vote && (!s.vote.sealed || s.vote.round === screen) ? s.vote : null);
    setPhase(started ? 'started' : 'lobby', list);
  }

  /* ---------- round title screens + leader cards ---------- */
  var ROUNDS = {
    r1: { title: 'Round 1 三句話' },
    r2: { title: 'Round 2 誰是真領袖？' },
    r3: { title: 'Round 3 破解密碼 — 最後的線索' }
  };
  var SLOTS4 = ['a', 'b', 'c', 'd'];   // internal colour slots only — the card label is the character NAME
  var names = {};
  fetch('../data/characters.json', { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { ((d && d.characters) || []).forEach(function (c) { names[c.id] = c.name; }); if (ROUNDS[screen]) renderCards(lastLeaders); })
    .catch(function () {});
  var lastLeaders = null, cardsNames = -1;
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var screen = 'lobby', cardsKey = '';
  /* 身份揭曉: aggregate count only ({revealed, total}) — the TV never knows WHO has looked */
  var rvKey = '';
  function renderRevealCount(r) {
    var done = r ? Math.max(0, r.revealed | 0) : 0, total = r ? Math.max(0, r.total | 0) : 0, k = done + '/' + total;
    $('rvCount').hidden = !r;
    if (k === rvKey) return;
    var bump = rvKey && done !== +rvKey.split('/')[0];
    rvKey = k;
    var d = $('rvDone');
    d.textContent = String(done); $('rvTotal').textContent = String(total);
    $('rvBar').style.width = (total ? Math.min(100, Math.round(done / total * 100)) : 0) + '%';
    if (bump) { d.classList.remove('bump'); void d.offsetWidth; d.classList.add('bump'); }
  }
  function roundImg(r, part) { return '../assets/img/round-' + r + '-' + part + '.webp?v=1'; }
  function setScreen(sc, leaders, s) {
    if (sc !== screen) {
      screen = sc;
      document.body.classList.toggle('is-round', sc !== 'lobby');
      // 身份揭曉 has its own layer (no leader cards / lambs)
      var rv = $('reveal');
      if (sc === 'reveal') { rv.hidden = true; void rv.offsetWidth; }
      rv.hidden = sc !== 'reveal';
      var on = !!ROUNDS[sc];
      var el = $('round');
      if (on) {
        el.dataset.r = sc;
        $('roundBg').src = roundImg(sc, 'bg');
        $('roundBanner').src = roundImg(sc, 'banner');
        $('roundTitle').textContent = ROUNDS[sc].title;
        // replay the entrance animation on every switch
        el.hidden = true; void el.offsetWidth;
      }
      el.hidden = !on;
    }
    // easter egg: the server's lamb count (r1 = 1; r2 / r3 = true-leader votes of the previous round); checked every poll
    renderLambs(ROUNDS[sc] ? (s && s.lambs != null ? s.lambs : (sc === 'r1' ? 1 : 0)) : 0);
    if (ROUNDS[screen]) {
      // Round 1 = the first time the leaders are shown publicly: play the entrance once per game
      // (remembered in localStorage so a TV reload mid-round doesn't replay it)
      if (screen === 'r1' && s && s.gameId && introSeen() !== s.gameId) startIntro(s.gameId);
      else if (screen !== 'r1' && intro === 'playing') endIntro();   // left r1 mid-entrance: show the plain cards
      renderCards(leaders);
    }
  }
  var INTRO_KEY = 'wwyf-r1-intro', intro = 'idle', introT = 0, INTRO_MS = 4200;
  function introSeen() { try { return localStorage.getItem(INTRO_KEY); } catch (e) { return null; } }
  function startIntro(gid) {
    try { localStorage.setItem(INTRO_KEY, gid); } catch (e) {}
    intro = 'playing'; cardsKey = '\u0000';   // force a re-render with the intro markup
    var box = $('cards'); box.classList.add('is-intro');
    clearTimeout(introT);
    introT = setTimeout(endIntro, INTRO_MS);
  }
  function endIntro() {
    clearTimeout(introT); intro = 'done';
    var box = $('cards');
    // settle in place: drop the face-down backs + sparkles without re-rendering (a re-render would replay the plain pop-in)
    Array.prototype.forEach.call(box.querySelectorAll('.lc__back, .lc__fx'), function (e) { e.remove(); });
    Array.prototype.forEach.call(box.querySelectorAll('.lc'), function (e) { e.style.animation = 'none'; });
    box.classList.remove('is-intro');
  }
  var FX = '<i class="lc__fx" aria-hidden="true">' + [1, 2, 3, 4, 5].map(function (n) {
    return '<svg class="lc__st lc__st--' + n + '" viewBox="0 0 20 20"><path d="M10 0l2.4 7.6L20 10l-7.6 2.4L10 20l-2.4-7.6L0 10l7.6-2.4z"/></svg>';
  }).join('') + '</i>';
  function renderCards(leaders) {
    var L = [0, 1, 2, 3].map(function (i) { var c = leaders && leaders[i]; return c && c.characterId ? c.characterId : ''; });
    lastLeaders = leaders;
    var key = L.join('|'), nk = Object.keys(names).length;
    if (key === cardsKey && nk === cardsNames) return;
    cardsKey = key; cardsNames = nk;
    var playing = intro === 'playing';
    $('cards').innerHTML = L.map(function (cid, i) {
      var l = SLOTS4[i], nm = cid ? (names[cid] || '') : '';
      return '<div class="lc lc--' + l + (cid ? '' : ' is-empty') + '" data-slot="' + (i + 1) + '" style="--i:' + i + '">' +
        (playing ? '<div class="lc__back" aria-hidden="true"><span lang="en">?</span></div>' + (cid ? FX : '') : '') +
        '<div class="lc__circle">' + (cid ? '<img alt="" src="' + img(cid, 'stale1') + '">' : '<span class="lc__q" lang="en">?</span>') + '</div>' +
        '<p class="lc__pill"><b lang="en">' + (nm ? esc(nm) : '?') + '</b></p></div>';
    }).join('');
  }
  /* ---------- 投票中 overlay (round screens): countdown + 已投票 X / N, then 已封票 ---------- */
  var voteKey = '', voteEnd = null, voteTick = 0;
  function renderVote(v) {
    var el = $('tvVote');
    if (!v) { if (!el.hidden) { el.hidden = true; voteKey = ''; clearInterval(voteTick); voteTick = 0; } return; }
    voteEnd = v.sealed || v.remain == null ? null : now() + v.remain;
    var k = [v.round, v.sealed, v.voted, v.total, v.remain == null].join('|');
    if (el.hidden) { el.hidden = false; void el.offsetWidth; }
    if (k !== voteKey) {
      var bump = voteKey && +voteKey.split('|')[2] !== v.voted;
      voteKey = k;
      el.classList.toggle('is-sealed', !!v.sealed);
      el.classList.toggle('is-final', !!v.final);
      $('tvVoteTag').textContent = v.sealed ? '已封票' : v.final ? '最後投票' : '投票中';
      $('tvVoted').textContent = String(v.voted); $('tvTotal').textContent = String(v.total);
      $('tvVoteBar').style.width = (v.total ? Math.min(100, Math.round(v.voted / v.total * 100)) : 0) + '%';
      if (bump) { var d = $('tvVoted'); d.classList.remove('bump'); void d.offsetWidth; d.classList.add('bump'); }
    }
    voteClock();
    if (!voteTick) voteTick = setInterval(voteClock, 250);
  }
  function voteClock() {
    var t = $('tvVoteTime'), el = $('tvVote');
    if (el.classList.contains('is-sealed')) { t.classList.remove('is-text'); t.textContent = '✓'; t.classList.remove('is-low'); return; }
    t.classList.toggle('is-text', voteEnd == null);
    if (voteEnd == null) { t.textContent = '不限時'; t.classList.remove('is-low'); return; }
    var x = Math.max(0, Math.ceil((voteEnd - now()) / 1000));
    t.textContent = ('0' + Math.floor(x / 60)).slice(-2) + ':' + ('0' + (x % 60)).slice(-2);
    t.classList.toggle('is-low', x <= 10);
  }

  /* ---------- lambs easter egg (bottom-right, below the signpost) ----------
     up to LAMB_MAX lambs: one row of ≤ 5 at full size; more = two rows, smaller and closer together */
  var LAMB = ['../assets/tv/lamb-walk1.webp?v=1', '../assets/tv/lamb-walk2.webp?v=1'];
  var LAMB_MAX = 20, lambCount = -1;
  function renderLambs(n) {
    n = Math.max(0, Math.min(LAMB_MAX, n | 0));
    if (n === lambCount) return;
    lambCount = n;
    var box = $('lambs');
    box.hidden = n === 0;
    var rows = n > 5 ? 2 : 1, cols = Math.ceil(n / rows);
    var sc = rows === 1 ? 1 : Math.max(0.5, Math.min(0.8, 5.2 / cols));
    var step = cols > 1 ? Math.min(30, (196 - 84 * sc) / (cols - 1)) : 0;
    box.innerHTML = Array.from({ length: n }, function (_, i) {
      var row = rows === 2 && i >= cols ? 1 : 0, c = row ? i - cols : i;
      // back row sits higher and a half-step over; stagger each lamb so a flock doesn't march in lockstep
      var x = 20 + c * step + (row ? step / 2 : 0), b = rows === 1 ? 52 - i * 4 : (row ? 66 : 30) - c * 2;
      return '<div class="lamb' + (row ? ' lamb--back' : '') + '" style="--i:' + i + ';--n:' + n + ';--x:' + x.toFixed(1) + 'px;--b:' + b + 'px;--s:' + sc.toFixed(3) + '"><div class="lamb__bob">' +
        '<img class="lamb__f1" alt="" draggable="false" src="' + LAMB[0] + '">' +
        '<img class="lamb__f2" alt="" draggable="false" src="' + LAMB[1] + '"></div></div>';
    }).join('');
  }
  // warm the cache so the first switch to a round is instant
  setTimeout(function () {
    Object.keys(ROUNDS).forEach(function (r) { ['bg', 'banner', 'ext'].forEach(function (p) { new Image().src = roundImg(r, p); }); });
    new Image().src = '../assets/img/banner-blank.webp?v=1';
    LAMB.forEach(function (u) { new Image().src = u; });
  }, 2500);

  function setPhase(p, list) {
    if (p === phase && !(p === 'started' && list && list.length !== startedCount)) return;
    phase = p;
    document.body.classList.toggle('is-started', p === 'started');
    $('title').textContent = p === 'started' ? "Let's play!" : 'Waiting for everyone...';
    $('sub').textContent = p === 'started' ? '遊戲已開始，請留意主持人的指示！' : '等齊所有玩家，一齊開始遊戲！';
    $('started').hidden = p !== 'started';
    if (p === 'started') {
      stopLoop();
      startedCount = (list || []).length;
      $('startedRow').innerHTML = (list || []).map(function (x) {
        return '<img alt="" src="' + img(x.characterId, 'stale1') + '" style="animation-delay:' + ((hash(x.id) % 16) / 10) + 's">';
      }).join('');
    } else {
      // back to the waiting room: everyone starts fresh from their spot
      for (var id in bubbles) { var b = bubbles[id]; if (b.popped) respawn(b); else { var st = startPos(id); b.x = st.x; b.y = st.y; b.vx = b.vy = 0; b.scale = 1; b.shown = 1; b.pops = 0; } }
      startLoop();
    }
  }
  var startedCount = -1;

  // Self-scheduling poll: the next request goes out exactly POLL_MS after the previous one started
  // (or right after it finished if it took longer) — no 50 ms tick quantisation, one request in flight.
  var pollTimer = 0;
  function interval() { return phase === 'started' ? POLL_STARTED_MS : POLL_MS; }
  function schedule() {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    pollTimer = setTimeout(poll, Math.max(0, lastPoll + interval() - now()));
  }
  function poll() {
    if (inflight || document.hidden) return;
    inflight = true; lastPoll = now(); stats.polls = (stats.polls || 0) + 1;
    WWYF.miniState().then(function (s) {
      failures = 0; connEl.hidden = true;
      applyState(s);
    }).catch(function () {
      if (++failures >= 3) connEl.hidden = false;
    }).then(function () { inflight = false; schedule(); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastT = 0; if (!inflight) poll(); } else clearTimeout(pollTimer); });
  poll();

  // read-only hook for automated checks
  window.WWYF_TV = { bubbles: bubbles, slots: SLOTS, slotOf: slotOf, stats: stats, get phase() { return phase; }, get screen() { return screen; }, get cards() { return cardsKey; }, get intro() { return intro; }, get lambs() { return lambCount < 0 ? 0 : lambCount; }, get vote() { var e = $('tvVote'); return e.hidden ? null : { tag: $('tvVoteTag').textContent, time: $('tvVoteTime').textContent, voted: +$('tvVoted').textContent, total: +$('tvTotal').textContent, sealed: e.classList.contains('is-sealed') }; }, renderLambs: renderLambs, get baseR() { return baseR; }, get running() { return running; }, startPos: startPos };
})();
