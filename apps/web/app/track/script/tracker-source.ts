/**
 * Milestone 3.1D/3.2E — the browser tracking script's actual source, as a
 * plain-JavaScript string constant. This file is TypeScript; the STRING
 * VALUE it exports is not. GET /track/script (route.ts) serves this
 * string byte-for-byte as the response body.
 *
 * Why a string constant rather than a real ES module: the served script
 * must be standalone, browser-executable JavaScript with zero import/
 * export/type syntax, loadable via a plain <script src> tag on an
 * arbitrary third-party page with no bundler on either side (3.1D design
 * resolution audit, Section 2). This repository has no bundler-as-a-
 * dependency for producing that from a real TypeScript module without
 * adding one — so the script is hand-authored once, here, as its own
 * self-contained IIFE, in plain ES5-style syntax (var/function, no
 * arrow functions/const/let/template literals) for maximum runtime
 * compatibility without a transpilation step. This is also the single
 * source of truth: nothing in packages/* or elsewhere in apps/web
 * duplicates this logic — it is tested directly (byte-identical to what
 * ships) by executing this exact string inside a Node vm sandbox with
 * hand-written browser-API stubs (apps/web/tests/track-script-*.test.ts).
 *
 * Global name: "aiRevenueOsTracker" — chosen final, not left undecided.
 * Storage keys are namespaced under "aiRevenueOsTracking." — never
 * generic names like "anonymousId"/"sessionId"/"consent" (Design
 * Resolution Audit Section 8).
 *
 * Optional pre-load queue snippet an installer may place BEFORE the
 * <script src="..." async> tag if they want calls queued before the
 * real script loads (not required for normal operation):
 *
 *   window.aiRevenueOsTracker = window.aiRevenueOsTracker || { q: [],
 *     consent: function (s) { this.q.push(["consent", s]); },
 *     track: function (e, f) { this.q.push(["track", e, f]); },
 *     identify: function (a) { this.q.push(["identify", a]); } };
 *
 * The real script detects that shape (an object with a `.q` array and
 * no __aiRevenueOsInitialized marker), replays its queued commands in
 * order (each at most once, capped at MAX_QUEUE_REPLAY), then replaces
 * the global with the real API.
 */

export const TRACKER_GLOBAL_NAME = "aiRevenueOsTracker";

