/* Character Select: everything is rendered from data/characters.json
   ({ characters: [{ id, name, tagline }] }); image paths come from the id.
   Taken characters come from the backend (/api/lobby) and are locked. */
(function () {
  'use strict';
  var V = 6;            // sprite / json cache-bust
  var PER_PAGE = 5;
  var KEY = 'wwyf.character';
  var POLL_MS = 4000;
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    f1: $('f1'), f2: $('f2'), sprite: $('sprite'), name: $('name'), nameText: $('nameText'),
    tagline: $('tagline'), row: $('thumbRow'), thumbs: $('thumbs'), dots: $('dots'),
    prev: $('prev'), next: $('next'), join: $('join'), heroHit: $('heroHit'), toast: $('toast')
  };
  var list = [];
  var sel = 0;          // selected index
  var page = 0;         // thumbnail page shown
  var taken = {};       // characterId -> true (taken by someone else)
  var joining = false;

  function img(id, frame) { return '../assets/characters/' + encodeURIComponent(id) + '/' + frame + '.webp?v=' + V; }
  function pages() { return Math.max(1, Math.ceil(list.length / PER_PAGE)); }
  function store(id) { try { localStorage.setItem(KEY, id); } catch (e) {} }
  function load() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function isTaken(i) { return !!(list[i] && taken[list[i].id]); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 2600);
  }

  function preload(i) {
    var c = list[(i + list.length) % list.length];
    if (!c) return;
    [img(c.id, 'stale1'), img(c.id, 'stale2')].forEach(function (u) { var im = new Image(); im.src = u; });
  }

  function renderHero(animate) {
    var c = list[sel];
    els.f1.src = img(c.id, 'stale1');
    els.f2.src = img(c.id, 'stale2');
    els.f1.alt = c.name;
    if (animate) {
      els.sprite.classList.remove('pop'); void els.sprite.offsetWidth; els.sprite.classList.add('pop');
      [els.name, els.tagline].forEach(function (e) { e.classList.add('out'); });
      setTimeout(function () {
        els.nameText.textContent = c.name; els.tagline.textContent = c.tagline || '';
        [els.name, els.tagline].forEach(function (e) { e.classList.remove('out'); });
      }, 140);
    } else {
      els.nameText.textContent = c.name; els.tagline.textContent = c.tagline || '';
    }
    preload(sel + 1); preload(sel - 1);
  }

  function renderThumbs(dir) {
    var start = page * PER_PAGE;
    var html = '';
    for (var k = 0; k < PER_PAGE && start + k < list.length; k++) {
      var i = start + k, c = list[i], t = isTaken(i);
      html += '<button class="thumb' + (t ? ' taken' : '') + '" type="button" style="--i:' + k + '" data-i="' + i + '" aria-pressed="' + (i === sel) + '"' +
        (t ? ' aria-disabled="true"' : '') + ' aria-label="' + esc(c.name) + (t ? '（已被選）' : '') + '"><img src="' + img(c.id, 'stale1') +
        '" alt="" draggable="false" />' + (t ? '<span class="thumb__lock" aria-hidden="true">已被選</span>' : '') + '</button>';
    }
    els.row.innerHTML = html;
    if (dir) {
      els.row.classList.add(dir > 0 ? 'enter-r' : 'enter-l');
      void els.row.offsetWidth;
      els.row.classList.remove('enter-r', 'enter-l');
    }
    var d = '';
    for (var p = 0; p < pages(); p++) {
      d += '<button class="dot" type="button" data-p="' + p + '" aria-label="第 ' + (p + 1) + ' 頁 Page ' + (p + 1) + '"' +
        (p === page ? ' aria-current="true"' : '') + '></button>';
    }
    els.dots.innerHTML = d;
  }

  function markSelected() {
    var bs = els.row.querySelectorAll('.thumb');
    for (var j = 0; j < bs.length; j++) bs[j].setAttribute('aria-pressed', String(+bs[j].getAttribute('data-i') === sel));
  }

  /** next free index from i in direction dir (i itself included); -1 if all taken */
  function freeFrom(i, dir) {
    var n = list.length;
    for (var k = 0; k < n; k++) { var j = (((i + dir * k) % n) + n) % n; if (!isTaken(j)) return j; }
    return -1;
  }

  function select(i, opts) {
    var n = list.length; if (!n) return;
    var dir = opts && opts.dir || 0;
    i = ((i % n) + n) % n;
    if (isTaken(i)) {
      if (!dir) { toast('「' + list[i].name + '」已被其他玩家選走了'); return; }
      i = freeFrom(i, dir);
      if (i < 0) { toast('所有角色都已被選走了'); return; }
    }
    var changed = i !== sel;
    if (!dir) dir = i > sel ? 1 : -1;
    sel = i;
    store(list[sel].id);
    var p = Math.floor(sel / PER_PAGE);
    if (p !== page) { page = p; renderThumbs(dir); } else { markSelected(); }
    if (changed || (opts && opts.force)) renderHero(true);
  }

  function goPage(p, dir) {
    var n = pages();
    p = ((p % n) + n) % n;
    if (p === page) return;
    page = p;
    renderThumbs(dir || 1);
  }

  /* horizontal swipe (pointer events; vertical scrolling is disabled on this page) */
  function swipe(el, onLeft, onRight) {
    var x0 = null, y0 = 0, t0 = 0, id = null;
    el.addEventListener('pointerdown', function (e) { x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); id = e.pointerId; });
    el.addEventListener('pointerup', function (e) {
      if (x0 === null || e.pointerId !== id) return;
      var dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
      if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.2 && Date.now() - t0 < 900) {
        el.dataset.swiped = '1'; setTimeout(function () { delete el.dataset.swiped; }, 50);
        if (dx < 0) onLeft(); else onRight();
      }
    });
    el.addEventListener('pointercancel', function () { x0 = null; });
  }

  /* ---- backend: taken characters ---- */
  function applyTaken(ids) {
    var me = window.WWYF && WWYF.getPlayer();
    var next = {};
    (ids || []).forEach(function (id) { if (!me || id !== me.characterId) next[id] = true; });
    var same = Object.keys(next).sort().join() === Object.keys(taken).sort().join();
    taken = next;
    if (!list.length) return;
    if (isTaken(sel)) {
      var j = freeFrom(sel, 1);
      if (j >= 0) {
        var name = list[sel].name;
        select(j, { dir: 1 });
        toast('「' + name + '」已被選走，已為你換成「' + list[sel].name + '」');
      }
      renderThumbs(0);
    } else if (!same) {
      renderThumbs(0);
    }
  }
  function refreshLobby() {
    if (!window.WWYF) return Promise.resolve();
    return WWYF.lobby().then(function (r) { applyTaken(r.taken); }).catch(function () {});
  }

  function doJoin() {
    if (joining || !list[sel]) return;
    if (isTaken(sel)) { toast('這個角色已被選走了，請選擇其他角色'); return; }
    var c = list[sel];
    store(c.id);
    joining = true;
    els.join.classList.add('is-busy');
    els.join.setAttribute('aria-busy', 'true');
    WWYF.join(c.id).then(function () {
      window.location.href = '../lobby/';
    }).catch(function (e) {
      joining = false;
      els.join.classList.remove('is-busy');
      els.join.removeAttribute('aria-busy');
      if (e.status === 409) {
        toast('哎呀！「' + c.name + '」剛剛被其他玩家選走了，請換一個角色');
        refreshLobby();
      } else if (e.status === 404 || e.status === 401) {
        WWYF.clearPlayer();   // stale token after a reset: try again as a new player
        toast('請再按一次「加入遊戲」');
      } else {
        toast('連線失敗，請稍後再試');
      }
    });
  }

  function bind() {
    els.prev.addEventListener('click', function () { select(sel - 1, { dir: -1 }); });
    els.next.addEventListener('click', function () { select(sel + 1, { dir: 1 }); });
    els.row.addEventListener('click', function (e) {
      if (els.thumbs.dataset.swiped) return;
      var b = e.target.closest('.thumb'); if (!b) return;
      select(+b.getAttribute('data-i'));
    });
    els.dots.addEventListener('click', function (e) {
      var b = e.target.closest('.dot'); if (!b) return;
      var p = +b.getAttribute('data-p'); goPage(p, p > page ? 1 : -1);
    });
    swipe(els.heroHit, function () { select(sel + 1, { dir: 1 }); }, function () { select(sel - 1, { dir: -1 }); });
    swipe(els.thumbs, function () { goPage(page + 1, 1); }, function () { goPage(page - 1, -1); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') select(sel + 1, { dir: 1 });
      else if (e.key === 'ArrowLeft') select(sel - 1, { dir: -1 });
    });
    els.join.addEventListener('click', doJoin);
    setInterval(function () { if (!document.hidden && !joining) refreshLobby(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshLobby(); });
  }

  var lobbyP = refreshLobby();
  fetch('../data/characters.json?v=' + V, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) {
      list = (data && data.characters || []).filter(function (c) { return c && c.id; });
      if (!list.length) return;
      var me = window.WWYF && WWYF.getPlayer();
      var saved = (me && me.characterId) || load(), i = 0;
      for (var k = 0; k < list.length; k++) if (list[k].id === saved) { i = k; break; }
      sel = i; page = Math.floor(sel / PER_PAGE);
      renderThumbs(0);
      renderHero(false);
      bind();
      lobbyP.then(function () { applyTaken(Object.keys(taken)); });
      if (/[?&]removed=1/.test(location.search)) setTimeout(function () { toast('你已離開遊戲，請重新選擇角色加入'); }, 300);
    })
    .catch(function (err) { console.error('characters.json', err); });
})();
