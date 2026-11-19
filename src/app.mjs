import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLineGutter, highlightActiveLine, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { icon } from './icons.mjs';
import { createPreview, escapeHTML } from './preview.mjs';
import { wrapSelection, prefixLines, setHeading, normalizeText, displayName, countCharacters, interpolate, restoreSession } from './core.mjs';
import { request, isDesktop, onHostEvent } from './bridge.mjs';
import { sample } from './sample.mjs';
import { enhancePreview } from './enhance.mjs';
import { peerRangeField, showPeerRange, correspondingElement } from './correspondence.mjs';
import { liveConfiguration, liveInteraction, livePreviewExtensions, liveHeadings } from './live-preview.mjs';

const $ = selector => document.querySelector(selector);
const html = escapeHTML;
const btn = (action, symbol, label, extra = '') => `<button class="icon-btn" data-action="${action}" title="${label}" aria-label="${label}" ${extra}>${icon(symbol)}</button>`;
const renderMarkdown = createPreview(window);
const editorStates = new Map();
const wrapSetting = new Compartment();
const liveSetting = new Compartment();
let documents = [], activeId, recent = [], workspace = null, view;
let settings = { mode: 'split', theme: 'light', sync: true, sidebar: true, fontSize: 14, split: 50, wrap: true };
let headings = [], sideTab = 'files', filter = '', renderTimer, persistTimer, toastTimer;
let persistChain = Promise.resolve(), scrollPairs = [], scrollOwner = null, mapFrame, lastDraftTime = null;
let assetGeneration = 0;
let previewGeneration = 0, pendingPreview = Promise.resolve(), peerFrame, peerScrollTimer;
const active = () => documents.find(doc => doc.id === activeId);
const dirty = doc => doc.content !== doc.savedContent;
const projectURL = 'https://github.com/ly2u/qingjian';

$('#app').innerHTML = `
<div class="shell">
  <aside class="sidebar" aria-label="文档导航">
    <div class="brand"><img src="icon.svg" alt=""><div><span class="brand-name">轻笺</span><span class="brand-note">QINGJIAN</span></div>${btn('sidebar', 'panel', '收起侧栏')}</div>
    <div class="side-actions"><button data-action="new">${icon('plus')}新建</button><button data-action="open">${icon('folderOpen')}打开</button></div>
    <nav class="side-tabs" aria-label="侧栏视图"><button class="active" data-side="files">文档</button><button data-side="outline">大纲</button></nav>
    <label class="file-search">${icon('search')}<input id="file-filter" placeholder="筛选文档…" aria-label="筛选文档"></label>
    <div class="side-scroll"><div id="file-list"></div><div id="outline-list" hidden></div></div>
    <div class="side-bottom"><span><i class="offline-dot"></i>本地写作 · 离线可用</span>${btn('help', 'keyboard', '快捷键与使用说明')}</div>
  </aside>
  <main class="main">
    <header class="topbar">
      ${btn('sidebar', 'panel', '展开侧栏', 'id="show-sidebar"')}
      <div class="doc-meta"><div class="doc-title">${icon('file')}<span id="doc-name">开始写作.md</span><i id="dirty-indicator" class="dirty-dot" hidden></i></div><div class="doc-state" id="doc-state">准备就绪</div></div>
      <nav class="mode-switch" aria-label="编辑视图"><button data-mode="edit" title="编辑 (Ctrl+1)">编辑</button><button data-mode="split" class="active" title="左右对照 (Ctrl+2)">对照</button><button data-mode="live" title="实时编辑 (Ctrl+4)">实时</button><button data-mode="preview" title="预览 (Ctrl+3)">预览</button></nav>
      <div class="top-tools">${btn('theme', 'moon', '切换深浅主题', 'id="theme-button"')}${btn('focus', 'focus', '专注写作 (Ctrl+Shift+F)', 'id="focus-button"')}${btn('menu', 'more', '更多选项', 'aria-haspopup="menu" aria-expanded="false" id="menu-button"')}<span class="tool-separator"></span><button class="save-btn" data-action="save" title="保存 (Ctrl+S)">${icon('save')}保存</button></div>
      <div class="menu-popover" id="more-menu" role="menu" hidden>
        <button data-action="saveAs" role="menuitem">${icon('save')}另存为<kbd>Ctrl Shift S</kbd></button>
        <button data-action="folder" role="menuitem">${icon('folderOpen')}打开文件夹</button>
        <button data-action="export" role="menuitem">${icon('export')}导出 HTML</button>
        <button data-action="print" role="menuitem">${icon('file')}打印 / 导出 PDF<kbd>Ctrl P</kbd></button>
        <div class="menu-rule"></div>
        <button data-action="find" role="menuitem">${icon('search')}查找与替换<kbd>Ctrl F</kbd></button>
        <button data-action="wrap" role="menuitemcheckbox" id="wrap-menu" aria-checked="true">${icon('check')}自动换行</button>
        <div class="font-setting"><span>文字大小</span><button class="icon-btn" data-action="fontMinus" aria-label="缩小文字">−</button><span id="font-size">14</span><button class="icon-btn" data-action="fontPlus" aria-label="放大文字">+</button></div>
        <div class="menu-rule"></div>
        <button data-action="integration" role="menuitem">${icon('file')}Windows 文件关联</button>
        <button data-action="project" role="menuitem">${icon('link')}GitHub 项目地址</button>
        <button data-action="help" role="menuitem">${icon('keyboard')}快捷键与使用说明</button>
      </div>
    </header>
    <div class="tabbar" id="tabbar" aria-label="打开的文档"></div>
    <nav class="toolbar" aria-label="Markdown 格式工具">
      <select id="heading-select" aria-label="设置标题级别"><option value="">正文</option><option value="1">一级标题</option><option value="2">二级标题</option><option value="3">三级标题</option><option value="4">四级标题</option><option value="0">清除标题</option></select>
      <span class="tool-separator"></span>
      ${btn('bold', 'bold', '粗体 (Ctrl+B)')}${btn('italic', 'italic', '斜体 (Ctrl+I)')}${btn('strike', 'strike', '删除线')}
      <span class="tool-separator"></span>
      ${btn('list', 'list', '无序列表')}${btn('ordered', 'ordered', '有序列表')}${btn('task', 'task', '任务列表')}${btn('quote', 'quote', '引用')}
      <span class="tool-separator"></span>
      ${btn('code', 'code', '代码块')}${btn('link', 'link', '链接 (Ctrl+K)')}${btn('image', 'image', '插入本地图片')}${btn('table', 'table', '表格')}
      <span class="toolbar-spacer"></span>
      ${btn('undo', 'undo', '撤销 (Ctrl+Z)')}${btn('redo', 'redo', '重做 (Ctrl+Y)')}
      <span class="tool-separator"></span><button class="sync-button active" data-action="sync" id="sync-button" aria-pressed="true" title="切换同步滚动">${icon('sync')}<span>同步滚动</span></button>
    </nav>
    <div class="workspace" data-mode="split">
      <section class="editor-panel" aria-label="Markdown 编辑区"><div class="pane-heading"><span class="pane-label">${icon('code')}MARKDOWN</span><span class="pane-note">写下你的想法</span></div><div id="editor"></div></section>
      <div class="divider" id="divider" role="separator" aria-label="调整对照栏宽度" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" aria-valuenow="50" tabindex="0"></div>
      <section class="preview-panel" aria-label="渲染预览"><div class="pane-heading"><span class="pane-label">预览效果</span><span class="pane-note"><i class="offline-dot"></i>实时更新</span></div><div class="preview-scroll" id="preview-scroll"><article class="markdown-body" id="preview"></article></div></section>
    </div>
  </main>
  <footer class="statusbar"><div class="status-left"><span id="draft-state">${icon('check')}本地草稿就绪</span></div><div class="status-right"><span id="character-count"></span><span id="cursor-position">行 1，列 1</span><span id="file-encoding">UTF-8</span><span id="line-ending">LF</span><span class="status-mode">Markdown</span></div></footer>
</div>`;

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: '#668052', fontWeight: '600' },
  { tag: tags.processingInstruction, color: '#a3a99e' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#958164' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: '#929989' },
  { tag: tags.link, color: '#6d927d' },
  { tag: tags.url, color: '#819573' },
  { tag: tags.monospace, color: '#9e8163' },
  { tag: tags.quote, color: '#8c9981' },
  { tag: tags.meta, color: '#a0a997' },
  { tag: tags.list, color: '#9aab89' },
  { tag: tags.comment, color: '#969e8e' },
  { tag: tags.keyword, color: '#a47ba0' },
  { tag: tags.string, color: '#7c985e' }
]);

