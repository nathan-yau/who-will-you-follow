/* Host dashboard: login, live player list (poll every 2 s), role assignment. */
(function () {
  'use strict';
  var V = 6;
  var AKEY = 'wwyf.admin';
  var $ = function (id) { return document.getElementById(id); };
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
  function ago(t) {
    if (!t || !state) return '從未連線';
    var s = Math.max(0, Math.round((state.serverTime - t) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分鐘前';
    return Math.round(s / 3600) + ' 小時前';
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
  function sync(ok, text) { $('sync').className = 'sync ' + (ok ? 'ok' : 'bad'); $('syncText').textContent = text; }
  function refresh() {
    return WWYF.admin('GET', 'state').then(function (s) {
      state = s; overlay(); sync(true, '即時同步');
      render();
    }).catch(function (e) {
      if (e.status === 401) { logout('登入已過期，請重新登入'); return; }
      sync(false, '連線中斷…');
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
    $('gameId').textContent = s.meta.gameId || '–';
    $('joined').textContent = s.players.length;
    $('cap').textContent = s.capacity;
    $('online').textContent = s.players.filter(function (p) { return p.online; }).length;

    // role chips + warnings
    var chips = '', warn = [];
    s.roleOrder.forEach(function (r) {
      var n = s.assigned[r] || 0, max = s.roles[r] || 0;
      chips += '<span class="chip' + (n > max ? ' over' : n === max && max ? ' full' : '') + '" style="--c:' + (ROLE_COLORS[r] || '#ccc') + '"><i></i>' + esc(r) + ' <b>' + n + '/' + max + '</b></span>';
      if (n > max) warn.push(['bad', '「' + r + '」超出上限：' + n + ' / ' + max]);
    });
    $('roleChips').innerHTML = chips;
    var un = s.players.filter(function (p) { return !p.role; }).length;
    if (s.players.length > s.capacity) warn.push(['bad', '玩家人數 (' + s.players.length + ') 超過角色總數 (' + s.capacity + ')，部分玩家將無法分配身分']);
    if (un && s.players.length) warn.push(['', '尚有 ' + un + ' 位玩家未分配身分']);
    var off = s.players.filter(function (p) { return !p.online; }).length;
    if (off) warn.push(['', off + ' 位玩家目前離線（超過 15 秒沒有回應）']);
    $('warnings').innerHTML = warn.map(function (w) { return '<li class="' + w[0] + '">' + esc(w[1]) + '</li>'; }).join('');

    renderGrid();
    renderArchive();
  }

  function renderGrid() {
    var s = state;
    $('empty').hidden = s.players.length > 0;
    var sig = JSON.stringify([s.players.map(function (p) { return [p.id, p.characterId, p.nickname, p.role, p.leader, p.online]; }), s.roles]);
    if (sig === lastSig) { updateTimes(); return; }
    lastSig = sig;
    var html = '';
    s.players.forEach(function (p) {
      var isLeader = p.role && s.leaderRoles.indexOf(p.role) >= 0;
      var name = esc(charName(p.characterId));
      html += '<article class="pc card' + (p.role ? '' : ' unassigned') + (pend[p.id] ? ' saving' : '') + '" data-id="' + esc(p.id) + '" style="--c:' + (p.role ? ROLE_COLORS[p.role] : 'var(--line)') + '">' +
        '<div class="pc__icon"><img src="' + img(p.characterId) + '" alt="" loading="lazy" /></div>' +
        '<p class="pc__name" lang="en">' + name + '</p>' +
        '<p class="pc__meta"><i class="dot' + (p.online ? ' on' : '') + '"></i><span class="pc__seen">' + (p.online ? '在線' : '離線 · ' + ago(p.lastSeen)) + '</span>' +
        (p.nickname ? '<span>·</span><span class="pc__nick">' + esc(p.nickname) + '</span>' : '') + '</p>' +
        '<div class="pc__ctrl">' +
          '<button class="pill' + (p.role ? '' : ' pill--none') + '" type="button" data-act="role" style="--c:' + (p.role ? ROLE_COLORS[p.role] : '#b9b4a4') + '" aria-label="身分：' + esc(p.role || '未分配') + '（點一下切換）">' + esc(p.role || '未分配') + '</button>' +
          (isLeader ? '<button class="badge" type="button" data-act="leader" aria-label="領袖 ' + esc(p.leader || '?') + '（點一下切換）">' + esc(p.leader || '?') + '</button>' : '') +
        '</div>' +
        '<button class="kick" type="button" data-act="kick" title="移出玩家" aria-label="移出 ' + name + '"><svg viewBox="0 0 14 14"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
        '</article>';
    });
    $('grid').innerHTML = html;
  }
  function updateTimes() {
    var els = $('grid').querySelectorAll('.pc');
    for (var i = 0; i < els.length; i++) {
      var p = state.players.find(function (q) { return q.id === els[i].getAttribute('data-id'); });
      if (!p) continue;
      els[i].querySelector('.pc__seen').textContent = p.online ? '在線' : '離線 · ' + ago(p.lastSeen);
    }
  }

  var archiveSig = '';
  function renderArchive() {
    var keys = state.archive || [];
    $('archiveCount').textContent = keys.length ? '（' + keys.length + '）' : '（尚無）';
    var sig = keys.join();
    if (sig === archiveSig) return;
    archiveSig = sig;
    $('archiveList').innerHTML = keys.map(function (k) {
      var ts = +k.split('/')[1].split('-')[0];
      return '<li><button type="button" data-key="' + esc(k) + '">' + esc(new Date(ts).toLocaleString('zh-TW', { hour12: false })) + '</button></li>';
    }).join('');
  }
  $('archiveList').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var bs = $('archiveList').querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i] === b));
    WWYF.admin('GET', 'archive?key=' + encodeURIComponent(b.getAttribute('data-key'))).then(function (a) {
      $('archiveView').innerHTML = '<table><thead><tr><th>角色</th><th>暱稱</th><th>身分</th><th>領袖</th></tr></thead><tbody>' +
        a.players.map(function (p) {
          return '<tr><td lang="en">' + esc(charName(p.characterId)) + '</td><td>' + esc(p.nickname || '–') + '</td><td>' + esc(p.role || '未分配') + '</td><td>' + esc(p.leader || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(fail);
  });

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
    $('lockText').textContent = locked ? '已鎖定' : '已解鎖 · ' + left + ' 秒後自動鎖定';
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
    if (!confirm('開始新一場？\n\n目前的玩家名單與身分會存到「過往場次紀錄」，然後清空所有玩家，大家需要重新加入。')) return;
    act(this, function () { return WWYF.admin('POST', 'reset').then(function (r) { lastSig = ''; toast('新的一場已開始' + (r.archived ? '（已封存 ' + r.archived + ' 位玩家）' : '')); }); });
  });

  /* ---------- boot ---------- */
  fetch('../data/characters.json?v=' + V, { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { (d.characters || []).forEach(function (c) { chars[c.id] = c; }); lastSig = ''; render(); })
    .catch(function () {});
  if (token()) start(); else showLogin('');
})();
