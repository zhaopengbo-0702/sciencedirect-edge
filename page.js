(() => {
  'use strict';

  const scienceDirectHosts = new Set(['www.sciencedirect.com', 'sciencedirect.com']);
  const pdfHosts = new Set(['pdf.sciencedirectassets.com', 'ars.els-cdn.com', 'ac.els-cdn.com']);
  const articlePath = /^\/science\/article\/(?:abs\/)?pii\/([a-z0-9]{8,36})\/?$/i;
  const pdfPath = /^\/science\/article\/(?:abs\/)?pii\/([a-z0-9]{8,36})\/(?:pdf|pdfft)\/?$/i;
  const mainPdfPath = /(?:^|\/)1-s2\.0-([a-z0-9]{8,36})(?:-|\/)main\.pdf$/i;
  const pdfLabel = /^(?:(?:view|download|open)(?: the)?(?: article| full.text)? pdf|pdf|下载\s*pdf|查看\s*pdf)(?:\s*(?:[,–-]\s*|\()opens? in (?:a )?new (?:tab|window)\)?)?$/i;
  const knownPdfLinks = [
    'a#pdfLink[href]',
    '.PdfDropDownMenu a[href]',
    'a.pdf-download-btn-link[href]',
    'a[download][href]',
    'a[href*="/pdfft"]',
    'a[href*="/pdf"]',
    'a[href*="main.pdf"]',
  ].join(',');
  const pdfControls = [
    '#pdfLink',
    '.PdfDropDown button',
    '.PdfDropDown [role="button"]',
    'button.pdf-download-btn',
  ].join(',');
  const pagePdfLimit = 30 * 1024 * 1024;
  let gateWatch;

  function clean(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function parseHttps(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('#')) return null;
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url;
    } catch {
      return null;
    }
    return null;
  }

  function matchingPdfUrl(rawUrl, pii) {
    const url = parseHttps(rawUrl);
    if (!url || !pii) return null;
    const isScienceDirect = scienceDirectHosts.has(url.hostname);
    const match = isScienceDirect ? pdfPath.exec(url.pathname) : mainPdfPath.exec(url.pathname);
    if ((!isScienceDirect && !pdfHosts.has(url.hostname)) || match?.[1].toUpperCase() !== pii) return null;

    const pid = url.searchParams.get('pid');
    if (isScienceDirect && pid && pid.toLowerCase() !== `1-s2.0-${pii.toLowerCase()}-main.pdf`) return null;
    url.hash = '';
    return url.href;
  }

  function isVisible(element) {
    if (!element || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(element);
    return style.visibility === 'visible' && style.opacity !== '0' && element.getClientRects().length > 0;
  }

  function controlLabel(element) {
    return clean(element.getAttribute('aria-label') || element.innerText || element.textContent);
  }

  function isVisibleAction(element) {
    return isVisible(element) && !element.matches(':disabled, [aria-disabled="true"]');
  }

  function firstOfficialPdfLink(pii, isViewer = false) {
    const selectors = isViewer ? `${knownPdfLinks}, #redirect-message a[href]` : knownPdfLinks;
    for (const link of document.querySelectorAll(selectors)) {
      if (!isVisibleAction(link)) continue;
      const url = matchingPdfUrl(link.getAttribute('href'), pii);
      if (url) return { link, url };
    }
    return null;
  }

  function embeddedPdfUrl(pii, isViewer) {
    const selectors = isViewer
      ? 'object[data], embed[src], iframe[src]'
      : '.PdfEmbed object[data], .PdfEmbed embed[src], .PdfEmbed iframe[src]';
    for (const element of document.querySelectorAll(selectors)) {
      if (!isVisible(element)) continue;
      const url = matchingPdfUrl(element.getAttribute('data') || element.getAttribute('src'), pii);
      if (url) return url;
    }
    return null;
  }

  function refreshPdfUrl(pii) {
    const content = document.querySelector('meta[http-equiv="refresh" i]')?.content || '';
    const redirect = /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.*?)\s*$/i.exec(content)?.[1];
    return matchingPdfUrl(redirect?.replace(/^(['"])(.*)\1$/, '$2'), pii);
  }

  function firstOfficialPdfControl() {
    return [...document.querySelectorAll(pdfControls)].find((element) => {
      if (!isVisibleAction(element)) return false;
      if (element.matches('a[href]') && element.getAttribute('href') !== '#') return false;
      const label = controlLabel(element);
      return pdfLabel.test(label) || (element.id === 'pdfLink' && !label);
    });
  }

  function declaredPdfUrl(control, pii) {
    if (!control) return null;
    const inlineHandler = control.getAttribute('onclick') || '';
    const handlerUrl = /^(?:(?:window\.)?location(?:\.href)?\s*=\s*|window\.open\s*\(\s*)(['"])(.*?)\1(?:\s*[,;)]|\s*$)/i.exec(inlineHandler.trim())?.[2];
    return [
      control.getAttribute('data-pdf-url'),
      control.getAttribute('data-pdf-href'),
      handlerUrl,
    ].map((value) => matchingPdfUrl(value, pii)).find(Boolean);
  }

  function isPdfMenuToggle(control) {
    if (!control || control.hasAttribute('onclick')) return false;
    const popup = control.getAttribute('aria-haspopup');
    return popup === 'true' || popup === 'menu' || popup === 'listbox' ||
      (control.hasAttribute('aria-expanded') && Boolean(control.closest('.PdfDropDown')));
  }

  function metaContent(name) {
    return clean(document.querySelector(`meta[name="${name}" i]`)?.content);
  }

  function searchSnapshot() {
    const selectors = [
      'a.result-list-title-link[href]',
      '[data-testid="result-list"] h2 a[href]',
      'main h2 a[href*="/science/article/"]',
    ].join(',');
    const seen = new Set();
    const candidates = [];
    for (const link of document.querySelectorAll(selectors)) {
      if (!isVisible(link)) continue;
      const url = parseHttps(link.getAttribute('href'));
      const pii = url && scienceDirectHosts.has(url.hostname) && articlePath.exec(url.pathname)?.[1].toUpperCase();
      const title = clean(link.innerText || link.textContent);
      if (!pii || !title || seen.has(pii)) continue;

      const result = link.closest('li, article, .result-item-content, [data-testid="search-result"]');
      const citation = result?.querySelector('.result-list-source, .publication-title, .result-list-publication');
      const authors = result?.querySelector('.result-list-authors, .authors');
      const detail = [citation, authors].map((node) => clean(node?.innerText || node?.textContent)).filter(Boolean).join(' · ');
      url.hash = '';
      seen.add(pii);
      candidates.push({ title, detail: detail.slice(0, 200), url: url.href });
      if (candidates.length === 12) break;
    }

    if (candidates.length) return { kind: 'search', candidates };
    const searchText = document.querySelector('main')?.innerText || document.body?.innerText || '';
    if (/no (?:matching )?results|0\s+(?:documents|results)\b|did not match any/i.test(searchText)) {
      return { kind: 'search', candidates };
    }
    return { kind: 'waiting' };
  }

  function gateSnapshot() {
    const firstHeading = clean(document.querySelector('h1')?.innerText);
    const headings = [firstHeading, clean(document.title)];
    const headingText = headings.join(' ');
    const challenge = document.querySelectorAll([
      '#challenge-form',
      '#cf-challenge-running',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="/recaptcha/"]',
    ].join(','));
    const verificationHeading = /^(?:are you a robot\b|(?:please )?verify (?:that )?you are human\b|sorry, we have to be sure\b|just a moment[.!… ]*(?:$|[-–|]))/i;
    if (headings.some((heading) => verificationHeading.test(heading)) || [...challenge].some((node) =>
        isVisible(node) && !node.closest('.grecaptcha-badge') && (!node.matches('iframe') || !metaContent('citation_title')))) {
      return { kind: 'challenge', reason: 'verification' };
    }
    if (/\/(?:login|sign-in|signin|remotelogin)(?:\/|$)/i.test(window.location.pathname) ||
        /^sciencedirect login\b/i.test(document.title) || /^sign in to get access\b/i.test(firstHeading)) {
      return { kind: 'access', reason: 'login' };
    }
    if (/there was a problem providing the content you requested/i.test(headingText)) return {kind: 'unavailable'};
    return null;
  }

  function inspectPage() {
    if (!document.body || document.readyState === 'loading') return { kind: 'waiting' };

    const gate = gateSnapshot();
    if (gate) return gate;

    const path = window.location.pathname;
    if (/^\/search(?:\/|$)/i.test(path)) return searchSnapshot();

    const viewerPii = pdfPath.exec(path)?.[1].toUpperCase();
    const articlePii = articlePath.exec(path)?.[1].toUpperCase();
    const pii = viewerPii || articlePii;
    if (!pii) return { kind: 'other' };

    const pdfLink = firstOfficialPdfLink(pii, Boolean(viewerPii));
    const embedUrl = embeddedPdfUrl(pii, Boolean(viewerPii));
    const heading = document.querySelector('h1 .title-text') || document.querySelector('h1');
    const articleTitle = metaContent('citation_title');
    const title = articleTitle || clean(heading?.innerText);
    const doi = metaContent('citation_doi');
    const pdfControl = firstOfficialPdfControl();
    const pdfUrl = pdfLink?.url || embedUrl || declaredPdfUrl(pdfControl, pii);
    const canClickPdf = Boolean(pdfUrl || pdfControl);

    if (viewerPii) {
      const currentUrl = matchingPdfUrl(window.location.href, pii);
      const readerUrl = [refreshPdfUrl(pii), embedUrl, pdfUrl].find((url) => url && url !== currentUrl);
      return { kind: 'viewer', pii, title, articleTitle, doi, pdfUrl: readerUrl || currentUrl, canClickPdf };
    }
    if (title && (pdfUrl || canClickPdf)) return { kind: 'article', pii, title, doi, pdfUrl, canClickPdf };
    const access = document.querySelectorAll('.accessContent, .access-options-link-text, #check-access-popover');
    if ([...access].some(isVisible)) return { kind: 'access', pii, title, reason: 'entitlement' };
    if (!title || /^(?:loading|please wait)[.\u2026]*$/i.test(title)) return { kind: 'waiting' };
    return { kind: 'article', pii, title, doi, canClickPdf: false };
  }

  function waitForPdfLink(pii, isViewer) {
    return new Promise((resolve) => {
      const findLink = () => firstOfficialPdfLink(pii, isViewer);
      const immediate = findLink();
      if (immediate) {
        resolve(immediate);
        return;
      }

      function finish(link) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(link);
      }
      const observer = new MutationObserver(() => {
        const link = findLink();
        if (link) finish(link);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      const timeout = setTimeout(() => finish(findLink()), 1200);
    });
  }

  async function resolvePdf(expectedPii) {
    const page = inspectPage();
    if (!['article', 'viewer'].includes(page.kind) || (expectedPii && page.pii !== expectedPii.toUpperCase())) {
      return { reason: page.reason || 'article_changed' };
    }
    if (page.pdfUrl) return { pdfUrl: page.pdfUrl };

    const control = firstOfficialPdfControl();
    if (!isPdfMenuToggle(control)) return { reason: 'no_pdf_link' };
    if (control.getAttribute('aria-expanded') !== 'true') control.click();
    const link = await waitForPdfLink(page.pii, page.kind === 'viewer');
    return link ? { pdfUrl: link.url } : { reason: 'no_pdf_link' };
  }

  function base64Pdf(chunks) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob(chunks, {type: 'application/pdf'}));
    });
  }

  async function readPagePdf(response) {
    if (Number(response.headers.get('content-length')) > pagePdfLimit) {
      await response.body?.cancel();
      return {ok: false, reason: 'too_large'};
    }
    if (!response.body) return {ok: false, reason: 'invalid_pdf'};

    const stream = response.body.getReader();
    const signature = new Uint8Array(5);
    const chunks = [];
    let length = 0;
    let signatureChecked = false;

    while (true) {
      const {value, done} = await stream.read();
      if (done) break;
      if (length < signature.length) signature.set(value.subarray(0, signature.length - length), length);
      length += value.byteLength;
      if (length > pagePdfLimit) {
        await stream.cancel();
        return {ok: false, reason: 'too_large'};
      }
      if (!signatureChecked && length >= signature.length) {
        if (new TextDecoder().decode(signature) !== '%PDF-') {
          await stream.cancel();
          return {ok: false, reason: 'invalid_pdf'};
        }
        signatureChecked = true;
      }
      chunks.push(value);
    }

    if (!signatureChecked) return {ok: false, reason: 'invalid_pdf'};
    return {ok: true, base64: await base64Pdf(chunks)};
  }

  async function fetchPagePdf({pii, url}) {
    const page = inspectPage();
    if (page.kind === 'access' || page.kind === 'challenge') return {ok: false, reason: page.kind};
    if (!['article', 'viewer'].includes(page.kind) || page.pii !== pii) return {ok: false, reason: 'ineligible'};

    const pdfUrl = matchingPdfUrl(url, pii);
    const viewerUrl = page.kind === 'viewer' && matchingPdfUrl(window.location.href, pii);
    if (!pdfUrl || (pdfUrl !== page.pdfUrl && pdfUrl !== viewerUrl) || new URL(pdfUrl).origin !== window.location.origin) {
      return {ok: false, reason: 'ineligible'};
    }

    try {
      const response = await fetch(pdfUrl, {
        credentials: 'same-origin',
        mode: 'same-origin',
        signal: AbortSignal.timeout(20000),
      });
      if (response.headers.get('cf-mitigated') === 'challenge') {
        await response.body?.cancel();
        return {ok: false, reason: 'pdf_blocked'};
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return {ok: false, reason: 'access'};
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        return {ok: false, reason: 'transient_response'};
      }
      if (response.status !== 200 || !matchingPdfUrl(response.url, pii)) {
        await response.body?.cancel();
        return {ok: false, reason: 'fetch_failed'};
      }
      if (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        return {ok: false, reason: 'html'};
      }
      return await readPagePdf(response);
    } catch {
      return {ok: false, reason: 'fetch_failed'};
    }
  }

  // Download inside the paper page: a hidden frame requests the official PDF
  // with the page's own session, and the background session rule turns that
  // response into an Edge download. The paper page itself never navigates and
  // no extra blank/PDF tab is opened.
  let downloadFrame;
  let downloadFrameTimer;

  function stopPageDownload() {
    clearTimeout(downloadFrameTimer);
    downloadFrameTimer = undefined;
    downloadFrame?.remove();
    downloadFrame = undefined;
  }

  function startPageDownload({ url, pii }) {
    const page = inspectPage();
    if (page.kind !== 'article' || (pii && page.pii !== pii.toUpperCase())) {
      return { ok: false, reason: 'ineligible' };
    }
    const pdfUrl = matchingPdfUrl(url, page.pii);
    if (!pdfUrl) return { ok: false, reason: 'ineligible' };

    stopPageDownload();
    const frame = document.createElement('iframe');
    frame.id = 'sd-edge-page-download';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    frame.src = pdfUrl;
    (document.body || document.documentElement).appendChild(frame);
    downloadFrame = frame;
    downloadFrameTimer = setTimeout(stopPageDownload, 120000);
    return { ok: true };
  }

  function stopWatchingGate(watchId) {
    if (!gateWatch || gateWatch.id !== watchId) return;
    gateWatch.observer.disconnect();
    clearTimeout(gateWatch.timer);
    gateWatch = undefined;
  }

  function watchGate({ watchId, expectedKind, expectedPii, expectedDoi, expectedQuery }) {
    if (typeof watchId !== 'string' || !watchId || !['search', 'paper'].includes(expectedKind)) return false;
    stopWatchingGate(gateWatch?.id);

    const watch = { id: watchId };
    function inspectAfterChange() {
      watch.timer = undefined;
      if (gateWatch !== watch) return;
      const page = inspectPage();
      const matchingPaper = ['article', 'viewer'].includes(page.kind) &&
        Boolean(page.pdfUrl || page.canClickPdf) &&
        (!expectedPii || page.pii === expectedPii.toUpperCase()) &&
        (!expectedDoi || page.doi?.toLowerCase() === expectedDoi.toLowerCase());
      const matchingSearch = page.kind === 'search' &&
        (!expectedQuery || new URLSearchParams(window.location.search).get('qs') === expectedQuery);
      if (expectedKind === 'search' ? !matchingSearch : !matchingPaper) return;

      stopWatchingGate(watchId);
      void chrome.runtime.sendMessage({ type: 'sd:page-ready', watchId }).catch(() => {});
    }

    watch.observer = new MutationObserver(() => {
      watch.timer ??= setTimeout(inspectAfterChange, 100);
    });
    gateWatch = watch;
    watch.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: [
        'class', 'style', 'href', 'src', 'content', 'hidden', 'inert',
        'aria-hidden', 'aria-label', 'disabled', 'aria-disabled',
      ],
    });
    watch.timer = setTimeout(inspectAfterChange, 0);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'sd:inspect') {
      sendResponse(inspectPage());
    } else if (message?.type === 'sd:resolve-pdf') {
      resolvePdf(message.expectedPii).then(sendResponse, () => {
        sendResponse({ reason: 'pdf_control_failed' });
      });
      return true;
    } else if (message?.type === 'sd:fetch-page-pdf') {
      void fetchPagePdf(message).then(sendResponse);
      return true;
    } else if (message?.type === 'sd:page-download-ping') {
      sendResponse({supported: true});
    } else if (message?.type === 'sd:page-download') {
      sendResponse(startPageDownload(message));
    } else if (message?.type === 'sd:stop-page-download') {
      stopPageDownload();
      sendResponse({ stopped: true });
    } else if (message?.type === 'sd:watch-gate') {
      sendResponse({ watching: watchGate(message) });
    } else if (message?.type === 'sd:stop-watch-gate') {
      stopWatchingGate(message.watchId);
      sendResponse({ watching: false });
    }
    return false;
  });
})();
