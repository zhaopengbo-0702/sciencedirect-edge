'use strict';

// Cloudflare Faker modules. faker-core.js holds the shared, DOM-free helpers;
// faker-background.js runs the verification sessions (chrome.debugger clicks).
try {
  importScripts('faker-core.js', 'faker-background.js');
} catch (error) {
  console.error('Cloudflare Faker modules failed to load; automatic verification is disabled.', error);
}

const fakerAlarmPrefix = 'sd-faker-';
// Automatic recovery: when a download stops for a recoverable reason the job
// retries itself instead of waiting for a manual click. Only active while the
// Cloudflare Faker setting is enabled, so switching it off keeps v1.2.6
// behaviour exactly.
const autoRecoverAlarm = 'scienceDirectAutoRecover';
const autoRecoverDelays = [15000, 30000, 60000, 120000];
// Verification failures retry for much longer: Cloudflare challenges can take
// a while to clear, and the user explicitly wants no manual intervention.
const autoVerificationDelays = [15000, 30000, 60000, 120000, 180000, 300000, 300000, 300000];
const autoDownloadRetries = 3;
const autoDownloadRetryDelay = 25000;
const stateKey = 'downloadJob';
const watchdog = 'scienceDirectDownload';
const browserWatchdog = 'scienceDirectBrowserDownload';
const browserDownloadWindow = 15 * 60 * 1000;
const readerDownloadRuleIds = [1, 2, 3];
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
const popupStateKeys = ['status', 'message', 'candidates', 'tabId', 'readerTabId', 'downloadId', 'title', 'filename', 'canRetry', 'showError', 'awaitingBrowserDownload'];
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
  if (next.status === 'attention') void scheduleAutoRecovery(next);
  else void chrome.alarms.clear(autoRecoverAlarm).catch(() => {});
  return next;
}

function pause(job, message, canRetry = true) {
  if (job.blobUrl) void releasePdf(job.blobUrl);
  return updateJob(job, {
    status: 'attention', message, canRetry, phase: null, blobUrl: null, faker: null,
    pausedFromPhase: job.phase || null, autoRecoverNotice: false,
  });
}

function fail(job, message) {
  if (job.blobUrl) void releasePdf(job.blobUrl);
  if (Number.isInteger(job.readerTabId)) void closeReaderTab(job, {force: true});
  stopFakerQuietly();
  return updateJob(job, {
    status: 'error', message, phase: null, blobUrl: null, faker: null,
    readerTabId: null, awaitingBrowserDownload: false,
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
        // Other content scripts (e.g. the Cloudflare Faker watcher) may also be
        // listening, in which case sendMessage can resolve with `undefined`
        // before page.js is injected. Treat that as "still loading" instead of
        // misreading the tab as a page without content.
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

async function resumeJob(job, retryNavigation, resumedAfterVerification = false,
    resetAutoRecover = true, autoRecoverCount = 0) {
  await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
  const next = await updateJob(job, {
    status: 'working', phase: 'page', message: loadingMessage, downloadId: null, retryNavigation,
    gateWatchId: null, pdfAttempt: 0, pdfFailure: null, pageWaits: 0,
    resumedAfterVerification, faker: null,
    pausedFromPhase: null, autoRecoverNotice: false, autoRecoverExhausted: false,
    autoRecoverCount: resetAutoRecover ? 0 : autoRecoverCount,
    autoDownloadRetryCount: resetAutoRecover ? 0 : (Number.isInteger(job.autoDownloadRetryCount) ? job.autoDownloadRetryCount : 0),
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
  await closeReaderTab(job, {force: true});
  stopFakerQuietly();
  return updateJob(job, {
    status: 'complete', phase: null, stagedFile: null, readerTabId: null,
    awaitingBrowserDownload: false, browserDownload: false,
    message: job.title ? `已保存到桌面《${job.title}》` : '论文 PDF 已保存到桌面。',
  });
}

function clearReaderDownloadRule() {
  return chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: readerDownloadRuleIds}).catch(() => {});
}

function enableReaderDownload(tabId, url, pii, filename) {
  const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const destinations = [
    {requestDomains: [...pdfHosts], urlFilter: `/1-s2.0-${pii}/main.pdf^`},
    {requestDomains: [...pdfHosts], urlFilter: `/1-s2.0-${pii}-main.pdf^`},
  ];
  if (publisherHosts.has(new URL(url).hostname)) destinations.push({urlFilter: `|${url}|`});
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: readerDownloadRuleIds,
    addRules: destinations.map((destination, index) => ({
      id: readerDownloadRuleIds[index],
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{header: 'content-disposition', operation: 'set', value: `attachment; filename*=UTF-8''${encodedFilename}`}],
      },
      condition: {
        tabIds: [tabId],
        resourceTypes: ['main_frame'],
        ...destination,
        responseHeaders: [{header: 'content-type', values: ['application/pdf', 'application/pdf;*']}],
        excludedResponseHeaders: [{header: 'content-range'}],
      },
    })),
  });
}

