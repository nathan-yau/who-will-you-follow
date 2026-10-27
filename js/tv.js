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
    setScreen(started && (ROUNDS[s.screen] || s.screen === 'reveal' || s.screen === 'final' || s.screen === 'ending' || s.screen === 'howto') ? s.screen : 'lobby', s.leaders, s);
    renderHowto(screen === 'howto' ? s.howto || {} : null, list);
    renderFinal(screen === 'final' ? s.final : null);
    renderEnding(screen === 'ending' ? s.ending || null : undefined);
    if (screen === 'reveal') renderRevealCount(s.reveal);
    // an open vote shows on any round screen; a just-sealed one only on its own round's screen
    renderVote(ROUNDS[screen] && s.vote && (!s.vote.sealed || s.vote.round === screen) ? s.vote : null);
    renderQuiz(screen === 'r3' && $('tvVote').hidden && s.quiz && (s.quiz.q || (s.quiz.unlocked && s.quiz.clue)) ? s.quiz : null);
    renderSpeak(ROUNDS[screen] && $('tvVote').hidden && $('tvQuiz').hidden && s.speak && s.speak.round === screen && s.speak.state === 'live' ? s.speak : null);
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
    .then(function (d) { ((d && d.characters) || []).forEach(function (c) { names[c.id] = c.name; }); if (ROUNDS[screen]) renderCards(lastLeaders); if (screen === 'final') { finalKey = ''; renderFinal(lastFinal); } })
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
      document.body.classList.toggle('is-final', sc === 'final' || sc === 'ending' || sc === 'howto');
      var hw = $('howto');
      if (sc === 'howto') { hw.hidden = true; void hw.offsetWidth; hwKey = ''; }
      hw.hidden = sc !== 'howto';
      document.body.classList.toggle('is-ending', sc === 'ending');
      var en = $('ending');
      if (sc === 'ending') { en.hidden = true; void en.offsetWidth; }
      en.hidden = sc !== 'ending';
      // 身份揭曉 has its own layer (no leader cards / lambs)
      var rv = $('reveal');
      if (sc === 'reveal') { rv.hidden = true; void rv.offsetWidth; }
      rv.hidden = sc !== 'reveal';
      var fn = $('final');
      if (sc === 'final') { fn.hidden = true; void fn.offsetWidth; }
      fn.hidden = sc !== 'final';
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
        '<div class="lc__circle">' + (cid ? '<img alt="" style="--dx:' + (window.wwyfSpriteDx ? window.wwyfSpriteDx(cid) : 0) + '" src="' + img(cid, 'stale1') + '">' : '<span class="lc__q" lang="en">?</span>') + '</div>' +
        '<p class="lc__pill"><b lang="en">' + (nm ? esc(nm) : '?') + '</b></p></div>';
    }).join('');
  }
  /* ---------- 最終揭曉: flip cards (any order) → 假領袖 stamp / 真正領袖 celebration; 揭曉支持者 pops the supporter out ----------
     Only animates CHANGES seen while this TV is open (a reload just shows the current state). */
  var finalKey = '', lastFinal = null, fnSeen = null, fnTimers = [];
  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CROWN = '<svg class="fc__crown" viewBox="0 0 64 44" aria-hidden="true"><path d="M4 40 L8 10 L22 24 L32 4 L42 24 L56 10 L60 40 Z" fill="#f6c94c" stroke="#b7862a" stroke-width="3" stroke-linejoin="round"/><circle cx="8" cy="10" r="4" fill="#f5ab9b"/><circle cx="32" cy="4" r="4" fill="#9fbedd"/><circle cx="56" cy="10" r="4" fill="#f5ab9b"/></svg>';
  function fnCardHtml(c, i) {
    var cid = c.characterId, nm = names[cid] || '';
    return '<div class="fc" data-slot="' + (i + 1) + '" style="--i:' + i + '">' +
      '<div class="fc__glow" aria-hidden="true"></div>' + CROWN +
      '<div class="lc lc--' + SLOTS4[i] + '"><div class="lc__circle"><img alt="" style="--dx:' + (window.wwyfSpriteDx ? window.wwyfSpriteDx(cid) : 0) + '" src="' + img(cid, 'stale1') + '"></div>' +
      '<p class="lc__pill"><b lang="en">' + (nm ? esc(nm) : '?') + '</b></p>' +
      '<span class="fc__q" lang="en" aria-hidden="true">?</span><span class="fc__stamp"></span></div>' +
      '<div class="fc__supp"></div><p class="fc__votes"></p></div>';
  }
  function fnConfetti(el, n) {
    if (RM) return;
    var cols = ['#f6c94c', '#f5ab9b', '#9fbedd', '#a9cf8f', '#fdfaf1'], h = '';
    for (var k = 0; k < n; k++) {
      var a = (k / n) * Math.PI * 2 + Math.random() * 0.4, d = 90 + Math.random() * 120;
      h += '<i style="--x:' + Math.round(Math.cos(a) * d) + 'px;--y:' + Math.round(Math.sin(a) * d - 60) + 'px;--r:' + Math.round(Math.random() * 720 - 360) + 'deg;background:' + cols[k % cols.length] + ';animation-delay:' + (0.6 + Math.random() * 0.15).toFixed(2) + 's"></i>';
    }
    var box = document.createElement('div'); box.className = 'fc__confetti'; box.innerHTML = h;
    el.appendChild(box); setTimeout(function () { box.remove(); }, 2200);
  }
  function fnApply(el, c, anim) {
    var role = c.flipped ? c.role : '', sup = c.supporters || null;
    if (!role && el._wait) { clearTimeout(el._wait); el._wait = 0; }
    if (role && !el.classList.contains('is-' + role)) {
      el.classList.add('is-flipped', 'is-' + role);
      el.querySelector('.fc__stamp').textContent = role === 'true' ? '真正領袖' : '假領袖';
      if (anim) { el.classList.add('anim'); if (role === 'true') { fnConfetti(el, 36); setTimeout(function () { fnConfetti(el, 24); }, 650); } }
    }
    if (!role) { el.classList.remove('is-flipped', 'is-true', 'is-fake', 'anim', 'has-supp', 'anim-supp'); el.querySelector('.fc__supp').innerHTML = ''; }
    var sk = sup ? sup.map(function (x) { return x.characterId; }).join(',') : '';
    if (el.dataset.supp !== sk) {
      el.dataset.supp = sk;
      el.classList.toggle('has-supp', !!sup);
      el.querySelector('.fc__supp').innerHTML = sup ? sup.slice(0, 3).map(function (x, k) {
        return '<span class="fs" style="--k:' + k + '"><span class="fs__c"><img alt="" style="--dx:' + (window.wwyfSpriteDx ? window.wwyfSpriteDx(x.characterId) : 0) + '" src="' + img(x.characterId, 'stale1') + '"></span><b>' + esc(names[x.characterId] || '') + '</b></span>';
      }).join('') : '';
      if (sup && anim) { el.classList.remove('anim-supp'); void el.offsetWidth; el.classList.add('anim-supp'); }
    }
    el.querySelector('.fc__votes').textContent = c.votes != null ? '最後投票 ' + c.votes + ' 票' : '';
    el.classList.toggle('has-votes', c.votes != null);
  }
  function renderFinal(f) {
    lastFinal = f;
    if (!f) { if (finalKey) { finalKey = ''; fnSeen = null; fnTimers.forEach(clearTimeout); fnTimers = []; $('fnCards').innerHTML = ''; } return; }
    var cards = (f.cards || []).map(function (c, i) { return c ? { c: c, i: i } : null; }).filter(Boolean);
    var key = cards.map(function (x) { return x.i + ':' + x.c.characterId; }).join('|') + '#' + Object.keys(names).length;
    var box = $('fnCards'), first = key !== finalKey;
    if (first) {
      finalKey = key; fnTimers.forEach(clearTimeout); fnTimers = [];
      box.innerHTML = cards.map(function (x) { return fnCardHtml(x.c, x.i); }).join('');
      box.dataset.n = String(cards.length);
    }
    var prev = first ? null : fnSeen, seen = {};
    cards.forEach(function (x) {
      var c = x.c, el = box.querySelector('.fc[data-slot="' + (x.i + 1) + '"]');
      seen[x.i] = c;
      // animate only a change seen live (not the state found when this TV loaded); 全部翻開 comes staggered by `at`
      var anim = !!prev && !RM;
      var late = c.flipped && c.at && f.t && c.at > f.t ? c.at - f.t : 0;
      if (anim && late && !el.classList.contains('is-flipped')) {
        if (!el._wait) { el._wait = setTimeout(function () { el._wait = 0; fnApply(el, c, true); }, late); fnTimers.push(el._wait); }
        return;
      }
      fnApply(el, c, anim);
    });
    fnSeen = seen;
    var nf = cards.filter(function (x) { return x.c.flipped; }).length;
    $('fnSub').textContent = !nf ? '誰才是真正領袖？' : nf < cards.length ? '已翻開 ' + nf + ' / ' + cards.length + ' 張' : '全部揭曉！';
  }

  /* ---------- 結局 (screen 'ending'): the meter fills to X / N (% who followed the 真正領袖) with the target line,
     then 勝利！(confetti, the true leader crowned in the middle, lambs walking) or 差一點點…(smug 假領袖 + a sad true leader).
     Data = aggregate only: {win, x, n, pct, threshold, leaders:[{characterId, role, votes}]} (never who voted for whom).
     Copy: data/texts.json "ending" (defaults below). Reduced motion: the final state at once. */
  var EDEF = { tvTitle: '結局', tvSub: '最後投票：有幾多人跟隨了真正的領袖？', meterLabel: '跟隨真正領袖', target: '目標 {t}%', count: '{x} / {n} 人（約 {p}%）',
    winTitle: '勝利！', winLine: '大家成功跟隨了真正的領袖！', loseTitle: '差一點點…', loseLine: '假領袖勝出…', votes: '{n} 票', trueTag: '真正領袖', fakeTag: '假領袖', waiting: '結局計算中…' };
  var ET = null;
  fetch('../data/texts.json?v=10', { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ending) { ET = d.ending; endKey = ''; if (screen === 'ending') renderEnding(lastEnding); }
      if (d && d.howto) { HT = d.howto; hwKey = ''; if (screen === 'howto') renderHowto(lastHowto, lastHowtoList); }
    }).catch(function () {});
  function E(k) { return ET && ET[k] != null && ET[k] !== '' ? ET[k] : EDEF[k]; }
  function fillT(t, o) { return String(t).replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); }
  var endKey = '', lastEnding = null, lastEndingRecv = 0, enTimers = [], enRaf = 0, enStage = '', enCounted = 0;
  function enClear() { enTimers.forEach(clearTimeout); enTimers = []; cancelAnimationFrame(enRaf); enRaf = 0; }
  function enSprite(cid, cls, frames) {
    var box = window.wwyfSpriteBox ? wwyfSpriteBox(cid) : [0.1, 0.15, 0.9, 0.96], dx = window.wwyfSpriteDx ? wwyfSpriteDx(cid) : 0;
    return '<div class="en-spr ' + cls + '" data-cid="' + esc(cid) + '" style="--dx:' + dx + ';--t:' + box[1].toFixed(3) + '"><div class="en-spr__in">' +
      frames.map(function (f, k) { return '<img class="en-f' + (k + 1) + '" alt="" draggable="false" src="' + img(cid, f) + '">'; }).join('') + '</div></div>';
  }
  function enConfetti(waves) {
    if (RM) return;
    var cols = ['#f6c94c', '#f5ab9b', '#9fbedd', '#a9cf8f', '#fdfaf1', '#e9b8e0'], box = $('enConf');
    for (var w = 0; w < waves; w++) (function (w) {
      enTimers.push(setTimeout(function () {
        var h = '';
        for (var k = 0; k < 70; k++) h += '<i style="left:' + (Math.random() * 100).toFixed(1) + '%;--r:' + Math.round(Math.random() * 900 - 450) + 'deg;--sx:' + Math.round(Math.random() * 120 - 60) + 'px;background:' + cols[k % cols.length] +
          ';animation-duration:' + (2.4 + Math.random() * 1.6).toFixed(2) + 's;animation-delay:' + (Math.random() * 0.8).toFixed(2) + 's"></i>';
        var g = document.createElement('div'); g.className = 'en-conf__w'; g.innerHTML = h; box.appendChild(g);
        enTimers.push(setTimeout(function () { g.remove(); }, 5200));
      }, w * 1800));
    })(w);
  }
  function renderEnding(e) {
    if (e === undefined) { if (endKey || lastEnding) { endKey = ''; lastEnding = null; enStage = ''; enClear(); $('enConf').innerHTML = ''; } return; }
    if (e !== lastEnding) { lastEnding = e; lastEndingRecv = now(); }
    var sec = $('ending');
    $('enTitle').textContent = E('tvTitle');
    if (!e) { if (endKey !== 'none') { endKey = 'none'; enClear(); enStage = 'wait'; sec.className = 'tv-round tv-ending is-wait'; $('enSub').textContent = E('waiting');
      ['enScene', 'enChips', 'enLambs', 'enConf'].forEach(function (id) { $(id).innerHTML = ''; }); } return; }
    var key = [e.win, e.x, e.n, e.pct, e.threshold, e.at, (e.order || []).join(','), (e.leaders || []).map(function (l) { return l.characterId + l.role + l.votes; }).join(','), Object.keys(names).length, ET ? 1 : 0].join('|');
    if (key === endKey) return;
    // where we are on the server's 點票 timeline (ms since 顯示結局) — a reload mid-count resumes, after the end it shows the result
    var EL = (e.el || 0) + (lastEndingRecv ? now() - lastEndingRecv : 0);
    endKey = key; enClear();
    $('enSub').textContent = E('tvSub');
    $('enLabel').textContent = E('meterLabel');
    $('enTargetText').textContent = fillT(E('target'), { t: e.threshold });
    $('enTarget').style.left = Math.max(0, Math.min(100, e.threshold)) + '%';
    $('enResTitle').textContent = e.win ? E('winTitle') : E('loseTitle');
    $('enResLine').textContent = e.win ? E('winLine') : E('loseLine');
    var L = e.leaders || [], tl = L.filter(function (l) { return l.role === 'true'; })[0], fk = L.filter(function (l) { return l.role !== 'true'; });
    // the scene (existing sprites: stale = idle / smug bounce, hit = sad) — hidden until the count is done
    var sc = '';
    if (e.win && tl) sc = '<i class="en-rays"></i>' + enSprite(tl.characterId, 'en-spr--hero', ['stale1', 'stale2']) ;
    else if (!e.win) {
      sc = fk.map(function (l, k) { return enSprite(l.characterId, 'en-spr--smug', ['stale1', 'stale2']).replace('style="', 'style="--k:' + k + ';--o:' + (k % 2 ? 1 : -1) * (Math.floor(k / 2) + 1) + ';'); }).join('') +
        (tl ? enSprite(tl.characterId, 'en-spr--sad', ['hit2']) : '');
    }
    $('enScene').innerHTML = sc;
    var hero = $('enScene').querySelector('.en-spr--hero');
    if (hero) hero.insertAdjacentHTML('beforeend', CROWN.replace('fc__crown', 'en-crown'));
    var sad = $('enScene').querySelector('.en-spr--sad');
    if (sad) sad.insertAdjacentHTML('beforeend', '<svg class="en-drop" viewBox="0 0 20 28"><path d="M10 2C6 10 3 14 3 18a7 7 0 0 0 14 0c0-4-3-8-7-16Z" fill="#9fc7ea" stroke="#5f8fbf" stroke-width="2"/></svg>');
    $('enLambs').innerHTML = e.win ? [40, 150, 260, 700, 810, 900].map(function (x, i) {
      return '<div class="lamb" style="--i:' + i + ';--x:' + x + 'px;--b:' + (i % 3 === 1 ? 10 : 2) + 'px;--s:' + (i % 3 === 1 ? 0.8 : 0.9) + '"><div class="lamb__bob"><img class="lamb__f1" alt="" draggable="false" src="' + LAMB[0] + '"><img class="lamb__f2" alt="" draggable="false" src="' + LAMB[1] + '"></div></div>';
    }).join('') : '';
    $('enChips').innerHTML = L.map(function (l, k) {
      var dx = window.wwyfSpriteDx ? wwyfSpriteDx(l.characterId) : 0;
      return '<div class="en-chip is-' + (l.role === 'true' ? 'true' : 'fake') + '" data-cid="' + esc(l.characterId) + '" style="--k:' + k + '"><span class="en-chip__c"><img alt="" src="' + img(l.characterId, 'stale1') + '" style="--dx:' + dx + '"></span>' +
        '<b class="en-chip__n" lang="en">' + esc(names[l.characterId] || '') + '</b><span class="en-chip__r">' + esc(l.role === 'true' ? E('trueTag') : E('fakeTag')) + '</span>' +
        '<span class="en-chip__v"></span></div>';
    }).join('');
    sec.className = 'tv-round tv-ending is-live ' + (e.win ? 'is-win' : 'is-lose');
    var order = e.order || [], plan = e.plan || { t: [], result: 0 }, n = e.n | 0, trueCid = tl && tl.characterId;
    var cnt = {}, x = 0, chipEl = {};
    [].forEach.call($('enChips').children, function (c) { chipEl[c.getAttribute('data-cid')] = c; cnt[c.getAttribute('data-cid')] = 0; });
    function setFill(p) { $('enFill').style.width = p + '%'; $('enPct').textContent = Math.round(p) + '%'; $('enPct').style.left = Math.max(4, Math.min(96, p)) + '%'; }
    function paint(popCid) {
      var p = n ? Math.round(x * 100 / n) : 0;
      setFill(p);
      $('enCount').textContent = fillT(E('count'), { x: x, n: n, p: Math.round(p) });
      $('enMeter').classList.toggle('is-met', n > 0 && x * 100 >= e.threshold * n);
      Object.keys(chipEl).forEach(function (cid) { chipEl[cid].querySelector('.en-chip__v').textContent = fillT(E('votes'), { n: cnt[cid] }); });
      if (popCid && chipEl[popCid]) { var c = chipEl[popCid]; c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
    }
    function step(i, live) {
      var cid = order[i];
      if (cid in cnt) cnt[cid]++;
      if (cid === trueCid) x++;
      enCounted = i + 1;
      $('enMeter').classList.remove('is-tense');
      if (live) { $('enFill').classList.toggle('is-up', cid === trueCid); paint(cid); }
    }
    function done(fresh) {
      enStage = 'done'; enCounted = order.length;
      sec.classList.remove('is-counting'); sec.classList.add('is-done');
      $('enMeter').classList.remove('is-tense');
      if (fresh && e.win) enConfetti(3);
    }
    enCounted = 0;
    if (RM || EL >= plan.result) {
      // reduced motion, or the count already finished (reload / late TV): straight to the result — no replay
      for (var i0 = 0; i0 < order.length; i0++) step(i0, false);
      paint(); done(!RM && EL < plan.result + 3000);
      return;
    }
    enStage = 'count'; sec.classList.add('is-counting');
    var i1 = 0;
    for (; i1 < order.length && plan.t[i1] <= EL; i1++) step(i1, false);
    paint();
    for (var i = i1; i < order.length; i++) (function (i) {
      var gap = plan.t[i] - (i ? plan.t[i - 1] : 0);
      if (gap > 1000 && plan.t[i] - 1100 > EL) enTimers.push(setTimeout(function () { $('enMeter').classList.add('is-tense'); }, plan.t[i] - 1100 - EL));
      enTimers.push(setTimeout(function () { step(i, true); }, plan.t[i] - EL));
    })(i);
    enTimers.push(setTimeout(function () { done(true); }, plan.result - EL));
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

  /* ---------- Round 3 破解密碼: question + 解鎖進度 + 已作答 X / N (aggregate); answer + result only after close ---------- */
  var quizEnd = null, quizTick = 0, quizKey = '';
  function renderQuiz(z) {
    var el = $('tvQuiz'), rnd = $('round');
    if (!z) { if (!el.hidden) { el.hidden = true; rnd.classList.remove('has-quiz'); clearInterval(quizTick); quizTick = 0; quizKey = ''; } return; }
    var q = z.q, mode = q && q.open ? 'open' : z.unlocked && z.clue ? 'clue' : 'done';
    if (el.hidden) { el.hidden = false; rnd.classList.add('has-quiz'); }
    el.setAttribute('data-q', mode);
    var dots = (z.states || []).map(function (x, i) { return '<i class="' + x + '">' + (x === 'ok' ? '✓' : i + 1) + '</i>'; }).join('');
    if ($('tqDots').innerHTML !== dots) $('tqDots').innerHTML = dots;
    if (mode === 'clue') { $('tqClueX').textContent = z.clue; clearInterval(quizTick); quizTick = 0; return; }
    $('tqBadge').textContent = '問題 ' + (q.index + 1) + ' / ' + (z.total || 5);
    var k = q.id + '|' + mode + '|' + q.answer + '|' + q.options.join('|');
    if (k !== quizKey) {
      quizKey = k;
      $('tqQ').textContent = q.q; $('tqQ').classList.toggle('is-long', String(q.q).length > 22);
      $('tqOpts').innerHTML = q.options.map(function (o, i) {
        return '<div class="tq-opt' + (q.answer === i ? ' is-right' : '') + (String(o).length > 12 ? ' is-long' : '') + '"><i>' + 'ABCD'[i] + '</i>' + esc(o) + '</div>';
      }).join('');
    }
    var r = q.result;
    if (mode === 'open') {
      quizEnd = q.remain == null ? null : now() + q.remain;
      $('tqSt').innerHTML = '<em>作答中</em><b id="tqTime" lang="en"></b>';
      var tot = z.answerTotal || (r && r.total) || 0;
      $('tqFoot').innerHTML = '已作答 <b>' + (q.answered | 0) + '</b>' + (q.eligible ? ' / <b>' + q.eligible + '</b>' : '') + '<span class="tq-bar"><i style="width:' + (q.eligible ? Math.min(100, Math.round(q.answered / q.eligible * 100)) : 0) + '%"></i></span>每題需 ' + z.threshold + '% 答對';
      quizClock();
      if (!quizTick) quizTick = setInterval(quizClock, 250);
    } else {
      clearInterval(quizTick); quizTick = 0;
      $('tqSt').innerHTML = r ? '<em class="' + (r.success ? 'ok">成功！' : 'fail">未達標') + '</em>' : '<em>作答結束</em>';
      $('tqFoot').innerHTML = r ? '答對 <b>' + r.pct + '%</b><span class="tq-bar"><i style="width:' + Math.min(100, r.pct) + '%"></i></span>' +
        (z.unlocked ? '已解鎖最後的線索！' : z.lost ? '未能解鎖最後的線索' : '已成功 <b>' + z.solved + '</b> / ' + z.need + ' 題') : '';
    }
  }
  function quizClock() {
    var t = $('tqTime'); if (!t) return;
    t.classList.toggle('is-text', quizEnd == null);
    if (quizEnd == null) { t.textContent = '不限時'; t.classList.remove('is-low'); return; }
    var x = Math.max(0, Math.ceil((quizEnd - now()) / 1000));
    t.textContent = ('0' + Math.floor(x / 60)).slice(-2) + ':' + ('0' + (x % 60)).slice(-2);
    t.classList.toggle('is-low', x <= 10);
  }

  /* ---------- 發言中 pill (round screens, while no vote is shown): the speaking countdown only ---------- */
  var speakEnd = null, speakTick = 0;
  function renderSpeak(sp) {
    var el = $('tvSpeak');
    if (!sp) { if (!el.hidden) { el.hidden = true; clearInterval(speakTick); speakTick = 0; } return; }
    speakEnd = sp.remain == null ? null : now() + sp.remain;
    el.hidden = false;
    speakClock();
    if (!speakTick) speakTick = setInterval(speakClock, 250);
  }
  function speakClock() {
    var t = $('tvSpeakTime');
    t.classList.toggle('is-text', speakEnd == null);
    if (speakEnd == null) { t.textContent = '不限時'; t.classList.remove('is-low'); return; }
    var x = Math.max(0, Math.ceil((speakEnd - now()) / 1000));
    t.textContent = ('0' + Math.floor(x / 60)).slice(-2) + ':' + ('0' + (x % 60)).slice(-2);
    t.classList.toggle('is-low', x <= 10);
    if (x <= 0) { $('tvSpeak').hidden = true; clearInterval(speakTick); speakTick = 0; }
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

  /* ---------- 玩法說明 (screen 'howto', before 身份揭曉): one slide per page, the host pages through them.
     mini/state howto = {page, pages, threshold (結局 %), quiz: {n, threshold, need}} — general rules only.
     The leader cards are mystery "?" cards: nobody is shown as a leader before Round 1. Copy: data/texts.json "howto"
     (an array of {title, sub, l1, l2}; {t} {n} {q} {need} are filled in), defaults below. */
  var HDEF = [
    { title: '玩法說明', sub: 'Who Will You Follow? 你會跟隨誰？', l1: '一起找出真正的領袖！', l2: '遊戲大約 15 分鐘' },
    { title: '遊戲目標', sub: '4 位領袖，只有 1 位是真的', l1: '4 位領袖：1 位真正領袖、3 位假領袖。', l2: '最後投票有 {t}% 或以上的人選中真正領袖，全體勝利！' },
    { title: '角色', sub: '領袖 · 平民', l1: '每位玩家的身份是「領袖」或「平民」。', l2: '身份只會顯示在你自己的手機上，請保密！' },
    { title: 'Round 1 聽佢講', sub: '每位領袖講 3 件關於自己的事', l1: '真正領袖 3 句全真；假領袖 2 真 1 假。', l2: '聽完之後，投票選出你相信的領袖！' },
    { title: 'Round 2 誰是真領袖？', sub: '神秘描述 · 領袖詞語', l1: '平民看神秘描述，領袖各有一個詞語。', l2: '聽領袖描述，猜猜誰是真領袖！' },
    { title: 'Round 3 破解密碼', sub: '{n} 條選擇題', l1: '每題有 {q}% 或以上的人答對，就算成功。', l2: '成功 {need} 題就解鎖最後的線索，然後最後投票！' },
    { title: '最終揭曉', sub: '誰才是真正領袖？', l1: '逐張翻開領袖卡，揭曉誰是真正領袖！', l2: '然後就是結局：大家能一起勝利嗎？' }
  ];
  var HT = null, hwKey = '', lastHowto = null, lastHowtoList = [], hwPage = -1;
  function HX(i, k) { var t = HT && HT[i] && HT[i][k] != null && HT[i][k] !== '' ? HT[i][k] : (HDEF[i] || {})[k]; return t == null ? '' : t; }
  var HW_COL = ['a', 'b', 'c', 'd'];   // card colours only — never shown as labels
  function hwCard(i, extra) { return '<div class="lc lc--' + HW_COL[i % 4] + ' hw-lc' + (extra || '') + '" style="--i:' + i + '"><div class="lc__circle"><span class="lc__q">?</span></div><p class="lc__pill"><b>？？？</b></p></div>'; }
  function hwSpr(cid, i) {
    var dx = window.wwyfSpriteDx ? wwyfSpriteDx(cid) : 0;
    return '<div class="hw-spr" style="--dx:' + dx + ';--i:' + i + '"><img alt="" draggable="false" src="' + img(cid, i % 2 ? 'stale2' : 'stale1') + '"></div>';
  }
  var HW_PHONE = '<svg class="hw-phone" viewBox="0 0 120 190"><rect x="8" y="6" width="104" height="178" rx="22" fill="#fdfaf1" stroke="#6f5a43" stroke-width="5"/>' +
    '<rect x="20" y="24" width="80" height="128" rx="10" fill="#e4eed8"/><rect x="46" y="13" width="28" height="5" rx="2.5" fill="#cdbfa6"/>' +
    '<circle cx="60" cy="168" r="6" fill="none" stroke="#cdbfa6" stroke-width="3"/>';
  var HW_PERSON = '<path d="M60 58c-12 0-21 9-21 20v6h42v-6c0-11-9-20-21-20z" fill="#b8cfa6"/><circle cx="60" cy="56" r="13" fill="#b8cfa6"/>';
  function hwPerson(cls) { return '<svg class="hw-person ' + (cls || '') + '" viewBox="30 30 60 60"><path d="M60 58c-12 0-21 9-21 20v8h42v-8c0-11-9-20-21-20z" fill="currentColor"/><circle cx="60" cy="48" r="13" fill="currentColor"/></svg>'; }
  function HW_BUB(c, i) { return '<svg class="hw-bub" style="--i:' + i + '" viewBox="0 0 70 56"><path d="M10 4h50a8 8 0 0 1 8 8v22a8 8 0 0 1-8 8H30l-12 10v-10h-8a8 8 0 0 1-8-8V12a8 8 0 0 1 8-8z" fill="' + c + '" stroke="#6f5a43" stroke-width="3.5" stroke-linejoin="round"/>' +
    '<circle cx="23" cy="23" r="4" fill="#6f5a43"/><circle cx="35" cy="23" r="4" fill="#6f5a43"/><circle cx="47" cy="23" r="4" fill="#6f5a43"/></svg>'; }
  function hwTicks(arr) { return '<span class="hw-ticks">' + arr.map(function (ok) { return '<i class="' + (ok ? 'is-ok' : 'is-no') + '">' + (ok ? '✓' : '✗') + '</i>'; }).join('') + '</span>'; }
  function hwArt(p, list, o) {
    var k, h = '';
    if (p === 0) {
      var ids = list.map(function (x) { return x.characterId; }).filter(Boolean);
      if (!ids.length) ids = Object.keys(window.WWYF_SPRITE_BOX || {}).slice(0, 8);
      ids = ids.slice(0, 9);
      return '<div class="hw-row hw-row--chars">' + ids.map(hwSpr).join('') + '</div>';
    }
    if (p === 1) {
      for (k = 0; k < 4; k++) h += hwCard(k);
      return '<div class="hw-row">' + h + '</div><div class="hw-goal"><b lang="en">' + o.t + '%</b><span>選中真正領袖 → 全體勝利</span></div>';
    }
    if (p === 2) {
      return '<div class="hw-row hw-row--roles"><div class="hw-role">' + hwCard(0) + '<span class="hw-tag">領袖</span></div>' +
        '<div class="hw-role"><div class="hw-people">' + hwPerson('c1') + hwPerson('c2') + hwPerson('c3') + '</div><span class="hw-tag">平民</span></div>' +
        '<div class="hw-role hw-role--phone">' + HW_PHONE + HW_PERSON + '<text x="60" y="128" text-anchor="middle" font-family="Fredoka, system-ui, sans-serif" font-weight="700" font-size="34" fill="#6f9a63">?</text></svg><span class="hw-tag hw-tag--shh">保密</span></div></div>';
    }
    if (p === 3) {
      return '<div class="hw-row hw-row--r1">' + hwCard(1) +
        '<div class="hw-say"><p><span>真正領袖</span>' + hwTicks([1, 1, 1]) + '</p><p><span>假領袖</span>' + hwTicks([1, 1, 0]) + '</p></div></div>';
    }
    if (p === 4) {
      return '<div class="hw-row hw-row--r2"><div class="hw-desc">' + HW_PHONE + '<rect x="30" y="44" width="60" height="7" rx="3.5" fill="#b8cfa6"/><rect x="30" y="60" width="52" height="7" rx="3.5" fill="#b8cfa6"/>' +
        '<rect x="30" y="76" width="58" height="7" rx="3.5" fill="#b8cfa6"/><rect x="30" y="92" width="40" height="7" rx="3.5" fill="#b8cfa6"/>' +
        '<text x="60" y="138" text-anchor="middle" font-family="Fredoka, system-ui, sans-serif" font-weight="700" font-size="26" fill="#6f9a63">?</text></svg></div>' +
        '<div class="hw-chat">' + HW_BUB('#fdfaf1', 0) + HW_BUB('#fee7e1', 1) + HW_BUB('#e0e9f2', 2) + '</div>' +
        '<div class="hw-ballot"><svg viewBox="0 0 80 80"><rect x="10" y="34" width="60" height="38" rx="8" fill="#fde4c0" stroke="#6f5a43" stroke-width="4"/>' +
        '<rect x="26" y="8" width="28" height="36" rx="4" fill="#fdfaf1" stroke="#6f5a43" stroke-width="4" transform="rotate(-8 40 26)"/><path d="M31 25l6 6 11-12" fill="none" stroke="#6f9a63" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<rect x="22" y="40" width="36" height="5" rx="2.5" fill="#6f5a43"/></svg><span>投票</span></div></div>';
    }
    if (p === 5) {
      for (k = 0; k < o.n; k++) h += '<i class="hw-q' + (k < o.need ? ' is-ok' : '') + '" style="--i:' + k + '">' + (k < o.need ? '✓' : (k + 1)) + '</i>';
      return '<div class="hw-row hw-row--r3"><div class="hw-qs">' + h + '</div><div class="hw-lock"><svg viewBox="0 0 80 80"><path d="M24 36V24a16 16 0 0 1 31-5" fill="none" stroke="#6f5a43" stroke-width="7" stroke-linecap="round"/>' +
        '<rect x="14" y="36" width="52" height="38" rx="9" fill="#f6c94c" stroke="#6f5a43" stroke-width="4"/><circle cx="40" cy="52" r="5" fill="#6f5a43"/><rect x="37.5" y="54" width="5" height="10" rx="2.5" fill="#6f5a43"/></svg><span>最後的線索</span></div></div>';
    }
    for (k = 0; k < 4; k++) h += hwCard(k, k === 2 ? ' hw-lc--flip' : '');
    return '<div class="hw-row hw-row--final">' + h + '</div>';
  }
  function renderHowto(h, list) {
    lastHowto = h; lastHowtoList = list || [];
    if (!h) { hwPage = -1; return; }
    var pages = h.pages || HDEF.length, p = Math.max(0, Math.min(pages - 1, h.page | 0)), q = h.quiz || {};
    var o = { t: h.threshold != null ? h.threshold : 70, n: q.n || 5, q: q.threshold != null ? q.threshold : 60, need: q.need || 3 };
    var chars = p === 0 ? lastHowtoList.map(function (x) { return x.characterId; }).join(',') : '';
    var k = [p, pages, o.t, o.n, o.q, o.need, chars, HT ? 1 : 0].join('|');
    if (k === hwKey) return;
    var turn = hwPage !== p;
    hwKey = k; hwPage = p;
    var f = function (t) { return fillT(t, o); };
    $('hwTitle').textContent = f(HX(p, 'title'));
    $('hwTitle').classList.toggle('is-latin', /[A-Za-z]/.test($('hwTitle').textContent));
    $('hwSub').textContent = f(HX(p, 'sub'));
    $('hwL1').textContent = f(HX(p, 'l1'));
    $('hwL2').textContent = f(HX(p, 'l2'));
    $('hwArt').innerHTML = hwArt(p, lastHowtoList, o);
    var d = '';
    for (var i = 0; i < pages; i++) d += '<i' + (i === p ? ' class="is-on"' : '') + '></i>';
    $('hwDots').innerHTML = d;
    var sec = $('howto');
    sec.dataset.page = String(p);
    if (turn && !RM) { sec.classList.remove('is-turn'); void sec.offsetWidth; sec.classList.add('is-turn'); }
  }

  // read-only hook for automated checks
  window.WWYF_TV = { bubbles: bubbles, slots: SLOTS, slotOf: slotOf, stats: stats, get phase() { return phase; }, get screen() { return screen; }, get cards() { return cardsKey; }, get intro() { return intro; }, get final() { return lastFinal; }, get ending() { return lastEnding; }, get endingStage() { return enStage; }, get endingCounted() { return enCounted; }, get howto() { return screen === 'howto' ? { page: hwPage, title: $('hwTitle').textContent } : null; }, get lambs() { return lambCount < 0 ? 0 : lambCount; }, get vote() { var e = $('tvVote'); return e.hidden ? null : { tag: $('tvVoteTag').textContent, time: $('tvVoteTime').textContent, voted: +$('tvVoted').textContent, total: +$('tvTotal').textContent, sealed: e.classList.contains('is-sealed') }; }, get speak() { var e = $('tvSpeak'); return e.hidden ? null : { time: $('tvSpeakTime').textContent }; }, renderLambs: renderLambs, get baseR() { return baseR; }, get running() { return running; }, startPos: startPos };
})();
