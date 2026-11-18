import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapSelection, prefixLines, setHeading, normalizeText, displayName, countCharacters, interpolate, restoreSession, taskMarkers } from '../src/core.mjs';

test('formatting wraps a selection and toggles it off without deleting text', () => {
  const edit = wrapSelection('中文 content', 0, 2, '**');
  assert.equal(edit.insert, '**中文**');
  assert.equal(edit.anchor, 2);
  assert.equal(edit.head, 4);
  assert.deepEqual(wrapSelection('**中文** content', 2, 4, '**'), { from: 0, to: 6, insert: '中文', anchor: 0, head: 2 });
  assert.equal(wrapSelection('**中文**', 0, 6, '**').insert, '中文');
});

test('multiline formatting does not include the following unselected line', () => {
  assert.deepEqual(prefixLines('one\ntwo\nthree', 0, 8, '- '), { from: 0, to: 7, insert: '- one\n- two', anchor: 0, head: 11 });
  assert.equal(prefixLines('- one\n- two', 0, 11, '- ').insert, 'one\ntwo');
  assert.equal(setHeading('# old\n## title', 0, 14, 2).insert, '## old\n## title');
  assert.equal(prefixLines('', 0, 0, '- ').insert, '- ');
  assert.equal(prefixLines('\nsecond', 0, 0, '- ').insert, '- ');
  assert.equal(setHeading('one\ntwo', 0, 4, 1).insert, '# one');
});

test('normalizes BOM and Windows newlines, and counts Unicode code points', () => {
  assert.equal(normalizeText('\uFEFF# 标题\r\n中文\r末行'), '# 标题\n中文\n末行');
  assert.equal(countCharacters('中 文 🌿\nA'), 4);
  assert.equal(displayName('D:\\笔记\\测试.md'), '测试.md');
});

test('scroll interpolation maps block anchors and clamps the ends', () => {
  const pairs = [{ editor: 0, preview: 0 }, { editor: 100, preview: 200 }, { editor: 500, preview: 700 }];
  assert.equal(interpolate(50, pairs, 'editor', 'preview'), 100);
  assert.equal(interpolate(450, pairs, 'preview', 'editor'), 300);
  assert.equal(interpolate(999, pairs, 'preview', 'editor'), 500);
  assert.equal(interpolate(-5, pairs, 'editor', 'preview'), 0);
});

test('session restore preserves unsaved drafts and rejects malformed records', () => {
  const restored = restoreSession({ activeId: 'missing', documents: [null, { id: 'a', content: '\uFEFFdraft\r\n编辑', savedContent: 'saved', path: 'D:\\测试.md' }, { id: 'a', content: 'duplicate' }, { id: 'b', content: 17 }], settings: { mode: 'preview' } });
  assert.equal(restored.documents.length, 1);
  assert.equal(restored.documents[0].content, 'draft\n编辑');
  assert.equal(restored.documents[0].savedContent, 'saved');
  assert.equal(restored.activeId, 'a');
  assert.equal(restored.settings.mode, 'preview');
});

test('task source positions exclude fenced code, including quoted code', () => {
  const source = '- [ ] real\n```md\n- [x] code\n```\n> ~~~~\n> - [ ] code\n> ~~~~\n- [X] last\n';
  const markers = taskMarkers(source);
  assert.equal(markers.length, 2);
  assert.equal(source[markers[0].offset], ' ');
  assert.equal(source[markers[1].offset], 'X');
});