function editorState(content) {
  return EditorState.create({ doc: content, extensions: [
    lineNumbers(), highlightActiveLineGutter(), drawSelection(), dropCursor(), highlightActiveLine(),
    history(), peerRangeField, livePreviewExtensions, liveSetting.of(liveConfiguration.of(liveContext())), markdown({ addKeymap: false }), bracketMatching(), indentOnInput(), syntaxHighlighting(highlightStyle),
    search({ top: true }), highlightSelectionMatches(),
    wrapSetting.of(settings.wrap ? EditorView.lineWrapping : []),
    EditorState.tabSize.of(2),
    EditorState.phrases.of({
      'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个', 'all': '全选',
      'match case': '区分大小写', 'regexp': '正则', 'by word': '全词', 'replace': '替换', 'replace all': '全部替换',
      'close': '关闭', 'Go to line': '跳转到行', 'go': '跳转', 'No matches found': '未找到匹配项'
    }),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown 正文', spellcheck: 'false' }),
    keymap.of([
      { key: 'Mod-b', run: () => { format('bold'); return true; } },
      { key: 'Mod-i', run: () => { format('italic'); return true; } },
      { key: 'Mod-k', run: () => { format('link'); return true; } },
      { key: 'Mod-`', run: () => { format('inlineCode'); return true; } },
      { key: 'Mod-h', run: editor => { openSearchPanel(editor); return true; } },
      ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab
    ]),
    EditorView.updateListener.of(update => {
      const doc = active();
      if (!doc) return;
      if (update.docChanged) {
        const wasDirty = dirty(doc);
        doc.content = update.state.doc.toString();
        if (dirty(doc) !== wasDirty) { renderTabs(); renderFiles(); updateMeta(); }
        $('#character-count').textContent = `${countCharacters(doc.content).toLocaleString()} 字符`;
        scheduleRender(); schedulePersist();
      }
      if (update.selectionSet || update.docChanged) { updateCursor(); schedulePeerHighlight(update.selectionSet && !update.docChanged && update.view.hasFocus); }
      if (update.geometryChanged || update.viewportChanged) scheduleMap();
    })
  ] });
}

function newDocument(content = '', name = '未命名.md', savedContent = '') {
  return { id: crypto.randomUUID(), name, path: null, content, savedContent, encoding: 'UTF-8', lineEnding: 'LF', stamp: null, assetBase: '' };
}

function liveContext() {
  return { enabled: settings.mode === 'live', enterActive: Boolean(view?.hasFocus), render: renderMarkdown, theme: settings.theme, assetBase: active()?.assetBase || '', onLink: target => openPreviewLink(target).catch(reportError) };
}

