import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { JSDOM } from 'jsdom';
import { createPreview } from '../src/preview.mjs';
import { indexLiveBlocks, liveConfiguration, liveInteraction, livePreviewState } from '../src/live-preview.mjs';

const { window } = new JSDOM('');
const render = createPreview(window);
const context = { enabled: true, enterActive: false, render, theme: 'light', assetBase: '' };
const source = '# 标题\n\n第一段 **重点**。\n\n第二段。\n\n- 第一项\n- [ ] 第二项\n\n```js\nconst a = 1;\n```\n\n[ref]: https://example.com\n';
function stateFor(text = source) { return EditorState.create({ doc: text, extensions: [liveConfiguration.of(context), livePreviewState] }); }

test('live block index preserves exact source offsets, list items and reference definitions', () => {
  const model = indexLiveBlocks(source, render.tokenize);
  assert.deepEqual(model.blocks.map(block => block.type), ['heading', 'paragraph', 'paragraph', 'list_item', 'list_item', 'code', 'def']);
  for (const block of model.blocks) assert.equal(source.slice(block.from, block.to), block.raw);
  assert.ok(model.references.includes('[ref]: https://example.com'));
  const ordered = indexLiveBlocks('1. one\n1. two\n', render.tokenize);
  assert.deepEqual(ordered.blocks.map(block => block.orderedStart), [1, 2]);
});

test('entering live preview changes presentation without modifying Markdown', () => {
  const state = stateFor();
  assert.equal(state.doc.toString(), source);
  const live = state.field(livePreviewState);
  assert.equal(live.active, false);
  assert.equal(live.decorations.size, 7);
});

test('activating a paragraph exposes its source while all other blocks stay rendered', () => {
  const state = stateFor();
  const position = source.indexOf('第一段') + 2;
  const next = state.update({ selection: { anchor: position }, effects: liveInteraction.of(true) }).state;
  const spans = [];
  next.field(livePreviewState).decorations.between(0, source.length, (from, to) => spans.push({ from, to }));
  assert.ok(!spans.some(span => span.from < position && span.to > position));
  assert.equal(next.doc.toString(), source);
  const collapsed = next.update({ effects: liveInteraction.of(false) }).state;
  assert.equal(collapsed.field(livePreviewState).decorations.size, 7);
  assert.equal(collapsed.doc.toString(), source);
});

test('edits, new paragraphs and multiline selections never replace stored source with rendered HTML', () => {
  let state = stateFor();
  const position = source.indexOf('第二段');
  state = state.update({ selection: { anchor: position }, effects: liveInteraction.of(true) }).state;
  state = state.update({ changes: { from: position, insert: '新增中文\n\n' }, selection: { anchor: position + 6 }, userEvent: 'input.type' }).state;
  assert.equal(state.doc.toString(), source.slice(0, position) + '新增中文\n\n' + source.slice(position));
  state = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
  const widgets = [];
  state.field(livePreviewState).decorations.between(0, state.doc.length, (_from, _to, decoration) => { if (decoration.spec.widget) widgets.push(decoration); });
  assert.equal(widgets.length, 0);
  assert.ok(state.doc.toString().includes('**重点**') && state.doc.toString().includes('```js'));
});

test('clicking a task can update its marker without activating hidden source', () => {
  let state = stateFor();
  const from = source.indexOf('[ ]') + 1;
  state = state.update({ changes: { from, to: from + 1, insert: 'x' }, effects: liveInteraction.of(false), userEvent: 'input.live-task' }).state;
  assert.ok(state.doc.toString().includes('- [x] 第二项'));
  assert.equal(state.field(livePreviewState).active, false);
});

test('cursor clicks throughout the same source line, including trailing spaces, keep it editable', () => {
  const text = '第一段 **重点**。  \n\n第二段\n';
  let state = stateFor(text);
  state = state.update({ selection: { anchor: 2 }, effects: liveInteraction.of(true) }).state;
  const original = state.field(livePreviewState).decorations;
  for (const position of [0, 5, 9, state.doc.line(1).to, 3]) {
    state = state.update({ selection: { anchor: position } }).state;
    assert.deepEqual(state.field(livePreviewState).expanded, [0]);
    assert.equal(state.field(livePreviewState).decorations, original, 'moving the cursor must not recreate the active editing block');
    assert.equal(state.doc.toString(), text);
  }
  state = state.update({ selection: { anchor: state.doc.line(3).from } }).state;
  assert.notDeepEqual(state.field(livePreviewState).expanded, [0], 'moving to another paragraph still restores the old paragraph');
});