async function closeReaderTab(job, options = {}) {
  if (!Number.isInteger(job?.readerTabId) || job.readerTabId === job.tabId) return;
  const tab = await chrome.tabs.get(job.readerTabId).catch(() => null);
  if (!tab) return;
  const url = tab.url || tab.pendingUrl || '';
  const disposable = options.force === true || !url || url === 'about:blank' ||
    /^(?:chrome-extension|edge):\/\//i.test(url);
  if (!disposable) return;
  await chrome.tabs.remove(job.readerTabId).catch(() => {});
  if (Number.isInteger(job.tabId)) await chrome.tabs.update(job.tabId, {active: true}).catch(() => {});
}

async function awaitBrowserDownload(job, page) {
  const watchStartedAt = Date.now();
  if (page.kind === 'viewer' && page.pii === job.pii) {
    job = {...job, manualReader: true};
  }
  const next = await updateJob(job, {
    status: 'attention', phase: 'manual-download', canRetry: false, awaitingBrowserDownload: true,
    watchStartedAt, watchDeadline: watchStartedAt + browserDownloadWindow,
    manualDownloadIds: [], gateWatchId: null,
    message: job.manualReader
      ? 'ScienceDirect 拦截了扩展的 PDF 请求。请点 Edge 阅读器右上角的下载按钮，扩展会校验并保存到桌面。'
      : 'ScienceDirect 拦截了扩展的 PDF 请求。请在论文页点「View PDF」，再点 Edge 阅读器右上角的下载按钮，扩展会校验并保存到桌面。',
  });
  await chrome.alarms.create(browserWatchdog, {when: next.watchDeadline});
  void scheduleDownloadRetry(next);

  if (page.kind !== 'article' || page.pii !== job.pii) return next;
  const url = officialPdf(page.pdfUrl, job.pii) || await resolvePdf(job);
  if (!url) return next;

  // Register the download before navigating, so an inline PDF or immediate
  // attachment can be saved from the publisher's normal document response.
  const reader = await chrome.tabs.create({url: 'about:blank', openerTabId: job.tabId, active: false}).catch(() => null);
  if (!reader) return next;
  let automatic = true;
  try {
    const filename = await pdfFilename(job);
    await enableReaderDownload(reader.id, url, job.pii, filename);
  } catch (error) {
    console.warn('Could not configure automatic PDF attachment:', error.message);
    automatic = false;
  }
  const pending = await updateJob(next, {
    readerTabId: reader.id,
    message: automatic
      ? '已打开 ScienceDirect 的官方 PDF 链接，正在等待 Edge 下载并校验 PDF。'
      : '已打开 ScienceDirect 的官方 PDF 链接。若进入 Edge 阅读器，请点右上角「保存」。',
  });
  try {
    await chrome.tabs.update(reader.id, {url, active: true});
    return pending;
  } catch {
    await clearReaderDownloadRule();
    await chrome.tabs.remove(reader.id).catch(() => {});
    return updateJob(next, {readerTabId: null});
  }
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

  await clearReaderDownloadRule();
  await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
  await closeReaderTab(job, {force: true});
  stopFakerQuietly();
  const next = await updateJob(job, {
    status: 'working', phase: 'desktop', awaitingBrowserDownload: false, browserDownload: true,
    downloadId: id, stagedFile: item.filename, manualDownloadIds: [...job.manualDownloadIds, id],
    readerTabId: null,
    message: '正在校验 Edge 下载的 PDF 并保存到桌面…',
  });
  run(next);
}

