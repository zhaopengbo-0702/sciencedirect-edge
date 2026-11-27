(() => {
  'use strict';

  try {
    boot();
  } catch {
    // Content scripts must never interfere with the page.
  }

  function boot() {
    const core = globalThis.SDFakerCore;
    if (!core || typeof core.detectChallenge !== 'function' || typeof core.clickSeries !== 'function') return;
    if (window.top !== window) return;
    if (typeof location !== 'undefined' && typeof core.isFakerHost === 'function' && !core.isFakerHost(location.href)) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

    const LIMITS = core.LIMITS && typeof core.LIMITS === 'object' ? core.LIMITS : {};
    const maxClicksLimit = Number.isFinite(LIMITS.maxClicks) && LIMITS.maxClicks > 0 ? LIMITS.maxClicks : 6;
    const clickIntervalLimit = Number.isFinite(LIMITS.clickIntervalMs) && LIMITS.clickIntervalMs > 0 ? LIMITS.clickIntervalMs : 2000;
    const armDelayLimit = Number.isFinite(LIMITS.armDelayMs) && LIMITS.armDelayMs >= 0 ? LIMITS.armDelayMs : 1200;
    const stateIntervalLimit = Number.isFinite(LIMITS.stateIntervalMs) && LIMITS.stateIntervalMs > 0 ? LIMITS.stateIntervalMs : 900;

    const mutationThrottleMs = 150;
    const fallbackPollMs = 400;
    const scrollSettleMs = 100;
    const widgetWatchdogMs = 12000;
    const clickResponseTimeoutMs = 3000;
    const frameSelector = 'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"]';

    let armed = false;
    let sessionId = null;
    let limits = {maxClicks: maxClicksLimit, clickIntervalMs: clickIntervalLimit};
    let lastPresence = 'clear';
    let clicksSent = 0;
    let stalledSent = false;
    let widgetSeen = false;
    let clickLoopActive = false;
    let clickPending = false;

    let observer = null;
    let mutationTimer = 0;
    let pollTimer = 0;
    let rootRetryTimer = 0;
    let rootAttempts = 0;
    let stateTimer = 0;
    let clickTimer = 0;
    let settleTimer = 0;
    let budgetTimer = 0;
    let watchdogTimer = 0;
    let responseTimer = 0;

    function guard(fn) {
      return function guarded() {
        try {
          return fn.apply(this, arguments);
        } catch {
          // Timers and listeners must be exception-proof.
        }
        return undefined;
      };
    }

    function send(message) {
      try {
        const runtime = chrome.runtime;
        if (!runtime || !runtime.id || typeof runtime.sendMessage !== 'function') return;
        const result = runtime.sendMessage(message);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        // Extension context can be invalidated while the page unloads.
      }
    }

    function locationHref() {
      try {
        return location.href;
      } catch {
        return '';
      }
    }

    function documentTitle() {
      try {
        return typeof document.title === 'string' ? document.title : '';
      } catch {
        return '';
      }
    }

    function readDetection() {
      try {
        return core.detectChallenge(document, window.location) || null;
      } catch {
        return null;
      }
    }

    function hasWidget(detection) {
      return Boolean(detection && detection.detected && (detection.frame || detection.captchaBoxRect));
    }

    function clampInt(value, min, max, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      const rounded = Math.round(number);
      if (rounded < min) return min;
      if (rounded > max) return max;
      return rounded;
    }

    // ---------------------------------------------------------------------
    // State reporting
    // ---------------------------------------------------------------------

    function reportState(detection, force) {
      const presence = detection ? 'challenge' : 'clear';
      if (!force && presence === lastPresence) return;
      lastPresence = presence;
      const state = detection ?
        Object.assign({}, detection, {alive: true}) :
        {detected: false, url: locationHref(), title: documentTitle(), alive: true};
      send({type: 'sd:faker-state', state});
    }

    function syncState() {
      try {
        const detection = readDetection();
        if (hasWidget(detection)) widgetSeen = true;
        if (!armed) {
          reportState(detection, false);
          return;
        }
        if (!detection) stopClickLoop();
        reportState(detection, false);
        if (hasWidget(detection)) ensureClickLoop(detection);
      } catch {
        // Detection failures are transient; the polling timer retries.
      }
    }

    function reportArmedState() {
      try {
        if (!armed) return;
        const detection = readDetection();
        if (hasWidget(detection)) widgetSeen = true;
        reportState(detection, true);
        if (!detection) stopClickLoop();
        else if (hasWidget(detection)) ensureClickLoop(detection);
      } catch {
        // Keep the interval alive.
      }
    }

    // ---------------------------------------------------------------------
    // Click loop
    // ---------------------------------------------------------------------

    function clearTimer(name) {
      if (name === 'click' && clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = 0;
      } else if (name === 'settle' && settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      } else if (name === 'budget' && budgetTimer) {
        clearTimeout(budgetTimer);
        budgetTimer = 0;
      } else if (name === 'watchdog' && watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = 0;
      } else if (name === 'response' && responseTimer) {
        clearTimeout(responseTimer);
        responseTimer = 0;
      }
    }

    function stopClickLoop() {
      clearTimer('click');
      clearTimer('settle');
      clearTimer('budget');
      clearTimer('response');
      clickLoopActive = false;
      clickPending = false;
    }

    function scheduleClick(delay) {
      clearTimer('click');
      clickTimer = setTimeout(guard(requestClick), Math.max(0, delay));
    }

    function ensureClickLoop(detection) {
      if (!armed || stalledSent || clickLoopActive) return;
      if (clicksSent >= limits.maxClicks) return;
      if (!hasWidget(detection)) return;
      clickLoopActive = true;
      widgetSeen = true;
      scheduleClick(clicksSent === 0 ? armDelayLimit : limits.clickIntervalMs);
    }

    function requestClick() {
      clearTimer('click');
      if (!armed || stalledSent) {
        clickLoopActive = false;
        return;
      }
      if (clicksSent >= limits.maxClicks) {
        clickLoopActive = false;
        finishClickBudget();
        return;
      }
      const detection = readDetection();
      if (!detection) {
        clickLoopActive = false;
        reportState(null, true);
        return;
      }
      if (!hasWidget(detection)) {
        clickLoopActive = false;
        return;
      }
      const frame = pickFrameElement();
      if (frame && isFrameOffscreen(frame)) {
        try {
          frame.scrollIntoView({block: 'center', inline: 'nearest'});
        } catch {
          // Scrolling is best effort.
        }
        // Give the page ~120ms to settle, then re-measure the frame rect.
        clearTimer('settle');
        settleTimer = setTimeout(guard(() => {
          clearTimer('settle');
          performClick();
        }), scrollSettleMs);
        return;
      }
      performClick();
    }

    function performClick() {
      if (!armed || stalledSent) {
        clickLoopActive = false;
        return;
      }
      if (clickPending) return;
      const detection = readDetection();
      if (!detection) {
        clickLoopActive = false;
        reportState(null, true);
        return;
      }
      const viewport = {
        width: Number(window.innerWidth) || 1280,
        height: Number(window.innerHeight) || 800,
      };
      const points = core.clickSeries(detection.frame, detection.captchaBoxRect, viewport);
      if (!Array.isArray(points) || !points.length) {
        clickLoopActive = false;
        return;
      }
      const attempt = clicksSent + 1;
      clicksSent = attempt;
      clickPending = true;
      // Background dispatches the real click and rotates candidates by attempt.
      send({type: 'sd:faker-click', sessionId, points, attempt});
      // Wait for the background's acknowledgement before the next click, so the
      // click budget is not burned by requests the debugger never dispatched
      // (that used to trigger needless page reloads).
      clearTimer('response');
      responseTimer = setTimeout(guard(() => {
        clearTimer('response');
        if (!armed || stalledSent) return;
        clickPending = false;
        if (clicksSent >= limits.maxClicks) {
          finishClickBudget();
        } else {
          scheduleClick(limits.clickIntervalMs);
        }
      }), clickResponseTimeoutMs);
    }

    function finishClickBudget() {
      clearTimer('budget');
      clickLoopActive = false;
      if (!armed || stalledSent) return;
      const detection = readDetection();
      if (!detection) {
        reportState(null, true);
        return;
      }
      reportStalled('click_budget');
    }

    function reportStalled(reason) {
      if (!armed || stalledSent || !sessionId) return;
      stalledSent = true;
      stopClickLoop();
      send({type: 'sd:faker-stalled', sessionId, reason});
    }

    function armWatchdog() {
      clearTimer('watchdog');
      if (!armed || stalledSent) return;
      const detection = readDetection();
      if (!detection) {
        // No widget at all after 12s of being armed (e.g. a reader tab that
        // already served the PDF): let the background decide, it ends the
        // session quietly for reader tabs without reloading.
        reportStalled('no_widget');
        return;
      }
      if (!hasWidget(detection)) {
        if (!widgetSeen) reportStalled('no_widget');
        else reportStalled('no_progress');
        return;
      }
      if (clicksSent === 0) reportStalled('no_progress');
    }

    // ---------------------------------------------------------------------
    // Frame helpers (element access lives in the content script only)
    // ---------------------------------------------------------------------

    function elementShown(element) {
      try {
        if (!element) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
        if (style && style.opacity === '0') return false;
      } catch {
        // Fall through: assume visible when the style probe fails.
      }
      return true;
    }

    function pickFrameElement() {
      let frames = [];
      try {
        frames = Array.from(document.querySelectorAll(frameSelector));
      } catch {
        return null;
      }
      let best = null;
      let bestArea = -1;
      for (const frame of frames) {
        if (!elementShown(frame)) continue;
        let area = 0;
        try {
          const rect = frame.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) area = rect.width * rect.height;
        } catch {
          area = 0;
        }
        if (area > bestArea) {
          bestArea = area;
          best = frame;
        }
      }
      return best;
    }

    function isFrameOffscreen(element) {
      let rect = null;
      try {
        rect = element.getBoundingClientRect();
      } catch {
        return false;
      }
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const width = Number(window.innerWidth) || 0;
      const height = Number(window.innerHeight) || 0;
      return rect.top < 0 || rect.left < 0 ||
        (height > 0 && rect.bottom > height) || (width > 0 && rect.right > width);
    }

    // ---------------------------------------------------------------------
    // Arm / disarm lifecycle
    // ---------------------------------------------------------------------

    function resetArmed() {
      armed = false;
      sessionId = null;
      clearTimer('click');
      clearTimer('settle');
      clearTimer('budget');
      clearTimer('watchdog');
      if (stateTimer) {
        clearInterval(stateTimer);
        stateTimer = 0;
      }
      clickLoopActive = false;
    }

    function arm(message) {
      const id = typeof message.sessionId === 'string' ? message.sessionId : '';
      if (!id) return;
      // Idempotent: a repeated arm for the same session must not reset
      // counters or stack timers.
      if (armed && sessionId === id) return;

      resetArmed();
      armed = true;
      sessionId = id;
      const rawLimits = message.limits && typeof message.limits === 'object' ? message.limits : {};
      limits = {
        maxClicks: clampInt(rawLimits.maxClicks, 1, 12, maxClicksLimit),
        clickIntervalMs: clampInt(rawLimits.clickIntervalMs, 300, 10000, clickIntervalLimit),
      };
      clicksSent = 0;
      stalledSent = false;
      widgetSeen = false;
      clickLoopActive = false;
      lastPresence = '';

      const detection = readDetection();
      if (hasWidget(detection)) widgetSeen = true;
      reportState(detection, true);
      stateTimer = setInterval(guard(reportArmedState), stateIntervalLimit);
      watchdogTimer = setTimeout(guard(armWatchdog), widgetWatchdogMs);
      if (hasWidget(detection)) ensureClickLoop(detection);
    }

    function disarm() {
      resetArmed();
      // Do not announce the current challenge again after a disarm: the
      // background may have just given up on this session, and a fresh
      // "detected" report would immediately restart it.
      lastPresence = readDetection() ? 'challenge' : 'clear';
    }

    function onMessage(message, sender, sendResponse) {
      if (!message || typeof message !== 'object') return false;
      try {
        if (sender && sender.id && chrome.runtime && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
      } catch {
        return false;
      }
      switch (message.type) {
        case 'sd:faker-probe':
          // Background asks for the live state after a navigation completes;
          // the content script (not the URL) is the authority on whether the
          // challenge is really gone.
          if (typeof sendResponse === 'function') {
            try {
              sendResponse({state: readDetection(), armed, clicksSent});
            } catch {
              // Ignore.
            }
          }
          return true;
        case 'sd:faker-arm':
          arm(message);
          break;
        case 'sd:faker-disarm':
          if (message.sessionId && sessionId && message.sessionId !== sessionId) return false;
          disarm();
          break;
        case 'sd:faker-click-result':
          if (!armed || stalledSent) return false;
          clickPending = false;
          clearTimer('response');
          if (message.ok === false) {
            // User turned auto-click off in the popup: report the real reason
            // instead of a misleading debugger/permission failure.
            reportStalled(message.reason === 'auto_click_off' ? 'auto_click_off' : 'debugger_unavailable');
            return false;
          }
          if (clicksSent >= limits.maxClicks) {
            finishClickBudget();
          } else {
            scheduleClick(limits.clickIntervalMs);
          }
          break;
        default:
          break;
      }
      return false;
    }

    // ---------------------------------------------------------------------
    // Detection wiring
    // ---------------------------------------------------------------------

    function onMutation() {
      if (mutationTimer) return;
      mutationTimer = setTimeout(guard(() => {
        mutationTimer = 0;
        syncState();
      }), mutationThrottleMs);
    }

    function observeRoot() {
      if (observer) return;
      let root = null;
      try {
        root = document.documentElement;
      } catch {
        root = null;
      }
      if (!root) {
        if (rootAttempts < 50) {
          rootAttempts += 1;
          rootRetryTimer = setTimeout(guard(observeRoot), 100);
        }
        return;
      }
      try {
        if (typeof MutationObserver !== 'function') return;
        observer = new MutationObserver(guard(onMutation));
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'src', 'id', 'style', 'hidden'],
        });
      } catch {
        observer = null;
      }
    }

    function cleanup() {
      resetArmed();
      lastPresence = '';
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = 0;
      }
      if (mutationTimer) {
        clearTimeout(mutationTimer);
        mutationTimer = 0;
      }
      if (rootRetryTimer) {
        clearTimeout(rootRetryTimer);
        rootRetryTimer = 0;
      }
      if (observer) {
        try {
          observer.disconnect();
        } catch {
          // Ignore.
        }
        observer = null;
      }
    }

    try {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        try {
          return onMessage(message, sender, sendResponse) === true;
        } catch {
          // A malformed message must never break the page.
          return false;
        }
      });
    } catch {
      return;
    }

    try {
      window.addEventListener('pagehide', () => {
        try {
          cleanup();
        } catch {
          // Ignore.
        }
      }, {once: true});
      document.addEventListener('DOMContentLoaded', guard(syncState), {once: true});
      window.addEventListener('load', guard(syncState), {once: true});
    } catch {
      // Listener registration failures are not fatal.
    }

    observeRoot();
    pollTimer = setInterval(guard(syncState), fallbackPollMs);
    syncState();
  }
})();
