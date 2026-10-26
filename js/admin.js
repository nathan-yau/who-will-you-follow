/* Host dashboard: login, live player list (poll every 2 s), role assignment. */
(function () {
  'use strict';
  var V = 6;
  var AKEY = 'wwyf.admin';
  var $ = function (id) { return document.getElementById(id); };
  var SHORT = { '真正領袖': '真領袖', '假領袖': '假領袖', '真領袖支持者': '真支持', '假領袖支持者': '假支持', '平民': '平民' };
  var CIV = '平民';
  function short(r) { return r ? (SHORT[r] || r) : '未分配'; }   // null only comes from the old backend
  var ROLE_COLORS = { '真正領袖': 'var(--r-true)', '假領袖': 'var(--r-fake)', '真領袖支持者': 'var(--r-tsup)', '假領袖支持者': 'var(--r-fsup)', '平民': 'var(--r-civ)' };
  var chars = {};
  var state = null;
  var timer = 0;
  var lastSig = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function img(id) { return '../assets/characters/' + encodeURIComponent(id) + '/stale1.webp?v=' + V; }
  function charName(id) { return (chars[id] && chars[id].name) || id; }
  function token() { try { return localStorage.getItem(AKEY); } catch (e) { return null; } }
  function setToken(t) { try { if (t) localStorage.setItem(AKEY, t); else localStorage.removeItem(AKEY); } catch (e) {} }

  var tt = 0;
  function toast(msg, bad) {
    var el = $('toast'); el.textContent = msg; el.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(tt); tt = setTimeout(function () { el.className = 'toast' + (bad ? ' bad' : ''); }, 2800);
  }
  function fail(e) {
    if (e.status === 401) { logout('登入已過期，請重新登入'); return; }
    toast(e.message || '操作失敗', true);
  }

  /* ---------- auth ---------- */
  function showLogin(msg) {
    clearInterval(timer);
    $('dash').hidden = true; $('topRight').hidden = true; $('login').hidden = false;
    $('loginErr').textContent = msg || '';
    setTimeout(function () { $('pw').focus(); }, 50);
  }
  function logout(msg) { setToken(null); state = null; lastSig = ''; showLogin(msg); }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('loginBtn'); btn.disabled = true; $('loginErr').textContent = '';
    WWYF.request('POST', '/admin/login', { password: $('pw').value }).then(function (r) {
      setToken(r.token); $('pw').value = ''; start();
    }).catch(function (err) {
      $('loginErr').textContent = err.status === 401 ? '密碼錯誤，請再試一次' : (err.message || '登入失敗');
      $('pw').select();
    }).then(function () { btn.disabled = false; });
  });
  $('logout').addEventListener('click', function () { logout(''); });

  /* ---------- polling ---------- */
  function sync(ok) { $('sync').hidden = ok; }
  function refresh() {
    return WWYF.admin('GET', 'state').then(function (s) {
      state = s; overlay(); sync(true);
      render();
    }).catch(function (e) {
      if (e.status === 401) { logout('登入已過期，請重新登入'); return; }
      sync(false);
    });
  }
  function start() {
    setLocked(true);
    $('login').hidden = true; $('dash').hidden = false; $('topRight').hidden = false;
    refresh();
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) refresh(); }, 2000);
  }

  /* ---------- render ---------- */
  function render() {
    if (!state) return;
    var s = state;
    $('joined').textContent = s.players.length;
    $('online').textContent = s.players.filter(function (p) { return p.online; }).length;

    // no player cap; 平民 is unlimited. Summary: special roles in use / their limits. Red text only when over a limit.
    var warn = [];
    specials().forEach(function (r) {
      var n = s.assigned[r] || 0, max = s.roles[r] || 0;
      if (n > max) warn.push('「' + short(r) + '」超出上限 ' + n + '/' + max);
    });
    $('warnings').innerHTML = warn.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
    function sum(list, src) { return list.reduce(function (a, r) { return a + (+src[r] || 0); }, 0); }
    var L = s.leaderRoles, S = specials().filter(function (r) { return L.indexOf(r) < 0; });
    $('sumJoined').textContent = s.players.length;
    $('sumLeaders').textContent = sum(L, s.assigned); $('sumLeadersMax').textContent = sum(L, s.roles);
    $('sumSup').textContent = sum(S, s.assigned); $('sumSupMax').textContent = sum(S, s.roles);

    renderGrid();
    renderPhase();
  }

  /* ---------- TV／遊戲 section ---------- */
  function renderPhase() {
    var started = !!(state && state.meta && state.meta.phase === 'started');
    var sc = curScreen(), rnd = sc.charAt(0) === 'r' ? SCREEN_NAMES[sc] : '';
    $('phaseText').textContent = started ? '遊戲已開始' + (rnd ? ' · ' + rnd : '') : '等候中 · 泡泡大戰進行中';
    $('phaseDot').classList.toggle('on', !started);
    $('phaseDot').classList.toggle('live', started);
    $('tvNote').textContent = started
      ? '遊戲已開始：TV 顯示' + (rnd ? '「' + rnd + '」標題畫面（含四位領袖卡）' : '「遊戲開始」') + '，手機按鈕已停用。'
      : '等候中：玩家可在手機按「避開啊／衝過去」玩 TV 上的泡泡大戰。';
    $('startGame').disabled = started;
    if (started) disarm();
    $('toLobby').disabled = !started;
    renderSeg();
  }

  /* TV 畫面 segmented control: 等候 / Round 1–3 (POST admin/screen; a round implies 開始遊戲) */
  var SCREEN_NAMES = { lobby: '等候', r1: 'Round 1', r2: 'Round 2', r3: 'Round 3' };
  var segPending = null, segArm = null, segArmT = 0;
  function curScreen() {
    var m = state && state.meta;
    if (!m || m.phase !== 'started') return 'lobby';
    return SCREEN_NAMES[m.tvScreen] && m.tvScreen !== 'lobby' ? m.tvScreen : 'start';   // 'start' = 遊戲開始 placeholder
  }
  function renderSeg() {
    var cur = segPending || curScreen();
    [].forEach.call(document.querySelectorAll('#tvSeg .seg__btn'), function (b) {
      var sc = b.dataset.screen, armed = segArm === sc;
      b.setAttribute('aria-pressed', String(sc === cur));
      b.classList.toggle('is-armed', armed);
      b.textContent = armed ? '再按確認' : SCREEN_NAMES[sc];
      b.disabled = !!segPending;
    });
  }
  function segDisarm() { clearTimeout(segArmT); segArmT = 0; segArm = null; renderSeg(); }
  $('tvSeg').addEventListener('click', function (e) {
    var b = e.target.closest('.seg__btn'); if (!b || b.disabled) return;
    var sc = b.dataset.screen, cur = curScreen();
    if (sc === cur) { segDisarm(); return; }
    if (sc === 'lobby') {
      segDisarm();
      if (!confirm('回到等候狀態？\n\nTV 會重新顯示泡泡大戰，手機按鈕會重新啟用。')) return;
    } else if (cur === 'lobby' && segArm !== sc) {   // a round from the waiting room also starts the game: two taps
      segArm = sc; clearTimeout(segArmT); segArmT = setTimeout(segDisarm, 3000); renderSeg();
      return;
    }
    clearTimeout(segArmT); segArm = null; segPending = sc; renderSeg();
    WWYF.admin('POST', 'screen', { screen: sc }).then(function (r) {
      if (state && state.meta) { state.meta.phase = r.phase; state.meta.tvScreen = r.screen; }
      toast(sc === 'lobby' ? '已回到等候' : 'TV 已切換到 ' + SCREEN_NAMES[sc]);
    }).catch(fail).then(function () { segPending = null; renderPhase(); return refresh(); });
  });
  var armT = 0;
  function disarm() {
    clearTimeout(armT); armT = 0;
    var b = $('startGame'); b.classList.remove('is-armed'); b.textContent = '開始遊戲';
  }
  $('startGame').addEventListener('click', function () {
    var b = this;
    if (!b.classList.contains('is-armed')) {            // first tap arms, second tap (within 3 s) confirms
      b.classList.add('is-armed'); b.textContent = '再按一次確認';
      clearTimeout(armT); armT = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    act(b, function () { return WWYF.admin('POST', 'start').then(function () { toast('遊戲已開始！'); }); }).then(renderPhase);
  });
  $('toLobby').addEventListener('click', function () {
    if (!confirm('回到等候狀態？\n\nTV 會重新顯示泡泡大戰，手機按鈕會重新啟用。')) return;
    act(this, function () { return WWYF.admin('POST', 'lobby').then(function () { toast('已回到等候'); }); }).then(renderPhase);
  });

  function renderGrid() {
    var s = state;
    $('empty').hidden = s.players.length > 0;
    var sig = JSON.stringify([s.players.map(function (p) { return [p.id, p.characterId, p.nickname, p.role, p.leader, p.online]; }), s.roles, !!chars.__ok]);
    if (sig === lastSig) return;
    lastSig = sig;
    var html = '';
    s.players.forEach(function (p) {
      var isLeader = p.role && s.leaderRoles.indexOf(p.role) >= 0;
      var name = esc(charName(p.characterId));
      html += '<div class="pc' + (p.role ? '' : ' unassigned') + (p.online ? '' : ' off') + (pend[p.id] ? ' saving' : '') + '" data-id="' + esc(p.id) + '" title="' + name + (p.nickname ? '（' + esc(p.nickname) + '）' : '') + (p.online ? '' : ' · 離線') + '">' +
        '<div class="pc__icon"><img src="' + img(p.characterId) + '" alt="" loading="lazy" />' + (p.online ? '' : '<i class="pc__off" aria-label="離線"></i>') +
          (isLeader ? '<button class="badge" type="button" data-act="leader" style="--c:' + ROLE_COLORS[p.role] + '" aria-label="領袖 ' + esc(p.leader || '?') + '（點一下切換）">' + esc(p.leader || '?') + '</button>' : '') + '</div>' +
        '<span class="pc__name" lang="en">' + name + '</span>' +
        '<button class="pill' + (p.role ? '' : ' pill--none') + '" type="button" data-act="role" style="--c:' + (p.role ? ROLE_COLORS[p.role] : '#b9b4a4') + '" aria-label="' + name + ' 身分：' + esc(p.role || '未分配') + '（點一下切換）">' + esc(short(p.role)) + '</button>' +
        '<button class="kick" type="button" data-act="kick" title="移出玩家" aria-label="移出 ' + name + '"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>' +
        '</div>';
    });
    $('grid').innerHTML = html;
  }

  /* ---------- actions ---------- */
  function act(btn, fn) {
    btn.disabled = true;
    for (var k in saveTimers) clearTimeout(saveTimers[k]);
    pend = {};
    return fn().then(refresh).catch(fail).then(function () { btn.disabled = false; });
  }
  /* ---------- tap-to-cycle roles & leader letters (optimistic, saved via API) ---------- */
  var CYCLE = ['平民', '真領袖支持者', '假領袖支持者', '假領袖', '真正領袖'];   // no "unassigned": everyone always has a role
  function specials() { return state.roleOrder.filter(function (r) { return r !== CIV; }); }
  var pend = {};                       // playerId -> {role, leader} not yet confirmed by the server
  var saveTimers = {};
  var saveChain = Promise.resolve();
  function isLeaderRole(r) { return !!r && state.leaderRoles.indexOf(r) >= 0; }
  function recount() {
    var a = {}; state.roleOrder.forEach(function (r) { a[r] = 0; });
    state.players.forEach(function (p) { if (p.role) a[p.role] = (a[p.role] || 0) + 1; });
    state.assigned = a;
  }
  function overlay() {               // keep optimistic values visible across polls until saved
    if (!state) return;
    state.players.forEach(function (p) { var o = pend[p.id]; if (o) { p.role = o.role; p.leader = o.leader; } });
    recount();
  }
  function usedLetters(exceptId) {
    var u = {};
    state.players.forEach(function (q) { if (q.id !== exceptId && isLeaderRole(q.role) && q.leader) u[q.leader] = 1; });
    return u;
  }
  function nextRole(p) {
    var i = CYCLE.indexOf(p.role);       // -1 (old backend's null) -> starts at 平民
    for (var k = 1; k <= CYCLE.length; k++) {
      var r = CYCLE[(i + k + CYCLE.length) % CYCLE.length];
      if (r === CIV) return CIV;         // 平民 has no limit
      var others = state.players.filter(function (q) { return q.id !== p.id && q.role === r; }).length;
      if (others < (state.roles[r] || 0)) return r;
    }
    return CIV;
  }
  function apply(p, role, leader) {
    pend[p.id] = { role: role, leader: leader };
    p.role = role; p.leader = leader;
    recount(); lastSig = ''; render();
    clearTimeout(saveTimers[p.id]);
    saveTimers[p.id] = setTimeout(function () { save(p.id); }, 350);   // coalesce quick multi-taps into one save
  }
  function save(id) {
    var sent = pend[id]; if (!sent) return;
    var body = { playerId: id, role: sent.role };
    if (isLeaderRole(sent.role) && sent.leader) body.leader = sent.leader;
    saveChain = saveChain.then(function () {
      return WWYF.admin('POST', 'role', body).then(function () {
        if (pend[id] === sent) delete pend[id];
      }).catch(function (err) {
        if (pend[id] === sent) delete pend[id];   // revert to the server's value
        fail(err);
      }).then(function () { lastSig = ''; return refresh(); });
    });
  }
  function cycleRole(p) {
    var role = nextRole(p), leader = null;
    if (isLeaderRole(role)) {
      var u = usedLetters(p.id);
      leader = isLeaderRole(p.role) && p.leader && !u[p.leader] ? p.leader
        : (state.leaderLabels.filter(function (l) { return !u[l]; })[0] || null);
    }
    apply(p, role, leader);
  }
  function cycleLetter(p) {
    var u = usedLetters(p.id), L = state.leaderLabels, i = L.indexOf(p.leader);
    for (var k = 1; k <= L.length; k++) {
      var l = L[(i + k + L.length) % L.length];
      if (!u[l]) { if (l !== p.leader) apply(p, p.role, l); else toast('其他領袖代號都已被使用'); return; }
    }
  }

  /* ---------- lock (UI only): default locked, auto re-lock after 30 s without role taps ---------- */
  var LOCK_MS = 30000, locked = true, lockAt = 0, lockTick = 0;
  function setLocked(v) {
    locked = v;
    clearInterval(lockTick);
    if (!v) { lockAt = Date.now() + LOCK_MS; lockTick = setInterval(lockUi, 500); }
    lockUi();
  }
  function lockUi() {
    var b = $('lock'), left = Math.ceil((lockAt - Date.now()) / 1000);
    if (!locked && left <= 0) { setLocked(true); return; }
    $('grid').classList.toggle('is-locked', locked);
    b.classList.toggle('is-open', !locked);
    b.setAttribute('aria-pressed', String(!locked));
    $('lockIcon').textContent = locked ? '🔒' : '🔓';
    $('lockText').textContent = locked ? '已鎖定' : left + ' 秒後鎖定';
  }
  function touchLock() { if (!locked) lockAt = Date.now() + LOCK_MS; lockUi(); }
  var hintT = 0;
  function nudge(el) {
    [el, $('lock')].forEach(function (x) { x.classList.remove('shake'); void x.offsetWidth; x.classList.add('shake'); });
    var h = $('lockHint'); h.classList.add('show');
    clearTimeout(hintT); hintT = setTimeout(function () { h.classList.remove('show'); }, 1300);
  }
  $('lock').addEventListener('click', function () { setLocked(!locked); });

  $('grid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || !state) return;
    var card = b.closest('.pc'), id = card.getAttribute('data-id');
    var p = state.players.find(function (q) { return q.id === id; }); if (!p) return;
    if (locked) { nudge(b); return; }
    var act = b.getAttribute('data-act');
    if (act === 'role') { touchLock(); cycleRole(p); }
    else if (act === 'leader') { touchLock(); cycleLetter(p); }
    else if (act === 'kick') {
      if (!confirm('確定要把「' + charName(p.characterId) + '」移出遊戲嗎？\n該玩家需要重新選擇角色加入。')) return;
      card.classList.add('busy');
      WWYF.admin('POST', 'kick', { playerId: id }).then(function () { toast('已移出玩家'); lastSig = ''; return refresh(); }).catch(fail);
    }
  });
  $('random').addEventListener('click', function () {
    var b = this;
    if (state && state.players.some(function (p) { return p.role && p.role !== CIV; }) && !confirm('重新隨機分配會覆蓋目前所有身分，確定嗎？')) return;
    act(b, function () {
      return WWYF.admin('POST', 'random').then(function (r) {
        lastSig = '';
        var msg = r.special != null
          ? '已隨機分配 ' + r.special + ' 個特殊身分' + (r.civilians ? '，其餘 ' + r.civilians + ' 位為平民' : '')
          : '已隨機分配 ' + r.assigned + ' 位玩家';                     // old backend response
        if (r.special != null && r.missingRoles) {
          var miss = Object.keys(r.missing || {}).map(function (k) { return short(k) + '×' + r.missing[k]; }).join('、');
          msg += '（人數不足，未分配：' + (miss || r.missingRoles + ' 個特殊身分') + '）';
        }
        toast(msg, !!r.missingRoles);
      });
    });
  });
  $('clear').addEventListener('click', function () {
    if (!confirm('確定要把所有玩家重設為平民嗎？')) return;
    act(this, function () { return WWYF.admin('POST', 'clear-roles').then(function () { lastSig = ''; toast('已全部重設為平民'); }); });
  });
  $('reset').addEventListener('click', function () {
    if (!confirm('開始新一場？\n\n會清空所有玩家與身分，大家需要重新選角色加入。')) return;
    act(this, function () { return WWYF.admin('POST', 'reset').then(function (r) { lastSig = ''; toast('新的一場已開始'); }); }).then(renderPhase);
  });

  /* ---------- collapsible sections: any .acc[data-acc] gets toggle + remembered state ---------- */
  var ACC_KEY = 'wwyf.admin.acc.';
  function initAcc(sec) {
    var id = sec.getAttribute('data-acc'), btn = sec.querySelector('.acc__toggle');
    function set(open, save) {
      sec.classList.toggle('is-closed', !open);
      btn.setAttribute('aria-expanded', String(open));
      if (save) try { localStorage.setItem(ACC_KEY + id, open ? '1' : '0'); } catch (e) {}
    }
    var saved = null; try { saved = localStorage.getItem(ACC_KEY + id); } catch (e) {}
    set(saved !== '0', false);
    btn.addEventListener('click', function () { set(sec.classList.contains('is-closed'), true); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.acc[data-acc]'), initAcc);

  /* ---------- boot ---------- */
  fetch('../data/characters.json?v=' + V, { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { (d.characters || []).forEach(function (c) { chars[c.id] = c; }); chars.__ok = 1; lastSig = ''; render(); })
    .catch(function () {});
  if (token()) start(); else showLogin('');
})();
