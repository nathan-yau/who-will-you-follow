/* 即時連線 (Ably) for the lobby bubble battle — loaded by the lobby phone page and the TV.
   The Ably SDK is fetched from its CDN only when the server says realtime is wanted; the API key never
   reaches the browser: /api/rt-token returns a signed TokenRequest (phone: publish-only as its player id,
   TV: subscribe-only, both limited to this game's lobby channel).
   WWYF_RT.connect({ tv, onMessage(clientId, data), onState(state, reason) }) -> { publish(data), close() }
     state 'ready' = connected + channel attached; 'down' = give up (reason: sdk | token | connect | drop | quota).
   After 'down' the caller falls back to polling and may try again later with a fresh connect(). */
(function () {
  'use strict';
  var SDK = 'https://cdn.ably.com/lib/ably.min-2.js';
  var CONNECT_MS = 8000, DROP_MS = 4000;
  var loading = null;

  function loadSdk() {
    if (window.Ably && window.Ably.Realtime) return Promise.resolve(window.Ably);
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var el = document.createElement('script');
      el.src = SDK; el.async = true;
      el.onload = function () { if (window.Ably && window.Ably.Realtime) res(window.Ably); else { loading = null; rej(new Error('sdk')); } };
      el.onerror = function () { loading = null; el.remove(); rej(new Error('sdk')); };
      document.head.appendChild(el);
    });
    return loading;
  }
  function token(tv) { return WWYF.request('GET', '/rt-token' + (tv ? '?as=tv' : ''), null, tv ? {} : WWYF.playerHeaders()); }
  // Ably quota / rate limits: HTTP 429 or error codes 429xx (and account-limit messages)
  function isQuota(e) {
    if (!e) return false;
    var c = +e.code || 0, st = +e.statusCode || 0;
    return st === 429 || (c >= 42900 && c < 43000) || /limit|quota|exceeded/i.test(e.message || '');
  }
  function isToken(e) { var c = e && +e.code || 0; return c >= 40100 && c < 40200; }

  function connect(opt) {
    var dead = false, realtime = null, channel = null, ready = false, everReady = false, dropT = 0, connT = 0;
    function down(reason) {
      if (dead) return;
      dead = true; ready = false;
      clearTimeout(dropT); clearTimeout(connT);
      try { if (realtime) realtime.close(); } catch (e) {}
      opt.onState('down', reason);
    }
    function why(e, fallback) { return isQuota(e) ? 'quota' : isToken(e) ? 'token' : fallback; }
    connT = setTimeout(function () { if (!ready) down('connect'); }, CONNECT_MS);
    loadSdk().then(function (Ably) {
      if (dead) return;
      return token(opt.tv).then(function (first) {
        if (dead) return;
        var name = first.channel;
        realtime = new Ably.Realtime({
          // the first TokenRequest is already in hand; later renewals ask the server again
          authCallback: function (params, cb) {
            if (first) { var t = first.tokenRequest; first = null; cb(null, t); return; }
            token(opt.tv).then(function (r) { cb(null, r.tokenRequest); }, function (e) { cb(e && e.message || 'token', null); down('token'); });
          },
          echoMessages: false, autoConnect: true, closeOnUnload: true
        });
        realtime.connection.on(function (ch) {
          if (dead) return;
          var st = ch.current, err = ch.reason;
          if (st === 'connected') {
            clearTimeout(dropT); dropT = 0;
            if (ready) return;
            channel = channel || realtime.channels.get(name, { modes: [opt.tv ? 'SUBSCRIBE' : 'PUBLISH'] });   // = what the token allows
            var p = opt.tv ? channel.subscribe(function (m) { if (m && m.clientId) opt.onMessage(m.clientId, m.data); }) : channel.attach();
            Promise.resolve(p).then(function () {
              if (dead) return;
              ready = everReady = true; clearTimeout(connT);
              opt.onState('ready');
            }, function (e) { down(why(e, 'connect')); });
          } else if (st === 'failed') {
            down(why(err, everReady ? 'drop' : isToken(err) ? 'token' : 'connect'));
          } else if (st === 'suspended') {
            down(why(err, everReady ? 'drop' : 'connect'));
          } else if (st === 'disconnected' && !everReady && err && ((+err.code >= 40000 && +err.code < 50000) || (+err.statusCode >= 400 && +err.statusCode < 500))) {
            down(why(err, 'token'));          // Ably refused the token request (wrong key / app, bad signature, quota)
          } else if ((st === 'disconnected' || st === 'connecting') && everReady && !dropT) {
            if (isQuota(err)) return down('quota');
            ready = false;
            // a short blip is fine (the SDK reconnects); longer than DROP_MS -> polling fallback
            dropT = setTimeout(function () { down('drop'); }, DROP_MS);
          }
        });
      }, function (e) { down(e && e.status === 409 ? 'off' : 'token'); });
    }).catch(function () { down('sdk'); });

    return {
      isReady: function () { return ready && !dead; },
      publish: function (data) {
        if (!ready || dead || !channel) return Promise.reject(new Error('not_ready'));
        return Promise.resolve(channel.publish('in', data)).catch(function (e) {
          if (isQuota(e)) down('quota'); else if (e && (+e.code === 40160 || isToken(e))) down('token');
          throw e;
        });
      },
      close: function () { if (dead) return; dead = true; ready = false; clearTimeout(dropT); clearTimeout(connT); try { if (realtime) realtime.close(); } catch (e) {} }
    };
  }
  window.WWYF_RT = { connect: connect, SDK: SDK };
})();