function refreshLiveContext() {
  if (view) view.dispatch({ effects: liveSetting.reconfigure(liveConfiguration.of(liveContext())) });
}

function makeSession() {
  return { documents: documents.map(({ assetBase, ...doc }) => doc), activeId, settings, recent, workspacePath: workspace?.path || null };
}

function schedulePersist() {
  clearTimeout(persistTimer);
  $('#draft-state').innerHTML = `${icon('check')}正在保留草稿…`;
  persistTimer = setTimeout(() => { persistNow().catch(reportError); }, 650);
}

function persistNow() {
  clearTimeout(persistTimer);
  const snapshot = makeSession();
  persistChain = persistChain.catch(() => {}).then(() => request('persist', snapshot)).then(() => {
    lastDraftTime = new Date();
    $('#draft-state').innerHTML = `${icon('check')}草稿已保留 · ${lastDraftTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }).catch(error => {
    $('#draft-state').textContent = '草稿保留失败，请手动保存';
    throw error;
  });
  return persistChain;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3200);
}
function reportError(error) { toast(error?.message || String(error)); }

function updateMeta() {
  const doc = active();
  if (!doc) return;
  $('#doc-name').textContent = doc.name;
  $('#doc-name').title = doc.path || doc.name;
  $('#dirty-indicator').hidden = !dirty(doc);
  $('#doc-state').textContent = dirty(doc) ? '有更改尚未保存到文件' : doc.path ? '文件已保存' : '本地文档 · Ctrl+S 保存到文件';
  $('#file-encoding').textContent = doc.encoding;
  $('#line-ending').textContent = doc.lineEnding;
  $('#character-count').textContent = `${countCharacters(doc.content).toLocaleString()} 字符`;
  request('title', { name: doc.name, dirty: dirty(doc), dark: settings.theme === 'dark' }).catch(reportError);
}

function updateCursor() {
  if (!view) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const selected = view.state.selection.main.to - view.state.selection.main.from;
  $('#cursor-position').textContent = selected ? `已选 ${selected} 字符` : `行 ${line.number}，列 ${head - line.from + 1}`;
}

function renderTabs() {
  $('#tabbar').innerHTML = documents.map(doc => `<div class="doc-tab ${doc.id === activeId ? 'active' : ''}" ${doc.id === activeId ? 'aria-current="page"' : ''}>${icon('file')}<button class="tab-title" data-doc="${html(doc.id)}" title="${html(doc.path || doc.name)}">${html(doc.name)}</button>${dirty(doc) ? '<i class="dirty-dot" aria-label="未保存"></i>' : ''}<button class="icon-btn" data-close="${html(doc.id)}" aria-label="关闭 ${html(doc.name)}" title="关闭文档">${icon('close')}</button></div>`).join('') + btn('new', 'plus', '新建文档 (Ctrl+N)');
  const add = $('#tabbar > button');
  add?.classList.add('tab-add');
}

function fileButton(doc, extra = '') {
  const selected = doc.id ? doc.id === activeId : Boolean(doc.path && active()?.path?.toLowerCase() === doc.path.toLowerCase());
  return `<button class="file-item ${selected ? 'active' : ''}" ${doc.id ? `data-doc="${html(doc.id)}"` : `data-path="${html(doc.path)}"`} title="${html(doc.path || doc.name)}">${icon('file')}<span class="file-label">${html(doc.name)}${extra ? `<small>${html(extra)}</small>` : ''}</span>${doc.id && dirty(doc) ? '<i class="dirty-dot"></i>' : ''}</button>`;
}

function renderFiles() {
  const query = filter.trim().toLowerCase();
  const matches = value => !query || value.toLowerCase().includes(query);
  let content = `<div class="section-label"><span>已打开 · ${documents.length}</span></div>`;
  content += documents.filter(doc => matches(doc.name)).map(doc => fileButton(doc)).join('');
  if (workspace) {
    content += `<div class="section-label">${icon('folder')}<span title="${html(workspace.path)}">${html(workspace.name)}</span>${btn('refreshFolder', 'refresh', '刷新文件夹')}</div>`;
    const files = workspace.files.filter(file => matches(file.relative));
    content += files.length ? files.map(file => fileButton(file, file.relative.includes('\\') ? file.relative.substring(0, file.relative.lastIndexOf('\\')) : '')).join('') : '<div class="empty-side">没有找到 Markdown 文档</div>';
    if (workspace.truncated) content += '<div class="empty-side">仅显示前 3,000 个文档。可单独打开其他文件。</div>';
  } else {
    content += `<button class="folder-entry" data-action="folder">${icon('folderOpen')}打开一个本地文件夹</button>`;
  }
  const remaining = recent.filter(path => !documents.some(doc => doc.path?.toLowerCase() === path.toLowerCase()) && matches(displayName(path)));
  if (remaining.length) content += '<div class="section-label"><span>最近打开</span></div>' + remaining.slice(0, 8).map(path => fileButton({ path, name: displayName(path) })).join('');
  $('#file-list').innerHTML = content;
}

function renderOutline() {
  $('#outline-list').innerHTML = headings.length ? '<div class="section-label"><span>文档大纲</span></div>' + headings.map((heading, i) => `<button class="outline-item level-${heading.level}" data-heading="${i}" style="padding-left:${10 + Math.max(0, heading.level - 1) * 12}px" title="${html(heading.text)}">${html(heading.text)}</button>`).join('') : '<div class="empty-side">用 # 写下标题，<br>这里就会出现文档大纲。</div>';
}

async function activateDocument(id, focus = true) {
  const doc = documents.find(item => item.id === id);
  if (!doc) return;
  if (view && activeId) editorStates.set(activeId, view.state);
  activeId = id;
  const state = editorStates.get(id) || editorState(doc.content);
  if (view) view.setState(state);
  else {
    view = new EditorView({ state, parent: $('#editor') });
    view.scrollDOM.addEventListener('scroll', () => syncScroll('editor'), { passive: true });
    view.dom.addEventListener('pointerup', () => schedulePeerHighlight(true));
  }
  view.dispatch({ effects: wrapSetting.reconfigure(settings.wrap ? EditorView.lineWrapping : []) });
  refreshLiveContext();
  renderTabs(); renderFiles(); updateMeta(); updateCursor();
  $('#preview-scroll').scrollTop = 0;
  renderPreview();
  if (focus && settings.mode !== 'preview') view.focus();
  schedulePersist();
  const generation = ++assetGeneration;
  if (doc.path && !doc.assetBase) {
    try {
      const result = await request('activateDocument', { path: doc.path });
      doc.assetBase = result.assetBase;
      if (generation === assetGeneration) { refreshLiveContext(); renderPreview(); }
    } catch (error) { reportError(error); }
  }
}

async function addFile(file) {
  if (!file) return;
  if (file.recent) recent = file.recent;
  const existing = file.path && documents.find(doc => doc.path?.toLowerCase() === file.path.toLowerCase());
  if (existing) { await activateDocument(existing.id); return; }
  const content = normalizeText(file.content);
  const doc = { ...newDocument(content, file.name || displayName(file.path), content), ...file, content, savedContent: content, id: crypto.randomUUID() };
  delete doc.recent;
  documents.push(doc);
  await activateDocument(doc.id);
}

async function openFile() {
  if (isDesktop) await addFile(await request('openFile'));
  else {
    const picker = Object.assign(document.createElement('input'), { type: 'file', accept: '.md,.markdown,.mdown,.txt' });
    picker.onchange = async () => {
      if (picker.files[0]) await addFile({ name: picker.files[0].name, content: await picker.files[0].text() });
    };
    picker.click();
  }
}

async function saveDocument(doc = active(), saveAs = false) {
  if (!doc) return false;
  const savedText = doc.content;
  const saved = await request('saveFile', { ...doc, saveAs });
  if (!saved) return false;
  doc.path = saved.path;
  doc.name = saved.name || doc.name;
  doc.stamp = saved.stamp;
  doc.assetBase = saved.assetBase || '';
  doc.savedContent = savedText;
  if (saved.recent) recent = saved.recent;
  renderTabs(); renderFiles(); updateMeta(); refreshLiveContext(); renderPreview();
  await persistNow();
  toast(saved.browserDownload ? '已下载 Markdown 文件' : `已保存 ${doc.name}`);
  if (workspace && doc.path && !workspace.files.some(file => file.path.toLowerCase() === doc.path.toLowerCase())) refreshFolder().catch(reportError);
  return true;
}

async function closeDocument(id) {
  const doc = documents.find(item => item.id === id);
  if (!doc) return;
  if (dirty(doc)) {
    const choice = await confirmCloseDocument(doc.name);
    if (choice === 'cancel') return;
    if (choice === 'save' && !await saveDocument(doc)) return;
  }
  const index = documents.indexOf(doc);
  documents.splice(index, 1); editorStates.delete(id);
  if (!documents.length) documents.push(newDocument());
  if (activeId === id) {
    activeId = null;
    await activateDocument(documents[Math.min(index, documents.length - 1)].id);
  } else { renderTabs(); renderFiles(); schedulePersist(); }
}

function confirmCloseDocument(name) {
  const dialog = $('#confirm-dialog');
  dialog.innerHTML = `<div class="dialog-title"><h2 id="confirm-title">保存文档更改？</h2></div><p class="dialog-caption">${html(name)} 的更改尚未保存到文件。关闭后，这份文档的草稿也会移除。</p><form method="dialog" class="dialog-actions"><button value="cancel" autofocus>取消</button><button value="discard">不保存</button><button value="save" class="primary">保存更改</button></form>`;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderPreview, 120); }
function renderPreview({ force = false } = {}) {
  clearTimeout(renderTimer);
  const doc = active();
  if (!doc) return;
  const generation = ++previewGeneration;
  if (settings.mode === 'live' && !force) {
    headings = view ? liveHeadings(view.state) : [];
    renderOutline();
    pendingPreview = Promise.resolve();
    return pendingPreview;
  }
  const result = renderMarkdown(doc.content);
  headings = result.headings;
  $('#preview').innerHTML = result.html || '<p class="preview-empty">从左边写下第一句话。</p>';
  resolveImages(); renderOutline(); scheduleMap();
  schedulePeerHighlight();
  pendingPreview = enhancePreview($('#preview'), result, { theme: settings.theme, isCurrent: () => previewGeneration === generation, onLayout: scheduleMap });
  return pendingPreview;
}

function schedulePeerHighlight(reveal = false) {
  cancelAnimationFrame(peerFrame);
  peerFrame = requestAnimationFrame(() => {
    $('#preview').querySelectorAll('.peer-active').forEach(node => node.classList.remove('peer-active'));
    if (!view || settings.mode !== 'split') return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const element = correspondingElement($('#preview'), line);
    if (!element) return;
    element.classList.add('peer-active');
    if (reveal) {
      const pane = $('#preview-scroll').getBoundingClientRect(), rect = element.getBoundingClientRect();
      if (rect.top < pane.top + 10 || rect.top > pane.bottom - 30) {
        scrollOwner = 'editor';
        element.scrollIntoView({ block: 'nearest' });
        clearTimeout(peerScrollTimer);
        peerScrollTimer = setTimeout(() => { scrollOwner = null; }, 120);
      }
    }
  });
}

function revealSource(element) {
  const from = Math.min(Number(element.dataset.sourceFrom), view.state.doc.length);
  const to = Math.min(Number(element.dataset.sourceTo), view.state.doc.length);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;
  scrollOwner = 'preview';
  view.dispatch({ selection: { anchor: from }, effects: [showPeerRange.of({ from, to }), EditorView.scrollIntoView(from, { y: 'nearest', yMargin: 40 })] });
  schedulePeerHighlight();
  clearTimeout(peerScrollTimer);
  peerScrollTimer = setTimeout(() => { scrollOwner = null; }, 120);
}

function resolveImages(container = $('#preview'), base = active()?.assetBase) {
  container.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src');
    if (src && base && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) {
      try { img.src = new URL(src.replace(/\\/g, '/'), base).href; } catch { }
    }
    img.addEventListener('load', scheduleMap, { once: true });
  });
}

function scheduleMap() {
  cancelAnimationFrame(mapFrame);
  mapFrame = requestAnimationFrame(() => {
    if (!view || settings.mode !== 'split') return;
    view.requestMeasure({ read() {
      const preview = $('#preview-scroll');
      const previewRect = preview.getBoundingClientRect();
      const pairs = [{ editor: 0, preview: 0 }];
      for (const block of $('#preview').querySelectorAll('.preview-block')) {
        const lineNumber = Math.min(Number(block.dataset.sourceLine), view.state.doc.lines);
        const y = view.lineBlockAt(view.state.doc.line(lineNumber).from).top + view.documentPadding.top;
        pairs.push({ editor: y, preview: block.getBoundingClientRect().top - previewRect.top + preview.scrollTop });
      }
      pairs.push({ editor: Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight), preview: Math.max(0, preview.scrollHeight - preview.clientHeight) });
      const maxEditor = pairs.at(-1).editor, maxPreview = pairs.at(-1).preview;
      return pairs.filter((pair, i) => i === 0 || i === pairs.length - 1 || pair.editor < maxEditor && pair.preview < maxPreview);
    }, write(pairs) { scrollPairs = pairs; } });
  });
}

function syncScroll(source) {
  if (!view || !settings.sync || settings.mode !== 'split' || scrollOwner && scrollOwner !== source) return;
  scrollOwner = source;
  const preview = $('#preview-scroll');
  if (source === 'editor') preview.scrollTop = interpolate(view.scrollDOM.scrollTop, scrollPairs, 'editor', 'preview');
  else view.scrollDOM.scrollTop = interpolate(preview.scrollTop, scrollPairs, 'preview', 'editor');
  requestAnimationFrame(() => requestAnimationFrame(() => { if (scrollOwner === source) scrollOwner = null; }));
}

function applyEdit(edit) {
  view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.anchor, head: edit.head }, scrollIntoView: true, userEvent: 'input' });
  view.focus();
}

function format(action) {
  if (!view) return;
  if (settings.mode === 'preview') setMode('split');
  const source = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  const markers = { bold: '**', italic: '*', strike: '~~', inlineCode: '`' };
  if (markers[action]) applyEdit(wrapSelection(source, from, to, markers[action]));
  else if (['list', 'ordered', 'task', 'quote'].includes(action)) applyEdit(prefixLines(source, from, to, { list: '- ', ordered: '1. ', task: '- [ ] ', quote: '> ' }[action]));
  else if (action === 'link') applyEdit(wrapSelection(source, from, to, '[', '链接文字', '](https://)'));
  else if (action === 'code') {
    const selection = source.slice(from, to) || '// 在这里写代码';
    const leading = from && source[from - 1] !== '\n' ? '\n\n' : '';
    const insert = `${leading}\`\`\`text\n${selection}\n\`\`\`\n`;
    applyEdit({ from, to, insert, anchor: from + leading.length + 8, head: from + leading.length + 8 + selection.length });
  } else if (action === 'table') {
    const insert = `${from && source[from - 1] !== '\n' ? '\n\n' : ''}| 标题一 | 标题二 |\n| --- | --- |\n| 内容 | 内容 |\n`;
    applyEdit({ from, to, insert, anchor: from + insert.length, head: from + insert.length });
  }
}

function setMode(mode) {
  settings.mode = mode;
  $('.workspace').dataset.mode = mode;
  refreshLiveContext();
  $('.editor-panel .pane-label').innerHTML = `${icon('code')}${mode === 'live' ? '实时编辑' : 'MARKDOWN'}`;
  $('.editor-panel .pane-note').textContent = mode === 'live' ? '点击段落编辑 · Esc 恢复排版' : '写下你的想法';
  $('#sync-button').hidden = mode === 'live';
  document.querySelectorAll('[data-mode]').forEach(button => {
    if (button.tagName !== 'BUTTON') return;
    button.classList.toggle('active', button.dataset.mode === mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  if (mode !== 'edit') renderPreview();
  requestAnimationFrame(() => { view?.requestMeasure(); scheduleMap(); });
  schedulePersist();
}

function applySettings() {
  settings.fontSize = Math.min(22, Math.max(12, Number(settings.fontSize) || 14));
  settings.split = Math.min(75, Math.max(25, Number(settings.split) || 50));
  if (!['edit', 'split', 'live', 'preview'].includes(settings.mode)) settings.mode = 'split';
  if (!['light', 'dark'].includes(settings.theme)) settings.theme = 'light';
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--editor-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--reading-size', `${settings.fontSize + 2}px`);
  document.documentElement.style.setProperty('--split', `${settings.split}%`);
  $('.shell').classList.toggle('sidebar-hidden', !settings.sidebar);
  $('#font-size').textContent = settings.fontSize;
  $('#theme-button').innerHTML = icon(settings.theme === 'dark' ? 'sun' : 'moon');
  $('#sync-button').classList.toggle('active', settings.sync);
  $('#sync-button').setAttribute('aria-pressed', String(settings.sync));
  $('#wrap-menu').setAttribute('aria-checked', String(settings.wrap));
  $('#divider').setAttribute('aria-valuenow', settings.split);
  if (view) view.dispatch({ effects: wrapSetting.reconfigure(settings.wrap ? EditorView.lineWrapping : []) });
  setMode(settings.mode);
  updateMeta();
}

async function refreshFolder() {
  const result = await request('refreshFolder');
  if (result) { workspace = result; renderFiles(); }
}

async function exportHTML() {
  const doc = active();
  const result = renderMarkdown(doc.content);
  const content = document.createElement('article');
  content.innerHTML = result.html;
  resolveImages(content, doc.assetBase);
  await enhancePreview(content, result, { theme: 'light' });
  content.querySelectorAll('input').forEach(input => { input.disabled = true; });
  content.querySelectorAll('.peer-active').forEach(node => node.classList.remove('peer-active'));
  const title = doc.name.replace(/\.(?:md|markdown|txt)$/i, '');
  const css = __PREVIEW_CSS__ + (content.querySelector('.katex') ? await (await fetch('katex-export.css')).text() : '');
  const output = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>body{margin:0;background:#fff;padding:55px 24px}.markdown-body{max-width:780px;margin:auto}${css}</style></head><body><article class="markdown-body">${content.innerHTML}</article></body></html>`;
  if (await request('exportHtml', { name: `${title}.html`, html: output })) toast('已导出 HTML');
}

function showHelp() {
  const shortcuts = [ ['新建 / 打开文档', 'Ctrl N / Ctrl O'], ['保存 / 另存为', 'Ctrl S / Ctrl Shift S'], ['编辑 / 对照 / 预览', 'Ctrl 1 / 2 / 3'], ['实时编辑 / 恢复排版', 'Ctrl 4 / Esc'], ['查找 / 替换', 'Ctrl F / Ctrl H'], ['粗体 / 斜体 / 链接', 'Ctrl B / Ctrl I / Ctrl K'], ['撤销 / 重做', 'Ctrl Z / Ctrl Y'], ['专注写作', 'Ctrl Shift F'], ['关闭当前文档', 'Ctrl W'], ['打印 / 导出 PDF', 'Ctrl P'] ];
  const dialog = $('#help-dialog');
  dialog.innerHTML = `<div class="dialog-title"><h2 id="help-title">轻笺，留一点空间给想法。</h2><form method="dialog">${btn('closeHelp', 'close', '关闭说明')}</form></div><p class="dialog-caption">一个安静、离线的 Markdown 编辑器 · v0.3.2</p>${shortcuts.map(([label, key]) => `<div class="shortcut-row"><span>${label}</span><kbd>${key}</kbd></div>`).join('')}<div class="dialog-foot">实时模式点击段落展开源码，Esc 恢复排版，Ctrl+单击可打开链接。<br>对照视图中，两边点击内容可互相定位并高亮。<br>公式使用 $…$ 或 $$…$$；图表使用 mermaid 代码块。<br>修改自动保留为草稿；保存原文件请按 Ctrl+S。<br>设置默认打开方式：更多选项 → Windows 文件关联。</div>`;
  dialog.showModal();
}

function renderIntegration(status) {
  const replacing = status.registered && !status.current;
  const stateLabel = status.current ? '已注册到当前用户' : replacing ? '已检测到旧版注册，可直接替换' : '尚未注册';
  const paths = replacing ? `旧位置：${html(status.registeredExecutable)}</small><small>当前版本：${html(status.executable)}` : html(status.executable);
  $('#integration-dialog').innerHTML = `<div class="dialog-title"><h2 id="integration-title">Windows 文件关联</h2>${btn('closeIntegration', 'close', '关闭文件关联设置')}</div><p class="dialog-caption">将轻笺加入 .md、.markdown 和 .mdown 的“打开方式”。安装新版时可直接更新注册，无需先移除旧版注册。</p><div class="integration-state">${html(stateLabel)}<small>${paths}</small></div><div class="integration-buttons"><button data-action="registerApp">${replacing ? '替换旧版注册' : status.current ? '更新当前注册' : '注册到打开方式'}</button><button class="primary" data-action="defaultApp">选择默认应用</button></div><button class="integration-remove" data-action="unregisterApp" ${!status.current ? 'disabled' : ''}>移除系统注册</button><p class="dialog-foot">注册只对当前用户生效，无需管理员权限。<br>新版会自动接管旧版的打开路径和系统入口，原来选择轻笺的默认打开方式可沿用。<br>移除注册会保留程序、文档和草稿。</p>`;
}

async function showIntegration() {
  const status = await request('integration', { action: 'status' });
  renderIntegration(status);
  $('#integration-dialog').showModal();
}

async function updateIntegration(action) {
  const buttons = [...$('#integration-dialog').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const status = await request('integration', { action });
    renderIntegration(status);
    if (action === 'register') toast(status.replacedPrevious ? '旧版注册已自动替换为当前版本' : '已更新 Windows 打开方式');
    if (action === 'unregister') toast('已移除系统注册，文档和草稿已保留');
  } finally { buttons.forEach(button => { button.disabled = false; }); }
}

async function runAction(action) {
  if (!view && action !== 'help') return;
  if (action !== 'menu' && !['fontPlus', 'fontMinus', 'wrap'].includes(action)) { $('#more-menu').hidden = true; $('#menu-button').setAttribute('aria-expanded', 'false'); }
  switch (action) {
    case 'new': { const doc = newDocument(); documents.push(doc); await activateDocument(doc.id); break; }
    case 'open': await openFile(); break;
    case 'save': await saveDocument(); break;
    case 'saveAs': await saveDocument(active(), true); break;
    case 'folder': {
      const result = await request('openFolder');
      if (result) { workspace = result; for (const doc of documents) doc.assetBase = ''; await activateDocument(activeId, false); renderFiles(); schedulePersist(); }
      break;
    }
    case 'refreshFolder': await refreshFolder(); break;
    case 'find': if (settings.mode === 'preview') setMode('split'); openSearchPanel(view); break;
    case 'undo': undo(view); view.focus(); break;
    case 'redo': redo(view); view.focus(); break;
    case 'sync': settings.sync = !settings.sync; applySettings(); toast(settings.sync ? '已开启同步滚动' : '已关闭同步滚动'); break;
    case 'theme': settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; applySettings(); break;
    case 'wrap': settings.wrap = !settings.wrap; applySettings(); break;
    case 'fontPlus': settings.fontSize++; applySettings(); break;
    case 'fontMinus': settings.fontSize--; applySettings(); break;
    case 'sidebar': {
      if (window.innerWidth <= 880) $('.shell').classList.toggle('mobile-sidebar');
      else { settings.sidebar = !settings.sidebar; $('.shell').classList.toggle('sidebar-hidden', !settings.sidebar); }
      if ($('.shell').classList.contains('focus-mode')) $('.shell').classList.remove('focus-mode');
      schedulePersist(); scheduleMap(); break;
    }
    case 'focus': $('.shell').classList.toggle('focus-mode'); $('#focus-button').classList.toggle('active', $('.shell').classList.contains('focus-mode')); scheduleMap(); view.requestMeasure(); break;
    case 'menu': $('#more-menu').hidden = !$('#more-menu').hidden; $('#menu-button').setAttribute('aria-expanded', String(!$('#more-menu').hidden)); break;
    case 'help': showHelp(); break;
    case 'closeHelp': $('#help-dialog').close(); break;
    case 'integration': await showIntegration(); break;
    case 'closeIntegration': $('#integration-dialog').close(); break;
    case 'registerApp': await updateIntegration('register'); break;
    case 'unregisterApp': await updateIntegration('unregister'); break;
    case 'defaultApp': await updateIntegration('defaults'); break;
    case 'project': await request('openExternal', { url: projectURL }); break;
    case 'export': await exportHTML(); break;
    case 'print': await renderPreview({ force: true }); await document.fonts.ready; await request('print'); break;
    case 'image': {
      if (!active().path && !await saveDocument()) break;
      const result = await request('insertImage', { path: active().path });
      if (result) {
        const { from, to } = view.state.selection.main;
        const insert = `![${result.name.replace(/[\[\]]/g, '')}](${result.relative})`;
        applyEdit({ from, to, insert, anchor: from + insert.length, head: from + insert.length });
      }
      break;
    }
    default: format(action);
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!event.target.closest('.top-tools, #more-menu')) { $('#more-menu').hidden = true; $('#menu-button').setAttribute('aria-expanded', 'false'); }
  if (!button) return;
  if (button.dataset.action) runAction(button.dataset.action).catch(reportError);
  else if (button.dataset.doc) activateDocument(button.dataset.doc).catch(reportError);
  else if (button.dataset.close) closeDocument(button.dataset.close).catch(reportError);
  else if (button.dataset.path) {
    const existing = documents.find(doc => doc.path?.toLowerCase() === button.dataset.path.toLowerCase());
    if (existing) activateDocument(existing.id).catch(reportError);
    else request('openPath', { path: button.dataset.path }).then(addFile).catch(reportError);
  } else if (button.dataset.mode) setMode(button.dataset.mode);
  else if (button.dataset.side) {
    sideTab = button.dataset.side;
    document.querySelectorAll('[data-side]').forEach(item => item.classList.toggle('active', item.dataset.side === sideTab));
    $('#file-list').hidden = sideTab !== 'files'; $('#outline-list').hidden = sideTab !== 'outline'; $('.file-search').hidden = sideTab !== 'files';
  } else if (button.dataset.heading !== undefined) {
    const heading = headings[Number(button.dataset.heading)];
    const line = view.state.doc.line(Math.min(heading.line, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: [EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 20 }), liveInteraction.of(true)] });
    $(`#${heading.id}`)?.scrollIntoView({ block: 'start' });
  }
});

$('#file-filter').addEventListener('input', event => { filter = event.target.value; renderFiles(); });
$('#heading-select').addEventListener('change', event => {
  if (event.target.value === '') return;
  if (settings.mode === 'preview') setMode('split');
  const { from, to } = view.state.selection.main;
  applyEdit(setHeading(view.state.doc.toString(), from, to, Number(event.target.value)));
  event.target.value = '';
});
$('#preview-scroll').addEventListener('scroll', () => syncScroll('preview'), { passive: true });
$('#preview').addEventListener('change', event => {
  const input = event.target.closest('input[data-task-offset]');
  if (!input) return;
  const from = Number(input.dataset.taskOffset);
  if (!/[ xX]/.test(view.state.doc.sliceString(from, from + 1))) return;
  view.dispatch({ changes: { from, to: from + 1, insert: input.checked ? 'x' : ' ' }, userEvent: 'input' });
});
$('#preview').addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  openPreviewLink(anchor.getAttribute('href')).catch(reportError);
});
async function openPreviewLink(target) {
  if (!target) return;
  if (target.startsWith('#')) {
    let id;
    try { id = decodeURIComponent(target.slice(1)); } catch { return; }
    if (settings.mode === 'live') {
      const heading = headings.find(item => item.id === id || item.text.toLowerCase().replace(/\s+/g, '-') === id.toLowerCase());
      if (heading) {
        const from = view.state.doc.line(heading.line).from;
        view.dispatch({ selection: { anchor: from }, effects: [liveInteraction.of(true), EditorView.scrollIntoView(from, { y: 'start' })] });
        view.focus();
      }
    } else {
      const heading = [...$('#preview').querySelectorAll('h1,h2,h3,h4,h5,h6')].find(el => el.id === id || el.textContent.toLowerCase().replace(/\s+/g, '-') === id.toLowerCase());
      heading?.scrollIntoView({ block: 'start' });
    }
  } else if (/^(https?:|mailto:)/i.test(target)) await request('openExternal', { url: target });
  else if (active().path) await addFile(await request('openLink', { path: active().path, target }));
  else toast('请先保存文档，再跳转到本地链接。');
}
$('#preview').addEventListener('click', event => {
  if (settings.mode !== 'split' || event.target.closest('a,input,button,summary') || window.getSelection()?.toString()) return;
  const element = event.target.closest('[data-source-from][data-source-to]');
  if (element) revealSource(element);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('#more-menu').hidden = true; return; }
  if (!event.ctrlKey || event.altKey || event.isComposing || document.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase();
  const actions = { n: 'new', o: 'open', s: event.shiftKey ? 'saveAs' : 'save', p: 'print', w: 'close', f: event.shiftKey ? 'focus' : 'find', h: 'find' };
  if (['1', '2', '3', '4'].includes(key)) { event.preventDefault(); setMode({ 1: 'edit', 2: 'split', 3: 'preview', 4: 'live' }[key]); return; }
  if (key in actions && actions[key]) {
    event.preventDefault();
    const promise = actions[key] === 'close' ? closeDocument(activeId) : runAction(actions[key]);
    promise.catch(reportError);
  }
}, true);

const divider = $('#divider');
divider.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  divider.setPointerCapture(event.pointerId);
  const drag = e => {
    const rect = $('.workspace').getBoundingClientRect();
    settings.split = Math.round(Math.min(75, Math.max(25, (e.clientX - rect.left) / rect.width * 100)));
    document.documentElement.style.setProperty('--split', `${settings.split}%`);
    divider.setAttribute('aria-valuenow', settings.split);
    scheduleMap();
  };
  const end = () => { divider.removeEventListener('pointermove', drag); schedulePersist(); };
  divider.addEventListener('pointermove', drag);
  divider.addEventListener('pointerup', end, { once: true });
  divider.addEventListener('pointercancel', end, { once: true });
});
divider.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
  event.preventDefault();
  settings.split = event.key === 'Home' ? 50 : settings.split + (event.key === 'ArrowLeft' ? -2 : 2);
  applySettings();
});
divider.addEventListener('dblclick', () => { settings.split = 50; applySettings(); });
window.addEventListener('resize', scheduleMap);

