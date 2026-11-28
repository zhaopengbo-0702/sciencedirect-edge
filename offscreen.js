const downloadBlobs = new Map();
const articlePdfPath = /^\/science\/article\/(?:abs\/)?pii\/([a-z0-9]{8,36})\/(?:pdf|pdfft)\/?$/i;
const cdnPdfPath = /(?:^|\/)1-s2\.0-([a-z0-9]{8,36})(?:-|\/)main\.pdf$/i;
const articleHosts = new Set(['sciencedirect.com', 'www.sciencedirect.com']);
const cdnHosts = new Set(['pdf.sciencedirectassets.com', 'ac.els-cdn.com', 'ars.els-cdn.com']);
const maxPageBytes = 30 * 1024 * 1024;

function officialPdf(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    const isArticleHost = articleHosts.has(url.hostname);
    if (!isArticleHost && !cdnHosts.has(url.hostname)) return null;
    const pii = (isArticleHost ? articlePdfPath : cdnPdfPath).exec(url.pathname)?.[1].toUpperCase();
    if (!pii) return null;
    const pid = url.searchParams.get('pid');
    if (isArticleHost && pid && pid.toLowerCase() !== `1-s2.0-${pii.toLowerCase()}-main.pdf`) return null;
    url.hash = '';
    return {url, pii};
  } catch {
    return null;
  }
}

function revoke(blobUrl) {
  if (!downloadBlobs.has(blobUrl)) return;
  clearTimeout(downloadBlobs.get(blobUrl));
  downloadBlobs.delete(blobUrl);
  URL.revokeObjectURL(blobUrl);
}

async function storePdf(pdf) {
  if (await pdf.slice(0, 5).text() !== '%PDF-') return {ok: false, reason: 'invalid_pdf'};
  const tail = await pdf.slice(Math.max(0, pdf.size - 4096)).text();
  if (!/%%EOF[\t\n\f\r \u0000]*$/.test(tail)) return {ok: false, reason: 'invalid_pdf'};
  const blobUrl = URL.createObjectURL(pdf.slice(0, pdf.size, 'application/pdf'));
  downloadBlobs.set(blobUrl, setTimeout(() => revoke(blobUrl), 5 * 60 * 1000));
  return {ok: true, blobUrl};
}

