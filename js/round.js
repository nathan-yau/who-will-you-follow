/* 回合頁 (round page) — the player's phone while the TV shows Round 1 / 2 / 3 (GET /api/me -> round).
   One page for every round: the copy comes from data/texts.json (rounds.<r1|r2|r3>, round.*).
   - the leaders (same slot order as the TV) peek out of paw-print pots; names under the pots
   - the 發言 timer (admin/speak): 準備中 --:-- -> 發言中 + countdown (server remain ms, no clock skew) -> 提問時間
   - players: 「前往投票」 stays disabled (等待投票開始) until this round's vote opens, then it is simply enabled.
     The page never jumps to the vote by itself; the player taps.
   - leaders (真 / 假): their own instructions (desc + tip) come from the server for that leader only, and instead of the
     button a 「跟隨你的人數」 box: a count only (never names), once this round's vote has closed. */
(function () {
  'use strict';
  var V = 6;  // character asset version
  var $ = function (id) { return document.getElementById(id); };
  var me = window.WWYF && WWYF.getPlayer();
  if (!me) { window.location.replace('../characters/'); return; }

  var app = $('app'), names = {}, T = null;
  var NUM = ['零', '一', '兩', '三', '四', '五', '六'];
  var POLL_FAST = 2000, POLL_IDLE = 3000;
  var DEF = {
    round: { speak: { ready: '準備中', live: '發言中', done: '提問時間', left: '剩餘時間', waitLabel: '等待開始', doneLabel: '發言結束', unlimited: '不限時' },
      vote: { wait: '等待投票開始', go: '前往投票', closed: '本輪投票已結束' },
      followers: { label: '跟隨你的人數', pending: '投票結束後公佈', unit: '人' }, again: '再看一次身份', tipTitle: '小提示' },
    rounds: {
      r1: { tag: 'Round 1 / 3', title: '三句話', desc: '{n}位領袖會各自分享三句關於自己的說話。\n你可以聽完發言後提問，\n然後選擇你最相信的一位領袖。', tip: '仔細聆聽每位領袖的說話，\n你可以在發言後向他們提問！' },
      r2: { tag: 'Round 2 / 3', title: '誰是真領袖？', desc: '{n}位領袖會再次發言。', tip: '' },
      r3: { tag: 'Round 3 / 3', title: '最後的線索', desc: '{n}位領袖會作最後發言。', tip: '' }
    }
  };
  var last = null, speakEnd = null, speakState = 'ready', rowKey = '', inflight = false, followKey = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function img(id, f) { return '../assets/characters/' + encodeURIComponent(id) + '/' + f + '.webp?v=' + V; }
  function txt() { return T || DEF; }
  function R(k) { var t = txt(); return (t.round && t.round[k]) || DEF.round[k]; }
  function copy(screen) { var t = txt(), d = DEF.rounds[screen] || DEF.rounds.r1, c = (t.rounds && t.rounds[screen]) || {}, o = {}; for (var k in d) o[k] = d[k]; for (k in c) if (c[k]) o[k] = c[k]; return o; }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function set(id, v) { var e = $(id); if (e && e.textContent !== v) e.textContent = v; }
  function gone(e) {
    if (e && (e.status === 404 || e.status === 401)) { WWYF.clearPlayer(); window.location.replace('../characters/?removed=1'); return true; }
    return false;
  }

  function renderRow(leaders) {
    var L = (leaders || []).filter(Boolean);
    var key = L.map(function (l) { return l.characterId; }).join('|') + '#' + Object.keys(names).length;
    if (key === rowKey) return L.length;
    rowKey = key;
    var pot = $('potTpl').innerHTML;
    var row = $('row');
    row.innerHTML = L.map(function (l) {
      var id = l.characterId, box = window.wwyfSpriteBox ? wwyfSpriteBox(id) : [0.1, 0.15, 0.9, 0.96];
      var dx = window.wwyfSpriteDx ? wwyfSpriteDx(id) : 0, t = Math.max(box[1], 0.17);
      return '<div class="rd-ld" data-cid="' + esc(id) + '"><span class="rd-ld__spr" style="--dx:' + dx + ';--t:' + t + '">' +
        '<img class="f1" alt="" draggable="false" src="' + img(id, 'stale1') + '"><img class="f2" alt="" draggable="false" src="' + img(id, 'stale2') + '"></span>' +
        '<span class="rd-pot">' + pot + '</span><p class="rd-ld__name" lang="en">' + esc(names[id] || '') + '</p></div>';
    }).join('');
    row.className = 'rd-row n' + L.length;
    return L.length;
  }

  function render() {
    var r = last;
    if (!r || !r.round) return;
    var rd = r.round, c = copy(rd.screen), leader = !!rd.leaderText || rd.followers != null;
    var n = renderRow(rd.leaders);
    set('tag', c.tag); set('rdTitle', c.title); set('tipTitle', R('tipTitle')); set('againText', R('again'));
    var lt = rd.leaderText || {};
    set('desc', leader && lt.desc ? lt.desc : leader && c.leaderDesc ? c.leaderDesc : String(c.desc || '').replace(/\{n\}/g, NUM[n] || String(n)));
    set('tip', leader && lt.tip ? lt.tip : leader && c.leaderTip ? c.leaderTip : c.tip);
    // vote button (players) — never navigates by itself
    var v = r.vote && r.vote.round === rd.screen ? r.vote : null;
    var vs = v ? (v.open ? 'open' : 'closed') : 'none', VB = R('vote');
    app.setAttribute('data-vote', vs);
    var go = $('go');
    go.disabled = vs !== 'open';
    set('goLabel', vs === 'open' ? VB.go : vs === 'closed' ? VB.closed : VB.wait);
    // follower count (leaders) — a number only, after this round's vote closed
    var F = R('followers'), f = rd.followers || { state: 'none' };
    set('followLabel', F.label);
    var fk = f.state + ':' + (f.count | 0) + F.pending + F.unit;
    if (fk !== followKey) {
      followKey = fk;
      $('followVal').innerHTML = f.state === 'closed' ? '<b lang="en">' + (f.count | 0) + '</b>' + esc(F.unit) : esc(F.pending);
      $('follow').classList.toggle('is-closed', f.state === 'closed');
      if (f.state === 'closed') { var fe = $('follow'); fe.classList.remove('is-in'); void fe.offsetWidth; fe.classList.add('is-in'); }
    }
    app.classList.toggle('has-knock', !$('knockSlot').hidden);
    app.setAttribute('data-state', leader ? 'leader' : 'player');
    tick();
  }

  // 發言 timer: ready (--:--) -> live (countdown) -> done (提問時間); counts down locally between polls
  function tick() {
    var sp = last && last.round && last.round.speak, S = R('speak');
    var st = sp ? sp.state : 'ready', remain = null;
    if (st === 'live' && speakEnd != null) { remain = speakEnd - Date.now(); if (remain <= 0) { st = 'done'; remain = 0; } }
    speakState = st;
    app.setAttribute('data-speak', st);
    set('pillText', S[st] || S.ready);
    var clock = $('clock');
    var unl = st === 'live' && sp && sp.remain == null;
    clock.classList.toggle('is-text', unl);
    set('clock', st === 'live' ? (unl ? S.unlimited : mmss(remain)) : st === 'done' ? '00:00' : '--:--');
    set('clockLabel', st === 'live' ? S.left : st === 'done' ? S.doneLabel : S.waitLabel);
    document.querySelector('.rd-clock').classList.toggle('is-low', st === 'live' && remain != null && remain <= 10000);
  }

  function poll() {
    if (inflight) return Promise.resolve();
    inflight = true;
    return WWYF.me().then(function (r) {
      if (!r.revealed) { window.location.replace('../lobby/'); return; }
      if (!r.seen || !r.round) { window.location.replace('../identity/'); return; }   // identity not seen yet, or the TV left the round screens
      if (window.WWYF_KNOCK) WWYF_KNOCK.update(r);
      var sp = r.round.speak;
      speakEnd = sp && sp.state === 'live' && sp.remain != null ? Date.now() + sp.remain : null;
      last = r;
      render();
    }).catch(function (e) { gone(e); }).then(function () { inflight = false; });
  }

  $('go').addEventListener('click', function () {
    if (this.disabled) return;
    window.location.href = '../vote/';
  });

  fetch('../data/texts.json?v=3', { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { if (d && (d.rounds || d.round)) { T = { rounds: d.rounds || {}, round: {} }; for (var k in DEF.round) T.round[k] = (d.round && d.round[k]) || DEF.round[k]; } render(); })
    .catch(function () {});
  fetch('../data/characters.json?v=' + V, { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { ((d && d.characters) || []).forEach(function (c) { names[c.id] = c.name; }); rowKey = ''; render(); })
    .catch(function () {});
  if (window.WWYF_KNOCK) WWYF_KNOCK.init($('knockSlot'));

  poll();
  (function loop() {
    var fast = speakState === 'live' || !!(last && last.vote && last.vote.open);
    setTimeout(function () { if (!document.hidden) poll(); loop(); }, fast ? POLL_FAST : POLL_IDLE);
  })();
  setInterval(tick, 250);
  setInterval(function () { if (document.hidden) WWYF.heartbeat().catch(function () {}); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  window.WWYF_ROUND = { get state() { return { app: app.getAttribute('data-state'), speak: app.getAttribute('data-speak'), vote: app.getAttribute('data-vote'), me: last }; }, poll: poll };
})();
