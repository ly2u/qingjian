import { Facet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view';
import { enhancePreview } from './enhance.mjs';
import { searchPanelOpen } from '@codemirror/search';

const disabled = { enabled: false };
export const liveConfiguration = Facet.define({ combine: values => values.at(-1) || disabled });
export const liveInteraction = StateEffect.define();

/** Index source blocks without rendering the entire document on each keystroke. */
export function indexLiveBlocks(source, tokenize) {
  const tokens = tokenize(source);
  const blocks = [], definitions = [];
  let offset = 0;
  for (const token of tokens) {
    const from = offset;
    offset += token.raw.length;
    if (token.type === 'space') continue;
    if (token.type === 'def') definitions.push(token.raw);
    if (token.type === 'list') {
      let itemOffset = from;
      const items = [];
      for (const [index, item] of token.items.entries()) {
        const raw = item.raw.trimEnd();
        const found = source.indexOf(raw, itemOffset);
        if (found < itemOffset || found + raw.length > offset) { items.length = 0; break; }
        items.push({ from: found, to: found + raw.length, raw, type: 'list_item', orderedStart: token.ordered ? Number(token.start) + index : null });
        itemOffset = found + item.raw.length;
      }
      if (items.length) { blocks.push(...items); continue; }
    }
    const raw = token.raw.trimEnd();
    if (raw) blocks.push({ from, to: from + raw.length, raw, type: token.type, depth: token.depth, title: token.text });
  }
  return { blocks, references: definitions.join('\n') };
}

function intersectsSelection(block, state) {
  const from = state.doc.lineAt(block.from).from;
  const to = state.doc.lineAt(block.to).to;
  return state.selection.ranges.some(range => range.empty ? range.head >= from && range.head <= to : range.from <= to && range.to >= from);
}

function expandedBlocks(model, active, state) {
  return active ? model.blocks.filter(block => intersectsSelection(block, state)).map(block => block.from) : [];
}

function clickedPosition(event, root, block, view) {
  const scoped = event.target.closest('[data-source-from]');
  let from = scoped ? Number(scoped.dataset.sourceFrom) : block.from;
  let to = scoped ? Number(scoped.dataset.sourceTo) : block.to;
  from = Math.max(block.from, Math.min(from, block.to));
  to = Math.max(from, Math.min(to, block.to));
  const range = root.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && root.contains(range.startContainer) && range.startContainer.nodeType === 3 && !event.target.closest('.qj-math,.qj-diagram,pre')) {
    const text = range.startContainer.textContent;
    const source = view.state.doc.sliceString(from, to);
    const index = source.indexOf(text);
    if (text.trim() && index >= 0) return from + index + Math.min(range.startOffset, text.length);
  }
  if (block.type === 'code' || block.type === 'blockMath') {
    const newline = block.raw.indexOf('\n');
    if (newline >= 0) return block.from + newline + 1;
  }
  return from;
}

