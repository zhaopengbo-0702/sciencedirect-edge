'use strict';

const stateKey = 'downloadJob';
const watchdog = 'scienceDirectDownload';
const browserWatchdog = 'scienceDirectBrowserDownload';
const browserDownloadWindow = 15 * 60 * 1000;
const desktopHost = 'org.sciencedirect_desktop.save';
const publisher = 'https://www.sciencedirect.com';
const publisherHosts = new Set(['www.sciencedirect.com', 'sciencedirect.com']);
const pdfHosts = new Set(['pdf.sciencedirectassets.com', 'ac.els-cdn.com', 'ars.els-cdn.com']);
const articlePath = /^\/science\/article\/(?:abs\/)?pii\/([a-z0-9]{8,36})\/?$/i;
const pdfPath = /^\/science\/article\/(?:abs\/)?pii\/([a-z0-9]{8,36})\/(?:pdf|pdfft)\/?$/i;
const cdnPath = /(?:^|\/)1-s2\.0-([a-z0-9]{8,36})(?:-|\/)main\.pdf$/i;
const doiPattern = /^10\.\d{4,9}\/[^\s]+$/i;
const loadingMessage = '正在读取 ScienceDirect 页面…';
const pdfRetryDelays = [500, 1000, 2000];
const recoverablePdfReasons = new Set(['expired', 'fetch_failed', 'invalid_pdf', 'no_route']);
const popupStateKeys = ['status', 'message', 'candidates', 'tabId', 'downloadId', 'title', 'filename', 'canRetry', 'showError', 'awaitingBrowserDownload'];
let flight;
let wakeAfterFlight = false;
let actions = Promise.resolve();

function readJob() {
  return chrome.storage.session.get(stateKey).then((data) => data[stateKey] || {status: 'idle'});
}

function popupState(job) {
  return Object.fromEntries(popupStateKeys.filter((key) => key in job).map((key) => [key, job[key]]));
}

async function updateJob(job, changes) {
  const next = {...job, ...changes};
  if (next.status !== 'working') await chrome.alarms.clear(watchdog);
  await chrome.storage.session.set({[stateKey]: next});
  return next;
}

function pause(job, message, canRetry = true) {
  if (job.blobUrl) void releasePdf(job.blobUrl);
  return updateJob(job, {
    status: 'attention', message, canRetry, phase: null, blobUrl: null,
  });
}

function fail(job, message) {
  if (job.blobUrl) void releasePdf(job.blobUrl);
  return updateJob(job, {
    status: 'error', message, phase: null, blobUrl: null, awaitingBrowserDownload: false,
  });
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password) return url;
  } catch {
    return null;
  }
  return null;
}

function paperPii(url) {
  if (!url) return '';
  const match = publisherHosts.has(url.hostname) ?
    articlePath.exec(url.pathname) || pdfPath.exec(url.pathname) :
    pdfHosts.has(url.hostname) && cdnPath.exec(url.pathname);
  return match?.[1].toUpperCase() || '';
}

function officialPdf(value, pii) {
  const url = parseUrl(value);
  if (!pii || paperPii(url) !== pii) return '';
  if (publisherHosts.has(url.hostname)) {
    const pid = url.searchParams.get('pid');
    if (!pdfPath.test(url.pathname) || (pid && pid.toLowerCase() !== `1-s2.0-${pii.toLowerCase()}-main.pdf`)) return '';
  }
  url.hash = '';
  return url.href;
}

function inputTarget(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > 2000) return null;
  const value = /^(?:www\.)?sciencedirect\.com\/|^(?:dx\.)?doi\.org\//i.test(text) ? `https://${text}` : text;
  const url = parseUrl(value);
  if (url && publisherHosts.has(url.hostname)) {
    const pii = paperPii(url);
    if (!pii) return null;
    url.hash = '';
    const articleUrl = articlePath.test(url.pathname) ? url.href : `${url.origin}/science/article/pii/${pii}`;
    return {url: articleUrl, targetUrl: articleUrl, pii};
  }

  let doi = text.replace(/^doi\s*:\s*/i, '');
  if (url && ['doi.org', 'dx.doi.org'].includes(url.hostname)) {
    try {
      doi = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return null;
    }
  }
  if (doiPattern.test(doi)) {
    const doiPath = doi.split('/').map(encodeURIComponent).join('/');
    const doiUrl = `https://doi.org/${doiPath}`;
    return {url: doiUrl, targetUrl: doiUrl, doi};
  }

  if (url || /^(?:[a-z][a-z\d+.-]*:\/\/|doi\s*:)/i.test(value)) return null;
  const searchUrl = new URL('/search', publisher);
  searchUrl.searchParams.set('qs', text);
  return {url: searchUrl.href, targetUrl: searchUrl.href, query: text};
}

