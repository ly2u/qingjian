import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { createFileSynchronizer, sourceChange } from '../src/file-sync.mjs';

const file = (content, stamp = content) => ({ content, stamp, encoding: 'UTF-8', lineEnding: 'LF' });
const document = () => ({ id: 'one', path: 'D:\\test.md', content: 'base', savedContent: 'base', stamp: 'base' });
function harness(request, extra = {}) {
  const doc = document(), docs = [doc], updates = [];
  const sync = createFileSynchronizer({ documents: () => docs, request, onUpdate: (doc, change) => updates.push(change), delay: 20, maxDelay: 60, ...extra });
  return { doc, docs, updates, sync };
}

test('clean external revisions load; dirty divergent revisions pause without a write', async () => {
  let next = { kind: 'loaded', file: file('external') };
  const calls = [];
  const { doc, sync, updates } = harness(async (method, params) => { calls.push(params); return next; });
  await sync.check(doc);
  assert.equal(doc.content, 'external');
  assert.equal(doc.savedContent, 'external');
  assert.ok(updates.some(update => update.contentChanged));
  doc.content = 'local';
  next = { kind: 'conflict', file: file('other client') };
  await sync.check(doc);
  sync.schedule(doc);
  await wait(70);
  assert.equal(doc.content, 'local');
  assert.equal(doc.savedContent, 'external');
  assert.equal(sync.state(doc).issue.kind, 'conflict');
  assert.equal(await sync.flush(doc), false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.write));
  sync.forget(doc);
});

test('typing while a save is pending keeps newer edits and serializes the next save', async () => {
  let finish, inFlight = 0, peak = 0;
  const calls = [];
  const { doc, sync } = harness(async (method, params) => {
    calls.push(params); peak = Math.max(peak, ++inFlight);
    if (params.write && calls.length === 2) await new Promise(resolve => { finish = resolve; });
    inFlight--;
    return { kind: params.write ? 'saved' : 'current', file: file(params.content) };
  });
  await sync.check(doc);
  doc.content = 'first';
  const saving = sync.flush(doc);
  while (!finish) await wait(1);
  doc.content = 'second'; sync.schedule(doc);
  const reading = sync.check(doc);
  finish(); await saving;
  assert.equal(doc.content, 'second');
  assert.equal(doc.savedContent, 'first');
  await reading;
  await sync.flush(doc);
  assert.equal(doc.savedContent, 'second');
  assert.equal(peak, 1);
  assert.equal(sync.state(doc).issue, null);
  sync.forget(doc);
});

test('typing during a clean read never gets replaced by the read result', async () => {
  let finish;
  const { doc, sync } = harness(() => new Promise(resolve => { finish = resolve; }));
  const reading = sync.check(doc);
  while (!finish) await wait(1);
  doc.content = 'typing now';
  finish({ kind: 'loaded', file: file('external') });
  await reading;
  assert.equal(doc.content, 'typing now');
  assert.equal(doc.savedContent, 'base');
  assert.equal(sync.state(doc).issue.kind, 'conflict');
  sync.forget(doc);
});

test('missing and inaccessible files retain drafts; retry can recover', async () => {
  let next = { kind: 'missing', file: null };
  const { doc, sync } = harness(async () => { if (next instanceof Error) throw next; return next; });
  doc.content = 'local';
  sync.schedule(doc);
  await wait(25);
  assert.equal(sync.state(doc).initialized, false, 'restored drafts must be checked before autosaving');
  await sync.check(doc);
  assert.equal(sync.state(doc).issue.kind, 'missing');
  assert.equal(doc.content, 'local');
  next = new Error('locked'); await sync.check(doc);
  assert.equal(sync.state(doc).issue.message, 'locked');
  next = { kind: 'unchanged', file: file('base') }; await sync.check(doc);
  assert.equal(sync.state(doc).issue, null);
  assert.equal(doc.savedContent, 'base');
  sync.forget(doc);
});

