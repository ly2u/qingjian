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
  const liveText = '# 实时编辑\n\n第一段：保留 **粗体**，也保留 *斜体*。  \n\n第二段：点击这里，上一段恢复排版。\n\n- 第一项 **重点**\n- [ ] 第二项待办\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n行内公式 $E=mc^2$。\n\n```mermaid\nflowchart LR\n A["输入"] --> B["结果"]\n```\n';
  const rich = '# 公式与图表\n\n行内 $E=mc^2$ 与 \\(a^2+b^2=c^2\\)。\n\n$$\nx=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\n$$\n\n\\[\\int_0^1 x^2\\,dx=\\frac{1}{3}\\]\n\n```mermaid\nflowchart LR\n A["输入"] --> B["处理"] --> C["结果"]\n```\n\n```mermaid\nsequenceDiagram\n participant U as 用户\n participant Q as 轻笺\n U->>Q: 打开文档\n Q-->>U: 显示预览\n```\n\n```mermaid\ngantt\n title 项目计划\n dateFormat YYYY-MM-DD\n section 编写\n 初稿 :a, 2026-11-18, 2d\n 修改 :after a, 1d\n```\n\n```mermaid\nclassDiagram\n class Note {\n +String title\n +save()\n }\n```\n';
  const body = Array.from({ length: 8 }, (_, i) => `这是第 ${i + 1} 段正文，用来验证长文档章节定位。\n\n`).join('');
  const outlineText = '# 项目计划\n\n' + body + '```md\n# 代码内标题不进入目录\n```\n\n## 第一章 **目标**\n\n' + body + '### 执行 [清单](https://example.com)\n\n' + body + '#### 四级标题\n\n' + body + '##### 五级标题\n\n' + body + '###### 六级标题\n\n' + body + '## 重复章节\n\n' + body + '## 重复章节\n\n' + body + '附录\n----\n\n' + body.repeat(3);
  await context.addInitScript(({ plain, rich, liveText, outlineText }) => {
    const listeners = [];
    const documents = [{ id: 'plain', name: '对照定位.md', content: plain, savedContent: plain }, { id: 'rich', name: '公式与图表.md', content: rich, savedContent: rich }, { id: 'live-doc', name: '实时编辑.md', content: liveText, savedContent: liveText }];
    const session = { documents, activeId: 'plain', settings: { mode: 'split' } };
    window.__registrationOwner = '';
    window.__nativeCalls = [];
    window.__session = session;
    if (location.search.includes('outline=')) {
      documents.push({ id: 'outline-doc', name: '章节导航.md', content: outlineText, savedContent: outlineText });
      session.activeId = 'outline-doc';
    }
    if (location.search.includes('outline=restore')) {
      window.__session = JSON.parse(localStorage.getItem('test-outline-session')) || session;
    }
    window.__disk = {};
    let revision = 0;
    const diskFile = (path, content) => ({ path, name: path.split('\\').pop(), content, encoding: 'UTF-8', lineEnding: 'LF', stamp: `revision-${++revision}` });
    window.__emitHost = data => queueMicrotask(() => listeners.forEach(fn => fn({ data })));
    window.__changeDisk = (content, path = window.__activeDiskPath) => {
      if (content === null) delete window.__disk[path];
      else window.__disk[path] = diskFile(path, content);
      window.__emitHost({ event: 'filesChanged', paths: [path] });
    };
    if (location.search.includes('restore=')) {
      documents[0].path = 'D:\\tests\\restored.md';
      if (location.search.includes('restore=dirty')) documents[0].content += '\n恢复的本地编辑';
      window.__disk[documents[0].path] = diskFile(documents[0].path, '# 启动前的外部修改\n');
    }
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
        if (method === 'saveFile') {
          const path = `D:\\tests\\${params.saveAs ? '副本-' : ''}${params.name}`;
          window.__activeDiskPath = path;
          result = { ...diskFile(path, params.content), assetBase: '' };
          window.__disk[path] = result;
        }
        if (method === 'watchFiles') window.__watchedPaths = params.paths;
        if (method === 'syncFile') {
          const disk = window.__disk[params.path];
          let kind;
          if (!disk) kind = params.recreate ? 'saved' : 'missing';
          else if (disk.content === params.content) kind = 'current';
          else if (params.overwriteStamp && params.overwriteStamp !== disk.stamp || params.recreate) kind = 'conflict';
          else if (!params.overwriteStamp && params.content === params.savedContent) kind = 'loaded';
          else if (!params.overwriteStamp && disk.content !== params.savedContent) kind = 'conflict';
          else kind = params.write ? 'saved' : 'unchanged';
          if (kind === 'saved') window.__disk[params.path] = diskFile(params.path, params.content);
          result = { kind, file: structuredClone(window.__disk[params.path] || null) };
        }
        if (method === 'integration') {
          const previous = window.__registrationOwner;
          if (params.action === 'register' || params.action === 'defaults') window.__registrationOwner = 'D:\\轻笺\\轻笺.exe';
          if (params.action === 'unregister') window.__registrationOwner = '';
          result = { current: window.__registrationOwner === 'D:\\轻笺\\轻笺.exe', registered: Boolean(window.__registrationOwner), executable: 'D:\\轻笺\\轻笺.exe', registeredExecutable: window.__registrationOwner, replacedPrevious: Boolean(previous && previous !== window.__registrationOwner && window.__registrationOwner) };
        }
        if (method === 'exportHtml') window.__exportedHTML = params.html;
        if (method === 'print') window.__printedHTML = document.querySelector('#preview').innerHTML;
        queueMicrotask(() => listeners.forEach(fn => fn({ data: { id: message.id, result } })));
      }
    };
  }, { plain, rich, liveText, outlineText });
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
  await page.evaluate(() => { window.__registrationOwner = 'D:\\旧版本\\轻笺.exe'; });
  await page.getByRole('button', { name: '更多选项' }).click();
  await page.getByRole('menuitem', { name: 'Windows 文件关联' }).click();
  assert.ok((await page.locator('.integration-state').textContent()).includes('已检测到旧版注册'));
  await page.getByRole('button', { name: '替换旧版注册', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.integration-state')?.textContent.includes('已注册到当前用户'));
  assert.equal(await page.evaluate(() => window.__registrationOwner), 'D:\\轻笺\\轻笺.exe');
  await page.getByRole('button', { name: '关闭文件关联设置' }).click();
  console.log('PASS old registration is detected and replaced directly from the new client');
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
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.locator('.tab-title[data-doc="live-doc"]').click();
  await page.locator('button[data-mode="live"]').click();
  await page.waitForSelector('.qj-live-block h1');
  assert.equal(await page.locator('.qj-live-source').count(), 0);
  assert.ok(await page.locator('.qj-live-block strong').count() >= 2);
  await page.locator('.qj-live-block').filter({ hasText: '第一段：' }).click();
  await page.waitForFunction(() => document.querySelector('.qj-live-source')?.textContent.includes('**粗体**'));
  for (const character of [4, 12, 20, 24, 8]) {
    const point = await page.locator('.qj-live-source').first().evaluate((line, index) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node, remaining = index;
      while ((node = walker.nextNode())) {
        if (remaining < node.textContent.length) {
          const range = document.createRange();
          range.setStart(node, remaining); range.setEnd(node, remaining + 1);
          const box = range.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
        remaining -= node.textContent.length;
      }
      throw new Error('Source character missing');
    }, character);
    await page.mouse.click(point.x, point.y);
    assert.ok((await page.locator('.qj-live-source').allTextContents()).some(text => text.includes('第一段：')), `click at source character ${character} must keep the same paragraph editable`);
  }
  console.log('PASS repeated cursor clicks within the same source line keep editing active');
  await page.keyboard.press('End');
  await page.keyboard.insertText('，实时修改');
  await page.locator('.qj-live-block').filter({ hasText: '第二段：' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.qj-live-block')].some(node => node.textContent.includes('，实时修改') && node.querySelector('strong')));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !document.querySelector('.cm-content').textContent.includes('，实时修改'));
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('，实时修改'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.qj-live-source').length === 0);
  console.log('PASS live preview reveals only the active paragraph, edits it and preserves undo/redo');

  await page.getByRole('checkbox', { name: '任务：第二项待办' }).check();
  await page.waitForFunction(() => window.__session.documents.find(doc => doc.id === 'live-doc').content.includes('- [x] 第二项待办'));
  await page.locator('.qj-live-block').filter({ hasText: '第一项' }).click();
  await page.waitForFunction(() => document.querySelector('.qj-live-source')?.textContent.includes('- 第一项 **重点**'));
  assert.equal(await page.getByRole('checkbox', { name: '任务：第二项待办' }).count(), 1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.waitForFunction(() => document.querySelectorAll('.qj-live-block').length === 0);
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.qj-live-block');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__nativeCalls.some(call => call.method === 'saveFile' && call.params.name === '实时编辑.md'));
  const savedLive = await page.evaluate(() => window.__nativeCalls.findLast(call => call.method === 'saveFile').params.content);
  assert.ok(savedLive.includes('**粗体**') && savedLive.includes('，实时修改') && savedLive.includes('| A | B |') && savedLive.includes('```mermaid'));
  console.log('PASS live list items, tasks, select-all and file saving preserve original Markdown');

  await page.keyboard.press('Control+Home');
  await page.locator('.qj-live-block').filter({ hasText: '第一段：' }).click();
  await page.keyboard.press('End'); await page.keyboard.insertText('，实时自动保存');
  await page.waitForFunction(() => window.__disk[window.__activeDiskPath]?.content.includes('，实时自动保存'));
  await page.keyboard.press('Escape');

  await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForSelector('.qj-live-block .qj-diagram-image');
  await page.waitForSelector('.qj-live-block .katex');
  await page.locator('.qj-live-block .qj-diagram-image').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.qj-live-source')].some(node => node.textContent.includes('flowchart LR')));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.qj-live-block .qj-diagram-image');
  await page.keyboard.press('Control+Home');
  await page.locator('.qj-live-block').filter({ hasText: '第一段：' }).click();
  await page.waitForSelector('.qj-live-source');
  await page.screenshot({ path: path.join(qa, 'live-preview-dark.png') });
  await page.getByRole('button', { name: '切换深浅主题' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: path.join(qa, 'live-preview.png') });
  console.log('PASS live formulas and diagrams render, unfold to source and restore');

  const syncPage = await context.newPage();
  syncPage.on('pageerror', error => errors.push(error.message));
  await syncPage.goto(origin);
  await syncPage.waitForSelector('.cm-content');
  await syncPage.locator('[data-mode="edit"]').click();
  await syncPage.keyboard.press('Control+s');
  await syncPage.waitForFunction(() => document.querySelector('#doc-state').textContent.includes('自动保存已开启'));
  await syncPage.locator('.cm-content').click();
  await syncPage.keyboard.press('Control+End');
  await syncPage.keyboard.insertText('\n自动保存验证');
  await syncPage.waitForFunction(() => window.__disk[window.__activeDiskPath]?.content.includes('自动保存验证'));
  assert.equal(await syncPage.evaluate(() => window.__nativeCalls.filter(call => call.method === 'saveFile').length), 1, 'editing an existing file never opens another save dialog');
  await syncPage.keyboard.press('Control+z');
  await syncPage.waitForFunction(() => !window.__disk[window.__activeDiskPath]?.content.includes('自动保存验证'));
  console.log('PASS bound files automatically save edits and undo without a save dialog');

  await syncPage.keyboard.press('Control+Home');
  await syncPage.keyboard.press('ArrowDown'); await syncPage.keyboard.press('ArrowDown');
  await syncPage.keyboard.press('Home'); await syncPage.keyboard.press('ArrowRight');
  const cursorBefore = await syncPage.locator('#cursor-position').textContent();
  await syncPage.evaluate(() => window.__changeDisk('# 外部更新\n\n' + window.__disk[window.__activeDiskPath].content));
  await syncPage.waitForFunction(() => document.querySelector('.cm-content').textContent.startsWith('# 外部更新'));
  assert.equal(await syncPage.locator('#cursor-position').textContent(), cursorBefore.replace('行 3', '行 5'));
  await syncPage.keyboard.press('Control+z');
  assert.ok((await syncPage.locator('.cm-content').textContent()).startsWith('# 外部更新'), 'undo cannot restore stale content from before an external reload');
  await syncPage.locator('[data-mode="split"]').click();
  await syncPage.waitForFunction(() => document.querySelector('#preview h1')?.textContent === '外部更新');
  await syncPage.locator('.tab-title[data-doc="rich"]').click();
  await syncPage.evaluate(() => window.__changeDisk('# 后台标签的外部更新\n'));
  await syncPage.waitForFunction(() => window.__session.documents.find(doc => doc.id === 'plain').content.includes('后台标签的外部更新'));
  assert.equal(await syncPage.locator('#doc-name').textContent(), '公式与图表.md');
  await syncPage.locator('.tab-title[data-doc="plain"]').click();
  await syncPage.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('后台标签的外部更新'));
  console.log('PASS active and inactive documents refresh with preview and cursor preserved');

  await syncPage.locator('.cm-content').click(); await syncPage.keyboard.press('Control+End');
  await syncPage.keyboard.insertText('\n本地待保存的编辑');
  await syncPage.evaluate(() => window.__changeDisk('# 同时发生的外部编辑\n'));
  await syncPage.waitForSelector('#file-sync-banner:not([hidden])');
  await syncPage.waitForTimeout(850);
  assert.ok((await syncPage.locator('.cm-content').textContent()).includes('本地待保存的编辑'));
  assert.equal(await syncPage.evaluate(() => window.__disk[window.__activeDiskPath].content), '# 同时发生的外部编辑\n');
  await syncPage.getByRole('button', { name: '查看并处理', exact: true }).click();
  await syncPage.waitForSelector('#file-conflict-dialog[open]');
  assert.ok((await syncPage.getByRole('textbox', { name: '当前本地内容' }).inputValue()).includes('本地待保存的编辑'));
  await syncPage.screenshot({ path: path.join(qa, 'file-sync-conflict.png') });
  await syncPage.evaluate(() => window.__changeDisk('# 查看冲突期间再次更新\n'));
  await syncPage.getByRole('button', { name: '使用本地版本', exact: true }).click();
  await syncPage.waitForFunction(() => document.querySelector('#toast').textContent.includes('请重新查看'));
  assert.equal(await syncPage.evaluate(() => window.__disk[window.__activeDiskPath].content), '# 查看冲突期间再次更新\n');
  await syncPage.getByRole('button', { name: '查看并处理', exact: true }).click();
  await syncPage.getByRole('button', { name: '使用外部版本', exact: true }).click();
  await syncPage.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('查看冲突期间再次更新') && document.querySelector('#file-sync-banner').hidden);
  await syncPage.waitForFunction(() => window.__session.documents.some(doc => doc.name.includes('本地冲突副本') && !doc.path && doc.content.includes('本地待保存的编辑')));
  console.log('PASS simultaneous edits pause writes; conflict review preserves a local recovery draft');

  await syncPage.locator('.cm-content').click(); await syncPage.keyboard.press('Control+End');
  await syncPage.keyboard.insertText('\n选择保留本地');
  await syncPage.evaluate(() => window.__changeDisk('# 第二次外部冲突\n'));
  await syncPage.waitForSelector('#file-sync-banner:not([hidden])');
  await syncPage.getByRole('button', { name: '查看并处理', exact: true }).click();
  await syncPage.getByRole('button', { name: '使用本地版本', exact: true }).click();
  await syncPage.waitForFunction(() => window.__disk[window.__activeDiskPath].content.includes('选择保留本地') && document.querySelector('#file-sync-banner').hidden);
  await syncPage.evaluate(() => window.__changeDisk(null));
  await syncPage.waitForSelector('#file-sync-banner:not([hidden])');
  assert.ok((await syncPage.locator('.cm-content').textContent()).includes('选择保留本地'));
  await syncPage.locator('.cm-content').click(); await syncPage.keyboard.press('Control+End');
  await syncPage.keyboard.insertText('\n删除期间的编辑');
  await syncPage.waitForTimeout(850);
  assert.equal(await syncPage.evaluate(() => Boolean(window.__disk[window.__activeDiskPath])), false);
  await syncPage.getByRole('button', { name: '重新创建文件', exact: true }).click();
  await syncPage.waitForFunction(() => window.__disk[window.__activeDiskPath]?.content.includes('删除期间的编辑') && document.querySelector('#file-sync-banner').hidden);
  await syncPage.screenshot({ path: path.join(qa, 'auto-save.png') });
  console.log('PASS explicit local resolution and missing-file recreation resume automatic saves');

  await syncPage.locator('.cm-content').click(); await syncPage.keyboard.press('Control+End');
  await syncPage.keyboard.insertText('\n切换标签补存');
  await syncPage.locator('.tab-title[data-doc="rich"]').click();
  await syncPage.waitForFunction(() => window.__disk[window.__activeDiskPath]?.content.includes('切换标签补存'));
  await syncPage.locator('.tab-title[data-doc="plain"]').click();
  await syncPage.locator('.cm-content').click(); await syncPage.keyboard.press('Control+End');
  await syncPage.keyboard.insertText('\n失焦补存');
  await syncPage.evaluate(() => window.dispatchEvent(new Event('blur')));
  await syncPage.waitForFunction(() => window.__disk[window.__activeDiskPath]?.content.includes('失焦补存'));
  await syncPage.keyboard.insertText('\n退出前补存');
  await syncPage.evaluate(() => window.__emitHost({ event: 'closing' }));
  await syncPage.waitForFunction(() => window.__nativeCalls.some(call => call.method === 'confirmClose' && call.params.documents.some(doc => doc.id === 'plain' && doc.content.includes('退出前补存') && doc.savedContent === doc.content)));
  console.log('PASS live editing, tab switches, blur and close flush to disk automatically');

  await syncPage.locator('.cm-content').click(); await syncPage.keyboard.press('Control+End');
  await syncPage.keyboard.insertText('\n关闭标签前补存');
  await syncPage.locator('.doc-tab.active [data-close]').click();
  await syncPage.waitForFunction(() => !document.querySelector('[data-doc="plain"]') && window.__disk[window.__activeDiskPath]?.content.includes('关闭标签前补存'));
  assert.equal(await syncPage.locator('#confirm-dialog[open]').count(), 0);
  assert.equal(await syncPage.evaluate(() => window.__watchedPaths.length), 0);
  console.log('PASS closing a bound tab flushes it and releases its file subscription');

  const restoredPage = await context.newPage();
  restoredPage.on('pageerror', error => errors.push(error.message));
  await restoredPage.goto(origin + '/?restore=clean');
  await restoredPage.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('启动前的外部修改'));
  await restoredPage.close();
  const recoveredPage = await context.newPage();
  recoveredPage.on('pageerror', error => errors.push(error.message));
  await recoveredPage.goto(origin + '/?restore=dirty');
  await recoveredPage.waitForSelector('#file-sync-banner:not([hidden])');
  assert.ok((await recoveredPage.locator('.cm-content').textContent()).includes('恢复的本地编辑'));
  assert.equal(await recoveredPage.evaluate(() => window.__disk['D:\\tests\\restored.md'].content), '# 启动前的外部修改\n');
  await recoveredPage.close();
  await syncPage.close();
  console.log('PASS startup rechecks disk before saving recovered drafts');

  const outlinePage = await context.newPage();
  outlinePage.on('pageerror', error => errors.push(error.message));
  await outlinePage.goto(origin + '/?outline=test');
  await outlinePage.waitForSelector('.cm-content');
  await outlinePage.locator('#outline-button').click();
  await outlinePage.waitForSelector('#outline-list:not([hidden])');
  assert.equal(await outlinePage.locator('.outline-item').count(), 9);
  assert.equal(await outlinePage.locator('.outline-level').count(), 0);
  assert.equal(await outlinePage.locator('[data-heading="0"]').textContent(), '项目计划');
  const resizeSidebar = async width => {
    const current = await outlinePage.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width);
    const handle = await outlinePage.locator('#sidebar-resizer').boundingBox();
    await outlinePage.mouse.move(handle.x + handle.width / 2, handle.y + 160);
    await outlinePage.mouse.down();
    await outlinePage.mouse.move(handle.x + handle.width / 2 + width - current, handle.y + 160, { steps: 8 });
    await outlinePage.mouse.up();
  };
  await resizeSidebar(400);
  assert.ok(Math.abs(await outlinePage.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width) - 400) <= 1);
  await resizeSidebar(1000);
  assert.equal(await outlinePage.locator('#sidebar-resizer').getAttribute('aria-valuenow'), '880');
  assert.ok(await outlinePage.locator('.topbar').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'wide sidebar leaves the document controls usable');
  await resizeSidebar(400);
  await outlinePage.locator('#sidebar-resizer').press('ArrowLeft');
  assert.equal(await outlinePage.locator('#sidebar-resizer').getAttribute('aria-valuenow'), '390');
  await outlinePage.locator('#sidebar-resizer').dblclick();
  assert.equal(await outlinePage.locator('#sidebar-resizer').getAttribute('aria-valuenow'), '222');
  await resizeSidebar(400);
  await outlinePage.waitForFunction(() => window.__session.settings.sidebarWidth === 400);
  assert.equal(await outlinePage.evaluate(() => window.__session.documents.find(doc => doc.id === 'outline-doc').content), outlineText, 'resizing never edits the document');
  assert.ok(await outlinePage.locator('.topbar').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  console.log('PASS sidebar dragging, keyboard resizing, reset and title-only outline labels');
  assert.equal(await outlinePage.locator('.outline-item').filter({ hasText: '代码内标题' }).count(), 0);
  assert.equal(await outlinePage.locator('.outline-item').filter({ hasText: '重复章节' }).count(), 2);
  await outlinePage.getByRole('button', { name: '收起 第一章 目标 的子标题', exact: true }).click();
  assert.equal(await outlinePage.locator('.outline-row:not([hidden])').count(), 5);
  await outlinePage.getByRole('button', { name: '展开 第一章 目标 的子标题', exact: true }).click();
  assert.equal(await outlinePage.locator('.outline-row:not([hidden])').count(), 9);
  await outlinePage.getByRole('button', { name: '全部收起', exact: true }).click();
  assert.equal(await outlinePage.locator('.outline-row:not([hidden])').count(), 1);
  await outlinePage.getByRole('button', { name: '全部展开', exact: true }).click();
  assert.equal(await outlinePage.locator('.outline-row:not([hidden])').count(), 9);
  console.log('PASS prominent outline entry, six levels, duplicate headings and folding');

  await outlinePage.locator('[data-action="sync"]').click();
  const secondDuplicate = outlineText.indexOf('## 重复章节', outlineText.indexOf('## 重复章节') + 1);
  const duplicateLine = outlineText.slice(0, secondDuplicate).split('\n').length;
  await outlinePage.locator('[data-heading="7"]').click();
  await outlinePage.waitForFunction(line => document.querySelector('#cursor-position').textContent === `行 ${line}，列 1`, duplicateLine);
  await outlinePage.waitForFunction(() => Math.abs(document.querySelector('#qj-heading-7').getBoundingClientRect().top - document.querySelector('#preview-scroll').getBoundingClientRect().top) < 24);
  await outlinePage.waitForFunction(() => document.querySelector('.cm-scroller').scrollTop > 300);
  await outlinePage.waitForSelector('[data-heading="7"][aria-current="location"]');
  console.log('PASS outline jumps both split panes even when synchronized scrolling is off');

  await outlinePage.locator('#outline-button').click();
  await outlinePage.locator('.cm-scroller').evaluate(node => { node.scrollTop = 0; });
  await outlinePage.waitForTimeout(100);
  await outlinePage.locator('#outline-button').click();
  await outlinePage.waitForSelector('[data-heading="0"][aria-current="location"]');

  await outlinePage.locator('[data-mode="preview"]').click();
  await outlinePage.locator('#preview-scroll').evaluate(pane => {
    const target = document.getElementById('qj-heading-1');
    pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 5;
  });
  await outlinePage.waitForSelector('[data-heading="1"][aria-current="location"]');
  await outlinePage.locator('[data-heading="6"]').click();
  await outlinePage.waitForFunction(() => Math.abs(document.querySelector('#qj-heading-6').getBoundingClientRect().top - document.querySelector('#preview-scroll').getBoundingClientRect().top) < 24);
  assert.equal(await outlinePage.locator('.workspace').getAttribute('data-mode'), 'preview');
  console.log('PASS preview scrolling highlights the current chapter and outline jumps preserve the view');

  await outlinePage.locator('[data-mode="edit"]').click();
  await outlinePage.locator('[data-heading="5"]').click();
  await outlinePage.locator('.cm-content').focus();
  await outlinePage.keyboard.press('End'); await outlinePage.keyboard.insertText('（已修改）');
  await outlinePage.waitForFunction(() => document.querySelector('[data-heading="5"]').textContent.includes('已修改'));
  await outlinePage.locator('[data-mode="live"]').click();
  await outlinePage.waitForFunction(() => document.querySelector('[data-heading="2"]').textContent === '执行 清单');
  await outlinePage.locator('[data-heading="8"]').click();
  await outlinePage.waitForSelector('[data-heading="8"][aria-current="location"]');
  await outlinePage.waitForFunction(() => {
    const heading = [...document.querySelectorAll('.qj-live-heading h2')].find(node => node.textContent === '附录');
    if (!heading) return false;
    const pane = document.querySelector('.cm-scroller').getBoundingClientRect(), box = heading.getBoundingClientRect();
    return box.top >= pane.top - 5 && box.top < pane.bottom;
  });
  await outlinePage.screenshot({ path: path.join(qa, 'outline.png') });
  console.log('PASS editing updates the outline and live mode preserves formatted heading labels');

  await outlinePage.keyboard.press('Control+Shift+o');
  await outlinePage.waitForFunction(() => document.querySelector('#outline-button').getAttribute('aria-expanded') === 'false');
  await outlinePage.keyboard.press('Control+Shift+o');
  await outlinePage.waitForFunction(() => document.querySelector('#outline-button').getAttribute('aria-expanded') === 'true');
  await outlinePage.locator('[data-action="focus"]').click();
  await outlinePage.locator('#outline-button').click();
  assert.equal(await outlinePage.locator('.shell.focus-mode').count(), 0);
  await outlinePage.locator('#theme-button').click();
  await outlinePage.screenshot({ path: path.join(qa, 'outline-dark.png') });
  await outlinePage.setViewportSize({ width: 900, height: 650 });
  await outlinePage.waitForFunction(() => document.querySelector('#sidebar-resizer').getAttribute('aria-valuenow') === '340');
  assert.ok(await outlinePage.locator('.topbar').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'header fits with the outline button');
  await outlinePage.setViewportSize({ width: 860, height: 650 });
  await outlinePage.locator('#outline-button').click();
  await outlinePage.waitForFunction(() => document.querySelector('#outline-button').getAttribute('aria-expanded') === 'true');
  assert.equal(await outlinePage.locator('.sidebar').evaluate(node => getComputedStyle(node).visibility), 'visible');
  await outlinePage.waitForFunction(() => document.querySelector('#sidebar-resizer').getAttribute('aria-valuenow') === '300');
  await outlinePage.screenshot({ path: path.join(qa, 'outline-compact.png') });
  await outlinePage.waitForFunction(() => window.__session.settings.sideTab === 'outline' && window.__session.settings.sidebar);
  await outlinePage.evaluate(() => localStorage.setItem('test-outline-session', JSON.stringify(window.__session)));
  const outlineRestored = await context.newPage();
  outlineRestored.on('pageerror', error => errors.push(error.message));
  await outlineRestored.goto(origin + '/?outline=restore');
  await outlineRestored.waitForSelector('#outline-list:not([hidden])');
  assert.equal(await outlineRestored.locator('#outline-button').getAttribute('aria-expanded'), 'true');
  assert.equal(await outlineRestored.locator('#sidebar-resizer').getAttribute('aria-valuenow'), '400', 'restoring a wider window restores the preferred sidebar width');
  await outlineRestored.close();
  console.log('PASS outline shortcut, focus mode, dark theme, compact layout and restored preference');

  await outlinePage.setViewportSize({ width: 1440, height: 950 });
  await outlinePage.keyboard.press('Control+s');
  await outlinePage.waitForFunction(() => document.querySelector('#doc-state').textContent.includes('自动保存已开启'));
  await outlinePage.evaluate(() => window.__changeDisk('# 同步后的目录\n\n## 新章节\n'));
  await outlinePage.waitForFunction(() => document.querySelectorAll('.outline-item').length === 2 && document.querySelector('.outline-item').textContent.includes('同步后的目录'));
  await outlinePage.locator('.side-actions [data-action="new"]').click();
  await outlinePage.waitForSelector('.outline-empty');
  assert.equal(await outlinePage.locator('.outline-item').count(), 0);
  await outlinePage.close();
  console.log('PASS external changes rebuild the outline and untitled documents show heading guidance');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS dark theme, keyboard modes and compact layout; no uncaught JavaScript errors');
  await fs.writeFile(path.join(qa, 'browser-results.json'), JSON.stringify({ passed: 26, errors, images, checkedAt: new Date().toISOString() }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
