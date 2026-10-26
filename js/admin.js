/* Host dashboard: login, live player list (poll every 2 s), role assignment. */
(function () {
  'use strict';
  var V = 6;
  var AKEY = 'wwyf.admin';
  var $ = function (id) { return document.getElementById(id); };
  var SHORT = { '真正領袖': '真領袖', '假領袖': '假領袖', '真領袖支持者': '真支持', '假領袖支持者': '假支持', '平民': '平民' };
  function short(r) { return r ? (SHORT[r] || r) : '未分配'; }
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
    $('cap').textContent = s.capacity;
    $('online').textContent = s.players.filter(function (p) { return p.online; }).length;

    // no chip row: one plain "已分配 n/m" in the header, red text only when a role is over its limit
    var warn = [];
    s.roleOrder.forEach(function (r) {
      var n = s.assigned[r] || 0, max = s.roles[r] || 0;
      if (n > max) warn.push('「' + short(r) + '」超出上限 ' + n + '/' + max);
    });
    if (s.players.length > s.capacity) warn.push('玩家 ' + s.players.length + ' 人，超過角色總數 ' + s.capacity);
    $('warnings').innerHTML = warn.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
    $('assigned').textContent = s.players.filter(function (p) { return p.role; }).length;
    $('assignedOf').textContent = s.players.length;
    $('sumJoined').textContent = s.players.length; $('sumCap').textContent = s.capacity;
    $('sumAssigned').textContent = $('assigned').textContent; $('sumAssignedOf').textContent = s.players.length;

    renderGrid();
  }

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
  var CYCLE = [null, '平民', '真領袖支持者', '假領袖支持者', '假領袖', '真正領袖'];
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
    var i = CYCLE.indexOf(p.role); if (i < 0) i = 0;
    for (var k = 1; k <= CYCLE.length; k++) {
      var r = CYCLE[(i + k) % CYCLE.length];
      if (r === null) return null;
      var others = state.players.filter(function (q) { return q.id !== p.id && q.role === r; }).length;
      if (others < (state.roles[r] || 0)) return r;
    }
    return null;
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
    if (state && state.players.some(function (p) { return p.role; }) && !confirm('重新隨機分配會覆蓋目前所有身分，確定嗎？')) return;
    act(b, function () {
      return WWYF.admin('POST', 'random').then(function (r) {
        lastSig = '';
        var msg = '已隨機分配 ' + r.assigned + ' 位玩家';
        if (r.unassigned) msg += '，' + r.unassigned + ' 位因角色不足未分配';
        if (r.missingRoles) msg += '（尚缺 ' + r.missingRoles + ' 位玩家才滿員）';
        toast(msg);
      });
    });
  });
  $('clear').addEventListener('click', function () {
    if (!confirm('確定要清除所有玩家的身分嗎？')) return;
    act(this, function () { return WWYF.admin('POST', 'clear-roles').then(function () { lastSig = ''; toast('已清除所有身分'); }); });
  });
  $('reset').addEventListener('click', function () {
    if (!confirm('開始新一場？\n\n會清空所有玩家與身分，大家需要重新選角色加入。')) return;
    act(this, function () { return WWYF.admin('POST', 'reset').then(function (r) { lastSig = ''; toast('新的一場已開始'); }); });
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
