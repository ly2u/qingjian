import mermaid from 'mermaid';
import createDOMPurify from 'dompurify';

let sequence = 0, currentTheme;
let queue = Promise.resolve();
const cache = new Map();

export function renderDiagram(source, theme, isCurrent = () => true) {
  const key = `${theme}:${source}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const work = queue.catch(() => {}).then(async () => {
    if (!isCurrent()) return null;
    if (cache.has(key)) return cache.get(key);
    if (source.length > 50000) throw new Error('图表内容过长，请拆分后显示。');
    if (currentTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: 50000,
        maxEdges: 1000,
        theme: theme === 'dark' ? 'dark' : 'neutral',
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
        flowchart: { htmlLabels: false, useMaxWidth: true },
        htmlLabels: false,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'htmlLabels', 'flowchart']
      });
      currentTheme = theme;
    }
    const { svg } = await mermaid.render(`qj-diagram-${++sequence}`, source);
    const purifier = createDOMPurify(window);
    const clean = purifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject', 'iframe'] });
    const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
    const root = parsed.documentElement;
    const bounds = (root.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
    if (bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
      root.setAttribute('width', String(Math.ceil(bounds[2])));
      root.setAttribute('height', String(Math.ceil(bounds[3])));
    }
    root.querySelectorAll('a').forEach(link => link.replaceWith(...link.childNodes));
    root.querySelectorAll('*').forEach(node => {
      for (const attr of [...node.attributes]) {
        if (/^(?:href|xlink:href|src)$/i.test(attr.name) && !attr.value.startsWith('#')) node.removeAttribute(attr.name);
      }
    });
    const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
    cache.set(key, uri);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    return uri;
  });
  queue = work;
  return work;
}
