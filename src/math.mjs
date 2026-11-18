import katex from 'katex';

export function renderFormula(tex, display) {
  if (tex.length > 16000) throw new Error('公式过长，请拆分后显示。');
  return katex.renderToString(tex, {
    displayMode: display,
    output: 'htmlAndMathml',
    throwOnError: true,
    trust: false,
    strict: 'ignore',
    maxExpand: 1000,
    maxSize: 20,
    macros: {}
  });
}
