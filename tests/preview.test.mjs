import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPreview } from '../src/preview.mjs';

const { window } = new JSDOM('');
const render = createPreview(window);
function documentFor(source) { const doc = window.document.createElement('div'); doc.innerHTML = render(source).html; return doc; }

test('preview supports tables, references, code highlighting and heading source positions', () => {
  const source = '# 标题\n\n段落 [链接][ref]\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst n = 1;\n```\n\n## 结束\n\n[ref]: https://example.com\n';
  const result = render(source);
  const doc = documentFor(source);
  assert.equal(doc.querySelectorAll('table').length, 1);
  assert.equal(doc.querySelector('a').getAttribute('href'), 'https://example.com');
  assert.ok(doc.querySelector('pre .hljs-keyword'));
  assert.equal(result.headings[0].line, 1);
  assert.equal(result.headings[1].line, 13);
});

test('preview strips scripts, event handlers, unsafe URLs and active embedded content', () => {
  const doc = documentFor('<script>window.pwned=1</script>\n\n<img src="x" onerror="alert(1)">\n\n[bad](javascript:alert(1))\n\n<iframe src="https://example.com"></iframe><form><input autofocus onfocus="alert(2)"></form><style>body{display:none}</style>');
  assert.equal(doc.querySelectorAll('script,iframe,form,style').length, 0);
  assert.equal(doc.querySelectorAll('[onerror],[onfocus],[autofocus]').length, 0);
  assert.ok(!doc.innerHTML.includes('href="javascript:'));
  assert.ok([...doc.querySelectorAll('input')].every(input => input.disabled));
});

test('editable task checkboxes address only their actual source marker', () => {
  const source = '- [ ] 待办\n- [x] 完成\n\n```md\n- [ ] 示例\n```';
  const doc = documentFor(source);
  const boxes = [...doc.querySelectorAll('input[type=checkbox]')];
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every(box => !box.disabled));
  assert.equal(source[Number(boxes[0].dataset.taskOffset)], ' ');
  assert.equal(source[Number(boxes[1].dataset.taskOffset)], 'x');
});

test('wiki links escape labels and attribute payloads', () => {
  const doc = documentFor('[[文档名|一份文档]]\n\n[[x" onmouseover="bad|<script>]]');
  assert.equal(doc.querySelector('a').getAttribute('href'), '文档名.md');
  assert.equal(doc.querySelectorAll('[onmouseover],script').length, 0);
});

test('a long document renders without evaluating source HTML', () => {
  const source = Array.from({ length: 600 }, (_, i) => `## 章节 ${i}\n\n这是一段普通文字，带有 **重点**。\n\n`).join('');
  const result = render(source);
  assert.equal(result.headings.length, 600);
  assert.ok(result.html.length > source.length);
});