function normalizedTitle(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

async function navigate(job, url) {
  try {
    const tab = Number.isInteger(job.tabId) ?
      await chrome.tabs.update(job.tabId, {url}) : await chrome.tabs.create({url, active: true});
    return updateJob(job, {tabId: tab.id, phase: 'page', message: loadingMessage});
  } catch {
    return fail(job, '无法打开论文页面。请在 Edge 打开论文后再试。');
  }
}

async function listCandidates(job, results) {
  const candidates = (results || []).filter((candidate) => {
    const url = parseUrl(candidate.url);
    return url && publisherHosts.has(url.hostname) && articlePath.test(url.pathname) && candidate.title;
  });
  if (!candidates.length) {
    return fail(job, '任务结束：ScienceDirect 没有检索到这篇论文。请检查题名，或改用 DOI / 论文链接重试。');
  }

  const query = normalizedTitle(job.query);
  const exactMatches = query ? candidates.filter((candidate) => normalizedTitle(candidate.title) === query) : [];
  if (exactMatches.length === 1) return chooseCandidate(job, exactMatches[0]);
  return updateJob(job, {status: 'choose', phase: null, candidates, message: '请选择要下载的论文。'});
}

async function chooseCandidate(job, candidate) {
  const target = inputTarget(candidate.url);
  return navigate({...job, ...target, query: null, title: candidate.title, candidates: null, resumedAfterVerification: false}, target.url);
}

async function readPage(job, tabId = job.tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = parseUrl(tab.url);
    const existingPdf = officialPdf(tab.url, job.pii);
    if (tab.status === 'loading' && tab.pendingUrl && tab.pendingUrl !== tab.url) return {kind: 'waiting'};
    if (url && publisherHosts.has(url.hostname)) {
      try {
        const page = await chrome.tabs.sendMessage(tab.id, {type: 'sd:inspect'});
        if (page && typeof page === 'object' && typeof page.kind === 'string') {
          return {...page, url};
        }
        return {kind: 'waiting', url, loaded: tab.status === 'complete'};
      } catch {
        if (existingPdf && tab.status === 'complete') {
          return {kind: 'viewer', url, pdfUrl: existingPdf, pii: job.pii, uninspected: true};
        }
        return {kind: 'waiting', url, loaded: tab.status === 'complete'};
      }
    }
    if (existingPdf) return {kind: 'viewer', url, pdfUrl: existingPdf, pii: job.pii, uninspected: true};
    return {kind: 'waiting', outside: tab.status === 'complete'};
  } catch {
    return {kind: 'closed'};
  }
}

function gateMessage(page) {
  if (page.kind === 'challenge') return 'ScienceDirect 要求验证。请在论文页面完成验证，然后点「继续下载」。';
  if (page.reason === 'entitlement') return '当前页面需要全文访问权限。完成机构登录或获取权限后，可点「继续下载」。';
  if (page.kind === 'access') return '请在论文页面完成 ScienceDirect 登录，然后点「继续下载」。';
  return '';
}

function gateWatchMessage(job, type) {
  return chrome.tabs.sendMessage(job.tabId, {
    type, watchId: job.gateWatchId,
    expectedKind: job.query ? 'search' : 'paper',
    expectedPii: job.pii || '', expectedDoi: job.pii ? '' : job.doi,
    expectedQuery: job.query,
  }, {frameId: 0}).catch(() => null);
}

async function pauseAtGate(job, page, message) {
  const canWatch = page.kind === 'challenge' && (job.pii || job.doi || job.query);
  if (!canWatch) return pause(job, gateMessage(page));

  const paused = await pause({...job, gateWatchId: crypto.randomUUID()},
    message || '请在 ScienceDirect 完成验证。回到原论文或搜索结果后，扩展会自动继续。');
  await gateWatchMessage(paused, 'sd:watch-gate');
  return paused;
}

function matchesVerifiedPage(job, page) {
  if (job.query) return page.kind === 'search' && page.url?.searchParams.get('qs') === job.query;
  if (!['article', 'viewer'].includes(page.kind) || page.uninspected || (!page.pdfUrl && !page.canClickPdf)) return false;
  if (job.pii) return page.pii === job.pii;
  return Boolean(job.doi && page.doi?.toLowerCase() === job.doi.toLowerCase());
}

