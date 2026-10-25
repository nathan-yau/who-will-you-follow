/* Shared API client. On Netlify the API is same-origin (/api); the GitHub Pages
   preview (github.io) calls the Netlify site directly (CORS is allowed there). */
(function () {
  'use strict';
  var NETLIFY = 'https://who-will-you-follow.netlify.app';
  var BASE = /\.github\.io$/.test(location.hostname) ? NETLIFY + '/api' : '/api';
  var PKEY = 'wwyf.player';

  function getPlayer() {
    try { var p = JSON.parse(localStorage.getItem(PKEY) || 'null'); return p && p.id && p.token ? p : null; } catch (e) { return null; }
  }
  function setPlayer(p) { try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) {} }
  function clearPlayer() { try { localStorage.removeItem(PKEY); } catch (e) {} }

  function request(method, path, data, headers) {
    var h = { 'Content-Type': 'application/json' };
    for (var k in headers || {}) h[k] = headers[k];
    return fetch(BASE + path, {
      method: method, headers: h, cache: 'no-store',
      body: method === 'GET' ? undefined : JSON.stringify(data || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || ('HTTP ' + r.status)); e.status = r.status; e.code = j.error; throw e; }
        return j;
      });
    });
  }
  function playerHeaders() {
    var p = getPlayer();
    return p ? { 'X-Player-Id': p.id, 'X-Player-Token': p.token } : {};
  }

  window.WWYF = {
    base: BASE,
    getPlayer: getPlayer, setPlayer: setPlayer, clearPlayer: clearPlayer,
    request: request,
    lobby: function () { return request('GET', '/lobby'); },
    join: function (characterId, nickname) {
      var body = { characterId: characterId };
      if (nickname !== undefined) body.nickname = nickname;
      return request('POST', '/join', body, playerHeaders()).then(function (r) {
        setPlayer({ id: r.player.id, token: r.token, characterId: r.player.characterId });
        return r;
      });
    },
    me: function () { return request('GET', '/me', null, playerHeaders()); },
    heartbeat: function () { return request('POST', '/heartbeat', {}, playerHeaders()); },
    admin: function (method, path, data) {
      var t = ''; try { t = localStorage.getItem('wwyf.admin') || ''; } catch (e) {}
      return request(method, '/admin/' + path, data, { 'X-Admin-Token': t });
    }
  };
})();
