// Keep repeated headings distinct and preserve folding when body text changes.
export function outlineRows(headings, collapsed = new Set()) {
  const stack = [], occurrences = new Map();
  return headings.map((heading, index) => {
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    const signature = JSON.stringify([heading.level, heading.text]);
    const occurrence = occurrences.get(signature) || 0;
    occurrences.set(signature, occurrence + 1);
    const key = JSON.stringify([heading.level, heading.text, occurrence]);
    const parent = stack.at(-1);
    const row = {
      ...heading, index, key, depth: stack.length, parent: parent?.index ?? null,
      hasChildren: index + 1 < headings.length && headings[index + 1].level > heading.level,
      collapsed: collapsed.has(key), hidden: Boolean(parent && (parent.hidden || parent.collapsed))
    };
    stack.push(row);
    return row;
  });
}

export function headingAtLine(headings, line) {
  let low = 0, high = headings.length - 1, result = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (headings[middle].line <= line) { result = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return result;
}