class RenderedBlock extends WidgetType {
  constructor(block, references, context) { super(); this.block = block; this.references = references; this.context = context; }
  eq(other) {
    return this.block.from === other.block.from && this.block.raw === other.block.raw && this.block.orderedStart === other.block.orderedStart && this.references === other.references && this.context.theme === other.context.theme && this.context.assetBase === other.context.assetBase;
  }
  get estimatedHeight() {
    const { raw, type } = this.block;
    if (type === 'heading') return 46;
    if (type === 'code') return raw.startsWith('```mermaid') ? 220 : Math.min(500, raw.split('\n').length * 24 + 28);
    if (type === 'blockMath') return 100;
    if (type === 'table') return Math.min(500, raw.split('\n').length * 40);
    return Math.max(30, Math.min(350, Math.ceil(raw.length / 65) * 32));
  }
  toDOM(view) {
    const { block, context } = this;
    const root = document.createElement('div');
    root.className = `qj-live-block markdown-body qj-live-${block.type}`;
    root.dataset.liveFrom = String(block.from);
    root.dataset.liveTo = String(block.to);
    root.contentEditable = 'false';
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', '排版内容，点击或按 Enter 编辑');
    const result = context.render(block.raw + (this.references ? '\n\n' + this.references : ''));
    root.innerHTML = result.html;
    root.querySelectorAll('[data-source-from]').forEach(node => {
      node.dataset.sourceFrom = String(Number(node.dataset.sourceFrom) + block.from);
      node.dataset.sourceTo = String(Number(node.dataset.sourceTo) + block.from);
    });
    root.querySelectorAll('[data-task-offset]').forEach(node => { node.dataset.taskOffset = String(Number(node.dataset.taskOffset) + block.from); });
    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((node, i) => { node.id = `qj-live-heading-${block.from}-${i}`; });
    if (block.orderedStart !== null && block.orderedStart !== undefined) {
      const list = root.querySelector('ol');
      if (list) list.start = block.orderedStart;
    }
    const measure = () => { if (root.isConnected) view.requestMeasure(); };
    root.querySelectorAll('img').forEach(image => {
      const src = image.getAttribute('src');
      if (src && context.assetBase && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) {
        try { image.src = new URL(src.replace(/\\/g, '/'), context.assetBase).href; } catch { }
      }
      image.addEventListener('load', measure, { once: true });
    });
    const activate = position => {
      if (!root.isConnected) return;
      view.dispatch({ selection: { anchor: position }, effects: liveInteraction.of(true), scrollIntoView: true });
      view.focus();
    };
    root.addEventListener('mousedown', event => {
      if (event.button !== 0 || event.target.closest('input[type="checkbox"]')) return;
      if (event.target.closest('a') && (event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      activate(clickedPosition(event, root, block, view));
    });
    root.addEventListener('keydown', event => {
      if (event.target !== root || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); activate(block.from);
    });
    root.addEventListener('click', event => {
      const link = event.target.closest('a');
      if (link) {
        event.preventDefault(); event.stopPropagation();
        if (event.ctrlKey || event.metaKey) context.onLink?.(link.getAttribute('href'));
      }
    });
    root.addEventListener('change', event => {
      const input = event.target.closest('input[data-task-offset]');
      if (!input) return;
      const from = Number(input.dataset.taskOffset);
      if (!/[ xX]/.test(view.state.doc.sliceString(from, from + 1))) return;
      view.dispatch({ changes: { from, to: from + 1, insert: input.checked ? 'x' : ' ' }, effects: liveInteraction.of(view.state.field(livePreviewState).active), userEvent: 'input.live-task' });
    });
    enhancePreview(root, result, { theme: context.theme, isCurrent: () => root.isConnected, onLayout: measure }).catch(() => {});
    return root;
  }
  ignoreEvent() { return true; }
}

function decorate(model, expanded, state, context) {
  const ranges = [];
  const sourceBlocks = new Set(expanded);
  for (const block of model.blocks) {
    if (!sourceBlocks.has(block.from)) ranges.push((block.type === 'def' ? Decoration.replace({}) : Decoration.replace({ widget: new RenderedBlock(block, model.references, context), block: true })).range(block.from, block.to));
    else {
      const first = state.doc.lineAt(block.from).number, last = state.doc.lineAt(block.to).number;
      for (let line = first; line <= last; line++) ranges.push(Decoration.line({ class: 'qj-live-source' }).range(state.doc.line(line).from));
    }
  }
  return Decoration.set(ranges, true);
}

function initialValue(state) {
  const context = state.facet(liveConfiguration);
  if (!context.enabled) return { enabled: false, active: false, expanded: [], decorations: Decoration.none, model: null, context };
  const model = indexLiveBlocks(state.doc.toString(), context.render.tokenize);
  const active = Boolean(context.enterActive);
  const expanded = expandedBlocks(model, active, state);
  return { enabled: true, active, expanded, model, context, decorations: decorate(model, expanded, state, context) };
}

export const livePreviewState = StateField.define({
  create: initialValue,
  update(previous, transaction) {
    const context = transaction.state.facet(liveConfiguration);
    if (!context.enabled || !previous.enabled) return initialValue(transaction.state);
    const model = transaction.docChanged ? indexLiveBlocks(transaction.state.doc.toString(), context.render.tokenize) : previous.model;
    let active = previous.active;
    if (transaction.selection || transaction.docChanged && transaction.isUserEvent('input')) active = true;
    for (const effect of transaction.effects) if (effect.is(liveInteraction)) active = effect.value;
    if (!transaction.docChanged && !transaction.selection && active === previous.active && context === previous.context) return previous;
    const expanded = expandedBlocks(model, active, transaction.state);
    if (model === previous.model && context === previous.context && expanded.length === previous.expanded.length && expanded.every((from, index) => from === previous.expanded[index])) {
      return active === previous.active ? previous : { ...previous, active };
    }
    return { enabled: true, active, expanded, model, context, decorations: decorate(model, expanded, transaction.state, context) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

export const livePreviewExtensions = [livePreviewState, EditorView.domEventHandlers({
  focus(_event, view) {
    queueMicrotask(() => {
      const live = view.state.field(livePreviewState);
      if (live.enabled && !live.active && view.hasFocus) view.dispatch({ effects: liveInteraction.of(true) });
    });
    return false;
  }
}), keymap.of([{ key: 'Escape', run(view) {
  const live = view.state.field(livePreviewState);
  if (!live.enabled || !live.active || searchPanelOpen(view.state)) return false;
  view.dispatch({ effects: liveInteraction.of(false) });
  return true;
} }])];

const headingLabels = new WeakMap();
export function liveHeadings(state) {
  const live = state.field(livePreviewState);
  if (!live.model) return [];
  let labels = headingLabels.get(live.context.render);
  if (!labels) { labels = new Map(); headingLabels.set(live.context.render, labels); }
  return live.model.blocks.filter(block => block.type === 'heading').map(block => {
    if (!labels.has(block.raw)) {
      labels.set(block.raw, live.context.render(block.raw).headings[0]?.text ?? block.title);
      if (labels.size > 512) labels.delete(labels.keys().next().value);
    }
    return { text: labels.get(block.raw), level: block.depth,
      line: state.doc.lineAt(block.from).number, id: `qj-live-heading-${block.from}-0` };
  });
}