async function expireBrowserWatch() {
  const job = await readJob();
  if (job.status !== 'attention' || job.phase !== 'manual-download' || Date.now() < job.watchDeadline) return;
  await clearReaderDownloadRule();
  await closeReaderTab(job, {force: true});
  return updateJob(job, {
    phase: null, awaitingBrowserDownload: false, canRetry: false, readerTabId: null,
    message: '等待 Edge 下载已超时。需要自动保存到桌面时，请重新提交这篇论文。',
  });
}

function canonicalArticle(pii) {
  return `${publisher}/science/article/pii/${pii}`;
}

async function withArticleTab(job, useArticle) {
  const articleTab = await chrome.tabs.create({active: false, url: canonicalArticle(job.pii)}).catch(() => null);
  if (!articleTab) return null;
  try {
    const article = await waitForPage({...job, tabId: articleTab.id}, 6000);
    return await useArticle(article, articleTab.id);
  } finally {
    await chrome.tabs.remove(articleTab.id).catch(() => {});
  }
}

async function titleForReader(job, page) {
  if (page.articleTitle || job.title) return page.articleTitle || job.title;

  for (const tab of await chrome.tabs.query({})) {
    const url = parseUrl(tab.url);
    if (!url || !publisherHosts.has(url.hostname) || !articlePath.test(url.pathname) || paperPii(url) !== job.pii) continue;
    const article = await readPage(job, tab.id);
    if (article.pii === job.pii && article.title) return article.title;
  }
  return withArticleTab(job, (article) => article.pii === job.pii ? article.title : '');
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
    if (['access', 'challenge', 'pdf_blocked'].includes(pageResult?.reason)) return pageResult;
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
    if (result.ok || ['access', 'challenge', 'pdf_blocked', 'expired', 'article_changed'].includes(result.reason)) return result;
    nextUrl = officialPdf(result.redirectUrl, job.pii);
  }
  return result;
}

async function refetchFromArticle(job) {
  return withArticleTab(job, async (article, tabId) => {
    if (['challenge', 'access'].includes(article.kind)) return {ok: false, reason: article.kind};
    if (article.kind === 'unavailable') return {ok: false, reason: 'page_unavailable'};
    if (article.kind !== 'article') return null;
    if (article.pii !== job.pii || (job.doi && article.doi && article.doi.toLowerCase() !== job.doi.toLowerCase())) {
      return {ok: false, reason: 'article_changed'};
    }

    const articleJob = {...job, tabId};
    let url = await renderedPdf(articleJob, article);
    // When the publisher page still displays the expired signed asset, request its normal full-text entry once.
    if (job.expiredPdfUrls?.includes(url) && article.canClickPdf) {
      url = `${canonicalArticle(job.pii)}/pdfft?isDTMRedir=true&download=true`;
    }
    return verifyPdfRoute(articleJob, article, url, new Set());
  });
}

