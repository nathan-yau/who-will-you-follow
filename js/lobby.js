/* Lobby: shows the joined player's character and the live player count. */
(function () {
  'use strict';
  var V = 6;  // asset version
  var $ = function (id) { return document.getElementById(id); };
  var me = window.WWYF && WWYF.getPlayer();
  if (!me) { window.location.replace('../characters/'); return; }

  var chars = {};
  var shown = null;
  var lastCount = -1;
  function img(id, f) { return '../assets/characters/' + encodeURIComponent(id) + '/' + f + '.webp?v=' + V; }

  function show(id) {
    if (!id || id === shown) return;
    shown = id;
    $('f1').src = img(id, 'stale1');
    $('f2').src = img(id, 'stale2');
    var c = chars[id] || {};
    $('f1').alt = c.name || '';
    $('nameText').textContent = c.name || '';
  }

  // One filled dot per joined player; dots shrink and wrap (up to 3 rows) as the count grows.
  var ROW_W = 288, ROW_H = 30, MAX_D = 15.4;
  function renderDots(n) {
    var row = $('playerDots');
    var d = MAX_D;
    for (var rows = 1; rows <= 3; rows++) {
      d = Math.min(MAX_D, ROW_W / Math.ceil(n / rows), ROW_H / rows);
      if (d >= 9 || rows === 3) break;
    }
    row.style.setProperty('--d', d.toFixed(2));
    var have = row.children.length;
    for (var i = have; i < n; i++) {
      var dot = document.createElement('i');
      if (have) dot.className = 'new';
      row.appendChild(dot);
    }
    while (row.children.length > n) row.removeChild(row.lastChild);
  }
  function setCount(n) {
    n = Math.max(0, n | 0);
    if (n === lastCount) return;
    var b = $('joined');
    b.textContent = n;
    if (lastCount >= 0) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
    lastCount = n;
    renderDots(n);
  }

  function poll() {
    return WWYF.me().then(function (r) {
      show(r.player.characterId);
      if (r.player.characterId !== me.characterId) { me.characterId = r.player.characterId; WWYF.setPlayer(me); }
      setCount(r.joined);
      setStarted(r.phase === 'started');
    }).catch(function (e) {
      if (e.status === 404 || e.status === 401) {
        WWYF.clearPlayer();
        window.location.replace('../characters/?removed=1');
      }
      // other errors: keep the last known count and retry on the next poll
    });
  }

  // ---- TV "bubble battle" mini game: this phone only sends inputs; all physics runs on the TV ----
  // 衝過去 (push): at most 2 taps per rolling second count (extra taps are ignored).
  // 避開啊 (dodge): 0.9 s cooldown (the TV enforces the same limits).
  // Inputs are batched and sent at most every 250 ms, and only when there is something new.
  var PUSH_PER_SEC = 2, DODGE_CD = 900, SEND_MS = 250;
  var pushTimes = [], lastDodge = -1e9, pendPush = 0, pendDodge = 0, inFlight = false, lastSend = 0, sendT = 0, seq = 0;
  var started = false;

  function setStarted(v) {
    v = !!v;
    if (v === started) return;
    started = v;
    document.body.classList.toggle('is-started', v);
    ['dodge', 'dash'].forEach(function (id) { $(id).disabled = v; });
    $('wait').innerHTML = v ? '遊戲已開始！' : '等待其他玩家加入<span class="lb-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>';
    $('hint').textContent = v ? '請看 TV，留意主持人的指示！' : '當所有人準備好後，遊戲就會開始！';
    if (v) { pendPush = 0; pendDodge = 0; }
  }
  function scheduleSend() {
    if (sendT || inFlight || started || (!pendPush && !pendDodge)) return;
    sendT = setTimeout(flush, Math.max(0, lastSend + SEND_MS - Date.now()));
  }
  function flush() {
    sendT = 0;
    if (inFlight || started || (!pendPush && !pendDodge)) return;
    var push = pendPush, dodge = pendDodge;
    pendPush = 0; pendDodge = 0;
    seq = Math.max(Date.now(), seq + 1);          // increasing across reloads; lets the server drop duplicates
    inFlight = true; lastSend = Date.now();
    WWYF.miniAct(push, dodge, seq).catch(function (e) {
      if (e.status === 409 && e.code === 'started') setStarted(true);
      else if (e.status === 404 || e.status === 401) { WWYF.clearPlayer(); window.location.replace('../characters/?removed=1'); }
      // other errors: drop this batch (it is only lobby fun)
    }).then(function () { inFlight = false; scheduleSend(); });
  }
  function sendMiniGameAction(action) {
    if (started) return false;
    var t = Date.now();
    if (action === 'dash' || action === 'push') {
      pushTimes = pushTimes.filter(function (x) { return t - x < 1000; });
      if (pushTimes.length >= PUSH_PER_SEC) return false;
      pushTimes.push(t); pendPush++;
    } else if (action === 'dodge') {
      if (t - lastDodge < DODGE_CD) return false;
      lastDodge = t; pendDodge = 1;
      var b = $('dodge');
      b.classList.remove('is-cooling'); void b.offsetWidth; b.classList.add('is-cooling');
      setTimeout(function () { b.classList.remove('is-cooling'); }, DODGE_CD);
    } else return false;
    scheduleSend();
    return true;
  }
  window.sendMiniGameAction = sendMiniGameAction;

  ['dodge', 'dash'].forEach(function (id) {
    var btn = $(id);
    var t = null;
    btn.addEventListener('click', function () {
      if (started) return;
      btn.classList.remove('is-pressed'); void btn.offsetWidth; btn.classList.add('is-pressed');
      clearTimeout(t); t = setTimeout(function () { btn.classList.remove('is-pressed'); }, 380);
      if (sendMiniGameAction(btn.getAttribute('data-action')) && navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    });
  });

  fetch('../data/characters.json?v=' + V, { cache: 'no-cache' })
    .then(function (r) { return r.json(); })
    .then(function (d) { (d.characters || []).forEach(function (c) { chars[c.id] = c; }); })
    .catch(function () {})
    .then(function () { shown = null; show(me.characterId); });

  poll();
  // status poll every 3 s (also acts as the heartbeat) + explicit heartbeat every 5 s while hidden tabs skip polls
  setInterval(function () { if (!document.hidden) poll(); }, 3000);
  setInterval(function () { if (document.hidden) WWYF.heartbeat().catch(function () {}); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