async function resumeJob(job, retryNavigation, resumedAfterVerification = false) {
  await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
  const next = await updateJob(job, {
    status: 'working', phase: 'page', message: loadingMessage, downloadId: null, retryNavigation,
    gateWatchId: null, pdfAttempt: 0, pdfFailure: null, pageWaits: 0, resumedAfterVerification,
  });
  if (job.gateWatchId) void gateWatchMessage(job, 'sd:stop-watch-gate');
  run(next);
  return next;
}

async function checkVerifiedPage(tabId, watchId) {
  const job = await readJob();
  if (job.status !== 'attention' || job.tabId !== tabId || !job.gateWatchId ||
      (watchId && job.gateWatchId !== watchId)) return;

  const page = await readPage(job);
  if (matchesVerifiedPage(job, page)) {
    await resumeJob(job, false, true);
  } else if (!watchId && page.kind !== 'closed') {
    // A full navigation replaces the content script and its watch.
    const watch = await gateWatchMessage(job, 'sd:watch-gate');
    if (!watch && (page.loaded || page.uninspected)) {
      await waitFor(300);
      await gateWatchMessage(job, 'sd:watch-gate');
    }
  }
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPage(job, timeout = 15000) {
  const until = Date.now() + timeout;
  let page;
  let outsideSince;
  let noControlSince;
  do {
    page = await readPage(job);
    if (!page || typeof page.kind !== 'string') page = {kind: 'waiting'};
    if (page.kind === 'article' && !page.canClickPdf && !page.pdfUrl) {
      noControlSince ??= Date.now();
      if (Date.now() - noControlSince >= 2500) return page;
    } else if (!['waiting', 'other'].includes(page.kind)) {
      return page;
    }
    if (page.outside) {
      outsideSince ??= Date.now();
      if (Date.now() - outsideSince > 3000) return page;
    } else {
      outsideSince = undefined;
    }
    if (page.kind === 'other' && !job.targetUrl) return page;
    await waitFor(300);
  } while (Date.now() < until);
  return page;
}

async function resolvePdf(job) {
  try {
    const response = await chrome.tabs.sendMessage(job.tabId, {type: 'sd:resolve-pdf', expectedPii: job.pii}, {frameId: 0});
    return officialPdf(response?.pdfUrl, job.pii);
  } catch {
    return '';
  }
}

async function pdfFilename(job) {
  const response = await chrome.runtime.sendNativeMessage(desktopHost, {action: 'name', title: job.title || ''});
  const filename = response?.filename;
  if (!response?.ok || typeof filename !== 'string' || /[\x00-\x1f<>:"/\\|?*]/.test(filename) || !filename.endsWith('.pdf')) {
    throw new Error('Failed to prepare the PDF filename.');
  }
  return filename;
}

async function openOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS'],
    justification: 'Verify the publisher PDF and hand its temporary Blob to the Edge download manager.',
  });
}

async function releasePdf(blobUrl) {
  try {
    await chrome.runtime.sendMessage({target: 'offscreen', type: 'sd:release-pdf', blobUrl});
  } catch {
    // The offscreen document may have been closed, which releases its URLs.
  }
}

async function saveVerified(job, blobUrl) {
  try {
    const filename = await pdfFilename(job);
    const pending = await updateJob(job, {phase: 'transfer', blobUrl, message: 'PDF 已校验，正在保存…'});
    const downloadId = await chrome.downloads.download({
      url: blobUrl, filename, saveAs: false, conflictAction: 'uniquify',
    });
    const tracked = await updateJob(pending, {downloadId});
    await inspectDownload(tracked);
  } catch {
    await fail({...job, blobUrl}, 'Edge 未能保存 PDF。请确认扩展已重新加载，并检查下载设置后重试。');
  }
}

async function inspectDownload(job) {
  if (!job.blobUrl) return pause(job, '此前的下载未完成 PDF 校验。请回到论文详情页后重试。');
  const byId = Number.isInteger(job.downloadId);
  const query = byId ? {id: job.downloadId} : {url: job.blobUrl};
  const [item] = await chrome.downloads.search(query);
  if (!byId && item) job = await updateJob(job, {downloadId: item.id});
  if (item?.state === 'in_progress') return;
  if (job.blobUrl) void releasePdf(job.blobUrl);
  if (item?.state !== 'complete') {
    await fail({...job, blobUrl: null}, 'Edge 下载已中断。请打开 Edge 的下载列表查看详情。');
    return;
  }
  const pending = await updateJob(job, {
    phase: 'desktop', blobUrl: null, stagedFile: item.filename,
    message: '正在把论文 PDF 保存到桌面…',
  });
  return saveToDesktop(pending);
}

