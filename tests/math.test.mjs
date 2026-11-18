import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPreview } from '../src/preview.mjs';
import { renderFormula } from '../src/math.mjs';
import { correspondingElement } from '../src/correspondence.mjs';

const { window } = new JSDOM('');
const render = createPreview(window);
test('math accepts inline and block delimiters while leaving code and currencies alone', () => {
  const source = '行内 $x^2$ 和 \\(a+b\\)。价格 $5 和 $10。\\$20\n\n$$\n\\frac{a}{b}\n$$\n\n\\[c^2\\]\n\n`$code$`\n\n```tex\n$code$\n```\n';
  const result = render(source);
  assert.deepEqual(result.formulas.map(({ tex, display }) => [tex, display]), [['x^2', false], ['a+b', false], ['\\frac{a}{b}', true], ['c^2', true]]);
  assert.ok(result.html.includes('$code$'));
});

test('KaTeX produces accessible math and blocks trusted HTML/link commands', () => {
  const result = renderFormula('\\frac{a}{b}+\\sqrt{x}', true);
  assert.ok(result.includes('katex-display') && result.includes('<math'));
  const fragment = window.document.createElement('div');
  fragment.innerHTML = renderFormula('\\href{javascript:alert(1)}{click}', false);
  assert.equal(fragment.querySelectorAll('a,script,[onclick]').length, 0);
  assert.throws(() => renderFormula('\\badcommand{x}', false));
});

test('Mermaid fences produce isolated render requests and preserve their text', () => {
  const source = '```mermaid\nflowchart LR\n A --> B\n```\n';
  const result = render(source);
  assert.equal(result.diagrams.length, 1);
  assert.ok(result.diagrams[0].source.includes('A --> B'));
  assert.equal(result.formulas.length, 0);
});

test('preview correspondence locates paragraphs, table rows and list items', () => {
  const source = '# 标题\n\n第一行\n第二行\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- 第一项\n- 第二项\n';
  const container = window.document.createElement('div');
  container.innerHTML = render(source).html;
  assert.ok(correspondingElement(container, 4).textContent.includes('第一行'));
  assert.equal(correspondingElement(container, 8).tagName, 'TR');
  assert.equal(correspondingElement(container, 11).textContent, '第二项');
  assert.equal(correspondingElement(container, 5), null);
  const first = correspondingElement(container, 3);
  assert.equal(source.slice(Number(first.dataset.sourceFrom), Number(first.dataset.sourceTo)), '第一行\n第二行');
});
