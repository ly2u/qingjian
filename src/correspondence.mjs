import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

export const showPeerRange = StateEffect.define();
export const peerRangeField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    let explicit = false;
    for (const effect of transaction.effects) {
      if (!effect.is(showPeerRange)) continue;
      explicit = true;
      const { from, to } = effect.value;
      const doc = transaction.state.doc;
      const first = doc.lineAt(Math.min(from, doc.length)).number;
      const last = doc.lineAt(Math.min(Math.max(from, to - 1), doc.length)).number;
      const lines = [];
      for (let number = first; number <= Math.min(last, first + 3000); number++) lines.push(Decoration.line({ class: 'cm-peer-range' }).range(doc.line(number).from));
      value = Decoration.set(lines);
    }
    if (transaction.selection && !explicit) value = Decoration.none;
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

export function correspondingElement(container, sourceLine) {
  let best = null, smallest = Infinity;
  for (const element of container.querySelectorAll('[data-source-line][data-source-end-line]')) {
    const start = Number(element.dataset.sourceLine), end = Number(element.dataset.sourceEndLine);
    if (sourceLine >= start && sourceLine <= end && end - start <= smallest) {
      best = element;
      smallest = end - start;
    }
  }
  return best;
}