async function saveToDesktop(job) {
  let response;
  try {
    response = await chrome.runtime.sendNativeMessage(desktopHost, {
      action: 'save', source: job.stagedFile, title: job.title || '',
    });
  } catch {
    // The browser has the file already. Retrying the Desktop step uses this same file.
  }
  if (!response?.ok || typeof response.path !== 'string' || !response.path) {
    if (job.browserDownload && response?.reason === 'invalid_pdf') {
      const pending = await updateJob(job, {
        status: 'attention', phase: 'manual-download', awaitingBrowserDownload: true,
        canRetry: false, downloadId: null, stagedFile: null, browserDownload: false,
        message: '刚下载的文件未通过 PDF 校验。请在 Edge PDF 阅读器中重新下载正文。',
      });
      if (Date.now() >= pending.watchDeadline) return expireBrowserWatch();
      return pending;
    }
    const message = response?.message || '当前无法保存到桌面。PDF 已下载，点「继续下载」可重试保存。';
    return updateJob(job, {status: 'attention', canRetry: true, message});
  }

  const placed = await updateJob(job, {phase: 'cleanup', filename: response.path});
  return finishDesktopSave(placed);
}

async function finishDesktopSave(job) {
  const alreadyAtDestination = job.stagedFile?.toLowerCase() === job.filename?.toLowerCase();
  if (!alreadyAtDestination && Number.isInteger(job.downloadId)) {
    try {
      await chrome.downloads.removeFile(job.downloadId);
    } catch {
      // The file may already have been removed before a worker restart.
      const result = await chrome.runtime.sendNativeMessage(desktopHost, {
        action: 'source-exists', source: job.stagedFile,
      }).catch(() => null);
      if (!result?.ok || result.exists) {
        return updateJob(job, {
          status: 'attention', canRetry: true,
          message: '论文已保存到桌面。Edge 的下载副本暂时无法清理，关闭打开的文件后可点「继续下载」重试清理。',
        });
      }
    }
  }
  if (job.browserDownload) await chrome.alarms.clear(browserWatchdog);
  return updateJob(job, {
    status: 'complete', phase: null, stagedFile: null,
    awaitingBrowserDownload: false, browserDownload: false,
    message: job.title ? `已保存到桌面《${job.title}》` : '论文 PDF 已保存到桌面。',
  });
}

async function awaitBrowserDownload(job, page) {
  const watchStartedAt = Date.now();
  const alreadyInViewer = page.kind === 'viewer' && page.pii === job.pii;
  const next = await updateJob(job, {
    status: 'attention', phase: 'manual-download', canRetry: false, awaitingBrowserDownload: true,
    watchStartedAt, watchDeadline: watchStartedAt + browserDownloadWindow,
    manualDownloadIds: [], gateWatchId: null,
    message: alreadyInViewer
      ? 'ScienceDirect 拦截了扩展的 PDF 请求。请点 Edge 阅读器右上角的下载按钮，扩展会校验并保存到桌面。'
      : 'ScienceDirect 拦截了扩展的 PDF 请求。请在论文页点「View PDF」，再点 Edge 阅读器右上角的下载按钮，扩展会校验并保存到桌面。',
  });
  await chrome.alarms.create(browserWatchdog, {when: next.watchDeadline});
  return next;
}

function matchesBrowserDownload(job, item) {
  if (!item || item.byExtensionId || item.byExtensionName || item.incognito || item.state !== 'complete' ||
      !item.exists || item.fileSize <= 0 || !/\.pdf$/i.test(item.filename || '')) return false;

  const startedAt = Date.parse(item.startTime);
  if (!Number.isFinite(startedAt) || startedAt < job.watchStartedAt || startedAt > job.watchDeadline ||
      Date.now() > job.watchDeadline) return false;
  if (!['application/pdf', 'application/octet-stream'].includes(item.mime?.toLowerCase())) return false;
  const source = parseUrl(item.url);
  const sourcePii = paperPii(source);
  if (sourcePii && sourcePii !== job.pii) return false;
  if (!officialPdf(item.finalUrl || item.url, job.pii)) return false;

  if (!officialPdf(item.url, job.pii) && !(source && publisherHosts.has(source.hostname) && sourcePii === job.pii)) return false;
  if (!item.referrer) return true;
  const referrer = parseUrl(item.referrer);
  return Boolean(referrer && (paperPii(referrer) === job.pii ||
    (referrer.pathname === '/' && (publisherHosts.has(referrer.hostname) || pdfHosts.has(referrer.hostname)))));
}