test('automatic writes are debounced, preserve undo content, and stop for closed documents', async () => {
  const writes = [];
  const { doc, docs, sync } = harness(async (method, params) => {
    if (params.write) writes.push(params.content);
    return { kind: params.write ? 'saved' : 'current', file: file(params.content) };
  });
  await sync.check(doc);
  for (let i = 0; i < 4; i++) { doc.content = String(i); sync.schedule(doc); await wait(5); }
  await wait(45);
  assert.deepEqual(writes, ['3']);
  doc.content = 'base'; sync.schedule(doc); await wait(40);
  assert.equal(doc.savedContent, 'base', 'undoing an edit is itself saved');
  doc.content = 'closed'; sync.schedule(doc); docs.pop(); sync.forget(doc); await wait(40);
  assert.deepEqual(writes, ['3', 'base']);
});

test('composition and close confirmation pause automatic writes', async () => {
  let composing = true, writes = 0;
  const { doc, sync } = harness(async (method, params) => {
    if (params.write) writes++;
    return { kind: params.write ? 'saved' : 'unchanged', file: file(params.write ? params.content : 'base') };
  }, { canSave: () => !composing });
  await sync.check(doc);
  doc.content = '输入中文'; sync.schedule(doc); await wait(50);
  assert.equal(writes, 0);
  composing = false; sync.pause(doc); await wait(30);
  assert.equal(writes, 0);
  sync.pause(doc, false); await wait(40);
  assert.equal(writes, 1);
  sync.forget(doc);
});

test('own save notifications and metadata-only changes never replace the editor', async () => {
  const { doc, sync, updates } = harness(async () => ({ kind: 'current', file: { ...file('base'), encoding: 'UTF-16 LE', lineEnding: 'CRLF' } }));
  await sync.check(doc); await sync.check(doc);
  assert.ok(updates.every(update => !update.contentChanged));
  assert.equal(doc.encoding, 'UTF-16 LE');
  assert.equal(doc.lineEnding, 'CRLF');
  sync.forget(doc);
});

test('minimal source changes keep unchanged suffixes available for cursor mapping', () => {
  assert.deepEqual(sourceChange('first\ncaret here\nlast', 'a new first\ncaret here\nlast'), { from: 0, to: 0, insert: 'a new ' });
  assert.deepEqual(sourceChange('abc', 'aXc'), { from: 1, to: 2, insert: 'X' });
  assert.deepEqual(sourceChange('', ''), { from: 0, to: 0, insert: '' });
});

test('continuous typing still saves at the maximum delay', async () => {
  const writes = [];
  const { doc, sync } = harness(async (method, params) => {
    if (params.write) writes.push(params.content);
    return { kind: params.write ? 'saved' : 'current', file: file(params.content) };
  }, { delay: 50, maxDelay: 70 });
  await sync.check(doc);
  for (let i = 0; i < 12; i++) { doc.content = `typing ${i}`; sync.schedule(doc); await wait(10); }
  assert.ok(writes.length >= 1, 'continuous input cannot postpone saves indefinitely');
  await sync.flush(doc);
  assert.equal(doc.savedContent, 'typing 11');
  sync.forget(doc);
});

test('temporary access errors retry and resume automatic saving', async () => {
  let locked = true;
  const { doc, sync } = harness(async (method, params) => {
    if (locked) throw new Error('temporarily locked');
    return { kind: params.write ? 'saved' : 'unchanged', file: file(params.write ? params.content : 'base') };
  });
  doc.content = 'draft';
  await sync.check(doc);
  assert.equal(sync.state(doc).issue.kind, 'error');
  locked = false;
  await wait(1120);
  assert.equal(doc.savedContent, 'draft');
  assert.equal(sync.state(doc).issue, null);
  sync.forget(doc);
});

test('external reads wait until IME composition finishes', async () => {
  let composing = true, reads = 0;
  const { doc, sync } = harness(async () => { reads++; return { kind: 'loaded', file: file('external') }; }, { canSave: () => !composing });
  await sync.check(doc); await wait(50);
  assert.equal(reads, 0);
  assert.equal(doc.content, 'base');
  composing = false;
  await sync.check(doc);
  assert.equal(reads, 1);
  assert.equal(doc.content, 'external');
  sync.forget(doc);
});
