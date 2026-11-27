const ui = Object.fromEntries([
  'paper-form', 'paper', 'submit', 'current', 'status-panel', 'status',
  'candidates', 'actions', 'focus', 'retry', 'show',
].map((id) => [id, document.getElementById(id)]));

// Show the current version in the popup header. Read dynamically from the
// manifest so every future release shows its own version automatically.
try {
  const versionLabel = document.getElementById('extension-version');
  if (versionLabel) versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  // Version display is cosmetic.
}

let state = {status: 'idle'};
let pending = false;
let statusRequest = 0;
let candidateList = '';

function render(nextState) {
  state = nextState;
  const working = state.status === 'working';
  ui.submit.disabled = working || pending;
  ui.current.disabled = working || pending;
  ui.focus.disabled = pending;
  ui.retry.disabled = pending;
  ui.show.disabled = pending;
  ui['status-panel'].hidden = state.status === 'idle';
  ui['status-panel'].dataset.status = state.status;
  const message = state.showError || state.message || '';
  if (ui.status.textContent !== message) ui.status.textContent = message;

  ui.focus.hidden = !['attention', 'error', 'choose'].includes(state.status) || !Number.isInteger(state.tabId);
  ui.focus.textContent = Number.isInteger(state.readerTabId) ? '打开 PDF 标签页' : '打开论文标签页';
  ui.retry.hidden = state.status !== 'attention' || !Number.isInteger(state.tabId) || state.canRetry === false;
  ui.show.hidden = state.status !== 'complete' || !state.filename;
  ui.actions.hidden = ui.focus.hidden && ui.retry.hidden && ui.show.hidden;

  const candidates = state.status === 'choose' ? state.candidates || [] : [];
  const listKey = JSON.stringify(candidates);
  if (listKey !== candidateList) {
    candidateList = listKey;
    ui.candidates.replaceChildren(...candidates.map((candidate, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'candidate';
      button.textContent = candidate.title;
      if (candidate.detail) {
        const detail = document.createElement('span');
        detail.textContent = candidate.detail;
        button.append(detail);
      }
      button.addEventListener('click', () => act({type: 'choose', index}));
      return button;
    }));
  }
  ui.candidates.hidden = candidates.length === 0;
  for (const button of ui.candidates.children) button.disabled = pending;
}

async function refresh() {
  const request = ++statusRequest;
  try {
    const response = await chrome.runtime.sendMessage({type: 'status'});
    if (!pending && request === statusRequest && response?.state) render(response.state);
  } catch {
    if (!pending && request === statusRequest) render({status: 'error', message: '扩展暂时无法启动。请关闭此窗口后重试。'});
  }
}

async function act(message) {
  if (pending) return;
  pending = true;
  statusRequest += 1;
  render(state);
  try {
    if (message.mode === 'current') {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      message.tabId = tab?.id;
    }
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.state) throw new Error('Missing runtime response');
    state = response.state;
  } catch {
    state = {status: 'error', message: '操作未完成，请关闭此窗口后重试。'};
  } finally {
    pending = false;
    render(state);
    if (!state.showError) void refresh();
  }
}

ui['paper-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const input = ui.paper.value.trim();
  if (input) act({type: 'start', mode: 'input', input});
  else ui.paper.focus();
});
ui.current.addEventListener('click', () => act({type: 'start', mode: 'current'}));
ui.focus.addEventListener('click', () => act({type: 'focus'}));
ui.retry.addEventListener('click', () => act({type: 'retry'}));
ui.show.addEventListener('click', () => act({type: 'show'}));
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session') void refresh();
});
void refresh();