async function captureBrowserDownload(id) {
  const job = await readJob();
  if (job.status !== 'attention' || job.phase !== 'manual-download' || !job.awaitingBrowserDownload ||
      job.manualDownloadIds.includes(id)) return;
  const [item] = await chrome.downloads.search({id});
  if (!matchesBrowserDownload(job, item)) return;

  await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
  const next = await updateJob(job, {
    status: 'working', phase: 'desktop', awaitingBrowserDownload: false, browserDownload: true,
    downloadId: id, stagedFile: item.filename, manualDownloadIds: [...job.manualDownloadIds, id],
    message: '正在校验 Edge 下载的 PDF 并保存到桌面…',
  });
  run(next);
}

async function expireBrowserWatch() {
  const job = await readJob();
  if (job.status !== 'attention' || job.phase !== 'manual-download' || Date.now() < job.watchDeadline) return;
  return updateJob(job, {
    phase: null, awaitingBrowserDownload: false, canRetry: false,
    message: '等待 Edge 下载已超时。需要自动保存到桌面时，请重新提交这篇论文。',
  });
}

function canonicalArticle(pii) {
  return `${publisher}/science/article/pii/${pii}`;
}

async function titleForReader(job, page) {
  if (page.articleTitle || job.title) return page.articleTitle || job.title;

  for (const tab of await chrome.tabs.query({})) {
    const url = parseUrl(tab.url);
    if (!url || !publisherHosts.has(url.hostname) || !articlePath.test(url.pathname) || paperPii(url) !== job.pii) continue;
    const article = await readPage(job, tab.id);
    if (article.pii === job.pii && article.title) return article.title;
  }
  return '';
}

async function pagePdfBytes(job, page, url) {
  if (page.uninspected || new URL(url).origin !== page.url?.origin) return null;
  try {
    return await chrome.tabs.sendMessage(job.tabId, {
      type: 'sd:fetch-page-pdf', pii: job.pii, url,
    }, {frameId: 0});
  } catch {
    return null;
  }
}

async function fetchPdf(job, page, url) {
  try {
    await openOffscreen();
    const pageResult = await pagePdfBytes(job, page, url);
    if (pageResult?.ok && pageResult.base64) {
      return await chrome.runtime.sendMessage({target: 'offscreen', type: 'sd:store-page-pdf', base64: pageResult.base64});
    }
    if (['access', 'challenge', 'pdf_blocked', 'rate_limited'].includes(pageResult?.reason)) return pageResult;
    if (pageResult?.reason === 'transient_response') return {ok: false, reason: 'fetch_failed'};
    return await chrome.runtime.sendMessage({target: 'offscreen', type: 'sd:fetch-pdf', url, pii: job.pii});
  } catch {
    return {ok: false, reason: 'fetch_failed'};
  }
}

async function renderedPdf(job, page) {
  const url = officialPdf(page.pdfUrl, job.pii);
  if (url || page.kind !== 'article' || !page.canClickPdf) return url;
  const resolved = await resolvePdf(job);
  return resolved || `${canonicalArticle(job.pii)}/pdfft?isDTMRedir=true&download=true`;
}

async function verifyPdfRoute(job, page, url, attempted) {
  let result = {ok: false, reason: 'no_route'};
  let nextUrl = officialPdf(url, job.pii);
  while (nextUrl && !attempted.has(nextUrl) && attempted.size < 4) {
    attempted.add(nextUrl);
    result = await fetchPdf(job, page, nextUrl) || {ok: false, reason: 'fetch_failed'};
    if (result.ok || ['access', 'challenge', 'pdf_blocked', 'expired', 'article_changed', 'rate_limited'].includes(result.reason)) return result;
    nextUrl = officialPdf(result.redirectUrl, job.pii);
  }
  return result;
}