let dragDepth = 0;
document.addEventListener('dragenter', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  if (++dragDepth === 1) { const overlay = document.createElement('div'); overlay.className = 'drag-overlay'; overlay.textContent = '松开，打开 Markdown 文档'; document.body.append(overlay); }
});
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', event => { if (event.dataTransfer.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; $('.drag-overlay')?.remove(); } });
document.addEventListener('drop', async event => {
  event.preventDefault(); dragDepth = 0; $('.drag-overlay')?.remove();
  for (const file of [...event.dataTransfer.files].slice(0, 12)) {
    if (!/\.(md|markdown|mdown|txt)$/i.test(file.name)) { toast('请选择 Markdown 或文本文件。'); continue; }
    if (file.size > 16 * 1024 * 1024) { toast('请选择 16 MB 以内的文件。'); continue; }
    try {
      if (isDesktop && window.chrome.webview.postMessageWithAdditionalObjects) await addFile(await request('dropFile', {}, [file]));
      else await addFile({ name: file.name, content: await file.text() });
    } catch (error) { reportError(error); }
  }
});

onHostEvent(async event => {
  if (event.event === 'closing') {
    try { await persistNow(); await request('confirmClose', makeSession()); }
    catch (error) { reportError(error); request('cancelClose').catch(() => {}); }
  } else if (event.event === 'documentSaved') {
    const doc = documents.find(item => item.id === event.document.id);
    if (doc) { Object.assign(doc, event.document); updateMeta(); renderTabs(); renderFiles(); }
  } else if (event.event === 'openFiles') {
    for (const file of event.files) await addFile(file);
  }
});

window.addEventListener('beforeunload', () => { if (!isDesktop) { try { localStorage.setItem('qingjian.session', JSON.stringify(makeSession())); } catch { } } });

async function initialize() {
try {
  const initial = await request('init');
  const restored = restoreSession(initial.session);
  documents = restored.documents;
  activeId = restored.activeId;
  settings = { ...settings, ...restored.settings };
  recent = initial.recent || [];
  workspace = initial.workspace || null;
  if (!documents.length) { const doc = newDocument(sample, '开始写作.md', sample); documents.push(doc); activeId = doc.id; }
  applySettings();
  await activateDocument(activeId, false);
  if (initial.fileToOpen) await addFile(initial.fileToOpen);
  for (const file of initial.filesToOpen || []) await addFile(file);
  if (initial.openErrors?.length) toast(initial.openErrors.join('；'));
} catch (error) {
  reportError(error);
  if (!view) { const doc = newDocument(); documents = [doc]; await activateDocument(doc.id); }
}
}
initialize().catch(reportError);
