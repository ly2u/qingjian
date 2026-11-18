import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.resolve(root, process.env.QINGJIAN_OUTPUT_DIR || 'dist', 'web');
const qa = path.join(root, '.build', 'qa');
await fs.mkdir(qa, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
  try {
    const requested = new URL(request.url, 'http://localhost').pathname;
    const filename = path.resolve(webRoot, '.' + (requested === '/' ? '/index.html' : decodeURIComponent(requested)));
    if (!filename.startsWith(webRoot + path.sep)) throw new Error('outside web root');
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' });
    response.end(await fs.readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  const plain = '# 对照定位\n\n第一段：从一份普通笔记开始。\n\n第二段：在两侧点击，可以看见对应内容。\n\n- [ ] 一项待办\n';
  const rich = '# 公式与图表\n\n行内 $E=mc^2$ 与 \\(a^2+b^2=c^2\\)。\n\n$$\nx=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\n$$\n\n\\[\\int_0^1 x^2\\,dx=\\frac{1}{3}\\]\n\n```mermaid\nflowchart LR\n A["输入"] --> B["处理"] --> C["结果"]\n```\n\n```mermaid\nsequenceDiagram\n participant U as 用户\n participant Q as 轻笺\n U->>Q: 打开文档\n Q-->>U: 显示预览\n```\n\n```mermaid\ngantt\n title 项目计划\n dateFormat YYYY-MM-DD\n section 编写\n 初稿 :a, 2026-11-18, 2d\n 修改 :after a, 1d\n```\n\n```mermaid\nclassDiagram\n class Note {\n +String title\n +save()\n }\n```\n';
  await context.addInitScript(({ plain, rich }) => {
    const listeners = [];
    const documents = [{ id: 'plain', name: '对照定位.md', content: plain, savedContent: plain }, { id: 'rich', name: '公式与图表.md', content: rich, savedContent: rich }];
    const session = { documents, activeId: 'plain', settings: { mode: 'split' } };
    let registered = false;
    window.__nativeCalls = [];
    window.__session = session;
    window.chrome ||= {};
    window.chrome.webview = {
      addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
      postMessage(message) {
        window.__nativeCalls.push(message);
        let result = true;
        const { method, params } = message;
        if (method === 'init') result = { session: window.__session, workspace: null, recent: [] };
        if (method === 'persist') window.__session = structuredClone(params);
        if (method === 'activateDocument') result = { assetBase: '' };
        if (method === 'integration') {
          if (params.action === 'register' || params.action === 'defaults') registered = true;
          if (params.action === 'unregister') registered = false;
          result = { current: registered, registered, executable: 'D:\\轻笺\\轻笺.exe', registeredExecutable: registered ? 'D:\\轻笺\\轻笺.exe' : '' };
        }
        if (method === 'exportHtml') window.__exportedHTML = params.html;
        if (method === 'print') window.__printedHTML = document.querySelector('#preview').innerHTML;
        queueMicrotask(() => listeners.forEach(fn => fn({ data: { id: message.id, result } })));
      }
    };
  }, { plain, rich });
  const page = await context.newPage();
  const errors = [], requested = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requested.push(request.url()));
  await page.goto(origin);
  await page.waitForSelector('.cm-content');
  assert.equal(requested.some(url => /\/(?:math|diagrams)-/.test(url)), false, 'plain Markdown must not load optional renderers');
  console.log('PASS plain Markdown keeps optional renderers unloaded');

  await page.locator('.cm-line').filter({ hasText: '第二段：' }).click();
  await page.waitForFunction(() => document.querySelector('#preview .peer-active')?.textContent.includes('第二段：'));
  await page.locator('#preview p').filter({ hasText: '第一段：' }).click();
  await page.waitForSelector('.cm-peer-range');
  assert.ok((await page.locator('.cm-peer-range').textContent()).includes('第一段：'));
  console.log('PASS split view locates and highlights corresponding text in both directions');

  await page.getByRole('checkbox', { name: '任务：一项待办' }).check();
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('[x] 一项待办'));
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('[ ] 一项待办'));
  console.log('PASS preview task changes remain undoable');

  await page.locator('.tab-title[data-doc="rich"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.qj-math.qj-rendered').length === 4 && document.querySelectorAll('.qj-diagram-image').length === 4, null, { timeout: 30000 });
  assert.equal(await page.locator('.qj-render-error').count(), 0);
  assert.ok(await page.locator('.katex math').count() >= 4);
  const images = await page.locator('.qj-diagram-image').evaluateAll(nodes => nodes.map(node => ({ complete: node.complete, width: node.naturalWidth, src: node.src.slice(0, 19) })));
  assert.ok(images.every(image => image.complete && image.width > 0 && image.src.startsWith('data:image/svg+xml')));
  await page.screenshot({ path: path.join(qa, 'math-and-diagrams.png') });
  console.log('PASS offline math, flowchart, sequence, gantt and class diagrams render');

  await page.getByRole('button', { name: '更多选项' }).click();
  await page.getByRole('menuitem', { name: '导出 HTML' }).click();
  await page.waitForFunction(() => Boolean(window.__exportedHTML));
  const exported = await page.evaluate(() => window.__exportedHTML);
  assert.ok(exported.includes('data:font/woff2;base64,'));
  assert.equal((exported.match(/class="qj-diagram-image"/g) || []).length, 4);
  assert.ok(!exported.includes('class="preview-block peer-active"'));
  await fs.writeFile(path.join(qa, 'exported.html'), exported);
  const exportPage = await context.newPage();
  await exportPage.setContent(exported);
  await exportPage.evaluate(() => document.fonts.ready);
  assert.equal(await exportPage.locator('.katex').count(), 4);
  await exportPage.close();
  console.log('PASS HTML export embeds rendered diagrams and math fonts');

  await page.getByRole('button', { name: '更多选项' }).click();
  await page.getByRole('menuitem', { name: 'Windows 文件关联' }).click();
  await page.getByRole('button', { name: '注册到打开方式', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.integration-state')?.textContent.includes('已注册到当前用户'));
  await page.getByRole('button', { name: '移除系统注册', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.integration-state')?.textContent.includes('尚未注册'));
  await page.getByRole('button', { name: '关闭文件关联设置' }).click();
  await page.getByRole('button', { name: '更多选项' }).click();
  await page.getByRole('menuitem', { name: 'GitHub 项目地址' }).click();
  assert.ok(await page.evaluate(() => window.__nativeCalls.some(call => call.method === 'openExternal' && call.params.url === 'https://github.com/ly2u/qingjian')));
  console.log('PASS registration controls and the corrected project link call the native bridge');

  await page.getByRole('button', { name: '切换深浅主题' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.querySelectorAll('.qj-diagram-image').length === 4);
  await page.screenshot({ path: path.join(qa, 'dark-theme.png') });
  await page.evaluate(() => { window.__exportedHTML = null; });
  await page.getByRole('button', { name: '更多选项' }).click();
  await page.getByRole('menuitem', { name: '导出 HTML' }).click();
  await page.waitForFunction(() => Boolean(window.__exportedHTML));
  const darkExport = await page.evaluate(() => window.__exportedHTML);
  const firstDiagram = markup => /src="(data:image\/svg\+xml[^\"]*)"/.exec(markup)?.[1];
  assert.equal(firstDiagram(darkExport), firstDiagram(exported), 'exports stay readable on white paper while the editor is dark');
  await page.keyboard.press('Control+1');
  await page.waitForFunction(() => document.querySelector('.workspace').dataset.mode === 'edit');
  await page.keyboard.press('Control+2');
  await page.waitForFunction(() => document.querySelector('.workspace').dataset.mode === 'split');
  await page.setViewportSize({ width: 900, height: 650 });
  await page.screenshot({ path: path.join(qa, 'compact-layout.png') });
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS dark theme, keyboard modes and compact layout; no uncaught JavaScript errors');
  await fs.writeFile(path.join(qa, 'browser-results.json'), JSON.stringify({ passed: 7, errors, images, checkedAt: new Date().toISOString() }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
