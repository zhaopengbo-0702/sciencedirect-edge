'use strict';

// Cloudflare Faker engine for ScienceDirect-Edge (background side).
// Native, extension-only port of the Cloudflare-Faker idea:
// detect a ScienceDirect Cloudflare challenge, dispatch human-like mouse
// clicks through chrome.debugger, retry after a page refresh, then let the
// download job continue. It never runs outside the ScienceDirect host
// allowlist and never outside an active download job (job logic lives in
// background.js; this file is transport/session only).

(() => {
  const core = globalThis.SDFakerCore;
  const SETTINGS_KEY = 'fakerSettings';
  const ALARM_PREFIX = 'sd-faker-';
  const CLICK_COOLDOWN_MS = 300;
  const MAX_POINTS = 8;
  const MAX_COORDINATE = 10000;

  if (!core || typeof core.detectChallenge !== 'function' || typeof core.humanPointerPath !== 'function') {
    console.error('[SDFaker] faker-core.js is missing or incomplete; automatic verification is disabled.');
    return;
  }

  const sessions = new Map(); // tabId -> session
  const attachedTabs = new Set();
  let settings = core.clampSettings(null);
  let hooks = {};

  function log(...args) {
    console.info('[SDFaker]', ...args);
    void persistDebug('info', args);
  }

  function warn(...args) {
    console.warn('[SDFaker]', ...args);
    void persistDebug('warn', args);
  }

  // Persist a small ring buffer of important engine events so failures can be
  // diagnosed after the service worker is gone (helpful in real-world support).
  async function persistDebug(level, args) {
    try {
      const first = args[0];
      if (typeof first !== 'string') return;
      const interesting = level === 'warn' ||
        /dispatch click|click skipped|attach|starting session|session ended|arm |abort/i.test(first);
      if (!interesting) return;
      const data = args.slice(1).map((value) => {
        try {
          return typeof value === 'string' ? value : JSON.stringify(value).slice(0, 400);
        } catch {
          return '';
        }
      }).join(' ');
      const stored = await chrome.storage.local.get('fakerDebugLog');
      const list = Array.isArray(stored?.fakerDebugLog) ? stored.fakerDebugLog : [];
      list.push({t: Date.now(), level, message: first, data});
      if (list.length > 40) list.splice(0, list.length - 40);
      await chrome.storage.local.set({fakerDebugLog: list});
    } catch {
      // Debug logging is best effort only.
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  async function callHook(name, ...args) {
    const hook = hooks?.[name];
    if (typeof hook !== 'function') return;
    try {
      await hook(...args);
    } catch (error) {
      warn(`hook ${name} failed:`, error?.message || error);
    }
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      settings = core.clampSettings(stored?.[SETTINGS_KEY]);
    } catch (error) {
      settings = core.clampSettings(null);
      warn('could not load settings; using defaults:', error?.message || error);
    }
  }

  function getSettings() {
    return {...settings};
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    const wasEnabled = settings.enabled;
    settings = core.clampSettings(changes[SETTINGS_KEY].newValue);
    if (wasEnabled && !settings.enabled) {
      log('automatic verification disabled; stopping sessions.');
      stopAll();
    }
  });

  async function getTab(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async function sendToTab(tabId, message) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      return false;
    }
  }

  async function attachDebugger(session) {
    if (attachedTabs.has(session.tabId)) return true;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await chrome.debugger.attach({tabId: session.tabId}, '1.3');
        attachedTabs.add(session.tabId);
        log('debugger attached to tab', session.tabId);
        return true;
      } catch (error) {
        warn(`debugger attach failed for tab ${session.tabId} (attempt ${attempt}):`, error?.message || error);
        if (attempt < 3) await wait(250 * attempt);
      }
    }
    return false;
  }

  // v2.5: attach the debugger when the session starts (and share the pending
  // promise) so the first real click does not pay the attach latency.
  function ensureDebugger(session) {
    if (attachedTabs.has(session.tabId)) return Promise.resolve(true);
    if (!session.attachPromise) {
      session.attachPromise = attachDebugger(session).finally(() => {
        session.attachPromise = null;
      });
    }
    return session.attachPromise;
  }

  async function detachDebugger(tabId) {
    if (!attachedTabs.has(tabId)) return;
    attachedTabs.delete(tabId);
    try {
      await chrome.debugger.detach({tabId});
      log('debugger detached from tab', tabId);
    } catch {
      // Already detached (tab closed or user cancelled debugging).
    }
  }

  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) return;
    attachedTabs.delete(tabId);
    const session = sessions.get(tabId);
    if (session) {
      session.debuggerLost = true;
      warn(`debugger detached from tab ${tabId}; automatic click will stop.`);
    }
  });

  function clearAlarm(session) {
    chrome.alarms.clear(ALARM_PREFIX + session.id).catch(() => {});
  }

  async function finish(session, outcome) {
    if (!session || sessions.get(session.tabId) !== session) return;
    sessions.delete(session.tabId);
    clearAlarm(session);
    sendToTab(session.tabId, {type: 'sd:faker-disarm', sessionId: session.id});
    if (!session.keepDebugger) await detachDebugger(session.tabId);
    log(`session ended: ${outcome}`, {tabId: session.tabId, reason: session.reason,
      clicks: session.clicks, reloads: session.reloads});
    if (outcome === 'cleared') await callHook('onCleared', session);
    else await callHook('onFailed', session, outcome);
  }

  async function arm(session) {
    if (!sessions.has(session.tabId) || sessions.get(session.tabId) !== session) return;
    session.lastArmAt = Date.now();
    const tab = await getTab(session.tabId);
    if (!tab) {
      await finish(session, 'tab_closed');
      return;
    }

    const tabUrl = tab.url || tab.pendingUrl || '';
    if (!core.isFakerHost(tabUrl)) {
      await finish(session, session.reason === 'reader' ? 'no_target' : 'not_sd_host');
      return;
    }
    // Do not wait for `tab.status === 'complete'`: a Cloudflare interstitial
    // keeps the tab in the loading state, and the content script is injected
    // at document_start, so it is already addressable.

    const message = {
      type: 'sd:faker-arm',
      sessionId: session.id,
      limits: {
        maxClicks: core.LIMITS.maxClicks,
        clickIntervalMs: core.LIMITS.clickIntervalMs,
        armDelayMs: core.LIMITS.armDelayMs,
      },
    };
    let delivered = await sendToTab(session.tabId, message);
    if (!delivered) {
      await wait(700);
      delivered = await sendToTab(session.tabId, message);
    }
    if (!delivered) {
      session.phase = 'arming';
      return;
    }
    if (session.phase === 'arming') session.phase = 'waiting';
    await callHook('onSessionProgress', session, {
      phase: session.phase, clicks: session.clicks, reloads: session.reloads,
    });
  }

  async function dispatchClick(session, points) {
    if (session.clicking) return false;
    log('dispatch click', {tabId: session.tabId, clicks: session.clicks,
      points: points.length, autoClick: settings.autoClick, attached: attachedTabs.has(session.tabId)});
    const elapsed = Date.now() - (session.lastClickAt || 0);
    if (session.clicks > 0 && elapsed < CLICK_COOLDOWN_MS) {
      log('click skipped: cooldown', {elapsed});
      return false;
    }
    if (!settings.autoClick) {
      log('click skipped: autoClick off');
      await sendToTab(session.tabId, {type: 'sd:faker-click-result', ok: false, reason: 'auto_click_off'});
      return false;
    }

    const target = points[session.clicks % points.length];
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y) ||
        target.x < 0 || target.y < 0 || target.x > MAX_COORDINATE || target.y > MAX_COORDINATE) {
      log('click skipped: bad target', target);
      return false;
    }

    const tab = await getTab(session.tabId);
    if (!tab) {
      await finish(session, 'tab_closed');
      return false;
    }

    session.clicking = true;
    try {
      const attached = await ensureDebugger(session);
      if (!attached) {
        log('click skipped: debugger attach failed');
        await sendToTab(session.tabId, {type: 'sd:faker-click-result', ok: false, reason: 'debugger_unavailable'});
        session.keepDebugger = false;
        await finish(session, 'debugger_unavailable');
        return false;
      }

      const to = {x: Math.round(target.x), y: Math.round(target.y)};
      const from = session.mouse && Number.isFinite(session.mouse.x) ?
        session.mouse : {
          x: Math.max(2, to.x - randomBetween(60, 110)),
          y: Math.max(2, to.y - randomBetween(20, 60)),
        };
      const rawPath = core.humanPointerPath(from, to).map((point) => ({
        x: Math.min(MAX_COORDINATE, Math.max(1, Math.round(point.x))),
        y: Math.min(MAX_COORDINATE, Math.max(1, Math.round(point.y))),
      }));
      // Extreme speed (v2.5): keep the curved look but only dispatch a few
      // points, which keeps the click well under ~150 ms.
      let path = rawPath;
      if (path.length > 14) {
        const step = Math.ceil(path.length / 14);
        path = path.filter((_point, index) => index % step === 0);
        path.push(to);
      }
      if (!path.length) path = [to];
      path[path.length - 1] = to;

      for (const point of path) {
        await chrome.debugger.sendCommand({tabId: session.tabId}, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, modifiers: 0,
        });
        await wait(randomBetween(2, 5));
      }
      await chrome.debugger.sendCommand({tabId: session.tabId}, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: to.x, y: to.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 0,
      });
      await wait(randomBetween(18, 40));
      await chrome.debugger.sendCommand({tabId: session.tabId}, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 0,
      });

      // Keyboard fallback: a focused Turnstile checkbox can also be toggled
      // with Space. Some widget variants ignore synthetic mouse clicks.
      try {
        await wait(randomBetween(15, 30));
        await chrome.debugger.sendCommand({tabId: session.tabId}, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
        });
        await wait(randomBetween(15, 30));
        await chrome.debugger.sendCommand({tabId: session.tabId}, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
        });
      } catch {
        // The keyboard fallback is optional.
      }

      session.mouse = to;
      session.clicks += 1;
      session.lastClickAt = Date.now();
      session.phase = 'clicking';
      await sendToTab(session.tabId, {type: 'sd:faker-click-result', ok: true});
      await callHook('onSessionProgress', session, {
        phase: session.phase, clicks: session.clicks, reloads: session.reloads,
      });
      return true;
    } catch (error) {
      warn('click dispatch failed:', error?.message || error);
      await detachDebugger(session.tabId);
      // A transient "Detached while handling command" error (Edge/DevTools
      // hiccup) must not abort the whole verification: keep the session alive
      // and let the content script's next scheduled click retry the attach.
      const transient = /detach|detached|closed|Target closed|No tab/i.test(error?.message || '');
      if (!transient) {
        await sendToTab(session.tabId, {type: 'sd:faker-click-result', ok: false, reason: 'debugger_error'});
        await finish(session, 'debugger_error');
        return false;
      }
      return false;
    } finally {
      session.clicking = false;
    }
  }

  async function reloadForRetry(session, stalledReason) {
    if (!session) return;
    if (stalledReason === 'debugger_unavailable') {
      await finish(session, 'debugger_unavailable');
      return;
    }
    if (stalledReason === 'auto_click_off') {
      // Automatic clicking is switched off: never reload the page just to retry clicks.
      await finish(session, 'auto_click_off');
      return;
    }
    if (session.reason === 'reader' && !session.challengeSeen) {
      // The reader tab never showed a challenge (direct PDF download); stop quietly.
      await finish(session, 'no_target');
      return;
    }
    if (session.reloads >= core.LIMITS.maxReloads) {
      await finish(session, stalledReason === 'no_widget' ? 'no_widget' : 'exhausted');
      return;
    }
    session.reloads += 1;
    session.phase = 'reloading';
    session.challengeSeen = session.challengeSeen || stalledReason === 'no_widget';
    await detachDebugger(session.tabId);
    try {
      await chrome.tabs.reload(session.tabId, {bypassCache: true});
      log(`reloading tab ${session.tabId} to retry verification`, {reloads: session.reloads});
    } catch (error) {
      await finish(session, 'reload_failed');
      return;
    }
    await callHook('onSessionProgress', session, {
      phase: 'reloading', clicks: session.clicks, reloads: session.reloads,
    });
  }

  async function start(options) {
    const tabId = options?.tabId;
    if (!Number.isInteger(tabId)) return null;
    if (!settings.enabled) return null;

    const existing = sessions.get(tabId);
    if (existing) return existing;

    const tab = await getTab(tabId);
    if (!tab) return null;

    const reason = options.reason === 'reader' ? 'reader' : 'gate';
    const tabUrl = tab.url || tab.pendingUrl || '';
    const loading = tab.status === 'loading';
    const acceptedUrl = core.isFakerHost(tabUrl) || (loading && tabUrl !== '' && !tabUrl.startsWith('about:'));
    if (!acceptedUrl) {
      if (reason !== 'reader') warn(`refusing faker start on unsupported tab url: ${tabUrl}`);
      return null;
    }

    const session = {
      id: typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : `sd-${crypto.randomUUID()}`,
      tabId,
      reason,
      startedAt: Date.now(),
      clicks: Number.isInteger(options.clicks) ? options.clicks : 0,
      reloads: Number.isInteger(options.reloads) ? options.reloads : 0,
      phase: 'arming',
      mouse: null,
      lastClickAt: 0,
      lastArmAt: 0,
      challengeSeen: false,
      stalledReported: false,
      clicking: false,
      debuggerLost: false,
      keepDebugger: false,
      attachPromise: null,
    };
    sessions.set(tabId, session);

    if (reason === 'gate') {
      try {
        const updated = await chrome.tabs.update(tabId, {active: true});
        if (Number.isInteger(updated?.windowId)) {
          chrome.windows.update(updated.windowId, {focused: true}).catch(() => {});
        }
      } catch {
        // Focus is best effort; clicking still works for background tabs through CDP.
      }
    }

    try {
      await chrome.alarms.create(ALARM_PREFIX + session.id, {when: Date.now() + core.LIMITS.sessionTimeoutMs});
    } catch (error) {
      warn('could not create faker timeout alarm:', error?.message || error);
    }

    log('starting session', {tabId, reason, sessionId: session.id});
    // Attach eagerly so the first click after arming is dispatched immediately.
    await ensureDebugger(session).catch(() => false);
    await callHook('onSessionStart', session);
    await arm(session);
    return session;
  }

  function stop(tabId) {
    const session = sessions.get(tabId);
    if (!session) return;
    sessions.delete(tabId);
    clearAlarm(session);
    detachDebugger(tabId);
    sendToTab(tabId, {type: 'sd:faker-disarm', sessionId: session.id});
  }

  function stopAll() {
    for (const tabId of [...sessions.keys()]) stop(tabId);
  }

  function sessionForTab(tabId) {
    return sessions.get(tabId) || null;
  }

  function handleMessage(message, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) return false;
    const session = sessions.get(tabId);
    const type = message?.type;

    if (type === 'sd:faker-state') {
      if (!session) return false;
      const state = message.state || {};
      if (state.detected) {
        session.challengeSeen = true;
        if (session.phase === 'arming' && Date.now() - (session.lastArmAt || 0) > 1500) {
          void arm(session);
        }
      } else if (session.challengeSeen) {
        void finish(session, 'cleared');
      }
      return true;
    }

    if (!session) return false;

    if (type === 'sd:faker-click') {
      const points = Array.isArray(message.points) ? message.points.slice(0, MAX_POINTS) : [];
      if (!points.length) return true;
      const valid = points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.x >= 0 && point.y >= 0 && point.x <= MAX_COORDINATE && point.y <= MAX_COORDINATE);
      if (!valid) return true;
      void dispatchClick(session, points);
      return true;
    }

    if (type === 'sd:faker-stalled') {
      if (session.stalledReported) return true;
      session.stalledReported = true;
      void reloadForRetry(session, message.reason);
      return true;
    }

    return false;
  }

  async function onTabUpdated(tabId, changes) {
    const session = sessions.get(tabId);
    if (!session) return;
    if (changes?.status !== 'complete') return;

    session.stalledReported = false;
    const tab = await getTab(tabId);
    if (!tab) {
      await finish(session, 'tab_closed');
      return;
    }
    const tabUrl = tab.url || '';
    if (session.challengeSeen && core.isFakerHost(tabUrl) && !core.isChallengeUrl(tabUrl)) {
      log('challenge page navigated away; treating verification as cleared.');
      await finish(session, 'cleared');
      return;
    }
    await arm(session);
  }

  async function onTabRemoved(tabId) {
    const session = sessions.get(tabId);
    if (!session) {
      attachedTabs.delete(tabId);
      return;
    }
    sessions.delete(tabId);
    clearAlarm(session);
    attachedTabs.delete(tabId);
    await callHook('onFailed', session, 'tab_closed');
  }

  async function handleAlarm(alarm) {
    const name = alarm?.name || '';
    if (!name.startsWith(ALARM_PREFIX)) return;
    const sessionId = name.slice(ALARM_PREFIX.length);
    const session = [...sessions.values()].find((candidate) => candidate.id === sessionId);
    if (!session) return;
    warn('session timed out.', {tabId: session.tabId, reason: session.reason});
    await finish(session, 'timeout');
  }

  async function init(nextHooks) {
    hooks = nextHooks || {};
    await loadSettings();
    log('engine initialised', getSettings());
  }

  globalThis.SDFakerBackground = {
    init,
    start,
    stop,
    stopAll,
    sessionForTab,
    handleMessage,
    onTabUpdated,
    onTabRemoved,
    handleAlarm,
    getSettings,
    isAttached: (tabId) => attachedTabs.has(tabId),
  };
})();
