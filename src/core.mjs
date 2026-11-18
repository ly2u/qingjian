/** Pure editing helpers shared by the app and its tests. */
export function wrapSelection(text, from, to, marker, placeholder = '文字', endMarker = marker) {
  const selected = text.slice(from, to);
  if (text.slice(Math.max(0, from - marker.length), from) === marker && text.slice(to, to + endMarker.length) === endMarker) {
    return { from: from - marker.length, to: to + endMarker.length, insert: selected, anchor: from - marker.length, head: to - marker.length };
  }
  if (selected.startsWith(marker) && selected.endsWith(endMarker) && selected.length >= marker.length + endMarker.length) {
    const insert = selected.slice(marker.length, -endMarker.length);
    return { from, to, insert, anchor: from, head: from + insert.length };
  }
  const value = selected || placeholder;
  return { from, to, insert: marker + value + endMarker, anchor: from + marker.length, head: from + marker.length + value.length };
}

export function prefixLines(text, from, to, prefix) {
  const start = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
  let end = text.indexOf('\n', to);
  if (end < 0) end = text.length;
  if (to > from && text[to - 1] === '\n') end = to - 1;
  const lines = text.slice(start, end).split('\n');
  const remove = lines.some(line => line.trim()) && lines.every(line => !line.trim() || line.startsWith(prefix));
  const insert = lines.map(line => remove ? (line.startsWith(prefix) ? line.slice(prefix.length) : line) : prefix + line).join('\n');
  return { from: start, to: end, insert, anchor: start, head: start + insert.length };
}

export function setHeading(text, from, to, level) {
  const start = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
  let end = text.indexOf('\n', to);
  if (end < 0) end = text.length;
  if (to > from && text[to - 1] === '\n') end = to - 1;
  const insert = text.slice(start, end).split('\n').map(line => '#'.repeat(level) + (level ? ' ' : '') + line.replace(/^ {0,3}#{1,6}(?:\s+|$)/, '')).join('\n');
  return { from: start, to: end, insert, anchor: start, head: start + insert.length };
}

export function normalizeText(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function displayName(path) {
  return String(path || '').split(/[\\/]/).pop() || '未命名.md';
}

export function countCharacters(text) {
  return Array.from(text.replace(/\s/g, '')).length;
}

export function interpolate(value, pairs, fromKey, toKey) {
  if (!pairs.length) return 0;
  if (value <= pairs[0][fromKey]) return pairs[0][toKey];
  for (let i = 1; i < pairs.length; i++) {
    if (value <= pairs[i][fromKey]) {
      const a = pairs[i - 1], b = pairs[i];
      const span = b[fromKey] - a[fromKey];
      return a[toKey] + (span > 0 ? (value - a[fromKey]) / span : 0) * (b[toKey] - a[toKey]);
    }
  }
  return pairs.at(-1)[toKey];
}

/** Ignore fenced and indented code, including fenced blocks nested in quotes. */
export function taskMarkers(source) {
  const result = [];
  let offset = 0, fence = null;
  for (const line of source.split('\n')) {
    const stripped = line.replace(/^ {0,3}(?:>\s*)+/, '');
    const match = stripped.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (match) {
      if (!fence) fence = { char: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
    } else if (!fence) {
      const task = line.match(/^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/);
      if (task) result.push({ offset: offset + task[1].length, checked: task[2].toLowerCase() === 'x' });
    }
    offset += line.length + 1;
  }
  return result;
}

export function restoreSession(raw) {
  if (!raw || typeof raw !== 'object') return { documents: [], activeId: null, settings: {} };
  const seen = new Set();
  const documents = (Array.isArray(raw.documents) ? raw.documents : []).filter(doc => {
    if (!doc || typeof doc.content !== 'string' || typeof doc.id !== 'string' || seen.has(doc.id)) return false;
    seen.add(doc.id);
    return true;
  }).map(doc => ({
    id: doc.id,
    name: typeof doc.name === 'string' ? doc.name : displayName(doc.path),
    path: typeof doc.path === 'string' ? doc.path : null,
    content: normalizeText(doc.content),
    savedContent: normalizeText(typeof doc.savedContent === 'string' ? doc.savedContent : ''),
    encoding: ['UTF-8', 'UTF-8 BOM', 'UTF-16 LE', 'UTF-16 BE', 'GB18030'].includes(doc.encoding) ? doc.encoding : 'UTF-8',
    lineEnding: doc.lineEnding === 'CRLF' ? 'CRLF' : 'LF',
    stamp: typeof doc.stamp === 'string' ? doc.stamp : null
  }));
  return { documents, activeId: documents.some(doc => doc.id === raw.activeId) ? raw.activeId : documents[0]?.id || null, settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {} };
}
