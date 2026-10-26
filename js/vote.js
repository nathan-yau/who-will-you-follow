/* 投票 (vote) — the player's phone. Reached from the identity page while the host has a vote open (GET /api/me -> vote.open).
   grid   : the leader cards (character names only; same slot order + colours as the TV) + 「確認投票」
   voted  : your pick + a hint line chosen by the server + 「更改投票」 (until the vote closes)
   leader : leaders (真 / 假) don't vote — a neutral waiting screen (identical for both)
   ended  : the vote closed (timer, host, or 封票 = everyone voted): your final choice, no more changes; then back to
            ../identity/ after a few seconds. The countdown always comes from the server (remain ms, no clock skew). */
(function () {
  'use strict';
  var V = 6;  // character asset version
  var $ = function (id) { return document.getElementById(id); };
  var me = window.WWYF && WWYF.getPlayer();
  if (!me) { window.location.replace('../characters/'); return; }

  var app = $('app'), names = {};
  var SLOTS = ['a', 'b', 'c', 'd'];
  var COL = { a: ['#e4edd8', '#dfe9d0'], b: ['#fee7e1', '#fcdcd4'], c: ['#fdeccb', '#fbe4b0'], d: ['#e0e9f2', '#d9e5f0'] };
  var ROUND_TAG = { r1: '<b lang="en">Round 1</b> · 投票', r2: '<b lang="en">Round 2</b> · 投票', r3: '最後投票 · 最終一輪' };
  var POLL_OPEN = 2000, POLL_IDLE = 3000, ENDED_MS = 10000;
  var TICK = '<svg viewBox="0 0 30 30" aria-hidden="true"><path d="M9 15.5l4 4 8-9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var TUFT = function (s) { return '<svg class="vt-tuft vt-tuft--' + s + '" viewBox="0 0 24 18" aria-hidden="true"><g fill="#8db07c"><ellipse cx="5.5" cy="12" rx="2.6" ry="5.4" transform="rotate(-28 5.5 12)"/><ellipse cx="12" cy="9.5" rx="2.8" ry="7.5"/><ellipse cx="18.5" cy="12" rx="2.6" ry="5.4" transform="rotate(28 18.5 12)"/></g></svg>'; };

  var state = 'loading', vote = null, sel = null, mine = null, changing = false, busy = false;
  var deadline = null, endedAt = 0, endT = 0, gridKey = '', myChar = me.characterId;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function dxOf(id) { return window.wwyfSpriteDx ? window.wwyfSpriteDx(id) : 0; }
  function img(id, f) { return '../assets/characters/' + encodeURIComponent(id) + '/' + f + '.webp?v=' + V; }
  function nameOf(id) { return names[id] || ''; }
  function slotOf(cid) { var L = (vote && vote.leaders) || []; for (var i = 0; i < L.length; i++) if (L[i] && L[i].characterId === cid) return SLOTS[i]; return 'a'; }
  function err(m) { $('err').textContent = m || ''; }
  function gone(e) {
    if (e && (e.status === 404 || e.status === 401)) { WWYF.clearPlayer(); window.location.replace('../characters/?removed=1'); return true; }
    return false;
  }
  function toIdentity() { window.location.replace('../identity/'); }

  function setState(s) {
    state = s;
    app.setAttribute('data-state', s);
    app.classList.toggle('is-leader', !!(vote && !vote.eligible));
    render();
  }

  function renderGrid() {
    var L = (vote && vote.leaders) || [];
    var key = L.map(function (l) { return l ? l.characterId : ''; }).join('|') + '#' + Object.keys(names).length;
    var g = $('grid');
    if (key !== gridKey) {
      gridKey = key;
      var n = 0;
      g.innerHTML = L.map(function (l, i) {
        if (!l) return '';
        n++;
        var nm = nameOf(l.characterId);
        return '<button type="button" class="vt-lc vt-lc--' + SLOTS[i] + '" role="radio" aria-checked="false" data-cid="' + esc(l.characterId) + '" data-slot="' + (i + 1) + '" aria-label="' + esc(nm || '領袖') + '">' +
          '<span class="vt-lc__circle"><img alt="" draggable="false" style="--dx:' + dxOf(l.characterId) + '" src="' + img(l.characterId, 'stale1') + '"></span>' + TUFT('l') + TUFT('r') +
          '<span class="vt-lc__pill"><span lang="en">' + esc(nm || '?') + '</span></span><span class="vt-lc__tick">' + TICK + '</span></button>';
      }).join('');
      g.className = 'vt-grid abs n' + n;
    }
    Array.prototype.forEach.call(g.querySelectorAll('.vt-lc'), function (b) {
      var on = b.getAttribute('data-cid') === sel;
      b.classList.toggle('is-sel', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var c = $('confirm');
    c.disabled = !sel;
    $('confirmLabel').textContent = changing && mine ? '確認更改' : '確認投票';
  }

  function setPick(cid, own) {
    var p = $('pick'), nm = $('pickName');
    if (cid) {
      if ($('pf1').getAttribute('data-cid') !== cid) {
        $('pf1').setAttribute('data-cid', cid);
        $('pf1').src = img(cid, 'stale1'); $('pf2').src = img(cid, 'stale2');
        $('pickSpr').style.setProperty('--dx', dxOf(cid));
      }
      p.classList.remove('is-empty');
    } else p.classList.add('is-empty');
    var c = own ? ['#e9f0dd', '#dfe9d0'] : COL[slotOf(cid)];
    p.style.setProperty('--c', cid ? c[0] : '#efeee4');
    nm.style.setProperty('--p', c[1]);
    nm.classList.toggle('is-none', !cid);
    nm.innerHTML = cid ? '<span lang="en">' + esc(nameOf(cid) || '?') + '</span>' : '未投票';
  }

  var lastLine = '';
  function render() {
    if (!vote) return;
    var tag = $('roundTag');
    tag.innerHTML = ROUND_TAG[vote.round] || '投票';
    tag.classList.toggle('is-final', !!vote.final);
    var head = $('head'), sub = $('sub'), bt = $('bTitle'), bl = $('bLine');
    if (state === 'grid') {
      head.textContent = '你會跟隨哪一位領袖？';
      sub.textContent = vote.final ? '最後一次投票，請選出你認為的真正領袖。' : '請選擇一位你認為是真正領袖的人選。';
      renderGrid();
    } else if (state === 'voted') {
      head.textContent = '你目前選擇';
      sub.textContent = '這位領袖會帶領大家走向正確方向嗎？';
      setPick(mine && mine.characterId, false);
      bt.textContent = '已完成本輪投票！';
      var line = (mine && mine.line) || '';
      if (line !== lastLine) { lastLine = line; bl.textContent = line; var b = $('bubble'); b.classList.remove('is-new'); void b.offsetWidth; b.classList.add('is-new'); }
    } else if (state === 'leader') {
      head.textContent = '投票進行中';
      sub.textContent = '領袖請等候其他玩家投票。';
      setPick(myChar, true);
      bt.textContent = '請稍候';
      bl.textContent = '領袖不參與投票，請耐心等候結果。'; lastLine = '';
    } else if (state === 'ended') {
      var sealed = !!vote.sealed;
      head.textContent = sealed ? '票已封存' : '投票已結束';
      sub.textContent = sealed ? '所有人已完成投票，票已封存。' : '本輪投票已結束，不能再更改。';
      $('seal').classList.toggle('is-sealed', sealed);
      $('sealText').textContent = sealed ? '已封票' : '投票已結束';
      if (!vote.eligible) {
        setPick(myChar, true);
        bt.textContent = '投票已結束';
        bl.textContent = '請留意 TV 上主持人的指示。';
      } else {
        setPick(mine && mine.characterId, false);
        bt.textContent = mine ? '你的最終選擇' : '這一輪你沒有投票';
        bl.textContent = '結果將由主持人公佈，請留意 TV！';   // never an 更改 hint once changing is impossible
      }
      lastLine = '';
    }
    tick();
  }

  function fmt(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return (s >= 600 ? Math.floor(s / 60) : ('0' + Math.floor(s / 60)).slice(-2)) + ':' + ('0' + (s % 60)).slice(-2); }
  var lastZeroPoll = 0;
  function tick() {
    if (!vote) return;
    var t = $('timeLeft'), left = $('leftSmall');
    if (!vote.open) { t.textContent = '00:00'; left.textContent = ''; return; }
    if (deadline == null) { t.textContent = '不限'; left.textContent = '投票進行中，結束前都可以更改。'; $('timer').classList.remove('is-low'); return; }
    var ms = deadline - Date.now();
    t.textContent = fmt(ms);
    $('timer').classList.toggle('is-low', ms <= 10000);
    left.innerHTML = '剩餘時間 <b lang="en">' + fmt(ms) + '</b>';
    if (ms <= 0 && Date.now() - lastZeroPoll > 1000) { lastZeroPoll = Date.now(); poll(); }   // the server closes it at the deadline
  }

  function apply(v) {
    var prevId = vote && vote.id;
    vote = v;
    deadline = v.open && v.remain != null ? Date.now() + v.remain : null;
    if (v.open) {
      clearTimeout(endT); endedAt = 0;
      if (prevId && prevId !== v.id) { changing = false; sel = null; mine = null; }
      mine = v.mine || (changing ? mine : null);
      if (!v.eligible) return setState('leader');
      if (mine && !changing) return setState('voted');
      if (!sel && mine) sel = mine.characterId;
      if (sel && !(v.leaders || []).some(function (l) { return l && l.characterId === sel; })) sel = null;
      return setState('grid');
    }
    // closed (timer / host / 封票)
    changing = false;
    if (v.eligible) mine = v.mine || null;
    if (state === 'loading' && v.endedAgo != null && v.endedAgo > ENDED_MS) return toIdentity();   // an old vote: nothing to show
    if (!endedAt) {
      endedAt = Date.now();
      clearTimeout(endT);
      endT = setTimeout(toIdentity, Math.max(4000, ENDED_MS - Math.max(0, v.endedAgo || 0)));
    }
    if (state !== 'ended') setState('ended'); else render();
  }

  var inflight = false;
  function poll() {
    if (inflight) return Promise.resolve();
    inflight = true;
    return WWYF.me().then(function (r) {
      if (r.player && r.player.characterId) myChar = r.player.characterId;
      if (!r.revealed) { window.location.replace('../lobby/'); return; }
      if (!r.seen) { toIdentity(); return; }   // identity not revealed yet (or the host changed this player's role)
      if (window.WWYF_KNOCK) WWYF_KNOCK.update(r);
      if (!r.vote) { if (state !== 'ended') toIdentity(); return; }
      if (busy) return;
      apply(r.vote);
    }).catch(function (e) { gone(e); }).then(function () { inflight = false; });
  }

  $('grid').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.vt-lc');
    if (!b || state !== 'grid') return;
    sel = b.getAttribute('data-cid'); err('');
    renderGrid();
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (x) {} }
  });
  $('confirm').addEventListener('click', function () {
    if (busy || !sel || state !== 'grid' || !vote) return;
    var btn = this; busy = true; btn.classList.add('is-busy'); err('');
    WWYF.request('POST', '/vote', { characterId: sel, round: vote.round }, { 'X-Player-Id': me.id, 'X-Player-Token': me.token }).then(function (r) {
      mine = r.mine; changing = false; busy = false;
      if (r.sealed) { vote.open = false; vote.sealed = true; vote.endedAgo = 0; apply(vote); }
      else setState('voted');
      if (navigator.vibrate) { try { navigator.vibrate([12, 50, 20]); } catch (x) {} }
    }).catch(function (e) {
      busy = false;
      if (gone(e)) return;
      if (e.status === 409) { poll(); return; }
      err(e.status === 400 || e.status === 403 ? (e.message || '無法投票') : '連線不穩，請再按一次');
    }).then(function () { btn.classList.remove('is-busy'); });
  });
  $('change').addEventListener('click', function () {
    if (state !== 'voted' || !vote || !vote.open) return;
    changing = true; sel = mine ? mine.characterId : null; setState('grid');
  });

  fetch('../data/characters.json', { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { ((d && d.characters) || []).forEach(function (c) { names[c.id] = c.name; }); render(); })
    .catch(function () {});
  if (window.WWYF_KNOCK) WWYF_KNOCK.init($('knockSlot'));

  poll();
  (function loop() {
    setTimeout(function () { if (!document.hidden) poll(); loop(); }, vote && vote.open ? POLL_OPEN : POLL_IDLE);
  })();
  setInterval(tick, 250);
  setInterval(function () { if (document.hidden) WWYF.heartbeat().catch(function () {}); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  window.WWYF_VOTE = { get state() { return state; }, get vote() { return vote; }, get sel() { return sel; }, get mine() { return mine; } };
})();