async function readResponsePrefix(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let prefix = '';
  let remaining = 64 * 1024;
  try {
    while (remaining > 0) {
      const {done, value} = await reader.read();
      if (done) break;
      prefix += decoder.decode(value.subarray(0, remaining), {stream: true});
      remaining -= value.length;
    }
    return prefix + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function describeResponse(response, raw, expected) {
  // Inspect an inert document with resource-loading markup removed.
  const inert = raw.replace(/<\/?(?:script|img|iframe|link|audio|video|source|embed|object)\b[^>]*>/gi, '');
  const doc = new DOMParser().parseFromString(inert, 'text/html');
  const summary = `${doc.title} ${doc.querySelector('h1')?.textContent || ''} ${doc.body?.textContent || ''}`.slice(0, 65536);
  const mediaHost = cdnHosts.has(expected.url.hostname);
  const headings = [doc.title, doc.querySelector('h1')?.textContent || ''];
  if (headings.some((heading) => /^(?:are you a robot\b|(?:please )?verify (?:that )?you are human\b|sorry, we have to be sure\b|just a moment[.!… ]*$)/i.test(heading.trim())) ||
      doc.querySelector('#challenge-form, #cf-challenge-running')) {
    return {ok: false, reason: 'pdf_blocked'};
  }
  if (/expiredtoken|request has expired|(?:token|signature|link) (?:has )?expired/i.test(summary) ||
      response.status === 410 || (mediaHost && [400, 404].includes(response.status))) {
    return {ok: false, reason: 'expired'};
  }
  const final = new URL(response.url);
  if ([401, 403].includes(response.status) || /(?:login|signin|sign-in|remotelogin|purchase)/i.test(final.pathname) ||
      /access denied|forbidden|access to this article|sign in to access|get full text access/i.test(summary)) {
    return {ok: false, reason: 'access'};
  }
  if (response.status === 200 && articleHosts.has(final.hostname)) {
    const refresh = doc.querySelector('meta[http-equiv="refresh" i]')?.content || '';
    const refreshUrl = /;\s*url\s*=\s*(.+)$/i.exec(refresh)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    const linkUrl = doc.querySelector('#redirect-message a[href]')?.getAttribute('href');
    const scripts = raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
    const scriptUrls = [];
    for (const [, source] of scripts) {
      const redirects = source.matchAll(/\b(?:(?:window|document)\s*\.\s*)?location\s*\.\s*(?:href\s*=\s*|(?:replace|assign)\s*\(\s*)(["'])([^"'\r\n]+)\1/g);
      for (const redirect of redirects) scriptUrls.push(redirect[2]);
    }
    for (const candidate of [refreshUrl, linkUrl, ...scriptUrls]) {
      if (!candidate) continue;
      const target = officialPdf(candidate, final.href);
      if (target?.pii === expected.pii && target.url.href !== final.href) return {ok: false, reason: 'html_response', redirectUrl: target.url.href};
    }
  }
  return {ok: false, reason: response.status === 200 ? 'html_response' : 'fetch_failed'};
}

async function fetchPdf(url, pii) {
  const expected = officialPdf(url);
  if (!expected || (pii && pii !== expected.pii)) return {ok: false, reason: 'unsupported_url'};

  try {
    const response = await fetch(expected.url.href, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(24000),
    });
    if (response.headers.get('cf-mitigated') === 'challenge') {
      await response.body?.cancel().catch(() => {});
      return {ok: false, reason: 'pdf_blocked'};
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      return {ok: false, reason: 'rate_limited'};
    }
    const final = new URL(response.url);
    if (!articleHosts.has(final.hostname) && !cdnHosts.has(final.hostname)) {
      await response.body?.cancel().catch(() => {});
      return {ok: false, reason: 'access'};
    }

    const received = officialPdf(final.href);
    if (received && expected.pii !== received.pii) {
      await response.body?.cancel().catch(() => {});
      return {ok: false, reason: 'article_changed'};
    }

    const contentType = response.headers.get('content-type') || '';
    if (response.status !== 200 || /^(?:text\/(?:html|xml)|application\/(?:xhtml\+xml|xml|json))(?:;|$)/i.test(contentType)) {
      return describeResponse(response, await readResponsePrefix(response), expected);
    }
    if (!received) {
      await response.body?.cancel().catch(() => {});
      return {ok: false, reason: 'access'};
    }
    const pdf = await response.blob();
    const result = await storePdf(pdf);
    if (result.ok) return result;
    const prefix = await pdf.slice(0, 64 * 1024).text();
    return /^\s*(?:<!doctype\s+html|<html\b|<\?xml|<error\b)/i.test(prefix) ? describeResponse(response, prefix, expected) : result;
  } catch {
    return {ok: false, reason: 'fetch_failed'};
  }
}

async function storePagePdf(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(maxPageBytes / 3) * 4) return {ok: false, reason: 'invalid_pdf'};
  try {
    const bytes = Uint8Array.fromBase64(base64);
    if (bytes.length > maxPageBytes) return {ok: false, reason: 'invalid_pdf'};
    return await storePdf(new Blob([bytes]));
  } catch {
    return {ok: false, reason: 'invalid_pdf'};
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.target !== 'offscreen') return false;

  if (message.type === 'sd:fetch-pdf') {
    void fetchPdf(message.url, message.pii).then(sendResponse);
    return true;
  }
  if (message.type === 'sd:store-page-pdf') {
    void storePagePdf(message.base64).then(sendResponse);
    return true;
  }
  if (message.type === 'sd:release-pdf') {
    revoke(message.blobUrl);
    sendResponse({ok: true});
  }
  return false;
});