async function showPdfFailure(job, reason) {
  if (['challenge', 'pdf_blocked', 'access'].includes(reason)) {
    const page = await readPage(job);
    if (['challenge', 'access'].includes(page.kind)) {
      if (page.kind === 'challenge') {
        const started = await startFakerForJob('gate');
        if (started) return started;
      }
      return pauseAtGate(job, page);
    }
    if (reason !== 'access') return enqueueAction(() => awaitBrowserDownload(job, page));
    return pause(job, 'ScienceDirect 拒绝了全文 PDF 请求。请在论文详情页检查机构登录和全文权限，再点「继续下载」。');
  }
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

// --- Cloudflare Faker integration -----------------------------------------
// All automatic-verification work is scoped to this extension's own download
// job and to ScienceDirect hosts. With the feature disabled (or the modules
// unavailable) every code path below falls back to the pre-Faker behaviour.

function fakerEngine() {
  return globalThis.SDFakerBackground || null;
}

function fakerSettings() {
  const engine = fakerEngine();
  if (!engine) return {enabled: false, autoClick: false};
  try {
    return engine.getSettings();
  } catch {
    return {enabled: false, autoClick: false};
  }
}

function fakerLimits() {
  return globalThis.SDFakerCore?.LIMITS || {maxClicks: 6, maxReloads: 3};
}

function fakerProgressMessage(session) {
  const limits = fakerLimits();
  if (session?.phase === 'reloading') {
    return `自动验证未通过，正在刷新页面重试（${session.reloads}/${limits.maxReloads}）…`;
  }
  if (session?.clicks) {
    return `正在自动通过 Cloudflare 人机验证（点击 ${session.clicks}/${limits.maxClicks}）…`;
  }
  return '检测到 Cloudflare 人机验证，正在自动通过…';
}

function stopFakerQuietly() {
  try {
    fakerEngine()?.stopAll();
  } catch {
    // Automatic verification is optional; never block the download flow.
  }
}

// --- Automatic retry / self-recovery for failed downloads -----------------
// When the Faker setting is on, recoverable failures retry themselves
// (re-open the tab, re-run the download pipeline or re-open the PDF link)
// instead of stopping until the user clicks "继续下载" manually.

function fakerAutoEnabled() {
  try {
    return Boolean(fakerSettings().enabled);
  } catch {
    return false;
  }
}

async function clearAutoRecovery() {
  try {
    await chrome.alarms.clear(autoRecoverAlarm);
  } catch {
    // Ignore.
  }
}

function isVerificationFailure(job) {
  if (!job) return false;
  if (!['page', 'download'].includes(job.pausedFromPhase)) return false;
  return /验证|人机|Cloudflare|verif/i.test(job.message || '');
}

function autoRecoverDelayList(job) {
  return isVerificationFailure(job) ? autoVerificationDelays : autoRecoverDelays;
}

async function scheduleAutoRecovery(job) {
  try {
    if (!job || job.status !== 'attention') {
      await clearAutoRecovery();
      return;
    }
    if (job.awaitingBrowserDownload) return; // download waits are handled by scheduleDownloadRetry
    if (job.canRetry === false || !fakerAutoEnabled() || job.autoRecoverExhausted) {
      await clearAutoRecovery();
      return;
    }
    const delays = autoRecoverDelayList(job);
    const count = Number.isInteger(job.autoRecoverCount) ? job.autoRecoverCount : 0;
    if (count >= delays.length) {
      await clearAutoRecovery();
      if (!job.autoRecoverExhausted) {
        const exhausted = isVerificationFailure(job)
          ? '自动验证已多次自动重试仍未通过，请手动完成验证后点「继续下载」。'
          : '自动重试已结束，可点「继续下载」手动重试。';
        await chrome.storage.session.set({[stateKey]: {
          ...job, autoRecoverExhausted: true,
          message: `${job.message || '下载未完成'}（${exhausted}）`,
        }});
      }
      return;
    }
    const delay = delays[count];
    await clearAutoRecovery();
    await chrome.alarms.create(autoRecoverAlarm, {when: Date.now() + delay});
    if (!job.autoRecoverNotice) {
      const seconds = Math.max(1, Math.round(delay / 1000));
      await chrome.storage.session.set({[stateKey]: {
        ...job, autoRecoverNotice: true,
        message: `${job.message || '下载未完成'}（${seconds} 秒后自动重试）`,
      }});
    }
  } catch {
    // Auto recovery must never break the download flow.
  }
}

async function scheduleDownloadRetry(job) {
  try {
    if (!fakerAutoEnabled()) return;
    const attempts = Number.isInteger(job.autoDownloadRetryCount) ? job.autoDownloadRetryCount : 0;
    if (attempts >= autoDownloadRetries) return;
    await clearAutoRecovery();
    await chrome.alarms.create(autoRecoverAlarm, {when: Date.now() + autoDownloadRetryDelay});
  } catch {
    // Ignore.
  }
}

async function runAutoRecovery() {
  const job = await readJob();
  if (!job || job.status !== 'attention' || !fakerAutoEnabled()) return;
  if (job.awaitingBrowserDownload) return retryManualDownload(job);
  if (job.canRetry === false || job.autoRecoverExhausted) return;
  const delays = autoRecoverDelayList(job);
  const count = Number.isInteger(job.autoRecoverCount) ? job.autoRecoverCount : 0;
  if (count >= delays.length) return;
  const attempt = count + 1;
  const label = `下载未完成，正在自动重试（第 ${attempt}/${delays.length} 次）…`;
  const phase = job.pausedFromPhase || job.phase;
  if (phase === 'manual-download') return retryManualDownload(job);
  await clearAutoRecovery();

  const tab = Number.isInteger(job.tabId) ? await chrome.tabs.get(job.tabId).catch(() => null) : null;
  if (!tab && job.targetUrl) {
    // The paper tab was closed: open it again and continue the same job.
    const created = await chrome.tabs.create({url: job.targetUrl, active: true}).catch(() => null);
    if (!created) {
      return updateJob(job, {
        canRetry: true, autoRecoverExhausted: true,
        message: '下载失败，且无法自动重新打开论文页。请手动重试。',
      });
    }
    const next = await updateJob(
      {...job, tabId: created.id, gateWatchId: null, downloadId: null, blobUrl: null},
      {status: 'working', phase: 'page', message: label, autoRecoverCount: attempt, autoRecoverNotice: false},
    );
    run(next);
    return;
  }
  if (!phase || phase === 'page') {
    return resumeJob(job, Boolean(job.targetUrl), false, false, attempt);
  }
  await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
  const targetPhase = ['download', 'transfer', 'desktop', 'cleanup'].includes(phase) ? phase : 'page';
  const next = await updateJob(job, {
    status: 'working', phase: targetPhase, message: label,
    autoRecoverCount: attempt, autoRecoverNotice: false,
  });
  run(next);
}

async function retryManualDownload(job) {
  try {
    const attempts = (Number.isInteger(job.autoDownloadRetryCount) ? job.autoDownloadRetryCount : 0) + 1;
    await clearAutoRecovery();
    await chrome.alarms.clear(browserWatchdog);
    if (attempts > autoDownloadRetries) {
      return updateJob(job, {
        canRetry: true, autoRecoverExhausted: true,
        message: '自动重试多次仍未触发 Edge 下载。请在论文页点「View PDF」，再点阅读器右上角下载按钮；或点「继续下载」重试保存。',
      });
    }
    if (Number.isInteger(job.readerTabId)) await chrome.tabs.remove(job.readerTabId).catch(() => {});
    await clearReaderDownloadRule();
    const next = await updateJob(job, {
      status: 'working', phase: 'page', readerTabId: null, awaitingBrowserDownload: false,
      manualReader: false, autoDownloadRetryCount: attempts, autoRecoverNotice: false,
      message: `正在自动重试 PDF 下载（第 ${attempts}/${autoDownloadRetries} 次）…`,
    });
    run(next);
    return next;
  } catch {
    return updateJob(job, {
      canRetry: true,
      message: '自动重试 PDF 下载失败。请在论文页重新点「View PDF」下载，或点「继续下载」。',
    });
  }
}

// The reader tab falling back to Edge's PDF viewer (or a viewer error page)
// means the attachment download did not start; recover automatically instead
// of leaving the "未能加载 PDF 文档" dialog for the user to handle.
async function detectReaderViewerFailure(tabId, url) {
  try {
    if (!/^(?:chrome-extension:\/\/|edge:\/\/pdf)/i.test(url || '')) return;
    const job = await readJob();
    if (job.status !== 'attention' || job.phase !== 'manual-download' ||
        job.awaitingBrowserDownload !== true || job.readerTabId !== tabId) return;
    // Give a real attachment download a moment to be captured first.
    await waitFor(1500);
    const latest = await readJob();
    if (latest.status !== 'attention' || latest.phase !== 'manual-download' ||
        latest.awaitingBrowserDownload !== true || latest.downloadId) return;
    await retryManualDownload(latest);
  } catch {
    // Recovery is best effort; the manual fallback stays available.
  }
}

function fakerRecoveryFields(job, tabId) {
  if (!job.faker || job.faker.tabId !== tabId) return {};
  return {
    sessionId: job.faker.sessionId,
    clicks: Number.isInteger(job.faker.clicks) ? job.faker.clicks : 0,
    reloads: Number.isInteger(job.faker.reloads) ? job.faker.reloads : 0,
  };
}

async function startFakerForJob(reason) {
  const engine = fakerEngine();
  if (!engine || !fakerSettings().enabled) return null;
  const job = await readJob();
  const tabId = reason === 'reader' ? job.readerTabId : job.tabId;
  if (!Number.isInteger(tabId)) return null;

  let session = engine.sessionForTab(tabId);
  if (!session) {
    session = await engine.start({tabId, reason, ...fakerRecoveryFields(job, tabId)}).catch(() => null);
  }
  if (!session) return null;

  const faker = {
    sessionId: session.id, tabId, reason,
    startedAt: session.startedAt, clicks: session.clicks || 0, reloads: session.reloads || 0,
  };
  if (job.faker?.sessionId === session.id) return updateJob(job, {message: fakerProgressMessage(session)});
  return updateJob(job, {faker, message: fakerProgressMessage(session)});
}

async function autoStartFakerFromContent(tab, state) {
  const engine = fakerEngine();
  if (!engine || !fakerSettings().enabled || !state?.detected) return;
  if (!tab || !Number.isInteger(tab.id) || engine.sessionForTab(tab.id)) return;
  const source = parseUrl(tab.url);
  if (!source || !(publisherHosts.has(source.hostname) || pdfHosts.has(source.hostname))) return;

  const job = await readJob();
  const isGate = job.status === 'working' && ['page', 'download'].includes(job.phase) && job.tabId === tab.id;
  const isReader = job.status === 'attention' && job.phase === 'manual-download' &&
    job.awaitingBrowserDownload === true && job.readerTabId === tab.id;
  if (!isGate && !isReader) {
    // No download job is waiting on this tab, but a ScienceDirect page is
    // showing a verification challenge: solve it anyway so the user never has
    // to tick the box manually while browsing or after a job finished.
    await engine.start({tabId: tab.id, reason: 'standalone'}).catch(() => null);
    return;
  }

  const reason = isGate ? 'gate' : 'reader';
  const session = await engine.start({tabId: tab.id, reason, ...fakerRecoveryFields(job, tab.id)}).catch(() => null);
  if (!session) return;

  const latest = await readJob();
  const stillGate = latest.status === 'working' && ['page', 'download'].includes(latest.phase) && latest.tabId === tab.id;
  const stillReader = latest.status === 'attention' && latest.phase === 'manual-download' &&
    latest.awaitingBrowserDownload === true && latest.readerTabId === tab.id;
  if (!(reason === 'gate' ? stillGate : stillReader) || latest.faker?.sessionId === session.id) return;
  await updateJob(latest, {
    faker: {
      sessionId: session.id, tabId: tab.id, reason,
      startedAt: session.startedAt, clicks: session.clicks || 0, reloads: session.reloads || 0,
    },
    message: fakerProgressMessage(session),
  });
}

async function continueAfterFakerCleared(job) {
  const cleared = {...job, faker: null};
  if (cleared.phase === 'download' && cleared.pii && cleared.title) {
    const page = await readPage(cleared);
    if (page.kind === 'challenge') {
      const restarted = await startFakerForJob('gate');
      if (restarted) return restarted;
      return pauseAtGate(cleared, page);
    }
    await chrome.alarms.create(watchdog, {periodInMinutes: 0.5});
    const next = await updateJob(cleared, {
      status: 'working', message: 'Cloudflare 验证已通过，正在继续验证论文 PDF…',
    });
    run(next);
    return next;
  }

  const page = await waitForPage(cleared, 8000);
  if (page.kind === 'closed') return pause(cleared, '论文标签页已关闭，正在尝试自动重新打开…');
  if (page.kind === 'waiting') return resumeJob(cleared, false, true);
  if (['challenge', 'access'].includes(page.kind)) {
    if (page.kind === 'challenge') {
      const restarted = await startFakerForJob('gate');
      if (restarted) return restarted;
    }
    return pauseAtGate(cleared, page);
  }
  if (matchesVerifiedPage(cleared, page)) return resumeJob(cleared, false, true);
  return pause(cleared, 'Cloudflare 验证已通过，但页面尚未回到目标论文页。请确认页面后点「继续下载」。');
}

function initFaker() {
  const engine = fakerEngine();
  if (!engine || typeof engine.init !== 'function') return;
  engine.init({
    async onSessionStart(session) {
      const job = await readJob();
      if (!job.faker || job.faker.sessionId !== session.id) return;
      await updateJob(job, {message: fakerProgressMessage(session)});
    },
    async onSessionProgress(session) {
      const job = await readJob();
      if (!job.faker || job.faker.sessionId !== session.id) return;
      const faker = {
        ...job.faker,
        clicks: session.clicks || 0,
        reloads: session.reloads || 0,
        phase: session.phase || job.faker.phase,
      };
      const active = (job.status === 'working' && ['page', 'download'].includes(job.phase)) ||
        (job.status === 'attention' && job.phase === 'manual-download');
      const changes = {faker};
      if (active) {
        const message = fakerProgressMessage(session);
        if (message && message !== job.message) changes.message = message;
      }
      const countersChanged = job.faker.clicks !== faker.clicks ||
        job.faker.reloads !== faker.reloads || job.faker.phase !== faker.phase;
      if (!countersChanged && !changes.message) return;
      await updateJob(job, changes);
    },
    async onCleared(session) {
      const job = await readJob();
      if (job.faker?.sessionId !== session.id) return;
      const cleared = {...job, faker: null};
      if (session.reason === 'reader') {
        if (cleared.status === 'attention' && cleared.phase === 'manual-download') {
          await updateJob(cleared, {
            message: cleared.awaitingBrowserDownload ?
              'Cloudflare 验证已通过，等待 Edge 下载…' : cleared.message,
          });
        } else {
          await updateJob(cleared, {});
        }
        return;
      }
      await continueAfterFakerCleared(cleared);
    },
    async onFailed(session, reason) {
      const job = await readJob();
      if (job.faker?.sessionId !== session.id) return;
      const cleaned = {...job, faker: null};
      if (session.reason === 'reader') {
        if (cleaned.status !== 'attention' || cleaned.phase !== 'manual-download') {
          await updateJob(cleaned, {});
          return;
        }
        if (['no_target', 'timeout', 'tab_closed', 'disabled'].includes(reason)) {
          await updateJob(cleaned, {});
          return;
        }
        await updateJob(cleaned, {
          message: reason === 'auto_click_off'
            ? '已在设置中关闭自动点击验证框。请在打开的页面完成验证，完成后 Edge 会自动下载。'
            : '自动通过 Cloudflare 验证未成功。请在打开的页面完成验证，完成后 Edge 会自动下载。',
        });
        return;
      }
      if (reason === 'tab_closed') return pause(cleaned, '论文标签页已关闭，正在尝试自动重新打开…');
      const page = await readPage(cleaned);
      if (['challenge', 'access'].includes(page.kind)) {
        if (reason === 'auto_click_off') {
          return pauseAtGate(cleaned, page,
            '已在设置中关闭自动点击验证框。请在论文页面手动完成验证，然后点「继续下载」。');
        }
        if (['debugger_unavailable', 'debugger_error'].includes(reason)) {
          return pause(cleaned,
            '自动点击验证框需要「调试」权限，或验证标签页正被开发者工具占用。请在论文页面手动完成验证，然后点「继续下载」。');
        }
        return pauseAtGate(cleaned, page);
      }
      if (cleaned.phase === 'page' && matchesVerifiedPage(cleaned, page)) {
        return resumeJob(cleaned, false, true);
      }
      if (cleaned.phase === 'download') {
        return enqueueAction(() => awaitBrowserDownload(cleaned, page));
      }
      return pause(cleaned, '自动通过 Cloudflare 验证未成功。请在论文页面完成验证，然后点「继续下载」。');
    },
  }).catch((error) => console.warn('Cloudflare Faker did not start:', error?.message || error));
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
    // A Cloudflare interstitial can keep the tab in the loading state for a
    // long time; page.js (document_idle) is not injected yet. Keep the job
    // alive and let the Faker watcher handle a detected challenge, instead of
    // declaring the page broken. The watchdog alarm re-checks periodically.
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
    if (page.kind === 'challenge') {
      const started = await startFakerForJob('gate');
      if (started) return started;
    }
    return pauseAtGate(job, page);
  }
  if (page.kind === 'unavailable') return showPdfFailure(job, 'page_unavailable');
  if (page.kind === 'closed') return pause(job, '论文标签页已关闭，正在尝试自动重新打开…');
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
  stopFakerQuietly();
  if (job.gateWatchId) void gateWatchMessage(job, 'sd:stop-watch-gate');
  if (job.watchDeadline) {
    await clearReaderDownloadRule();
    await chrome.alarms.clear(browserWatchdog);
  }
  const fresh = {
    status: 'working', phase: 'page', message: loadingMessage,
    autoRecoverCount: 0, autoDownloadRetryCount: 0,
    autoRecoverNotice: false, autoRecoverExhausted: false, pausedFromPhase: null,
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
    let tab;
    if (Number.isInteger(job.readerTabId)) {
      tab = await chrome.tabs.update(job.readerTabId, {active: true}).catch(() => null);
    }
    if (!tab) tab = await chrome.tabs.update(job.tabId, {active: true}).catch(() => null);
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
  if (message.type === 'sd:faker-state' || message.type === 'sd:faker-click' || message.type === 'sd:faker-stalled') {
    if (!sender.tab || !Number.isInteger(sender.tab.id)) return false;
    const source = parseUrl(sender.url || sender.tab.url);
    if (!source || !(publisherHosts.has(source.hostname) || pdfHosts.has(source.hostname))) return false;
    const engine = fakerEngine();
    try {
      if (engine) engine.handleMessage(message, sender);
    } catch (error) {
      console.warn('Cloudflare Faker message handling failed:', error?.message || error);
    }
    if (message.type === 'sd:faker-state' && message.state?.detected && engine && !engine.sessionForTab(sender.tab.id)) {
      const tab = sender.tab;
      void enqueueAction(() => autoStartFakerFromContent(tab, message.state));
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
  if (fakerEngine()) void SDFakerBackground.onTabUpdated(tabId, changes);
  if (changes.url) void enqueueAction(() => detectReaderViewerFailure(tabId, changes.url));
  if (changes.status === 'complete') void enqueueAction(() => checkVerifiedPage(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (fakerEngine()) void SDFakerBackground.onTabRemoved(tabId);
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
  if (alarm.name === autoRecoverAlarm) void enqueueAction(runAutoRecovery);
  if (alarm.name.startsWith(fakerAlarmPrefix) && fakerEngine()) void SDFakerBackground.handleAlarm(alarm);
});

initFaker();