async function refetchFromArticle(job) {
  const article = await readPage(job);
  if (['challenge', 'access'].includes(article.kind)) return {ok: false, reason: article.kind};
  if (article.kind === 'unavailable') return {ok: false, reason: 'page_unavailable'};
  if (!['article', 'viewer'].includes(article.kind)) return {ok: false, reason: 'no_route'};
  if (article.pii !== job.pii || (job.doi && article.doi && article.doi.toLowerCase() !== job.doi.toLowerCase())) {
    return {ok: false, reason: 'article_changed'};
  }

  let url = await renderedPdf(job, article);
  if (job.expiredPdfUrls?.includes(url) && article.canClickPdf) {
    url = `${canonicalArticle(job.pii)}/pdfft?isDTMRedir=true&download=true`;
  }
  return verifyPdfRoute(job, article, url, new Set());
}

async function showPdfFailure(job, reason) {
  if (['challenge', 'pdf_blocked', 'access'].includes(reason)) {
    const page = await readPage(job);
    if (['challenge', 'access'].includes(page.kind)) {
      return pauseAtGate(job, page);
    }
    if (reason !== 'access') return enqueueAction(() => awaitBrowserDownload(job, page));
    return pause(job, 'ScienceDirect 拒绝了全文 PDF 请求。请在论文详情页检查机构登录和全文权限，再点「继续下载」。');
  }
  if (reason === 'rate_limited') return pause(job, 'ScienceDirect 暂时限制了请求频率。请稍候再点「继续下载」。');
  if (reason === 'page_unavailable') return pause(job, 'ScienceDirect 暂时无法打开论文页。请稍后刷新论文页，再试一次。');
  if (reason === 'expired') return pause(job, '这篇论文的 PDF 链接已失效。请重新打开论文详情页，再点「下载当前页 PDF」。');
  if (reason === 'no_route') return pause(job, '当前论文页面没有可用的 PDF 下载入口。请检查 ScienceDirect 的全文访问权限。');
  if (reason === 'article_changed') return fail(job, '链接指向了另一篇论文。请确认论文后重新提交。');
  if (reason === 'fetch_failed') return pause(job, '暂时无法完整获取论文 PDF。请检查网络连接，或从论文详情页重试。');
  return pause(job, 'ScienceDirect 当前返回的内容无法验证为论文 PDF。请在论文详情页确认 PDF 可以打开，再点「继续下载」。');
}

async function verifyWithRecovery(job, page) {
  let lastReason = job.pdfFailure || 'fetch_failed';
  for (let attempt = (job.pdfAttempt || 0) + 1; attempt <= pdfRetryDelays.length + 1; attempt += 1) {
    job = await updateJob(job, {
      pdfAttempt: attempt,
      message: attempt === 1 ? '正在验证论文 PDF…' : `正在重新获取论文 PDF（重试 ${attempt - 1}/${pdfRetryDelays.length}）…`,
    });

    let result;
    if (attempt === 1 && page) {
      const url = await renderedPdf(job, page);
      const attempted = new Set();
      result = await verifyPdfRoute(job, page, url, attempted);
      if (result.reason === 'expired') job = {...job, expiredPdfUrls: [...attempted]};
    } else {
      await waitFor(pdfRetryDelays[attempt - 2] || 0);
      result = await refetchFromArticle(job);
    }
    if (result?.ok && result.blobUrl) return saveVerified(job, result.blobUrl);
    const reason = result?.reason || 'fetch_failed';
    if (!recoverablePdfReasons.has(reason)) return showPdfFailure(job, reason);

    // Keep an explicit expiry diagnosis if reloading the article only found an absent PDF control.
    if (reason !== 'no_route' || lastReason !== 'expired') lastReason = reason;
    job = await updateJob(job, {pdfFailure: lastReason});
  }
  return showPdfFailure(job, lastReason);
}

async function downloadPaper(job, page) {
  if (job.pii && job.pii !== page.pii) return fail(job, '页面已切换到另一篇论文。请确认论文后重新提交。');
  if (job.doi && page.doi && job.doi.toLowerCase() !== page.doi.toLowerCase()) {
    return fail(job, '打开的论文与输入的 DOI 不一致。请核对 DOI。');
  }

  const paper = {...job, pii: page.pii, targetUrl: job.targetUrl || canonicalArticle(page.pii)};
  const title = page.kind === 'viewer' ? await titleForReader(paper, page) : page.title || job.title;
  if (!title) return pause(paper, '暂时无法读取论文完整标题。请打开这篇论文的详情页，再点「下载当前页 PDF」。');
  const next = await updateJob(paper, {
    title, phase: 'download', pdfAttempt: 0, pdfFailure: null, expiredPdfUrls: null, message: '正在验证论文 PDF…',
  });
  return verifyWithRecovery(next, page);
}

