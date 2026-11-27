import test from 'node:test';
import assert from 'node:assert/strict';
import { outlineRows, headingAtLine } from '../src/outline.mjs';

const headings = [
  { text: '笔记', level: 1, line: 1 },
  { text: '主题', level: 2, line: 4 },
  { text: '细节', level: 4, line: 9 },
  { text: '主题', level: 2, line: 12 },
  { text: '细节', level: 3, line: 15 },
  { text: '结尾', level: 1, line: 20 }
];

test('outline hierarchy handles skipped levels and repeated titles independently', () => {
  const rows = outlineRows(headings);
  assert.deepEqual(rows.map(row => row.parent), [null, 0, 1, 0, 3, null]);
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 2, 1, 2, 0]);
  assert.notEqual(rows[1].key, rows[3].key);
});

test('folding hides descendants without hiding siblings or losing their own folding', () => {
  const rows = outlineRows(headings);
  let collapsed = new Set([rows[1].key]);
  assert.deepEqual(outlineRows(headings, collapsed).map(row => row.hidden), [false, false, true, false, false, false]);
  collapsed.add(rows[0].key);
  assert.deepEqual(outlineRows(headings, collapsed).map(row => row.hidden), [false, true, true, true, true, false]);
  collapsed.delete(rows[0].key);
  assert.equal(outlineRows(headings, collapsed)[2].hidden, true);
});

test('editing body text preserves the folded chapter identity', () => {
  const before = outlineRows(headings);
  const shifted = headings.map(heading => ({ ...heading, line: heading.line + 5 }));
  assert.deepEqual(outlineRows(shifted).map(row => row.key), before.map(row => row.key));
  assert.equal(outlineRows(shifted, new Set([before[1].key]))[2].hidden, true);
});

test('current chapter includes its body until the next heading', () => {
  assert.equal(headingAtLine([], 1), -1);
  assert.equal(headingAtLine(headings, 0), -1);
  assert.equal(headingAtLine(headings, 1), 0);
  assert.equal(headingAtLine(headings, 8), 1);
  assert.equal(headingAtLine(headings, 12), 3);
  assert.equal(headingAtLine(headings, 999), 5);
});
