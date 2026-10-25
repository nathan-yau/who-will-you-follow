/* Lobby: shows the joined player's character and waits for the host. */
(function () {
  'use strict';
  var V = 6;
  var $ = function (id) { return document.getElementById(id); };
  var me = window.WWYF && WWYF.getPlayer();
  if (!me) { window.location.replace('../characters/'); return; }

  var chars = {};
  var shown = null;
  var fails = 0;
  function img(id, f) { return '../assets/characters/' + encodeURIComponent(id) + '/' + f + '.webp?v=' + V; }

  function show(id) {
    if (!id || id === shown) return;
    shown = id;
    $('f1').src = img(id, 'stale1');
    $('f2').src = img(id, 'stale2');
    var c = chars[id] || {};
    $('f1').alt = c.name || '';
    $('nameText').textContent = c.name || '';
    $('tagline').textContent = c.tagline || '';
  }
  function conn(ok, text) {
    var el = $('conn');
    el.className = 'lb-conn abs ' + (ok ? 'ok' : 'bad');
    $('connText').textContent = text;
  }

  function poll() {
    return WWYF.me().then(function (r) {
      fails = 0;
      show(r.player.characterId);
      if (r.player.characterId !== me.characterId) { me.characterId = r.player.characterId; WWYF.setPlayer(me); }
      $('joined').textContent = r.joined;
      $('cap').textContent = r.capacity;
      conn(true, r.assigned ? '已連線 · 主持人已為你分配身分' : '已連線');
    }).catch(function (e) {
      if (e.status === 404 || e.status === 401) {
        WWYF.clearPlayer();
        window.location.replace('../characters/?removed=1');
        return;
      }
      fails++;
      conn(false, fails > 1 ? '連線中斷，重新連線中…' : '連線中…');
    });
  }

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
