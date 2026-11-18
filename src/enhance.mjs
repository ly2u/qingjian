let mathModule, diagramModule, stylePromise;
const mathCache = new Map();

function ensureMathStyles() {
  if (!stylePromise) stylePromise = new Promise((resolve, reject) => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'katex.css', id: 'math-styles' });
    link.onload = resolve;
    link.onerror = () => { link.remove(); stylePromise = null; reject(new Error('公式样式加载失败，请检查程序文件是否完整。')); };
    document.head.append(link);
  });
  return stylePromise;
}

function showError(node, title, source, error) {
  node.classList.add('qj-render-error');
  node.replaceChildren();
  const summary = document.createElement('span');
  summary.className = 'qj-error-label';
  summary.textContent = title;
  summary.title = String(error?.message || error).replace(/^Parse error[^:]*:/, '').slice(0, 500);
  const code = document.createElement('code');
  code.textContent = source;
  node.append(summary, code);
  node.setAttribute('aria-label', `${title}：${source}`);
}

export async function enhancePreview(container, result, { theme = 'light', isCurrent = () => true, onLayout = () => {} } = {}) {
  const work = [];
  if (result.formulas.length) {
    mathModule ||= import('./math.mjs');
    work.push(Promise.all([mathModule, ensureMathStyles()]).then(([module]) => {
      for (const [i, formula] of result.formulas.entries()) {
        if (!isCurrent()) return;
        const node = container.querySelector(`[data-qj-math="${i}"]`);
        if (!node) continue;
        try {
          const key = `${formula.display}:${formula.tex}`;
          if (!mathCache.has(key)) {
            mathCache.set(key, module.renderFormula(formula.tex, formula.display));
            if (mathCache.size > 128) mathCache.delete(mathCache.keys().next().value);
          }
          node.innerHTML = mathCache.get(key);
          node.classList.add('qj-rendered');
        } catch (error) { showError(node, '公式语法有误', formula.tex, error); }
      }
      onLayout();
    }).catch(error => {
      if (isCurrent()) container.querySelectorAll('[data-qj-math]').forEach(node => showError(node, '公式加载失败', node.textContent, error));
    }));
  }
  if (result.diagrams.length) {
    diagramModule ||= import('./diagrams.mjs');
    work.push(diagramModule.then(async module => {
      for (const [i, diagram] of result.diagrams.entries()) {
        if (!isCurrent()) return;
        const node = container.querySelector(`[data-qj-diagram="${i}"]`);
        if (!node) continue;
        try {
          const uri = await module.renderDiagram(diagram.source, theme, isCurrent);
          if (!isCurrent() || !uri) return;
          const image = Object.assign(document.createElement('img'), { src: uri, alt: 'Mermaid 图表', className: 'qj-diagram-image' });
          await image.decode();
          if (!isCurrent()) return;
          node.replaceChildren(image);
          node.classList.add('qj-rendered');
        } catch (error) { if (isCurrent()) showError(node, '图表语法有误', diagram.source, error); }
        onLayout();
      }
    }).catch(error => {
      if (isCurrent()) container.querySelectorAll('[data-qj-diagram]').forEach(node => showError(node, '图表加载失败', node.textContent, error));
    }));
  }
  await Promise.all(work);
  if (result.formulas.length && isCurrent()) await document.fonts.ready;
  onLayout();
}
