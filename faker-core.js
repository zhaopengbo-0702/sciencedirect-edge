(() => {
  'use strict';

  // Dependency-free helpers shared by the content script, the extension
  // service worker (importScripts) and Node unit tests. Everything that
  // touches the live document is evaluated inside function bodies, so
  // loading this file never requires browser globals.

  const SCIENCE_DIRECT_HOSTS = ['www.sciencedirect.com', 'sciencedirect.com'];
  const PDF_HOSTS = ['pdf.sciencedirectassets.com', 'ac.els-cdn.com', 'ars.els-cdn.com'];
  const FAKER_HOSTS = SCIENCE_DIRECT_HOSTS.concat(PDF_HOSTS);
  const DEFAULT_SETTINGS = Object.freeze({enabled: true, autoClick: true});
  const LIMITS = Object.freeze({
    maxClicks: 6,
    // The user asked for "keep refreshing and retrying if it does not work":
    // eight refresh attempts per verification session, up to four minutes.
    maxReloads: 8,
    clickIntervalMs: 2000,
    armDelayMs: 1200,
    sessionTimeoutMs: 240000,
    stateIntervalMs: 900,
  });

  const CHALLENGE_URL_TOKENS = [
    '__cf_chl_tk=',
    '__cf_chl_f_tk=',
    '__cf_chl_captcha_tk=',
    '__cf_chl_rt_tk=',
    'cf_chl_jschl_tk=',
  ];
  const CHALLENGE_ELEMENT_SELECTORS = [
    '#captcha-box',
    '#challenge-error-text',
    '#challenge-form',
    '#cf-challenge-running',
    '#challenge-running',
    '.cf-browser-verification',
    '.cf-checking-browser',
  ];
  const CHALLENGE_ELEMENT_SELECTOR = CHALLENGE_ELEMENT_SELECTORS.join(',');
  const CHALLENGE_FRAME_SELECTOR = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="challenge-platform"]',
  ].join(',');
  const CHALLENGE_TITLE_PATTERNS = [
    'please wait',
    'just a moment',
    'attention required',
    '请稍后',
    '请稍候',
    '请等待',
    '稍等片刻',
  ];
  // Lower-cased normalized fragments that only appear on an interstitial.
  const CF_BODY_PATTERNS = [
    'are you a robot',
    'please confirm you are a human',
    'completing the captcha challenge below',
    'enable javascript and cookies to continue',
    'checking if you are a real person',
    'please complete the following to verify that you are human',
    'verify you are human',
    'verify you are a human',
    'confirm you are a human',
    'are you a human',
    '正在验证您是否是真人',
    '验证您是否是真人',
    '确认您是真人',
    '请完成以下操作，验证您是真人',
    '请完成以下操作验证您是真人',
    '请完成以下验证',
  ];
  const SD_BODY_PATTERNS = [
    'sorry, we have to be sure',
    'please verify you are human',
    'please verify that you are human',
  ];
  // Two-part Cloudflare copy, tolerant to punctuation/spacing/verb variants.
  const CF_BODY_PAIRS = [
    ['before you continue', 'check the security of your connection'],
    ['继续之前', '需要先检查您的连接的安全性'],
    ['继续之前', '检查您的连接的安全性'],
  ];

  const BODY_TEXT_LIMIT = 800000;

  function clampInt(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const rounded = Math.round(number);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
  }

  function hostOf(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    const candidates = [text];
    if (!/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[/?#]/.test(text) && !/\s/.test(text)) {
      candidates.push(`https://${text}`);
    }
    for (const candidate of candidates) {
      try {
        const host = String(new URL(candidate).hostname || '').toLowerCase().replace(/\.$/, '');
        if (host) return host;
      } catch {
        // Ignore malformed candidates and try the next representation.
      }
    }
    return '';
  }

  function schemeOf(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    const match = /^([a-z][a-z\d+.-]*):/i.exec(text);
    return match ? match[1].toLowerCase() : '';
  }

  // Host matching is exact and requires https whenever a scheme is present;
  // bare host names keep working for convenience.
  function hostIn(value, hosts) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return false;
    const scheme = schemeOf(text);
    if (scheme && scheme !== 'https') return false;
    return hosts.includes(hostOf(text));
  }

  function isScienceDirectHost(value) {
    return hostIn(value, SCIENCE_DIRECT_HOSTS);
  }

  function isFakerHost(value) {
    return hostIn(value, FAKER_HOSTS);
  }

  function urlString(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value.href === 'string') return value.href;
    return '';
  }

  function isChallengeUrl(value) {
    const href = urlString(value).toLowerCase();
    if (!href) return false;
    return CHALLENGE_URL_TOKENS.some((token) => href.includes(token));
  }

  function locationHref(loc) {
    if (!loc) return '';
    if (typeof loc === 'string') return loc;
    try {
      if (typeof loc.href === 'string') return loc.href;
      if (loc.location && typeof loc.location.href === 'string') return loc.location.href;
    } catch {
      // Hostile location getters are ignored.
    }
    return '';
  }

  function normalizeText(value, limit) {
    let text = typeof value === 'string' ? value : '';
    if (!text) return '';
    if (text.length > limit) text = text.slice(0, limit);
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function safeQueryAll(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function elementText(element) {
    try {
      if (typeof element.innerText === 'string') return element.innerText;
      if (typeof element.textContent === 'string') return element.textContent;
    } catch {
      // Ignore detached/hostile nodes.
    }
    return '';
  }

  function safeTitle(doc) {
    try {
      return doc && typeof doc.title === 'string' ? doc.title : '';
    } catch {
      return '';
    }
  }

  function collectBodyText(doc) {
    let text = '';
    try {
      const body = doc.body;
      if (body) {
        if (typeof body.textContent === 'string') text = body.textContent;
        else if (typeof body.innerText === 'string') text = body.innerText;
      }
      if (!text && doc.documentElement && typeof doc.documentElement.textContent === 'string') {
        text = doc.documentElement.textContent;
      }
    } catch {
      text = '';
    }
    const headings = safeQueryAll(doc, 'h1, h2').map(elementText).join(' ');
    return `${normalizeText(text, BODY_TEXT_LIMIT)} ${normalizeText(headings, 4000)}`;
  }

  function isShown(doc, element) {
    if (!element) return false;
    try {
      if (element.hidden) return false;
      const view = doc && doc.defaultView;
      const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(element) : null;
      if (style) {
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (style.opacity === '0') return false;
      }
    } catch {
      // A failing style probe must not hide a real widget.
    }
    return true;
  }

  function positiveNumber(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  // Viewport coordinates (getBoundingClientRect already includes scrolling).
  function rectOf(element, fallbackSize) {
    if (!element) return null;
    let raw = null;
    try {
      raw = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    } catch {
      raw = null;
    }
    const read = (primary, secondary) => {
      if (!raw) return 0;
      const value = raw[primary] !== undefined ? raw[primary] : raw[secondary];
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    };
    const x = read('x', 'left');
    const y = read('y', 'top');
    let width = Math.max(0, read('width', 'width'));
    let height = Math.max(0, read('height', 'height'));
    if (!width && fallbackSize) width = positiveNumber(fallbackSize.width);
    if (!height && fallbackSize) height = positiveNumber(fallbackSize.height);
    if (!width && element.getAttribute) width = positiveNumber(element.getAttribute('width'));
    if (!height && element.getAttribute) height = positiveNumber(element.getAttribute('height'));
    if (!width || !height) return null;
    return {x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)};
  }

  // Some Cloudflare widgets are injected into an open shadow root. This is a
  // last-resort lookup, only executed when the regular selector found nothing
  // but other challenge signals are already present (and bounded in depth).
  function shadowChallengeFrames(doc) {
    const frames = [];
    const visit = (root, depth) => {
      if (!root || depth > 3 || frames.length >= 5) return;
      let hosts = [];
      try {
        hosts = Array.from(root.querySelectorAll('*'));
      } catch {
        return;
      }
      for (const host of hosts) {
        let shadow = null;
        try {
          shadow = host.shadowRoot;
        } catch {
          shadow = null;
        }
        if (!shadow) continue;
        try {
          for (const frame of shadow.querySelectorAll(CHALLENGE_FRAME_SELECTOR)) frames.push(frame);
        } catch {
          // Ignore hostile shadow trees.
        }
        visit(shadow, depth + 1);
        if (frames.length >= 5) return;
      }
    };
    visit(doc, 0);
    return frames;
  }

  function detectChallenge(doc, loc) {
    let target = doc;
    if (target && typeof target.querySelectorAll !== 'function' && target.document) target = target.document;
    if (!target && typeof document !== 'undefined') target = document;
    let locationRef = loc;
    if (!locationRef && typeof location !== 'undefined') locationRef = location;

    const url = locationHref(locationRef);
    const title = safeTitle(target);
    const urlHit = isChallengeUrl(url);
    const titleHit = CHALLENGE_TITLE_PATTERNS.some((pattern) => normalizeText(title, 400).includes(pattern));

    const elements = safeQueryAll(target, CHALLENGE_ELEMENT_SELECTOR);
    const elementsHit = elements.length > 0;

    const captchaBoxElement = safeQueryAll(target, '#captcha-box')[0] || null;
    const captchaBoxShown = Boolean(captchaBoxElement && isShown(target, captchaBoxElement));
    const captchaBoxRect = captchaBoxShown ? rectOf(captchaBoxElement, null) : null;

    const bodyText = collectBodyText(target);
    const cfBodyHit = CF_BODY_PATTERNS.some((pattern) => bodyText.includes(pattern)) ||
      CF_BODY_PAIRS.some((parts) => parts.every((part) => bodyText.includes(part)));
    const sdBodyHit = SD_BODY_PATTERNS.some((pattern) => bodyText.includes(pattern));

    const frames = safeQueryAll(target, CHALLENGE_FRAME_SELECTOR);
    let frameHit = false;
    let frameRect = null;
    const considerFrame = (frame) => {
      if (!frame || !isShown(target, frame)) return;
      frameHit = true;
      const rect = rectOf(frame, {width: 300, height: 65});
      if (rect && (!frameRect || rect.width * rect.height > frameRect.width * frameRect.height)) frameRect = rect;
    };
    for (const frame of frames) considerFrame(frame);

    const otherSignal = urlHit || elementsHit || titleHit || cfBodyHit || captchaBoxShown;
    if (!frameHit && otherSignal) {
      for (const frame of shadowChallengeFrames(target)) considerFrame(frame);
    }

    const cloudflareSignal = urlHit || elementsHit || frameHit || titleHit || cfBodyHit;
    const verificationSignal = sdBodyHit;
    if (!cloudflareSignal && !verificationSignal) return null;

    return {
      detected: true,
      kind: cloudflareSignal ? 'cloudflare' : 'sd-verification',
      // Interactive means a live widget exists; clicks still require a rect.
      interactive: Boolean(frameHit || captchaBoxShown),
      frame: frameRect,
      captchaBoxRect,
      signals: {
        urlTokens: urlHit,
        title: titleHit,
        bodyText: Boolean(cfBodyHit || sdBodyHit),
        elements: elementsHit,
        frame: frameHit,
        captchaBox: captchaBoxShown,
      },
      url,
      title,
    };
  }

  function clampSettings(raw) {
    if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
    return {
      enabled: raw.enabled !== false,
      autoClick: raw.autoClick !== false,
    };
  }

  function normalizeRect(rect) {
    if (!rect || typeof rect !== 'object') return null;
    const x = Number(rect.x !== undefined ? rect.x : rect.left);
    const y = Number(rect.y !== undefined ? rect.y : rect.top);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
    if (width <= 0 || height <= 0) return null;
    return {x, y, width, height};
  }

  function viewportSize(viewport) {
    const width = Number(viewport && (viewport.width !== undefined ? viewport.width : viewport.innerWidth));
    const height = Number(viewport && (viewport.height !== undefined ? viewport.height : viewport.innerHeight));
    return {
      width: Number.isFinite(width) && width > 0 ? width : 1280,
      height: Number.isFinite(height) && height > 0 ? height : 800,
    };
  }

  function clickSeries(frameRect, captchaBoxRect, viewport) {
    const size = viewportSize(viewport);
    const maxX = Math.max(1, Math.floor(size.width) - 2);
    const maxY = Math.max(1, Math.floor(size.height) - 2);
    const toPoint = (x, y) => ({
      x: clampInt(Math.round(x), 1, maxX, 1),
      y: clampInt(Math.round(y), 1, maxY, 1),
    });
    const frame = normalizeRect(frameRect);
    const box = normalizeRect(captchaBoxRect);
    const candidates = [];

    if (frame) {
      const {x, y, width, height} = frame;
      if (width >= 200) {
        // Wide widget: the checkbox sits near the left edge, but some layouts
        // only react to clicks on the label text. Cover both areas.
        const offsets = [[30, 33], [26, 30], [34, 36], [40, 32], [120, 33], [180, 33], [60, 33]];
        for (const [dx, dy] of offsets) candidates.push(toPoint(x + dx, y + dy));
        candidates.push(toPoint(x + width / 2, y + height / 2));
      } else {
        // Compact widget: aim at the left-hand checkbox area proportionally.
        const ratios = [[0.12, 0.5], [0.1, 0.45], [0.15, 0.55], [0.13, 0.48]];
        for (const [rx, ry] of ratios) candidates.push(toPoint(x + width * rx, y + height * ry));
        candidates.push(toPoint(x + width / 2, y + height / 2));
        candidates.push(toPoint(x + width / 2, y + height * 0.35));
      }
    }

    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const leftShift = Math.min(Math.round(box.width * 0.25), 120);
      const upShift = Math.min(Math.round(box.height * 0.25), 80);
      // The real Turnstile checkbox sits in the upper-left of the widget; when
      // the iframe is unavailable (shadow DOM / not injected yet) aim there
      // first, then fall back to the container centre.
      const bandTop = box.y + Math.min(Math.round(box.height * 0.5), 33);
      for (const dx of [24, 34, 44]) candidates.push(toPoint(box.x + dx, bandTop));
      candidates.push(toPoint(cx, cy));
      candidates.push(toPoint(cx - leftShift, cy));
      candidates.push(toPoint(cx, cy - upShift));
      candidates.push(toPoint(box.x + 34, box.y + 33));
      candidates.push(toPoint(cx - leftShift, cy - upShift));
    }

    const seen = new Set();
    const points = [];
    for (const point of candidates) {
      const key = `${point.x},${point.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(point);
      if (points.length >= 8) break;
    }
    return points;
  }

  function pointOf(value) {
    if (!value || typeof value !== 'object') return null;
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {x, y};
  }

  function bezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  }

  // Independent take on a human mouse path: curved approach with lateral
  // wander, a small overshoot and a corrective tail back onto the target.
  // Options: {random?: () => number, scale?: number}.
  function humanPointerPath(from, to, options) {
    const settings = options && typeof options === 'object' ? options : {};
    const random = typeof settings.random === 'function' ? settings.random : Math.random;
    const scale = Number.isFinite(settings.scale) ? Math.min(3, Math.max(0.25, settings.scale)) : 1;
    const start = pointOf(from);
    const end = pointOf(to);
    if (!start || !end) return [];

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);
    const angle = distance > 0.5 ? Math.atan2(dy, dx) : random() * Math.PI * 2;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const perpX = -dirY;
    const perpY = dirX;
    const travel = Math.max(distance, 24);

    const rawCount = 18 + Math.min(1, travel / 700) * 18 + random() * 12;
    const count = clampInt(Math.round(rawCount * (0.85 + scale * 0.3)), 16, 56);
    const mainCount = count - 3;

    const overshootDistance = Math.max(1.5, Math.min(16, (2.5 + random() * 7) * scale)) * (distance > 30 ? 1 : 0.5);
    const overshoot = {x: end.x + dirX * overshootDistance, y: end.y + dirY * overshootDistance};
    const bendA = (random() - 0.5) * 2 * (0.06 + random() * 0.14) * Math.max(distance, 90);
    const bendB = (random() - 0.5) * 2 * (0.06 + random() * 0.14) * Math.max(distance, 90);
    const control1 = {
      x: start.x + (overshoot.x - start.x) * 0.3 + perpX * bendA,
      y: start.y + (overshoot.y - start.y) * 0.3 + perpY * bendA,
    };
    const control2 = {
      x: start.x + (overshoot.x - start.x) * 0.68 + perpX * bendB,
      y: start.y + (overshoot.y - start.y) * 0.68 + perpY * bendB,
    };
    const noiseAmplitude = Math.min(4.5, Math.max(0.6, (1.2 + random() * 2.4) * scale));

    const points = [];
    let last = null;
    for (let index = 0; index < mainCount; index += 1) {
      const raw = mainCount > 1 ? index / (mainCount - 1) : 0;
      const eased = raw * raw * (3 - 2 * raw);
      const point = bezierPoint(start, control1, control2, overshoot, eased);
      const fade = Math.sin(Math.PI * raw);
      point.x += (random() - 0.5) * 2 * noiseAmplitude * fade;
      point.y += (random() - 0.5) * 2 * noiseAmplitude * fade;
      last = point;
      points.push({x: Math.round(point.x), y: Math.round(point.y)});
    }

    for (let step = 1; step <= 3; step += 1) {
      const ratio = step / 3;
      points.push({
        x: Math.round(last.x + (end.x - last.x) * ratio),
        y: Math.round(last.y + (end.y - last.y) * ratio),
      });
    }
    // The final coordinate is exactly the requested target.
    points[points.length - 1] = {x: Math.round(end.x), y: Math.round(end.y)};
    return points;
  }

  globalThis.SDFakerCore = {
    SCIENCE_DIRECT_HOSTS,
    PDF_HOSTS,
    FAKER_HOSTS,
    DEFAULT_SETTINGS,
    LIMITS,
    CHALLENGE_FRAME_SELECTOR,
    hostOf,
    isScienceDirectHost,
    isFakerHost,
    isChallengeUrl,
    detectChallenge,
    clampSettings,
    clickSeries,
    humanPointerPath,
  };
})();