export const TRACKER_SCRIPT_SOURCE = `
(function () {
  'use strict';

  var GLOBAL_NAME = 'aiRevenueOsTracker';
  var w = window;

  // Duplicate real-script-execution guard — must be the very first thing
  // this IIFE does. If the real script already initialized on this page,
  // every subsequent execution (e.g. the script tag included twice) is a
  // complete no-op: no second bootstrap, no second storage read, no
  // second automatic pageview, no second queue replay.
  if (w[GLOBAL_NAME] && w[GLOBAL_NAME].__aiRevenueOsInitialized === true) {
    return;
  }

  var KEY_PREFIX = 'aiRevenueOsTracking.';
  var KEY_ANON_ID = KEY_PREFIX + 'anonymousId';
  var KEY_GRANTED = KEY_PREFIX + 'consentGranted';
  var KEY_SESSION_ID = KEY_PREFIX + 'sessionId';
  var KEY_LANDING = KEY_PREFIX + 'landingPage';
  var KEY_UTM = KEY_PREFIX + 'utm';

  var MAX_QUEUE_REPLAY = 50;
  var MAX_UTM_LEN = 255;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var ALLOWED_TRACK_EVENTS = { click: true, form_submit: true };

  function isValidUuid(v) {
    return typeof v === 'string' && UUID_RE.test(v);
  }

  // ---- storage adapter: every access guarded, never throws outward ----

  function getStorageHandle(kind) {
    try {
      var s = kind === 'local' ? w.localStorage : w.sessionStorage;
      if (!s) return null;
      var probeKey = '__aiRevenueOsStorageProbe__';
      s.setItem(probeKey, '1');
      s.removeItem(probeKey);
      return s;
    } catch (e) {
      return null;
    }
  }

  function storageGet(kind, key) {
    var s = getStorageHandle(kind);
    if (!s) return null;
    try {
      var v = s.getItem(key);
      return typeof v === 'string' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function storageSet(kind, key, value) {
    var s = getStorageHandle(kind);
    if (!s) return false;
    try {
      s.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageRemove(kind, key) {
    var s = getStorageHandle(kind);
    if (!s) return;
    try {
      s.removeItem(key);
    } catch (e) {
      // ignored — nothing further to do if removal itself throws.
    }
  }

  // ---- identity generation: browser-native only, no fingerprinting ----

  function safeRandomUuid() {
    try {
      if (w.crypto && typeof w.crypto.randomUUID === 'function') {
        var id = w.crypto.randomUUID();
        if (isValidUuid(id)) return id;
      }
    } catch (e) {
      // fall through to null — no alternate generation strategy is used.
    }
    return null;
  }

  // ---- URL / referrer / UTM sanitization ----

  function currentSanitizedUrl() {
    try {
      return w.location.origin + w.location.pathname;
    } catch (e) {
      return null;
    }
  }

  function sanitizedReferrer() {
    try {
      var ref = w.document.referrer;
      if (!ref) return undefined;
      var u = new w.URL(ref);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
      return u.origin + u.pathname;
    } catch (e) {
      return undefined;
    }
  }

  function extractApprovedUtm() {
    var result = {};
    try {
      var params = new w.URL(w.location.href).searchParams;
      var map = [
        ['utm_source', 'utmSource'],
        ['utm_medium', 'utmMedium'],
        ['utm_campaign', 'utmCampaign']
      ];
      for (var i = 0; i < map.length; i++) {
        var raw = params.get(map[i][0]);
        if (typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_UTM_LEN) {
          result[map[i][1]] = raw;
        }
      }
    } catch (e) {
      // ignored — no UTM captured for this page.
    }
    return result;
  }

  // ---- installation contract: site key + platform origin from the
  // executing <script> element itself, never from the host page's own
  // location/origin (that would be the customer's origin, not the
  // platform's — collect/consent calls must always target the origin
  // this script itself was loaded from). ----

  function getCurrentScriptEl() {
    try {
      return w.document.currentScript || null;
    } catch (e) {
      return null;
    }
  }

  function deriveSiteKey(scriptEl) {
    try {
      if (!scriptEl) return null;
      var v = scriptEl.getAttribute('data-site-key');
      return isValidUuid(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  function derivePlatformOrigin(scriptEl) {
    try {
      if (!scriptEl || !scriptEl.src) return null;
      var u = new w.URL(scriptEl.src);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch (e) {
      return null;
    }
  }

  var scriptEl = getCurrentScriptEl();
  var siteKey = deriveSiteKey(scriptEl);
  var platformOrigin = derivePlatformOrigin(scriptEl);
  // Missing/malformed site key or an undetermined platform origin ->
  // permanently inert for this page load: no network request is ever
  // constructed, consent()/track() remain safe no-ops, nothing throws
  // into the host page.
  var inert = !siteKey || !platformOrigin;

  var state = {
    granted: false,
    anonymousId: null,
    anonymousSessionId: null,
    landingPage: null,
    utm: {}
  };
  var autoPageviewSent = false;
  var backoffUntil = 0;

  function nowMs() {
    try {
      return Date.now();
    } catch (e) {
      return 0;
    }
  }

  function parseRetryAfterSeconds(value) {
    if (typeof value !== 'string' || value.length === 0) return 60;
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 60;
    // Defensive bound: never suppress sends for more than one hour
    // client-side no matter what a response header claims.
    return Math.min(n, 3600);
  }

  function postJson(path, body) {
    if (inert) return;
    if (nowMs() < backoffUntil) return;
    try {
      w.fetch(platformOrigin + path, {
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (res) {
        if (res && res.status === 429) {
          var retryAfter = null;
          try {
            retryAfter = res.headers.get('Retry-After');
          } catch (e) {
            retryAfter = null;
          }
          backoffUntil = nowMs() + parseRetryAfterSeconds(retryAfter) * 1000;
        }
      }).catch(function () {
        // network failure -> drop, no retry.
      });
    } catch (e) {
      // fetch threw synchronously (e.g. unavailable) -> drop, no retry.
    }
  }

  function sendCollect(eventType, extra) {
    if (!state.granted || !state.anonymousId || !state.anonymousSessionId) return;
    var body = {
      siteKey: siteKey,
      anonymousId: state.anonymousId,
      anonymousSessionId: state.anonymousSessionId,
      eventType: eventType
    };
    var url = currentSanitizedUrl();
    if (url) body.url = url;
    var ref = sanitizedReferrer();
    if (ref !== undefined) body.referrer = ref;
    if (state.landingPage) body.landingPage = state.landingPage;
    if (state.utm.utmSource) body.utmSource = state.utm.utmSource;
    if (state.utm.utmMedium) body.utmMedium = state.utm.utmMedium;
    if (state.utm.utmCampaign) body.utmCampaign = state.utm.utmCampaign;
    if (extra && typeof extra === 'object' && extra.metadata !== undefined) {
      body.metadata = extra.metadata;
    }
    postJson('/track/collect', body);
  }

  function sendConsentRequest(anonymousId, status) {
    postJson('/track/consent', { siteKey: siteKey, anonymousId: anonymousId, status: status });
  }

  function ensureIdentity() {
    if (!state.anonymousId) state.anonymousId = safeRandomUuid();
    if (!state.anonymousSessionId) state.anonymousSessionId = safeRandomUuid();
  }

  function initializeSessionAttribution() {
    if (!state.landingPage) {
      var landing = currentSanitizedUrl();
      if (landing) state.landingPage = landing;
    }
    if (!state.utm || Object.keys(state.utm).length === 0) {
      state.utm = extractApprovedUtm();
    }
  }

  function persistGrantedState() {
    if (state.anonymousId) storageSet('local', KEY_ANON_ID, state.anonymousId);
    if (state.anonymousSessionId) storageSet('session', KEY_SESSION_ID, state.anonymousSessionId);
    storageSet('local', KEY_GRANTED, '1');
    if (state.landingPage) storageSet('session', KEY_LANDING, state.landingPage);
    try {
      storageSet('session', KEY_UTM, JSON.stringify(state.utm));
    } catch (e) {
      // ignored — attribution simply isn't persisted this time.
    }
  }

  function grant() {
    if (inert) return;
    if (state.granted) return; // repeated grant: no-op beyond current state.
    ensureIdentity();
    if (!state.anonymousId || !state.anonymousSessionId) return; // crypto unavailable.
    initializeSessionAttribution();
    persistGrantedState();
    state.granted = true;
    sendConsentRequest(state.anonymousId, 'granted');
    if (!autoPageviewSent) {
      autoPageviewSent = true;
      sendCollect('pageview');
    }
  }

  function withdraw() {
    if (inert) return;
    // Not currently granted -> nothing to withdraw, a pure no-op. Note
    // state.anonymousId may already be non-null here (pre-consent
    // identity is generated in memory at bootstrap) -- granted state
    // alone is the correct signal, not identifier presence.
    if (!state.granted) return;
    var idToSend = state.anonymousId;
    // Synchronous disable BEFORE any network I/O — nothing sent after
    // this line can race ahead of collection being turned off.
    state.granted = false;
    if (idToSend) {
      sendConsentRequest(idToSend, 'withdrawn');
    }
    storageRemove('local', KEY_ANON_ID);
    storageRemove('local', KEY_GRANTED);
    storageRemove('session', KEY_SESSION_ID);
    storageRemove('session', KEY_LANDING);
    storageRemove('session', KEY_UTM);
    state.anonymousId = null;
    state.anonymousSessionId = null;
    state.landingPage = null;
    state.utm = {};
  }

  function consent(status) {
    if (status === 'granted') {
      grant();
    } else if (status === 'withdrawn') {
      withdraw();
    }
    // any other value: dropped silently, invalid.
  }

  function track(eventType, fields) {
    if (inert) return;
    if (typeof eventType !== 'string' || !ALLOWED_TRACK_EVENTS[eventType]) return;
    if (!state.granted) return;
    var extra;
    if (
      fields &&
      typeof fields === 'object' &&
      !Array.isArray(fields) &&
      Object.prototype.hasOwnProperty.call(fields, 'metadata')
    ) {
      extra = { metadata: fields.metadata };
    }
    sendCollect(eventType, extra);
  }

  function identify(assertion) {
    // Milestone 3.2E. The tracker never parses, verifies, or interprets
    // the assertion in any way -- it is an opaque string obtained by the
    // host page from the customer's own trusted backend (out of band,
    // never via this script) and relayed verbatim to POST /track/identify.
    // Never persisted anywhere (no storage key exists for it, unlike
    // anonymousId/consent state) -- it lives only as this function's own
    // parameter and the body of the one fetch call below, then is
    // discarded. Gated on granted consent exactly like track() -- fails
    // closed without a network request otherwise.
    if (inert) return;
    if (typeof assertion !== 'string' || assertion.length === 0) return;
    if (!state.granted || !state.anonymousId) return;
    postJson('/track/identify', { siteKey: siteKey, anonymousId: state.anonymousId, assertion: assertion });
  }

  function processCommand(cmd) {
    try {
      if (!cmd || typeof cmd.length !== 'number' || cmd.length < 1) return;
      var name = cmd[0];
      if (name === 'consent') {
        consent(cmd[1]);
      } else if (name === 'track') {
        track(cmd[1], cmd[2]);
      } else if (name === 'identify') {
        identify(cmd[1]);
      }
      // any other command name is dropped as invalid.
    } catch (e) {
      // a malformed queued command must never throw into the host page.
    }
  }

  // ---- capture any pre-load shim's queued commands, bounded ----
  var existingGlobal = w[GLOBAL_NAME];
  var queuedCommands = [];
  if (existingGlobal && typeof existingGlobal === 'object' && !existingGlobal.__aiRevenueOsInitialized && existingGlobal.q) {
    try {
      var q = existingGlobal.q;
      if (q && typeof q.length === 'number') {
        for (var qi = 0; qi < q.length && queuedCommands.length < MAX_QUEUE_REPLAY; qi++) {
          queuedCommands.push(q[qi]);
        }
      }
    } catch (e) {
      queuedCommands = [];
    }
  }

  // ---- bootstrap ----
  if (!inert) {
    var persistedGranted = storageGet('local', KEY_GRANTED) === '1';
    if (persistedGranted) {
      var storedAnonId = storageGet('local', KEY_ANON_ID);
      state.anonymousId = isValidUuid(storedAnonId) ? storedAnonId : safeRandomUuid();
      var storedSessionId = storageGet('session', KEY_SESSION_ID);
      state.anonymousSessionId = isValidUuid(storedSessionId) ? storedSessionId : safeRandomUuid();
      var storedLanding = storageGet('session', KEY_LANDING);
      state.landingPage = storedLanding || currentSanitizedUrl();
      var storedUtmRaw = storageGet('session', KEY_UTM);
      var storedUtm = null;
      if (storedUtmRaw) {
        try {
          storedUtm = JSON.parse(storedUtmRaw);
        } catch (e) {
          storedUtm = null;
        }
      }
      state.utm = storedUtm && typeof storedUtm === 'object' ? storedUtm : extractApprovedUtm();
      if (state.anonymousId && state.anonymousSessionId) {
        persistGrantedState(); // self-heals any partially-missing storage.
        state.granted = true;
        if (!autoPageviewSent) {
          autoPageviewSent = true;
          sendCollect('pageview');
        }
      }
    } else {
      ensureIdentity(); // memory-only; nothing persisted, nothing sent.
    }
  }

  w[GLOBAL_NAME] = {
    __aiRevenueOsInitialized: true,
    consent: consent,
    track: track,
    identify: identify
  };

  for (var ci = 0; ci < queuedCommands.length; ci++) {
    processCommand(queuedCommands[ci]);
  }
})();
`;
