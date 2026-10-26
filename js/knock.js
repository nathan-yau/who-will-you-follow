/* 私下敲門 (private knock) — shared by the identity and vote pages. Copy comes from data/texts.json.
   update(meResponse) after every /api/me poll:
   - r.knock   (真正領袖 only): { round, available, done, count } -> a 「私下敲門」 button (2-tap) or 「已敲門」 in the page's slot
   - r.knocked (knocked players only): [{ round, at }] -> a private 叩叩 card over the page until dismissed
   The server picks who gets knocked; the true leader never chooses (and by default never learns who). */
(function () {
  'use strict';
  var T = {
    knock: { button: '私下敲門', hint: '投票已結束，你可以私下敲門。', confirm: '再按一次確認敲門', done: '已敲門', doneHint: '你的敲門已經悄悄送出。', none: '這一輪沒有需要敲門的人。' },
    knocked: { title: '叩叩……', bodies: ['有人輕輕敲了你的門。再想想？'], note: '請保密，不要告訴其他人喔。', dismiss: '知道了' }
  };
  fetch('../data/texts.json?v=7', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (d) {
    ['knock', 'knocked'].forEach(function (k) { if (d && d[k]) for (var x in d[k]) if (typeof d[k][x] === 'string' || (Array.isArray(d[k][x]) && d[k][x].length)) T[k][x] = d[k][x]; });
    render(); renderModal();
  }).catch(function () {});

  var DOOR = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="11" y="5" width="26" height="39" rx="3" fill="#d9a66d" stroke="#5e3f26" stroke-width="2.6"/><rect x="15.5" y="10" width="17" height="13" rx="2" fill="#c18e58"/><rect x="15.5" y="27" width="17" height="12" rx="2" fill="#c18e58"/><circle cx="31" cy="26" r="2" fill="#5e3f26"/><path d="M41 12l4-3M42 19h4.5M41 26l4 3" stroke="#f2b83f" stroke-width="2.4" stroke-linecap="round"/></svg>';
  var slot = null, kn = null, inbox = [], dismissed = {}, armed = false, armT = 0, busy = false, modal = null;
  function $(id) { return document.getElementById(id); }

  function render() {
    if (!slot) return;
    var show = !!(kn && (kn.available || kn.done));
    slot.hidden = !show;
    slot.classList.toggle('is-on', show);
    if (!show) { slot.innerHTML = ''; return; }
    var key = (kn.available ? 'a' : 'd') + (armed ? '1' : '0') + (kn.count | 0) + JSON.stringify(T.knock);
    if (slot.dataset.k === key) return;
    slot.dataset.k = key;
    if (kn.available) {
      slot.innerHTML = '<button type="button" class="btn kn-btn' + (armed ? ' is-armed' : '') + '" id="knockBtn">' + DOOR +
        '<span class="btn__label">' + esc(armed ? T.knock.confirm : T.knock.button) + '</span></button>' +
        '<p class="kn-hint">' + esc(T.knock.hint) + '</p>';
      $('knockBtn').addEventListener('click', tap);
    } else {
      slot.innerHTML = '<p class="kn-done">' + DOOR + '<span>' + esc(T.knock.done) + '</span></p>' +
        '<p class="kn-hint">' + esc(kn.count ? T.knock.doneHint : T.knock.none) + '</p>';
    }
  }
  function tap() {
    if (busy || !kn || !kn.available) return;
    if (!armed) { armed = true; clearTimeout(armT); armT = setTimeout(function () { armed = false; render(); }, 3000); render(); return; }
    clearTimeout(armT); armed = false; busy = true;
    var b = $('knockBtn'); if (b) b.classList.add('is-busy');
    WWYF.request('POST', '/knock', {}, hdr()).then(function (r) {
      kn = { round: r.round, available: false, done: true, count: r.count };
      if (navigator.vibrate) { try { navigator.vibrate([10, 40, 10]); } catch (e) {} }
    }).catch(function () {}).then(function () { busy = false; slot.dataset.k = ''; render(); });
  }
  function hdr() { var p = WWYF.getPlayer(); return p ? { 'X-Player-Id': p.id, 'X-Player-Token': p.token } : {}; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* the private 叩叩 card: lives inside .cs-stage (absolute, no position:fixed), above everything on the page */
  function renderModal() {
    var k = null;
    for (var i = 0; i < inbox.length; i++) if (!dismissed[inbox[i].round + ':' + inbox[i].at]) { k = inbox[i]; break; }
    if (!k) { if (modal) { modal.classList.remove('is-on'); modal.hidden = true; } return; }
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'kn-modal';
      modal.id = 'knockModal';
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
      (document.querySelector('.cs-stage') || document.body).appendChild(modal);
    }
    var key = k.round + ':' + k.at + JSON.stringify(T.knocked);
    if (modal.dataset.k !== key) {
      modal.dataset.k = key;
      modal.innerHTML = '<div class="kn-card"><div class="kn-door">' + DOOR + '</div>' +
        '<p class="kn-title">' + esc(T.knocked.title) + '</p><p class="kn-body">' + esc(bodyFor(k)) + '</p>' +
        '<p class="kn-note">' + esc(T.knocked.note) + '</p>' +
        '<button type="button" class="btn cs-join kn-ok" id="knockOk"><span class="btn__label">' + esc(T.knocked.dismiss) + '</span></button></div>';
      modal.querySelector('#knockOk').addEventListener('click', function () {
        dismissed[k.round + ':' + k.at] = 1;
        WWYF.request('POST', '/knock-ack', { round: k.round }, hdr()).catch(function () {});
        renderModal();
      });
      if (navigator.vibrate) { try { navigator.vibrate([30, 80, 30]); } catch (e) {} }
    }
    modal.hidden = false; modal.classList.add('is-on');
  }

  // one of the (subtle) variants, stable for a given knock (same round + time -> same line on every reload)
  function bodyFor(k) {
    var b = T.knocked.bodies || [], h = 0, s = k.round + ':' + k.at;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return b.length ? b[Math.abs(h) % b.length] : '';
  }
  window.WWYF_KNOCK = {
    init: function (el) { slot = el; render(); },
    update: function (r) {
      kn = (r && r.knock) || null;
      if (kn && !kn.available) { armed = false; clearTimeout(armT); }
      inbox = (r && r.knocked) || [];
      render(); renderModal();
    },
    get state() { return { leader: kn, inbox: inbox, modal: !!(modal && !modal.hidden) }; }
  };
})();
