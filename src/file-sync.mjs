export function sourceChange(before, after) {
  let from = 0, endBefore = before.length, endAfter = after.length;
  while (from < endBefore && from < endAfter && before[from] === after[from]) from++;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}

// File operations for each document share one queue. Watcher messages only request a
// fresh read, so a delayed notification can never replay an older disk snapshot.
export function createFileSynchronizer({ documents, request, onUpdate = () => {}, canSave = () => true, delay = 700, maxDelay = 2000 }) {
  const states = new Map();
  const dirty = doc => doc.content !== doc.savedContent;
  const exists = doc => documents().includes(doc);
  function state(doc) {
    let entry = states.get(doc.id);
    if (!entry) { entry = { chain: Promise.resolve(), timer: null, firstEdit: 0, initialized: false, issue: null, saving: false }; states.set(doc.id, entry); }
    if (entry.path !== doc.path) {
      clearTimeout(entry.timer); clearTimeout(entry.retryTimer); entry.timer = null; entry.firstEdit = 0; entry.retryCount = 0;
      entry.path = doc.path; entry.initialized = false; entry.issue = null;
    }
    return entry;
  }
  function exclusive(doc, operation) {
    const entry = state(doc);
    const result = entry.chain.catch(() => {}).then(() => exists(doc) ? operation() : false);
    entry.chain = result.catch(() => {});
    return result;
  }
  function schedule(doc) {
    if (!doc?.path || !exists(doc)) return;
    const entry = state(doc);
    clearTimeout(entry.timer); entry.timer = null;
    if (!dirty(doc) || !entry.initialized || entry.issue || entry.paused) { entry.firstEdit = 0; return; }
    entry.firstEdit ||= Date.now();
    const wait = canSave(doc) ? Math.min(delay, Math.max(0, maxDelay - (Date.now() - entry.firstEdit))) : delay;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!canSave(doc)) { entry.firstEdit = 0; schedule(doc); return; }
      synchronize(doc, { write: true });
    }, wait);
  }
  function synchronize(doc, { write = false, overwriteStamp, recreate = false } = {}) {
    if (!doc?.path || !exists(doc)) return Promise.resolve(false);
    return exclusive(doc, async () => {
      const entry = state(doc);
      clearTimeout(entry.retryTimer); entry.retryTimer = null;
      clearTimeout(entry.timer); entry.timer = null; entry.firstEdit = 0;
      if (write && entry.issue && !overwriteStamp && !recreate) return false;
      if (!canSave(doc)) {
        entry.timer = setTimeout(() => { entry.timer = null; synchronize(doc, { write, overwriteStamp, recreate }); }, delay);
        return false;
      }
      const snapshot = { path: doc.path, content: doc.content, savedContent: doc.savedContent, encoding: doc.encoding, lineEnding: doc.lineEnding, write, overwriteStamp, recreate };
      entry.saving = write && dirty(doc); onUpdate(doc, {});
      try {
        const result = await request('syncFile', snapshot);
        if (!exists(doc) || doc.path !== snapshot.path) return false;
        entry.initialized = true;
        let contentChanged = false;
        const file = result.file;
        if (result.kind === 'missing') entry.issue = { kind: 'missing' };
        else if (!file || typeof file.content !== 'string') throw new Error('无法读取文件同步结果，请重试。');
        else {
          if (result.kind === 'saved') doc.savedContent = snapshot.content;
          // The user may keep typing while a read or save is in flight.
          if (file.content === doc.content) {
            doc.savedContent = file.content; entry.issue = null;
          } else if (file.content === doc.savedContent && result.kind !== 'conflict') entry.issue = null;
          else if (!dirty(doc) && result.kind !== 'conflict') {
            doc.content = doc.savedContent = file.content; contentChanged = true; entry.issue = null;
          } else entry.issue = { kind: 'conflict', file };
          if (!entry.issue) {
            doc.stamp = file.stamp; doc.encoding = file.encoding || doc.encoding; doc.lineEnding = file.lineEnding || doc.lineEnding;
          }
        }
        onUpdate(doc, { contentChanged, external: contentChanged });
        return !entry.issue && !dirty(doc);
      } catch (error) {
        if (exists(doc) && doc.path === snapshot.path) { entry.issue = { kind: 'error', message: error.message || String(error) }; onUpdate(doc, {}); }
        return false;
      } finally {
        entry.saving = false;
        if (exists(doc)) {
          onUpdate(doc, {}); schedule(doc);
          if (entry.issue?.kind === 'error' && !entry.paused) {
            const retryDelay = Math.min(10000, 1000 * 2 ** (entry.retryCount || 0));
            entry.retryCount = Math.min(4, (entry.retryCount || 0) + 1);
            entry.retryTimer = setTimeout(() => synchronize(doc), retryDelay);
          } else entry.retryCount = 0;
        }
      }
    });
  }
  function forget(doc) { const entry = states.get(doc.id); if (entry) { clearTimeout(entry.timer); clearTimeout(entry.retryTimer); } states.delete(doc.id); }
  async function flush(doc) {
    const entry = state(doc);
    await entry.chain;
    return synchronize(doc, { write: true });
  }
  function stopTimer(doc) { const entry = state(doc); clearTimeout(entry.timer); entry.timer = null; }
  function pause(doc, value = true) {
    const entry = state(doc); entry.paused = value; stopTimer(doc);
    clearTimeout(entry.retryTimer); entry.retryTimer = null;
    if (!value) { if (!entry.initialized || entry.issue?.kind === 'error') synchronize(doc); else schedule(doc); }
  }
  return { state, schedule, check: doc => synchronize(doc), synchronize, flush, exclusive, forget, stopTimer, pause };
}
