const pending = new Map();
let nextId = 0;
export const isDesktop = Boolean(window.chrome?.webview);
const subscribers = new Set();

if (isDesktop) window.chrome.webview.addEventListener('message', ({ data }) => {
  if (data.event) {
    subscribers.forEach(listener => listener(data));
    return;
  }
  const entry = pending.get(data.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(data.id);
  if (data.error) entry.reject(new Error(data.error));
  else entry.resolve(data.result);
});

export function onHostEvent(listener) { subscribers.add(listener); }

export function request(method, params = {}, additionalObjects = null) {
  if (!isDesktop) return browserRequest(method, params);
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    // File dialogs can stay open until the user returns to the app.
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作未完成，请重试。')); }, 15 * 60 * 1000);
    pending.set(id, { resolve, reject, timer });
    if (additionalObjects) window.chrome.webview.postMessageWithAdditionalObjects({ id, method, params }, additionalObjects);
    else window.chrome.webview.postMessage({ id, method, params });
  });
}

async function browserRequest(method, params) {
  switch (method) {
    case 'init': {
      let session;
      try { session = JSON.parse(localStorage.getItem('qingjian.session')); } catch { /* New or invalid browser profile. */ }
      return { session, recent: [], workspace: null, version: '0.4.0' };
    }
    case 'persist': localStorage.setItem('qingjian.session', JSON.stringify(params)); return true;
    case 'title': document.title = `${params.name} — 轻笺`; return true;
    case 'saveFile': {
      const blob = new Blob([params.content], { type: 'text/markdown;charset=utf-8' });
      download(blob, params.name || '未命名.md');
      return { ...params, path: null, stamp: null, browserDownload: true };
    }
    case 'exportHtml': download(new Blob([params.html], { type: 'text/html;charset=utf-8' }), params.name); return true;
    case 'print': window.print(); return true;
    case 'openExternal': window.open(params.url, '_blank', 'noopener'); return true;
    case 'activateDocument': return { assetBase: '' };
    default: throw new Error('这个功能请在 Windows 桌面版中使用。');
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement('a'), { href: url, download: name });
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