async function processJob(job) {
  if (job.phase === 'transfer') return inspectDownload(job);
  if (job.phase === 'desktop') return saveToDesktop(job);
  if (job.phase === 'cleanup') return finishDesktopSave(job);
  if (job.phase === 'download' && job.pii && job.title) return verifyWithRecovery(job);
  if (job.phase !== 'page') return pause(job, '上次操作中断了。请回到论文页面后点「继续下载」。');

  let page = await waitForPage(job);
  if (job.retryNavigation && page.kind === 'other') {
    job = await navigate({...job, retryNavigation: false}, job.targetUrl);
    if (job.status !== 'working') return;
    page = await waitForPage(job);
  }
  if (page.kind === 'waiting') {
    const tab = await chrome.tabs.get(job.tabId).catch(() => null);
    const waits = (Number.isInteger(job.pageWaits) ? job.pageWaits : 0) + 1;
    if (tab && tab.status === 'loading' && waits <= 20) {
      await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
      return updateJob(job, {
        status: 'working', phase: 'page', pageWaits: waits,
        message: '正在等待 ScienceDirect 页面加载完成…',
      });
    }
    if (waits > 20) {
      return pause(job, 'ScienceDirect 页面加载超时。请检查网络后刷新页面，或点「继续下载」重试。');
    }
  }
  if (['challenge', 'access'].includes(page.kind)) {
    return pauseAtGate(job, page);
  }
  if (page.kind === 'unavailable') return showPdfFailure(job, 'page_unavailable');
  if (page.kind === 'closed') return pause(job, '论文标签页已关闭。请重新打开论文后再下载。');
  if (job.resumedAfterVerification && !matchesVerifiedPage(job, page)) {
    return pause(job, '原论文或搜索页已切换。请回到原页面后点「继续下载」。');
  }
  if (page.kind === 'search' && job.query) return listCandidates(job, page.candidates);
  if (['article', 'viewer'].includes(page.kind) && !job.query) return downloadPaper(job, page);
  if (page.outside) {
    if (!job.targetUrl) return pause(job, '请在 Edge 打开 ScienceDirect 的论文详情页，再点「下载当前页 PDF」。', false);
    return pause(job, '目标页可能停留在登录或跳转步骤，或该 DOI 由其他平台提供。请打开目标标签页查看。');
  }
  if (job.query) return fail(job, '任务结束：ScienceDirect 搜索页没有加载出论文结果。请检查网络，或改用 DOI / 论文链接重试。');
  if (page.loaded && paperPii(page.url)) return pause(job, '浏览器未能读取此页面。若已显示 PDF，可在阅读器里下载。');
  return pause(job, '请在 Edge 打开 ScienceDirect 的论文详情页，再点「下载当前页 PDF」。', Boolean(job.targetUrl));
}

function run(job) {
  if (job.status !== 'working') return;
  if (flight) {
    wakeAfterFlight = true;
    return;
  }
  flight = (async () => {
    try {
      let current = job;
      while (current.status === 'working') {
        await processJob(current);
        const following = await readJob();
        // Automatic exact-title resolution moves the same job to a new article.
        if (following.phase !== 'page' || following.targetUrl === current.targetUrl) break;
        current = following;
      }
    } catch {
      await fail(await readJob(), '下载过程遇到问题。请打开论文页面后重试。');
    } finally {
      flight = null;
      if (wakeAfterFlight) {
        wakeAfterFlight = false;
        void readJob().then(run);
      }
    }
  })();
}

async function start(job, message) {
  if (job.status === 'working') return job;
  if (job.gateWatchId) void gateWatchMessage(job, 'sd:stop-watch-gate');
  if (job.watchDeadline) await chrome.alarms.clear(browserWatchdog);
  const fresh = {
    status: 'working', phase: 'page', message: loadingMessage,
  };
  if (message.mode === 'current') {
    if (!Number.isInteger(message.tabId)) return fail(fresh, '请先在 Edge 打开 ScienceDirect 论文。');
    fresh.tabId = message.tabId;
    const tab = await chrome.tabs.get(message.tabId).catch(() => null);
    const url = parseUrl(tab?.url);
    if (url && paperPii(url)) {
      fresh.pii = paperPii(url);
      if (fresh.pii === job.pii) fresh.title = job.title;
      url.hash = '';
      fresh.targetUrl = publisherHosts.has(url.hostname) && articlePath.test(url.pathname) ?
        url.href : `${publisher}/science/article/pii/${fresh.pii}`;
    }
  } else {
    const target = inputTarget(message.input);
    if (!target) return fail(fresh, '请输入论文题名、DOI 或 ScienceDirect 论文链接。');
    Object.assign(fresh, target);
  }

  await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
  const next = message.mode === 'current' ? await updateJob(fresh, {}) : await navigate(fresh, fresh.url);
  run(next);
  return next;
}

