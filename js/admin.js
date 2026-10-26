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
      state = s; fetchedAt = Date.now(); overlay(); sync(true);
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
    renderReveal();
  }

  /* ---------- TV／遊戲 section ---------- */
  function renderPhase() {
    var started = !!(state && state.meta && state.meta.phase === 'started');
    var sc = curScreen(), rnd = SCREEN_NAMES[sc] && sc !== 'lobby' ? SCREEN_NAMES[sc] : '';
    $('phaseText').textContent = started ? '遊戲已開始' + (rnd ? ' · ' + rnd : '') : '等候中 · 泡泡大戰進行中';
    $('phaseDot').classList.toggle('on', !started);
    $('phaseDot').classList.toggle('live', started);
    $('tvNote').textContent = started
      ? '遊戲已開始：TV 顯示' + (sc === 'reveal' ? '「身份揭曉」畫面' : rnd ? '「' + rnd + '」標題畫面（含四位領袖卡）' : '「遊戲開始」') + '，手機按鈕已停用。'
      : '等候中：玩家可在手機按「避開啊／衝過去」玩 TV 上的泡泡大戰。';
    $('startGame').disabled = started;
    if (started) disarm();
    $('toLobby').disabled = !started;
    renderSeg();
    renderGoR1();
    renderVote();
  }

  /* 開始 Round 1 (flow: 等候 → 身份揭曉 → Round 1): shown once the reveal stage has started, until a round is on the TV.
     Everyone revealed (done == total > 0) -> prominent, one tap. Otherwise locked with 「X / N 已揭曉」; a tap arms
     「仍然開始」 and a second tap within 3 s overrides (someone's phone died). Uses admin/screen r1, which also ends
     the reveal stage (players can still re-view their own card). */
  var r1Arm = false, r1ArmT = 0;
  function r1Disarm() { clearTimeout(r1ArmT); r1ArmT = 0; r1Arm = false; renderGoR1(); }
  function renderGoR1() {
    if (!state || !state.meta) return;
    var m = state.meta, cur = curScreen(), b = $('goR1');
    var show = !!m.revealed && m.phase === 'started' && !/^r[123]$/.test(cur) && segPending !== 'r1';
    $('r1go').hidden = !show;
    if (!show) { if (r1Arm) { clearTimeout(r1ArmT); r1Arm = false; } return; }
    var done = state.players.filter(function (p) { return p.seen; }).length, total = state.players.length;
    var ready = total > 0 && done === total;
    if (ready && r1Arm) { clearTimeout(r1ArmT); r1Arm = false; }
    $('r1Done').textContent = done; $('r1Total').textContent = total;
    $('r1go').classList.toggle('is-ready', ready);
    b.classList.toggle('is-locked', !ready);
    b.classList.toggle('is-armed', !ready && r1Arm);
    b.removeAttribute('aria-disabled');   // locked is still tappable (arms the override), so not disabled for AT
    b.disabled = total === 0;
    b.textContent = ready ? '開始 Round 1' : r1Arm ? '仍然開始' : done + ' / ' + total + ' 已揭曉';
    b.title = ready ? '所有玩家都已揭曉身份：TV 切換到 Round 1，首次公開領袖' : '還有玩家未揭曉：按一下再按「仍然開始」可強制開始';
  }
  $('goR1').addEventListener('click', function () {
    if (!state || this.disabled) return;
    var b = this, ready = !b.classList.contains('is-locked');
    if (!ready && !r1Arm) { r1Arm = true; clearTimeout(r1ArmT); r1ArmT = setTimeout(r1Disarm, 3000); renderGoR1(); return; }
    clearTimeout(r1ArmT); r1Arm = false;
    segPending = 'r1'; renderSeg(); renderGoR1();
    WWYF.admin('POST', 'screen', { screen: 'r1' }).then(function (r) {
      if (state && state.meta) { state.meta.phase = r.phase; state.meta.tvScreen = r.screen; }
      toast('Round 1 開始！TV 正在公開領袖');
    }).catch(fail).then(function () { segPending = null; renderPhase(); renderReveal(); return refresh(); });
  });

  /* TV 畫面 segmented control: 等候 / Round 1–3 (POST admin/screen; a round implies 開始遊戲) */
  var SCREEN_NAMES = { lobby: '等候', r1: 'Round 1', r2: 'Round 2', r3: 'Round 3', reveal: '身份揭曉' };
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
      b.textContent = armed ? '再按確認' : SCREEN_NAMES[sc];   // (身份揭曉 has its own section: no button is pressed)
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

  /* ---------- 投票 (in TV／遊戲) + 投票結果 section ----------
     Round picker defaults to the round on the TV (tap another to override); the time limit cycles 30/45/60/90/無限 and is
     remembered on this device. 開始投票 = one tap (restarting a round that already has votes asks first: its ballots are
     cleared); 結束投票 = two taps. Live: 投票中 · 剩 mm:ss · 已投票 X / N, then 已封票 (everyone voted) / 已結束. */
  var VROUNDS = ['r1', 'r2', 'r3'], VLABEL = { r1: 'Round 1', r2: 'Round 2', r3: '最後投票' };
  var VDUR_KEY = 'wwyf.admin.voteDur', voteDur = 45, votePick = null, votePickScreen = '', fetchedAt = 0;
  try { var vd = localStorage.getItem(VDUR_KEY); if (vd != null && [30, 45, 60, 90, 0].indexOf(+vd) >= 0) voteDur = +vd; } catch (e) {}
  var vEndArm = false, vEndArmT = 0, vBusy = false;
  function durText(d) { return d ? '時限 ' + d + ' 秒' : '時限 無限'; }
  function mmss(ms) { var x = Math.max(0, Math.ceil(ms / 1000)); return ('0' + Math.floor(x / 60)).slice(-2) + ':' + ('0' + (x % 60)).slice(-2); }
  function openVote() {   // the round whose vote is open right now (or null)
    var m = state && state.meta, v = m && m.vote && state.votes && state.votes[m.vote];
    if (!v || !v.open) return null;
    var left = v.remain == null ? null : v.remain - (Date.now() - fetchedAt);
    if (left != null && left <= 0) return null;   // past the deadline: the next poll confirms it closed
    return { round: m.vote, v: v, left: left };
  }
  function renderVote() {
    if (!state) return;
    var m = state.meta || {}, started = m.phase === 'started', revealed = !!m.revealed;
    var sc = curScreen(), def = VROUNDS.indexOf(sc) >= 0 ? sc : (VROUNDS.indexOf(m.vote) >= 0 ? m.vote : 'r1');
    if (votePickScreen !== sc) { votePickScreen = sc; votePick = null; }
    var ov = openVote(), pick = ov ? ov.round : (votePick || def);
    [].forEach.call(document.querySelectorAll('#voteSeg .seg__btn'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.round === pick));
      b.disabled = !!ov || vBusy;
    });
    var dur = $('voteDur');
    dur.textContent = durText(ov ? ov.v.duration : voteDur);
    dur.disabled = !!ov || vBusy;
    var go = $('voteGo'), can = started && revealed;
    go.disabled = vBusy || (!ov && !can);
    go.classList.toggle('btn--primary', !ov); go.classList.toggle('btn--danger', !!ov);
    go.classList.toggle('is-armed', !!ov && vEndArm);
    go.textContent = ov ? (vEndArm ? '再按確認結束' : '結束投票') : '開始投票';
    if (!ov && vEndArm) vEndDisarm(true);
    var txt, dot = '', lv = state.votes && m.vote && state.votes[m.vote];
    if (ov) { txt = '投票中 · ' + (ov.left == null ? '不限時' : '剩 ' + mmss(ov.left)) + ' · ' + ov.v.voted + ' / ' + ov.v.total + ' 已投'; dot = 'live'; }   // the round = the pressed seg button
    else if (!can) txt = started ? '身份揭曉後才能投票' : '開始遊戲並完成身份揭曉後才能投票';
    else if (lv && (lv.sealed || lv.endedAt)) { txt = VLABEL[m.vote] + (lv.sealed ? ' 已封票' : ' 已結束') + ' · ' + lv.voted + ' / ' + lv.total; dot = 'done'; }
    else txt = '未開始';
    $('voteText').textContent = txt;
    $('voteDot').className = 'dot' + (dot ? ' v-' + dot : '');
    $('voteBox').classList.toggle('is-open', !!ov);
    renderVotes();
  }
  function vEndDisarm(quiet) { clearTimeout(vEndArmT); vEndArmT = 0; vEndArm = false; if (!quiet) renderVote(); }
  $('voteSeg').addEventListener('click', function (e) {
    var b = e.target.closest('.seg__btn'); if (!b || b.disabled) return;
    votePick = b.dataset.round; renderVote();
  });
  $('voteDur').addEventListener('click', function () {
    var L = (state && state.voteDurations) || [30, 45, 60, 90, 0];
    voteDur = L[(L.indexOf(voteDur) + 1) % L.length];
    try { localStorage.setItem(VDUR_KEY, String(voteDur)); } catch (e) {}
    renderVote();
  });
  $('voteGo').addEventListener('click', function () {
    if (!state || vBusy) return;
    var ov = openVote(), b = this;
    if (ov) {
      if (!vEndArm) { vEndArm = true; clearTimeout(vEndArmT); vEndArmT = setTimeout(function () { vEndDisarm(); }, 3000); renderVote(); return; }
      vEndDisarm(true); vBusy = true; renderVote();
      WWYF.admin('POST', 'vote-end').then(function () { toast(VLABEL[ov.round] + ' 投票已結束'); })
        .catch(fail).then(function () { vBusy = false; return refresh(); }).then(renderVote);
      return;
    }
    var m = state.meta || {}, sc = curScreen();
    var pick = votePick || (VROUNDS.indexOf(sc) >= 0 ? sc : (VROUNDS.indexOf(m.vote) >= 0 ? m.vote : 'r1'));
    var prev = state.votes && state.votes[pick];
    if (prev && prev.voted && !confirm('重新開始「' + VLABEL[pick] + '」投票？\n\n這一輪之前的 ' + prev.voted + ' 張票會被清除。')) return;
    vBusy = true; renderVote();
    WWYF.admin('POST', 'vote', { round: pick, duration: voteDur }).then(function () {
      toast(VLABEL[pick] + ' 投票開始！' + (voteDur ? voteDur + ' 秒' : '不限時'));
    }).catch(fail).then(function () { vBusy = false; return refresh(); }).then(renderVote);
  });
  setInterval(function () { if (state && !document.hidden && openVote()) renderVote(); }, 500);

  var vrSig = '', vrOpen = {};
  function renderVotes() {
    var s = state, V = s.votes || {}, K = (s.meta && s.meta.knocks) || {};
    var byId = {}; s.players.forEach(function (p) { byId[p.id] = p; });
    var rounds = VROUNDS.filter(function (r) { return V[r]; });
    var cur = s.meta && s.meta.vote;
    $('vrSum').textContent = rounds.length ? rounds.map(function (r) { return VLABEL[r] + ' ' + V[r].voted + '/' + V[r].total + (V[r].open ? '（投票中）' : V[r].sealed ? '（封票）' : ''); }).join(' · ') : '尚未投票';
    var sig = JSON.stringify([V, K, !!chars.__ok, s.players.map(function (p) { return [p.id, p.characterId]; })].map(function (x) { return x; }), function (k, v) { return k === 'remain' ? undefined : v; });
    if (sig === vrSig) return;
    vrSig = sig;
    function who(id, cid) { var p = byId[id]; cid = cid || (p && p.characterId); return '<span class="vr__who"><img alt="" src="' + img(cid) + '">' + esc(charName(cid)) + '</span>'; }
    $('vrList').innerHTML = rounds.map(function (r) {
      var v = V[r], open = vrOpen[r] != null ? vrOpen[r] : r === cur;
      var rows = (v.leaders || []).map(function (l, i) {
        if (!l) return '';
        var lp = byId[l.id], tag = lp && lp.role === '真正領袖' ? '<b class="vr__true">真</b>' : '<b class="vr__fake">假</b>';
        var voters = v.ballots.filter(function (x) { return x.target === l.id; });
        return '<div class="vr__row" style="--c:' + (SLOT_COLORS[s.leaderLabels[i]] || '#d8d2c0') + '"><span class="vr__lead">' + tag + who(l.id, l.characterId) + '<em>' + voters.length + ' 票</em></span>' +
          '<span class="vr__voters">' + (voters.map(function (x) { return who(x.voter); }).join('') || '<i class="vr__none">—</i>') + '</span></div>';
      }).join('');
      var voted = {}; v.ballots.forEach(function (x) { voted[x.voter] = 1; });
      var none = s.players.filter(function (p) { return s.leaderRoles.indexOf(p.role) < 0 && !voted[p.id]; });
      if (none.length) rows += '<div class="vr__row vr__row--none"><span class="vr__lead">未投票 <em>' + none.length + '</em></span><span class="vr__voters">' + none.map(function (p) { return who(p.id); }).join('') + '</span></div>';
      var k = K[r], kn = '';
      if (k) {
        var fk = byId[k.fake];
        kn = '<div class="vr__knock">🚪 私下敲門 ' + new Date(k.at).toLocaleTimeString('zh-Hant', { hour: '2-digit', minute: '2-digit' }) + '：' +
          (k.targets.length ? k.targets.map(function (id) { return who(id) + (k.seen && k.seen[id] ? '<small>已讀</small>' : '<small>未讀</small>'); }).join('') +
            '<span class="vr__fk">（都投給假領袖 ' + (fk ? who(fk.id) : '?') + '）</span>' : '<span class="vr__fk">沒有可敲門的人</span>') + '</div>';
      }
      var st = v.open ? '投票中' : v.sealed ? '已封票' : '已結束';
      return '<details class="vr__round" data-round="' + r + '"' + (open ? ' open' : '') + '><summary><span class="vr__title">' + VLABEL[r] + '</span><span class="vr__st' + (v.open ? ' is-open' : '') + '">' + st + ' · ' + v.voted + ' / ' + v.total + '</span></summary>' + rows + kn + '</details>';
    }).join('') || '<p class="empty">還沒有任何投票</p>';
  }
  $('vrList').addEventListener('toggle', function (e) {
    var d = e.target; if (d && d.dataset && d.dataset.round) vrOpen[d.dataset.round] = d.open;
  }, true);

  /* ---------- 身份揭曉 section: start (two taps) / end the stage; X/N players have tapped 揭曉 ---------- */
  var rvArmT = 0, rvSig = '';
  function rvInfo() {
    var s = state, m = s.meta || {};
    var stage = m.phase === 'started' && m.tvScreen === 'reveal';
    var done = s.players.filter(function (p) { return p.seen; }).length;
    return { stage: stage, revealed: !!m.revealed, done: done, total: s.players.length };
  }
  function rvDisarm() {
    clearTimeout(rvArmT); rvArmT = 0;
    var b = $('rvStart'); b.classList.remove('is-armed');
    if (state) renderReveal();
  }
  function renderReveal() {
    if (!state) return;
    var r = rvInfo(), b = $('rvStart');
    $('rvDone').textContent = r.done; $('rvTotal').textContent = r.total;
    $('rvText').textContent = r.stage ? '進行中' : r.revealed ? '已結束（身分可重看）' : '未開始';
    $('rvDot').classList.toggle('rv-on', r.stage);
    $('rvDot').classList.toggle('on', !r.stage && r.revealed);
    $('rvBar').style.width = (r.total ? Math.round(100 * r.done / r.total) : 0) + '%';
    $('rvNote').textContent = r.stage
      ? '揭曉中：玩家在手機按「揭曉我的身份」（已揭曉 ' + r.done + ' / ' + r.total + '，只有主持人看得到）。TV 只顯示「請看你的手機」，不會顯示任何玩家資料。'
      : r.revealed
        ? '身份已揭曉：玩家可隨時在手機「再看一次身份」。如有改動身分，該玩家的手機會重新顯示「揭曉」。'
        : '開始後，每位玩家的手機會顯示「揭曉我的身份」，TV 只顯示「請看你的手機」（不會顯示任何玩家資料或進度）。請先在上方分配好身分。';
    if (!b.classList.contains('is-armed')) b.textContent = r.stage ? '揭曉進行中' : r.revealed ? '再次開始揭曉' : '開始身份揭曉';
    b.disabled = r.stage;
    $('rvEnd').disabled = !r.stage;
    var sig = JSON.stringify([state.players.map(function (p) { return [p.id, p.characterId, p.seen]; }), !!chars.__ok]);
    if (sig === rvSig) return;
    rvSig = sig;
    $('rvList').innerHTML = state.players.map(function (p) {
      var n = esc(charName(p.characterId));
      return '<span class="rv' + (p.seen ? ' done' : '') + '" title="' + n + (p.seen ? ' · 已揭曉' : ' · 未揭曉') + '"><img src="' + img(p.characterId) + '" alt="' + n + '" loading="lazy" /></span>';
    }).join('');
  }
  $('rvStart').addEventListener('click', function () {
    var b = this; if (!state) return;
    if (!b.classList.contains('is-armed')) {           // first tap arms, second tap (within 3 s) confirms
      var anySpecial = state.players.some(function (p) { return p.role && p.role !== CIV; });
      b.classList.add('is-armed'); b.textContent = anySpecial ? '再按一次確認' : '尚未分配身分！再按確認';
      clearTimeout(rvArmT); rvArmT = setTimeout(rvDisarm, 3000);
      return;
    }
    rvDisarm();
    act(b, function () {
      return WWYF.admin('POST', 'reveal-stage', { on: true }).then(function () { toast('身份揭曉開始！請玩家看手機'); });
    }).then(render);
  });
  $('rvEnd').addEventListener('click', function () {
    act(this, function () {
      return WWYF.admin('POST', 'reveal-stage', { on: false }).then(function () { toast('身份揭曉已結束（玩家仍可重看身分）'); });
    }).then(render);
  });

  var SLOT_COLORS = { A: '#a9cf8f', B: '#f5ab9b', C: '#f2c46e', D: '#9fbedd' };   // TV leader-card pastels, a bit stronger
  function supTag(p, s) {
    var l = p.supports && s.players.filter(function (q) { return q.id === p.supports && q.role === '假領袖'; })[0];
    var txt = l ? '→' + esc(charName(l.characterId)) : '→—';
    return '<span class="sup" lang="en" style="--c:' + ROLE_COLORS['假領袖'] + '" title="' + (l ? '暗中支持 假領袖 ' + esc(charName(l.characterId)) : '未配對（沒有假領袖）') + '">' + txt + '</span>';
  }
  function renderGrid() {
    var s = state;
    $('empty').hidden = s.players.length > 0;
    var sig = JSON.stringify([s.players.map(function (p) { return [p.id, p.characterId, p.nickname, p.role, p.leader, p.online, p.supports]; }), s.roles, !!chars.__ok]);
    if (sig === lastSig) return;
    lastSig = sig;
    var html = '';
    s.players.forEach(function (p) {
      var isLeader = p.role && s.leaderRoles.indexOf(p.role) >= 0;
      var name = esc(charName(p.characterId));
      html += '<div class="pc' + (p.role ? '' : ' unassigned') + (p.online ? '' : ' off') + (pend[p.id] ? ' saving' : '') + '" data-id="' + esc(p.id) + '" title="' + name + (p.nickname ? '（' + esc(p.nickname) + '）' : '') + (p.online ? '' : ' · 離線') + '">' +
        '<div class="pc__icon"><img src="' + img(p.characterId) + '" alt="" loading="lazy" />' + (p.online ? '' : '<i class="pc__off" aria-label="離線"></i>') +
          // leaders: a colour dot = their card's position/colour on the TV round screens (tap to move); no letter is ever shown
          (isLeader ? '<button class="badge" type="button" data-act="leader" style="--c:' + (SLOT_COLORS[p.leader] || '#d8d2c0') + '" title="TV 領袖卡位置／顏色（點一下切換）" aria-label="TV 領袖卡位置 ' + (state.leaderLabels.indexOf(p.leader) + 1 || '?') + '（點一下切換）"></button>' : '') +
          // 假領袖支持者: the fake leader the server paired them with (admin-only, read-only)
          (p.role === '假領袖支持者' ? supTag(p, s) : '') + '</div>' +
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
      if (!u[l]) { if (l !== p.leader) apply(p, p.role, l); else toast('其他領袖卡位置都已被使用'); return; }
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
