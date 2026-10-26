/* 回合頁 (round page) — the player's phone while the TV shows Round 1 / 2 / 3 (GET /api/me -> round).
   One page for every round: the copy comes from data/texts.json (rounds.<r1|r2|r3>, round.*).
   - the leaders (same slot order as the TV) peek out of paw-print pots; names under the pots
   - the 發言 timer (admin/speak): 準備中 --:-- -> 發言中 + countdown (server remain ms, no clock skew) -> 提問時間
   - players: 「前往投票」 stays disabled (等待投票開始) until this round's vote opens, then it is simply enabled.
     The page never jumps to the vote by itself; the player taps.
   - leaders (真 / 假): their own instructions (desc + tip) come from the server for that leader only, and instead of the
     button a 「跟隨你的人數」 box: a count only (never names), once this round's vote has closed.
   - Round 2 adds the 「神秘描述」 card (round.mystery, edited in admin 「遊戲內容」).
   - Round 3 (破解密碼) swaps the pots for 解鎖進度 + the current question (round.quiz): players tap A–D and can change
     until the host closes it; leaders see it read-only. The answer + 成功 / 未達標 only arrive after close; once enough
     questions succeed the final clue replaces the question card (while no question is open). */
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
    final: { tag: '最終揭曉', title: '請看 TV！', desc: '主持人正在逐一翻開領袖卡，\n看看誰才是真正領袖！', hidden: '未翻開', fake: '假領袖', true: '真正領袖',
      noSupp: '' },
    ending: { tag: '結局', winTitle: '勝利！', winLine: '大家成功跟隨了真正的領袖！', loseTitle: '差一點點…', loseLine: '假領袖勝出…', meterLabel: '跟隨真正領袖',
      target: '目標 {t}%', count: '{x} / {n} 人（約 {p}%）', votes: '{n} 票', trueTag: '真正領袖', fakeTag: '假領袖', mineTrue: '你跟隨了真正的領袖 🎉', mineFake: '你跟隨了 {name}',
      mineNone: '你沒有在最後投票中投票', leaderTrueWin: '你成功帶領大家找到你！', leaderTrueLose: '大家未能認出你是真正的領袖…', leaderFakeWin: '你成功迷惑了大家！',
      leaderFakeLose: '你的偽裝被識破了！', leaderVotes: '最後投票有 {n} 人跟隨你', thanks: '多謝參與幸福小組！', waiting: '結局計算中…',
      phoneWaitTitle: '點票中…', phoneWait: '請看 TV，正在點票…' },
    rounds: {
      r1: { tag: 'Round 1 / 3', title: '三句話', desc: '{n}位領袖會各自分享三句關於自己的說話。\n你可以聽完發言後提問，\n然後選擇你最相信的一位領袖。', tip: '仔細聆聽每位領袖的說話，\n你可以在發言後向他們提問！' },
      r2: { tag: 'Round 2 / 3', title: '誰是真領袖？', desc: '{n}位領袖會再次發言。', tip: '' },
      r3: { tag: 'Round 3 / 3', title: '破解密碼', desc: '大家將一起完成五道選擇題，\n每題需要至少 {pct} 的玩家答對才算成功。\n只要成功 {need} 題，即可解鎖最後的線索！', tip: '請大家認真討論，選出你認為正確的答案！' }
    },
    quiz: { progress: '解鎖進度', progressNote: '成功 {need} 題即可解鎖最後線索！', qLabel: '問題 {i} / {n}', waiting: '等待主持人開始第 {i} 題', open: '作答中',
      answered: '已作答', closed: '作答結束', ok: '成功！', fail: '未達標', pctLine: '答對 {pct}% · 門檻 {need}%', leader: '領袖不參與作答', must: '請作答！', unlockedTitle: '最後的線索',
      unlocked: '已解鎖！', lost: '未能解鎖最後的線索', left: '剩餘時間', unlimited: '不限時', yours: '你的答案', noAnswer: '你未有作答' }
  };
  var quizEnd = null, optKey = '', descKey = '', pending = null, sending = false;
  var last = null, speakEnd = null, speakState = 'ready', rowKey = '', inflight = false, followKey = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function img(id, f) { return '../assets/characters/' + encodeURIComponent(id) + '/' + f + '.webp?v=' + V; }
  function txt() { return T || DEF; }
  function R(k) { var t = txt(); return (t.round && t.round[k]) || DEF.round[k]; }
  function copy(screen) { var t = txt(), d = DEF.rounds[screen] || DEF.rounds.r1, c = (t.rounds && t.rounds[screen]) || {}, o = {}; for (var k in d) o[k] = d[k]; for (k in c) if (c[k]) o[k] = c[k]; return o; }
  function FT(k) { var t = txt(); return (t.final && t.final[k] != null ? t.final[k] : DEF.final[k]); }
  function EN(k) { var t = txt(); return (t.ending && t.ending[k] != null && t.ending[k] !== '' ? t.ending[k] : DEF.ending[k]); }
  function Q(k) { var t = txt(); return (t.quiz && t.quiz[k]) || DEF.quiz[k]; }
  function fill(s, o) { return String(s || '').replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); }
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
    var rd = r.round;
    if (rd.screen === 'final') { renderFinal(rd); return; }
    if (rd.screen === 'ending') { renderEnding(rd); return; }
    var c = copy(rd.screen), leader = !!rd.leaderText || rd.followers != null;
    var n = renderRow(rd.leaders);
    set('tag', c.tag); set('rdTitle', c.title); set('tipTitle', R('tipTitle')); set('againText', R('again'));
    var lt = rd.leaderText || {};
    app.setAttribute('data-r', rd.screen === 'r2' || rd.screen === 'r3' ? rd.screen : 'r1');
    var qz = rd.screen === 'r3' ? rd.quiz : null;
    var dtx = leader && lt.desc ? lt.desc : leader && c.leaderDesc ? c.leaderDesc : String(c.desc || '').replace(/\{n\}/g, NUM[n] || String(n));
    var dk = dtx + '#' + (qz ? qz.threshold + '/' + qz.need : '');
    if (dk !== descKey) {
      descKey = dk;
      // {pct} / {need} (Round 3) are highlighted; everything else is plain text
      $('desc').innerHTML = esc(dtx).replace(/\{(pct|need)\}/g, function (m, k) { return '<b lang="en">' + (qz ? (k === 'pct' ? qz.threshold + '%' : qz.need) : '') + '</b>'; });
    }
    if (rd.screen === 'r2') {
      set('mystTitle', c.mysteryTitle || '神秘描述');
      var mt = String(rd.mystery || '');
      set('mystText', mt);
      $('myst').classList.toggle('is-long', mt.length > 66);
    }
    if (qz) renderQuiz(qz, leader);
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

  // 最終揭曉: every phone gets the same public list (only cards the host has flipped carry a role / supporters)
  var finKey = '';
  function renderFinal(rd) {
    app.setAttribute('data-r', 'final');
    app.setAttribute('data-state', 'player');
    app.setAttribute('data-vote', 'none');
    set('tag', FT('tag')); set('rdTitle', FT('title')); set('againText', R('again'));
    if ($('desc').textContent !== FT('desc')) $('desc').textContent = FT('desc');
    var cards = ((rd.final && rd.final.cards) || []).filter(Boolean);
    var key = JSON.stringify(cards) + Object.keys(names).length;
    if (key === finKey) return;
    finKey = key;
    var el = $('fin');
    el.className = 'rd-fin abs n' + cards.length;
    el.innerHTML = cards.map(function (c) {
      var id = c.characterId, dx = window.wwyfSpriteDx ? wwyfSpriteDx(id) : 0, st = c.flipped ? c.role : 'hidden';
      var sup = c.supporters && c.supporters.length ? '<p class="rd-fin__sup">' + c.supporters.map(function (x) { return '<b>' + esc(names[x.characterId] || '') + '</b>'; }).join('、') + '</p>' : '';
      return '<div class="rd-fin__row is-' + st + '"><span class="rd-fin__c"><img alt="" src="' + img(id, 'stale1') + '" style="--dx:' + dx + '"></span>' +
        '<p class="rd-fin__n" lang="en">' + esc(names[id] || '') + '</p><span class="rd-fin__st">' + esc(c.flipped ? FT(c.role) : FT('hidden')) + '</span>' +
        (c.votes != null ? '<span class="rd-fin__v">' + (c.votes | 0) + ' 票</span>' : '') + sup + '</div>';
    }).join('');
  }

  // 結局: the public result (win / lose, X / N, %, each leader's count) + this phone's own line
  var endKey = '', endWaitT = 0;
  function renderEnding(rd) {
    var e = rd.ending, m = rd.mine || {};
    app.setAttribute('data-r', 'ending');
    app.setAttribute('data-state', 'player');
    app.setAttribute('data-vote', 'none');
    app.setAttribute('data-end', e ? (e.win ? 'win' : 'lose') : 'wait');
    set('tag', EN('tag'));
    set('rdTitle', e ? (e.win ? EN('winTitle') : EN('loseTitle')) : EN('phoneWaitTitle'));
    var line = e ? (e.win ? EN('winLine') : EN('loseLine')) : EN('phoneWait');
    if ($('desc').textContent !== line) $('desc').textContent = line;
    var key = JSON.stringify([e, m, Object.keys(names).length, !!T]);
    if (key === endKey) return;
    endKey = key;
    if (!e) { $('endLs').innerHTML = ''; return; }
    set('endLabel', EN('meterLabel'));
    set('endCount', fill(EN('count'), { x: e.x, n: e.n, p: e.pct }));
    set('endTgText', fill(EN('target'), { t: e.threshold }));
    $('endTg').style.left = Math.max(0, Math.min(100, e.threshold)) + '%';
    var fl = $('endFill');
    requestAnimationFrame(function () { fl.style.width = Math.max(0, Math.min(100, e.pct)) + '%'; });
    // personal line: leaders -> their own side's result; voters -> who they followed (only this phone's own choice)
    var me1 = '', cid = '';
    if (m.leader) { me1 = EN(m.leader === 'true' ? (m.won ? 'leaderTrueWin' : 'leaderTrueLose') : (m.won ? 'leaderFakeWin' : 'leaderFakeLose')) + '\n' + fill(EN('leaderVotes'), { n: m.votes | 0 }); cid = (last && last.player && last.player.characterId) || ''; }
    else if (m.voted) { me1 = m.true ? EN('mineTrue') : fill(EN('mineFake'), { name: names[m.voted] || '' }); cid = m.voted; }
    else me1 = EN('mineNone');
    $('endMe').className = 'rd-end__me' + (m.leader ? ' is-leader' : '') + (m.leader ? (m.won ? ' is-good' : ' is-bad') : m.voted ? (m.true ? ' is-good' : ' is-bad') : '');
    $('endMeC').innerHTML = cid ? '<img alt="" src="' + img(cid, 'stale1') + '" style="--dx:' + (window.wwyfSpriteDx ? wwyfSpriteDx(cid) : 0) + '">' : '';
    $('endMeC').hidden = !cid;
    set('endMeText', me1);
    var L = (e.leaders || []).filter(Boolean);
    $('endLs').className = 'rd-end__ls n' + L.length;
    $('endLs').innerHTML = L.map(function (l) {
      var id = l.characterId, dx = window.wwyfSpriteDx ? wwyfSpriteDx(id) : 0;
      return '<div class="rd-end__l is-' + (l.role === 'true' ? 'true' : 'fake') + '"><span class="rd-end__lc"><img alt="" src="' + img(id, 'stale1') + '" style="--dx:' + dx + '"></span>' +
        '<p class="rd-end__ln" lang="en">' + esc(names[id] || '') + '</p><span class="rd-end__lr">' + esc(l.role === 'true' ? EN('trueTag') : EN('fakeTag')) + '</span>' +
        '<span class="rd-end__lv">' + esc(fill(EN('votes'), { n: l.votes | 0 })) + '</span></div>';
    }).join('');
    set('endThx', EN('thanks'));
  }

  function renderQuiz(qz, leader) {
    var total = qz.total || 5, q = qz.q, st = qz.states || [];
    set('progLabel', Q('progress'));
    var dots = st.map(function (x, i) { return '<span class="rd-dot ' + x + '" lang="en">' + (x === 'ok' ? '✓' : i + 1) + '</span>'; }).join('');
    if ($('progDots').innerHTML !== dots) $('progDots').innerHTML = dots;
    set('progNote', qz.lost && !qz.unlocked ? Q('lost') : qz.unlocked ? Q('unlockedTitle') + ' ' + Q('unlocked') : fill(Q('progressNote'), { need: qz.need }));
    $('prog').classList.toggle('is-lost', !!qz.lost && !qz.unlocked);
    var box = $('quiz'), mode;
    if (q && q.open) mode = 'open';
    else if (qz.unlocked && qz.clue) mode = 'clue';
    else if (q && !q.open) mode = 'done';
    else mode = 'wait';
    box.setAttribute('data-q', mode);
    if (mode !== 'open') box.classList.remove('is-must');
    if (mode === 'clue') { set('clueTitle', Q('unlockedTitle')); set('clueBadge', Q('unlocked')); set('clueText', qz.clue); quizEnd = null; return; }
    var idx = q ? q.index : st.indexOf('none') < 0 ? total - 1 : st.indexOf('none');
    set('qBadge', fill(Q('qLabel'), { i: idx + 1, n: total }));
    if (mode === 'wait') { set('qText', fill(Q('waiting'), { i: idx + 1 })); set('qStatus', ''); $('qText').classList.remove('is-long'); quizEnd = null; optKey = ''; $('opts').innerHTML = ''; return; }
    set('qText', q.q); $('qText').classList.toggle('is-long', String(q.q).length > 26);
    var mine = pending != null && mode === 'open' ? pending : q.mine;
    var res = q.result, stEl = $('qStatus');
    if (mode === 'open') {
      quizEnd = q.remain != null ? Date.now() + q.remain : null;
      var must = !leader && qz.canAnswer && mine == null;   // 所有人都必須作答: emphasise until this phone has answered
      set('qStatus', leader ? Q('leader') : mine != null ? Q('answered') + ' ' + 'ABCD'[mine] : Q('must'));
      stEl.className = 'rd-quiz__st open' + (must ? ' must' : '');
      box.classList.toggle('is-must', must);
    } else {
      quizEnd = null;
      box.classList.remove('is-must');
      set('qStatus', res ? (res.success ? Q('ok') : Q('fail')) + ' ' + res.pct + '%' : Q('closed'));
      stEl.className = 'rd-quiz__st' + (res ? (res.success ? ' ok' : ' fail') : '');
    }
    var key = q.id + mode + mine + (q.answer == null ? '' : q.answer) + (leader ? 'L' : '') + q.options.join('|');
    if (key === optKey) return;
    optKey = key;
    var dis = leader || mode !== 'open' || !qz.canAnswer;
    $('opts').innerHTML = q.options.map(function (o, i) {
      var cl = 'rd-opt' + (mine === i ? ' is-mine' : '') + (q.answer === i ? ' is-right' : '') + (String(o).length > 8 ? ' is-long' : '');
      return '<button type="button" class="' + cl + '" data-i="' + i + '"' + (dis ? ' disabled' : '') + ' aria-pressed="' + (mine === i) + '"><i lang="en">' + 'ABCD'[i] + '</i><span>' + esc(o) + '</span></button>';
    }).join('');
  }

  function answer(i) {
    var rq = last && last.round && last.round.quiz && last.round.quiz.q;
    if (!rq || !rq.open) return;
    pending = i; optKey = ''; render();
    if (sending) return;
    sending = true;
    (function send() {
      var c = pending;
      WWYF.request('POST', '/quiz/answer', { index: rq.index, choice: c }, { 'X-Player-Id': me.id, 'X-Player-Token': me.token })
        .then(function (j) { if (last && last.round.quiz && last.round.quiz.q && last.round.quiz.q.index === j.index) last.round.quiz.q.mine = j.mine; })
        .catch(function (e) { if (!gone(e)) poll(); })
        .then(function () { if (pending !== c) return send(); sending = false; pending = null; optKey = ''; render(); });
    })();
  }
  $('opts').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.rd-opt');
    if (b && !b.disabled) answer(+b.getAttribute('data-i'));
  });

  // 發言 timer: ready (--:--) -> live (countdown) -> done (提問時間); counts down locally between polls
  function tick() {
    var sp = last && last.round && last.round.speak, S = R('speak');
    var qq = last && last.round && last.round.screen === 'r3' && last.round.quiz && last.round.quiz.q;
    if (qq && qq.open) {   // Round 3: while a question is open the pill + clock show the answering time
      var qr = quizEnd != null ? quizEnd - Date.now() : null;
      app.setAttribute('data-speak', 'live'); speakState = 'live';
      set('pillText', Q('open'));
      $('clock').classList.toggle('is-text', qr == null);
      set('clock', qr == null ? Q('unlimited') : mmss(qr)); set('clockLabel', Q('left'));
      document.querySelector('.rd-clock').classList.toggle('is-low', qr != null && qr <= 10000);
      if (qr != null && qr <= -1500) { quizEnd = null; poll(); }
      return;
    }
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
      // 結局: the TV is still counting -> poll again exactly when the result is due (one-shot)
      clearTimeout(endWaitT);
      var w = r.round.wait;
      if (w && w.in > 0) endWaitT = setTimeout(function () { poll(); }, w.in + 80);
      render();
    }).catch(function (e) { gone(e); }).then(function () { inflight = false; });
  }

  $('go').addEventListener('click', function () {
    if (this.disabled) return;
    window.location.href = '../vote/';
  });

  fetch('../data/texts.json?v=8', { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { if (d && (d.rounds || d.round)) { T = { rounds: d.rounds || {}, round: {}, quiz: d.quiz || {}, final: d.final || {}, ending: d.ending || {} }; for (var k in DEF.round) T.round[k] = (d.round && d.round[k]) || DEF.round[k]; } render(); })
    .catch(function () {});
  fetch('../data/characters.json?v=' + V, { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { ((d && d.characters) || []).forEach(function (c) { names[c.id] = c.name; }); rowKey = ''; finKey = ''; endKey = ''; render(); })
    .catch(function () {});
  if (window.WWYF_KNOCK) WWYF_KNOCK.init($('knockSlot'));

  poll();
  (function loop() {
    var fast = speakState === 'live' || !!(last && last.vote && last.vote.open) || !!(last && last.round && last.round.quiz && last.round.quiz.q && last.round.quiz.q.open);
    setTimeout(function () { if (!document.hidden) poll(); loop(); }, fast ? POLL_FAST : POLL_IDLE);
  })();
  setInterval(tick, 250);
  setInterval(function () { if (document.hidden) WWYF.heartbeat().catch(function () {}); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  window.WWYF_ROUND = { get state() { return { app: app.getAttribute('data-state'), speak: app.getAttribute('data-speak'), vote: app.getAttribute('data-vote'), r: app.getAttribute('data-r'), quiz: $('quiz').getAttribute('data-q'), me: last }; }, poll: poll };
})();
