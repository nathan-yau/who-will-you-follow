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
  var pendingRender = false;
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
      state = s; sync(true, '即時同步');
      render();
    }).catch(function (e) {
      if (e.status === 401) { logout('登入已過期，請重新登入'); return; }
      sync(false, '連線中斷…');
    });
  }
  function start() {
    $('login').hidden = true; $('dash').hidden = false; $('topRight').hidden = false;
    refresh();
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) refresh(); }, 2000);
  }

  /* ---------- render ---------- */
  function interacting() {
    var a = document.activeElement;
    return a && a.tagName === 'SELECT' && $('grid').contains(a);
  }
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
    if (interacting()) { pendingRender = true; updateTimes(); return; }
    if (sig === lastSig) { updateTimes(); return; }
    lastSig = sig; pendingRender = false;
    var html = '';
    s.players.forEach(function (p) {
      var isLeader = p.role && s.leaderRoles.indexOf(p.role) >= 0;
      var opts = '<option value="">未分配</option>';
      s.roleOrder.forEach(function (r) {
        var left = (s.roles[r] || 0) - (s.assigned[r] || 0) + (p.role === r ? 1 : 0);
        opts += '<option value="' + esc(r) + '"' + (p.role === r ? ' selected' : '') + (left <= 0 && p.role !== r ? ' disabled' : '') + '>' +
          esc(r) + (left <= 0 && p.role !== r ? '（已滿）' : '') + '</option>';
      });
      var lopts = '';
      if (isLeader) {
        var used = {};
        s.players.forEach(function (q) { if (q.id !== p.id && q.leader && s.leaderRoles.indexOf(q.role) >= 0) used[q.leader] = 1; });
        s.leaderLabels.forEach(function (l) {
          lopts += '<option value="' + l + '"' + (p.leader === l ? ' selected' : '') + (used[l] ? ' disabled' : '') + '>' + l + (used[l] ? ' ·' : '') + '</option>';
        });
      }
      html += '<article class="pc card' + (p.role ? '' : ' unassigned') + '" data-id="' + esc(p.id) + '" style="--c:' + (p.role ? ROLE_COLORS[p.role] : 'var(--line)') + '">' +
        '<div class="pc__icon"><img src="' + img(p.characterId) + '" alt="" loading="lazy" /></div>' +
        '<p class="pc__name" lang="en">' + esc(charName(p.characterId)) + '</p>' +
        '<p class="pc__meta"><i class="dot' + (p.online ? ' on' : '') + '"></i><span class="pc__seen" data-t="' + (p.lastSeen || '') + '">' + (p.online ? '在線' : '離線 · ' + ago(p.lastSeen)) + '</span>' +
        (p.nickname ? '<span>·</span><span class="pc__nick">' + esc(p.nickname) + '</span>' : '') + '</p>' +
        '<div class="pc__ctrl"><select class="sel sel--role" aria-label="身分">' + opts + '</select>' +
        (isLeader ? '<select class="sel sel--leader" aria-label="領袖代號">' + lopts + '</select>' : '') + '</div>' +
        '<button class="kick" type="button" title="移出玩家" aria-label="移出 ' + esc(charName(p.characterId)) + '"><svg viewBox="0 0 14 14"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
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
    return fn().then(refresh).catch(fail).then(function () { btn.disabled = false; });
  }
  $('grid').addEventListener('change', function (e) {
    var card = e.target.closest('.pc'); if (!card) return;
    var id = card.getAttribute('data-id');
    var role = card.querySelector('.sel--role').value || null;
    var body = { playerId: id, role: role };
    if (e.target.classList.contains('sel--leader')) body.leader = e.target.value;
    card.classList.add('busy');
    e.target.blur();
    WWYF.admin('POST', 'role', body).then(function () { lastSig = ''; return refresh(); })
      .catch(function (err) { lastSig = ''; fail(err); render(); })
      .then(function () { card.classList.remove('busy'); });
  });
  $('grid').addEventListener('focusout', function () { setTimeout(function () { if (pendingRender && !interacting()) { lastSig = ''; render(); } }, 0); });
  $('grid').addEventListener('click', function (e) {
    var b = e.target.closest('.kick'); if (!b) return;
    var card = b.closest('.pc'), id = card.getAttribute('data-id');
    var p = state.players.find(function (q) { return q.id === id; });
    if (!confirm('確定要把「' + charName(p && p.characterId) + '」移出遊戲嗎？\n該玩家需要重新選擇角色加入。')) return;
    card.classList.add('busy');
    WWYF.admin('POST', 'kick', { playerId: id }).then(function () { toast('已移出玩家'); lastSig = ''; return refresh(); }).catch(fail);
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
