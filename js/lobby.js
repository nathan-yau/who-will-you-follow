/* Lobby: shows the joined player's character and the live player count. */
(function () {
  'use strict';
  var V = 6;
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
    }).catch(function (e) {
      if (e.status === 404 || e.status === 401) {
        WWYF.clearPlayer();
        window.location.replace('../characters/?removed=1');
      }
      // other errors: keep the last known count and retry on the next poll
    });
  }

  // ---- TV mini game (spec to come) ----
  // TODO: send the action to the backend / TV mini game once it is specified.
  function sendMiniGameAction(action) {
    if (window.console && console.debug) console.debug('[mini-game] action:', action);
  }
  window.sendMiniGameAction = sendMiniGameAction;

  ['dodge', 'dash'].forEach(function (id) {
    var btn = $(id);
    var t = null;
    btn.addEventListener('click', function () {
      btn.classList.remove('is-pressed'); void btn.offsetWidth; btn.classList.add('is-pressed');
      clearTimeout(t); t = setTimeout(function () { btn.classList.remove('is-pressed'); }, 380);
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
      sendMiniGameAction(btn.getAttribute('data-action'));
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