async function action(message) {
  const job = await readJob();
  if (message.type === 'start') return start(job, message);
  if (message.type === 'choose' && job.status === 'choose') {
    const candidate = job.candidates?.[message.index];
    if (!candidate) return job;
    await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
    const next = await chooseCandidate({...job, status: 'working'}, candidate);
    run(next);
    return next;
  }
  if (message.type === 'retry' && job.status === 'attention' && job.canRetry !== false) {
    if (['desktop', 'cleanup'].includes(job.phase)) {
      await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
      const message = job.phase === 'cleanup' ? '正在清理 Edge 的下载副本…' : '正在把论文 PDF 保存到桌面…';
      const next = await updateJob(job, {status: 'working', message});
      run(next);
      return next;
    }
    return resumeJob(job, Boolean(job.targetUrl));
  }
  if (message.type === 'show' && job.status === 'complete' && job.filename) {
    const response = await chrome.runtime.sendNativeMessage(desktopHost, {action: 'show', path: job.filename}).catch(() => null);
    return {...job, showError: response?.ok ? '' : '未能在资源管理器定位文件。请在桌面查找论文 PDF。'};
  }
  if (message.type === 'focus' && Number.isInteger(job.tabId)) {
    const tab = await chrome.tabs.update(job.tabId, {active: true}).catch(() => null);
    if (!tab) return fail(job, '论文标签页已关闭。请重新提交。');
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, {focused: true});
  }
  return job;
}

function enqueueAction(callback) {
  const result = actions.then(callback);
  actions = result.catch(() => {});
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target || !message?.type || sender.id !== chrome.runtime.id) return false;
  if (message.type === 'sd:page-ready') {
    const url = parseUrl(sender.url);
    if (sender.frameId === 0 && Number.isInteger(sender.tab?.id) && url && publisherHosts.has(url.hostname) &&
        typeof message.watchId === 'string' && message.watchId) {
      void enqueueAction(() => checkVerifiedPage(sender.tab.id, message.watchId));
    }
    return false;
  }
  // The docked helper panel (content script on ScienceDirect pages) may use
  // the same status/action messages as the toolbar popup.
  const panelUrl = Number.isInteger(sender.tab?.id) && sender.frameId === 0 ? parseUrl(sender.url) : null;
  const fromPanel = Boolean(panelUrl && publisherHosts.has(panelUrl.hostname));
  if (!fromPanel && sender.url !== chrome.runtime.getURL('popup.html')) return false;
  if (fromPanel) {
    if (!['status', 'start', 'choose', 'retry', 'show', 'focus'].includes(message.type)) return false;
    if (message.type === 'start' && message.mode === 'current' && !Number.isInteger(message.tabId)) {
      message = {...message, tabId: sender.tab.id};
    }
  }
  if (message.type === 'status') {
    void readJob().then((job) => sendResponse({state: popupState(job)}));
    return true;
  }

  const result = enqueueAction(() => action(message));
  void result.then((job) => sendResponse({state: popupState(job)}), () => {
    sendResponse({state: {status: 'error', message: '扩展未能完成当前操作。请重试。'}});
  });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'complete') void enqueueAction(() => checkVerifiedPage(tabId));
});

chrome.downloads.onCreated.addListener((item) => {
  if (item.state === 'complete') void enqueueAction(() => captureBrowserDownload(item.id));
});

chrome.downloads.onChanged.addListener(({id, state}) => {
  if (!state) return;
  void readJob().then((job) => {
    if (job.phase === 'transfer' && id === job.downloadId) run(job);
    else if (state.current === 'complete' && job.phase === 'manual-download') {
      void enqueueAction(() => captureBrowserDownload(id));
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === watchdog) void readJob().then(run);
  if (alarm.name === browserWatchdog) void enqueueAction(expireBrowserWatch);
});
