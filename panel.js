(() => {
  'use strict';

  // Always-on helper panel for ScienceDirect pages. It stays docked at the
  // top-right corner until the user closes it; a small chip can reopen it.
  // Only the ScienceDirect Edge extension injects this script and it only
  // runs on ScienceDirect pages.

  try {
    if (window.top !== window) return;
    if (!/^https:\/\/(?:www\.)?sciencedirect\.com\//i.test(location.href)) return;
    if (document.getElementById('sd-edge-helper-host')) return;
  } catch {
    return;
  }

  const HOST_ID = 'sd-edge-helper-host';
  const HIDDEN_KEY = 'sdHelperHidden';
  const REFRESH_MS = 2000;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483647;';
  (document.documentElement || document.body).appendChild(host);
  const shadow = host.attachShadow({mode: 'open'});

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        position: fixed; top: 12px; right: 12px; width: 358px; max-width: calc(100vw - 24px);
        font: 13px/1.5 "Segoe UI", "Microsoft YaHei UI", sans-serif;
        color: #172a3c; background: #fbfcfe; border: 1px solid #cbd5e0; border-radius: 10px;
        box-shadow: 0 10px 28px rgba(15, 32, 50, .18); overflow: hidden;
      }
      @media (prefers-color-scheme: dark) {
        .wrap { color: #edf4fc; background: #141e29; border-color: #455b71; box-shadow: 0 10px 28px rgba(0,0,0,.5); }
        .muted { color: #b2c4d5 !important; }
        input { background: #101925 !important; color: #edf4fc !important; border-color: #455b71 !important; }
        button { background: #202f3e !important; color: #edf4fc !important; border-color: #455b71 !important; }
        .primary { background: #a9d4f8 !important; color: #12273c !important; border-color: #a9d4f8 !important; }
        .card { background: #202f3e !important; }
        .status-card { background: #202f3e !important; }
        .kicker, .card span { color: #b2c4d5 !important; }
        .version { color: #b2c4d5 !important; }
      }
      .head { display: flex; align-items: center; gap: 9px; padding: 10px 11px; border-bottom: 1px solid #cbd5e0; }
      .logo { width: 32px; height: 32px; flex: 0 0 32px; border-radius: 7px; background: #174a78; position: relative; }
      .logo::before { content: ""; position: absolute; left: 50%; top: 7px; width: 2px; height: 9px; background: #fff; transform: translateX(-50%); }
      .logo::after { content: ""; position: absolute; left: 50%; top: 12px; width: 11px; height: 9px; transform: translateX(-50%); border: 2px solid #fff; border-top: 0; border-radius: 0 0 2px 2px; }
      .head-text { flex: 1; display: grid; gap: 1px; overflow: hidden; }
      .kicker { color: #4f6276; font-size: 11px; line-height: 1.2; }
      .title { font-weight: 650; font-size: 15px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .version { color: #4f6276; font-size: 11px; font-weight: 600; line-height: 1.2; }
      .dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: #174a78; margin-top: 4px; }
      .dot[data-status="complete"] { background: #16714b; }
      .dot[data-status="attention"] { background: #965713; }
      .dot[data-status="error"] { background: #ad3d32; }
      .dot[data-status="working"] { animation: pulse 1s ease-in-out infinite alternate; }
      @keyframes pulse { to { opacity: .35; } }
      .close { border: 0; background: none; color: inherit; font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 4px; opacity: .7; }
      .close:hover { opacity: 1; }
      .body { padding: 10px 11px 11px; display: grid; gap: 8px; }
      .status-card { padding: 8px 9px; background: #edf3fa; border-radius: 7px; display: grid; gap: 6px; }
      .status-line { display: flex; align-items: flex-start; gap: 8px; }
      .status { margin: 0; overflow-wrap: anywhere; }
      .actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .actions button { flex: 1 1 auto; }
      .current { width: 100%; }
      .muted { color: #4f6276; font-size: 11px; }
      .row { display: grid; gap: 6px; }
      label { font-weight: 600; font-size: 12px; }
      input { font: inherit; min-height: 32px; padding: 5px 8px; border: 1px solid #cbd5e0; border-radius: 6px; background: #fff; color: inherit; width: 100%; }
      button { font: inherit; min-height: 30px; padding: 4px 8px; border: 1px solid #cbd5e0; border-radius: 6px; background: #fff; color: inherit; cursor: pointer; font-weight: 600; }
      button:disabled { opacity: .55; cursor: default; }
      button:hover:enabled { border-color: #174a78; color: #174a78; }
      @media (prefers-color-scheme: dark) { button:hover:enabled { color: #a9d4f8; border-color: #a9d4f8; } }
      .primary { background: #174a78; color: #fff; border-color: #174a78; }
      .primary:hover:enabled { background: #103c65; color: #fff; border-color: #103c65; }
      .actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .actions button { flex: 1 1 auto; }
      .candidates { display: grid; gap: 5px; max-height: 180px; overflow-y: auto; }
      .card { text-align: left; background: #edf3fa; border: 1px solid #cbd5e0; border-radius: 6px; padding: 6px 8px; font-weight: 500; display: grid; gap: 2px; cursor: pointer; }
      .card span { color: #4f6276; font-weight: 400; font-size: 11px; }
      .chip {
        position: fixed; top: 14px; right: 14px; width: 40px; height: 40px; border-radius: 50%;
        border: 1px solid #cbd5e0; background: #fbfcfe; color: #174a78; font: 650 13px/1 "Segoe UI", sans-serif;
        box-shadow: 0 6px 18px rgba(15, 32, 50, .22); cursor: pointer; z-index: 2147483647;
      }
      @media (prefers-color-scheme: dark) { .chip { background: #141e29; color: #a9d4f8; border-color: #455b71; } }
      [hidden] { display: none !important; }
    </style>
    <div class="wrap" id="wrap" hidden>
      <div class="head">
        <span class="logo" aria-hidden="true"></span>
        <div class="head-text">
          <span class="kicker">ScienceDirect</span>
          <span class="title">论文下载助手</span>
          <span class="version" id="version"></span>
        </div>
        <button class="close" id="close" title="关闭面板（可点右上角 SD 圆钮重新打开）">×</button>
      </div>
      <div class="body">
        <div class="status-card">
          <div class="status-line">
            <span class="dot" id="dot"></span>
            <p class="status" id="status">正在读取状态…</p>
          </div>
          <div class="candidates" id="candidates" hidden></div>
          <div class="actions" id="actions">
            <button id="retry" hidden>继续下载</button>
            <button id="show" hidden>在桌面上显示</button>
          </div>
        </div>
        <div class="row">
          <label for="paper">论文题名、DOI 或链接</label>
          <input id="paper" type="text" placeholder="粘贴题名、DOI 或 ScienceDirect 链接"
                 autocomplete="off" spellcheck="false" maxlength="2000">
          <button class="primary" id="submit">查找并下载 PDF</button>
        </div>
        <button id="current" class="current">下载当前页 PDF</button>
      </div>
    </div>
    <button class="chip" id="chip" title="打开 ScienceDirect 下载助手面板" hidden>SD</button>
  `;

  const el = {
    wrap: shadow.getElementById('wrap'),
    chip: shadow.getElementById('chip'),
    dot: shadow.getElementById('dot'),
    status: shadow.getElementById('status'),
    candidates: shadow.getElementById('candidates'),
    paper: shadow.getElementById('paper'),
    submit: shadow.getElementById('submit'),
    current: shadow.getElementById('current'),
    retry: shadow.getElementById('retry'),
    show: shadow.getElementById('show'),
    close: shadow.getElementById('close'),
    version: shadow.getElementById('version'),
  };

  let state = {status: 'idle'};
  let hidden = false;
  let pending = false;
  let candidateList = '';
  let refreshTimer = 0;

  function applyHidden() {
    el.wrap.hidden = hidden;
    el.chip.hidden = !hidden;
  }

  async function loadHidden() {
    try {
      const result = await chrome.storage.local.get(HIDDEN_KEY);
      hidden = result?.[HIDDEN_KEY] === true;
    } catch {
      hidden = false;
    }
    applyHidden();
  }

  function saveHidden(value) {
    try {
      chrome.storage.local.set({[HIDDEN_KEY]: value}).catch(() => {});
    } catch {
      // Ignore.
    }
  }

  function render() {
    const working = state.status === 'working';
    el.dot.dataset.status = state.status || 'idle';
    const message = state.showError || state.message || (state.status === 'idle' ? '就绪：可粘贴题名/DOI/链接，或下载当前页 PDF。' : '');
    if (el.status.textContent !== message) el.status.textContent = message;

    const candidates = state.status === 'choose' ? state.candidates || [] : [];
    const key = JSON.stringify(candidates);
    if (key !== candidateList) {
      candidateList = key;
      el.candidates.replaceChildren(...candidates.map((candidate, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card';
        button.textContent = candidate.title;
        if (candidate.detail) {
          const span = document.createElement('span');
          span.textContent = candidate.detail;
          button.append(span);
        }
        button.addEventListener('click', () => act({type: 'choose', index}));
        return button;
      }));
    }
    el.candidates.hidden = candidates.length === 0;

    el.submit.disabled = working || pending;
    el.current.disabled = working || pending;
    el.retry.disabled = pending;
    el.show.disabled = pending;
    el.retry.hidden = !(state.status === 'attention' && state.canRetry !== false);
    el.show.hidden = !(state.status === 'complete' && state.filename);
    for (const button of el.candidates.children) button.disabled = pending;
  }

  async function refresh() {
    try {
      const response = await chrome.runtime.sendMessage({type: 'status'});
      if (response?.state) {
        state = response.state;
        render();
      }
    } catch {
      // Background may be waking up / reloading; keep the current rendering.
    }
  }

  async function act(message) {
    if (pending) return;
    pending = true;
    render();
    try {
      if (message.mode === 'current') {
        // The background resolves the tab id from the sender for panel messages.
      }
      const response = await chrome.runtime.sendMessage(message);
      if (response?.state) state = response.state;
    } catch {
      state = {status: 'error', message: '操作未完成，请刷新页面后重试。'};
    } finally {
      pending = false;
      render();
      void refresh();
    }
  }

  el.close.addEventListener('click', () => {
    hidden = true;
    saveHidden(true);
    applyHidden();
  });
  el.chip.addEventListener('click', () => {
    hidden = false;
    saveHidden(false);
    applyHidden();
    void refresh();
  });
  el.submit.addEventListener('click', () => {
    const input = el.paper.value.trim();
    if (!input) {
      el.paper.focus();
      return;
    }
    void act({type: 'start', mode: 'input', input});
  });
  el.paper.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      el.submit.click();
    }
  });
  el.current.addEventListener('click', () => void act({type: 'start', mode: 'current'}));
  el.retry.addEventListener('click', () => void act({type: 'retry'}));
  el.show.addEventListener('click', () => void act({type: 'show'}));

  try {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area === 'local') void refresh();
    });
  } catch {
    // Ignore.
  }

  try {
    if (el.version) el.version.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    // Version display is cosmetic.
  }

  void loadHidden();
  void refresh();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !hidden) void refresh();
  }, REFRESH_MS);

  window.addEventListener('pagehide', () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = 0;
    }
  }, {once: true});
})();
