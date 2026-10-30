/* 身份揭曉 (identity reveal) — the player's phone.
   Reached from the lobby once the host starts the stage in admin (GET /api/me -> revealed: true).
   pre   : silhouette of the player's own character + 「揭曉我的身份」
   shown : role pill + description (texts from data/roles.json) + 「知道了」
   wait  : calm waiting screen + 「再看一次身份」 (the role stays viewable for the rest of the game)
   The role is only put into the DOM after the player taps 揭曉 (POST /api/reveal-ack). */
(function () {
  'use strict';
  var V = 6;  // character asset version
  var $ = function (id) { return document.getElementById(id); };
  var me = window.WWYF && WWYF.getPlayer();
  if (!me) { window.location.replace('../characters/'); return; }

  var app = $('app');
  var roles = {}, leaderLabel = '{name}', names = {};
  function nameOf(id) { return (names[id] && names[id].name) || ''; }
  var state = 'loading', role = null, supports = null, helped = false, charId = null;
  // ../identity/#card (再看一次身份 on the round page): open straight on the role card
  var review = window.location.hash === '#card', onRound = false;
  if (review && window.history && history.replaceState) history.replaceState(null, '', window.location.pathname + window.location.search);
  var ackSeq = 0;   // ignore /me answers that were requested before the latest 揭曉 tap

  var ICONS = {
    crown: '<svg viewBox="0 0 44 38"><path d="M5 12l8.5 7L22 5l8.5 14L39 12l-3.2 20.5H8.2Z" fill="#f2c14e" stroke="#5e3f26" stroke-width="2.6" stroke-linejoin="round"/><circle cx="18" cy="24" r="1.6" fill="#5e3f26"/><circle cx="26" cy="24" r="1.6" fill="#5e3f26"/><path d="M20 27.2q2 1.6 4 0" stroke="#5e3f26" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
    mask: '<svg viewBox="0 0 44 38"><path d="M4 11c6-3 12-3 18 1 6-4 12-4 18-1 0 10-4 18-10 18-4 0-6-4-8-4s-4 4-8 4C8 29 4 21 4 11Z" fill="#b99ad6" stroke="#5e3f26" stroke-width="2.6" stroke-linejoin="round"/><ellipse cx="14" cy="17" rx="3.6" ry="2.6" fill="#5e3f26"/><ellipse cx="30" cy="17" rx="3.6" ry="2.6" fill="#5e3f26"/></svg>',
    heart: '<svg viewBox="0 0 44 38"><path d="M22 33S5 23 5 13c0-5 3.6-8.5 8-8.5 3.8 0 6.8 2.4 9 5.6 2.2-3.2 5.2-5.6 9-5.6 4.4 0 8 3.5 8 8.5 0 10-17 20-17 20Z" fill="#ef9a8a" stroke="#5e3f26" stroke-width="2.6" stroke-linejoin="round"/><path d="M12 12.5c.6-2 2-3 3.6-3.2" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
    shield: '<svg viewBox="0 0 44 38"><path d="M22 3c5 3 10 4.4 15 4.6.4 13.4-4.6 23.4-15 27.9C11.6 31 6.6 21 7 7.6 12 7.4 17 6 22 3Z" fill="#8fb3d9" stroke="#5e3f26" stroke-width="2.6" stroke-linejoin="round"/><path d="M15.5 18.5l4.6 4.6 8.4-9" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    leaf: '<svg viewBox="0 0 44 38"><path d="M7 31C7 15 18 6 37 5c1 18-9 27-24 26Z" fill="#9cc58a" stroke="#5e3f26" stroke-width="2.6" stroke-linejoin="round"/><path d="M9 30C15 22 21 17 30 12" stroke="#5e3f26" stroke-width="2" stroke-linecap="round" fill="none"/></svg>'
  };
  // fallback if data/roles.json fails to load
  var DEFAULT = {
    '真正領袖': { icon: 'crown', color: '#f2c14e', desc: '你是真正的領袖！想辦法邀請其他玩家跟隨你。遊戲中有一個人知道你的身份，會暗中幫你。' },
    '假領袖': { icon: 'mask', color: '#b99ad6', desc: '' },
    '真領袖支持者': { icon: 'heart', color: '#ef9a8a', desc: '', ruleLine: '⚠️ 你可以幫佢拉票、暗示，但唔可以直接講出邊個係真領袖，亦唔可以俾人睇手機。' },
    '假領袖支持者': { icon: 'shield', color: '#8fb3d9', desc: '' },
    '平民': { icon: 'leaf', color: '#8db07c', desc: '' }
  };
  var LEADERS = ['真正領袖', '假領袖'];
  var SUPPORTERS = ['假領袖支持者', '真領袖支持者'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function img(id, f) { return '../assets/characters/' + encodeURIComponent(id) + '/' + f + '.webp?v=' + V; }

  function setChar(id) {
    if (!id || id === charId) return;
    charId = id;
    $('f1').src = img(id, 'stale1');
    $('f2').src = img(id, 'stale2');
    $('box').style.setProperty('--sil', 'url("' + img(id, 'stale1') + '")');
    $('box').style.setProperty('--dx', window.wwyfSpriteDx ? window.wwyfSpriteDx(id) : 0);
  }

  function fillRole() {
    var r = roles[role] || DEFAULT[role] || DEFAULT['平民'];
    $('pillIcon').innerHTML = ICONS[r.icon] || ICONS.leaf;
    $('roleName').textContent = r.name || role || '';
    $('pill').style.setProperty('--rc', r.color || '#f2c14e');
    var lb = $('roleLeader');
    // leaders: their own character NAME (never a letter)
    if (LEADERS.indexOf(role) >= 0 && nameOf(charId)) {
      lb.innerHTML = esc(leaderLabel).replace('{name}', '<b lang="en">' + esc(nameOf(charId)) + '</b>');
      lb.hidden = false;
    } else { lb.hidden = true; lb.textContent = ''; }
    // 假領袖: the helper line only when the server paired a 假領袖支持者 with this fake leader
    $('descText').textContent = (r.desc || '') + (role === '假領袖' && helped && r.helperLine ? r.helperLine : '');
    // 假領袖支持者 / 真領袖支持者: the one leader they back — identical line + art for both, so the layouts can't be told apart
    var sp = $('sup');
    if (SUPPORTERS.indexOf(role) >= 0 && supports) {
      var nm = nameOf(supports.characterId), lab = nm ? '<b lang="en">' + esc(nm) + '</b>' : '一位領袖';
      $('supText').innerHTML = esc(r.supportsLabel || (roles['假領袖支持者'] || {}).supportsLabel || '你支持：{name}').replace('{name}', lab);
      $('supImg').src = img(supports.characterId, 'stale1');
      sp.style.setProperty('--rc', r.color || '#8fb3d9');
      sp.hidden = false;
    } else { sp.hidden = true; $('supText').textContent = ''; $('supImg').removeAttribute('src'); }
    // 真領袖支持者 only: a one-line reminder of the rules (under the description)
    var rl = $('ruleText'), rule = role === '真領袖支持者' ? (r.ruleLine || DEFAULT['真領袖支持者'].ruleLine) : '';
    rl.textContent = rule; rl.hidden = !rule;
    fitDesc();
  }
  function clearRole() { $('pillIcon').innerHTML = ''; $('roleName').textContent = ''; $('roleLeader').hidden = true; $('descText').textContent = ''; $('sup').hidden = true; $('supText').textContent = ''; $('supImg').removeAttribute('src'); $('ruleText').hidden = true; $('ruleText').textContent = ''; }
  function take(r) {
    var key = JSON.stringify([r.role, r.supports || null, !!r.helped]);
    role = r.role || '平民'; supports = r.supports || null; helped = !!r.helped;
    var changed = key !== roleKey; roleKey = key; return changed;
  }
  var roleKey = '';
  // long (owner-edited) descriptions shrink to fit the box
  function fitDesc() {
    var box = $('desc'), p = $('descText'), fs = 16.4;
    p.style.setProperty('--fs', fs);
    if (app.getAttribute('data-state') !== 'shown') return;
    var cs = getComputedStyle(box), pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), gap = parseFloat(cs.rowGap) || 0;
    var over = function () { var h = 0, n = 0; for (var c = box.firstElementChild; c; c = c.nextElementSibling) if (!c.hidden) { h += c.offsetHeight; n++; } return h + gap * Math.max(0, n - 1) > box.clientHeight - pad + 1; };
    while (fs > 12 && over()) { fs -= 0.6; p.style.setProperty('--fs', fs.toFixed(1)); }
  }

  var fxT = 0, clrT = 0;
  function setState(s, fx) {
    // the role only lives in the DOM while it is on screen (cleared after the fade-out)
    clearTimeout(clrT);
    if (s !== 'shown') { if (state === 'shown') clrT = setTimeout(function () { if (state !== 'shown') clearRole(); }, 450); else clearRole(); }
    state = s;
    app.classList.remove('is-flip', 'is-pop');
    if (fx) { void app.offsetWidth; app.classList.add(fx); clearTimeout(fxT); fxT = setTimeout(function () { app.classList.remove(fx); }, 1500); }
    app.setAttribute('data-state', s);
    if (s === 'shown') { fillRole(); }
    if (fx === 'is-flip') burst();
  }
  function burst() {
    var b = $('burst'); b.innerHTML = '';
    for (var i = 0; i < 12; i++) {
      var a = (i / 12) * Math.PI * 2 + Math.random() * 0.3, d = 110 + Math.random() * 50;
      var e = document.createElement('i');
      e.style.setProperty('--dx', 'calc(' + (Math.cos(a) * d).toFixed(1) + ' * var(--U))');
      e.style.setProperty('--dy', 'calc(' + (Math.sin(a) * d).toFixed(1) + ' * var(--U))');
      e.style.animationDelay = (0.3 + Math.random() * 0.12).toFixed(2) + 's';
      b.appendChild(e);
    }
    setTimeout(function () { b.innerHTML = ''; }, 1600);
  }
  function err(msg) { $('err').textContent = msg || ''; }

  function gone(e) {
    if (e && (e.status === 404 || e.status === 401)) { WWYF.clearPlayer(); window.location.replace('../characters/?removed=1'); return true; }
    return false;
  }

  function poll() {
    var ackAt = ackSeq;
    return WWYF.me().then(function (r) {
      setChar(r.player.characterId);
      if (r.player.characterId !== me.characterId) { me.characterId = r.player.characterId; WWYF.setPlayer(me); }
      if (!r.revealed) { window.location.replace('../lobby/'); return; }
      onRound = !!r.round;
      // 私下敲門 / 叩叩 live only on that round's vote page
      if (r.seen && state !== 'shown' && ((r.knock && r.knock.available) || (r.knocked && r.knocked.length))) { window.location.replace('../vote/'); return; }
      // the TV is on a round screen: the round page (it has the 「前往投票」 button; nothing auto-jumps to the vote).
      // Re-viewing from the round page (#card) shows the card and 知道了 goes back.
      if (r.seen && r.round && state !== 'shown' && !(review && (state === 'loading'))) { window.location.replace('../round/'); return; }
      // a vote opened while the TV is not on a round screen: go vote (only once this player has seen their identity)
      if (r.seen && !r.round && r.vote && r.vote.open && state !== 'shown') { window.location.replace('../vote/'); return; }
      if (ackAt !== ackSeq || busy) return;   // a 揭曉 tap happened meanwhile: its answer wins
      if (!r.seen) {                           // first time, or the host changed this player's role
        role = null; supports = null; helped = false; roleKey = '';
        if (state !== 'pre') setState('pre');
        return;
      }
      var changed = take(r);
      if (review && state === 'loading') { review = false; setState('shown', 'is-pop'); return; }
      if (state === 'pre' || state === 'loading') setState('wait');
      else if (state === 'shown' && changed) fillRole();
    }).catch(function (e) { gone(e); });
  }

  var busy = false;
  $('reveal').addEventListener('click', function () {
    if (busy || state !== 'pre') return;
    var b = this; busy = true; b.classList.add('is-busy'); err('');
    ackSeq++;
    WWYF.revealAck().then(function (r) {
      take(r);
      setState('shown', 'is-flip');
      if (navigator.vibrate) { try { navigator.vibrate([12, 60, 24]); } catch (e) {} }
    }).catch(function (e) {
      if (gone(e)) return;
      if (e.status === 409) { window.location.replace('../lobby/'); return; }
      err('連線不穩，請再按一次');
    }).then(function () { busy = false; b.classList.remove('is-busy'); });
  });
  $('ok').addEventListener('click', function () {
    if (state !== 'shown') return;
    if (onRound) { window.location.replace('../round/'); return; }
    setState('wait');
  });
  $('again').addEventListener('click', function () { if (state === 'wait' && role) setState('shown', 'is-pop'); });

  fetch('../data/characters.json', { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { ((d && d.characters) || []).forEach(function (c) { names[c.id] = c; }); if (state === 'shown') fillRole(); })
    .catch(function () {});
  fetch('../data/roles.json?v=4', { cache: 'no-cache' }).then(function (r) { return r.json(); })
    .then(function (d) { roles = (d && d.roles) || {}; if (d && d.leaderLabel) leaderLabel = d.leaderLabel; if (state === 'shown') fillRole(); })
    .catch(function () {});
  window.addEventListener('resize', fitDesc);

  setChar(me.characterId);
  poll();
  setInterval(function () { if (!document.hidden) poll(); }, 3000);
  setInterval(function () { if (document.hidden) WWYF.heartbeat().catch(function () {}); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
