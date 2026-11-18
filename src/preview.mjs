import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import { taskMarkers } from './core.mjs';

for (const [name, language] of Object.entries({ javascript, typescript, python, json, bash, css, xml })) hljs.registerLanguage(name, language);
const aliases = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', html: 'xml' };
export const escapeHTML = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function createPreview(windowObject) {
  const purifier = createDOMPurify(windowObject);
  let checkboxIndex = 0;
  let formulas = [], diagrams = [];
  function mathPlaceholder(token) {
    const index = formulas.push({ tex: token.text, display: token.display }) - 1;
    const tag = token.display ? 'div' : 'span';
    return `<${tag} class="qj-math ${token.display ? 'qj-math-block' : ''}" data-qj-math="${index}">${escapeHTML(token.raw.trim())}</${tag}>`;
  }
  const parser = new Marked({
    gfm: true,
    renderer: {
      code({ text, lang }) {
        const requested = (lang || '').split(/\s/)[0].toLowerCase();
        if (requested === 'mermaid') {
          const index = diagrams.push({ source: text }) - 1;
          return `<figure class="qj-diagram" data-qj-diagram="${index}"><pre data-language="mermaid"><code>${escapeHTML(text)}</code></pre></figure>`;
        }
        const language = aliases[requested] || requested;
        const highlighted = hljs.getLanguage(language) && text.length < 40000 ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHTML(text);
        return `<pre data-language="${escapeHTML(requested || 'text')}"><code class="hljs">${highlighted}</code></pre>`;
      },
      checkbox({ checked }) {
        return `<input type="checkbox" data-qj-task="${checkboxIndex++}" ${checked ? 'checked' : ''} disabled> `;
      }
    },
    extensions: [{
      name: 'blockMath', level: 'block',
      start: src => { const at = src.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/); return at < 0 ? undefined : at; },
      tokenizer(src) {
        const match = /^ {0,3}(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\])[ \t]*(?:\n|$)/.exec(src);
        if (!match) return undefined;
        return { type: 'blockMath', raw: match[0], text: (match[1] ?? match[2]).trim(), display: true };
      },
      renderer: mathPlaceholder
    }, {
      name: 'inlineMath', level: 'inline',
      start: src => { const at = src.search(/\$|\\\(/); return at < 0 ? undefined : at; },
      tokenizer(src) {
        let match = /^\\\(([^\n]*?)\\\)/.exec(src);
        if (match) return { type: 'inlineMath', raw: match[0], text: match[1], display: false };
        if (!src.startsWith('$') || src.startsWith('$$') || /^\$\s/.test(src)) return undefined;
        match = /^\$((?:\\[^\n]|[^$\\\n])+?)\$(?!\d|\$)/.exec(src);
        if (!match || /\s$/.test(match[1])) return undefined;
        return { type: 'inlineMath', raw: match[0], text: match[1], display: false };
      },
      renderer: mathPlaceholder
    }, {
      name: 'wikilink', level: 'inline',
      start: src => src.indexOf('[['),
      tokenizer(src) {
        const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
        if (!match) return undefined;
        const [target, label] = match[1].split('|');
        return { type: 'wikilink', raw: match[0], target, label: label || target };
      },
      renderer(token) {
        let target = token.target;
        if (!/[.#]/.test(target)) target += '.md';
        return `<a href="${escapeHTML(target)}">${escapeHTML(token.label)}</a>`;
      }
    }]
  });

  return function render(source) {
    checkboxIndex = 0;
    formulas = []; diagrams = [];
    const tokens = parser.lexer(source);
    let line = 1, offset = 0;
    const html = tokens.map(token => {
      const tokenLine = line, tokenOffset = offset;
      line += (token.raw.match(/\n/g) || []).length;
      offset += token.raw.length;
      if (token.type === 'space' || token.type === 'def') return '';
      const blockTokens = [token];
      blockTokens.links = tokens.links;
      const endOffset = tokenOffset + token.raw.trimEnd().length;
      const endLine = tokenLine + (token.raw.trimEnd().match(/\n/g) || []).length;
      return `<div class="preview-block" data-source-line="${tokenLine}" data-source-end-line="${endLine}" data-source-from="${tokenOffset}" data-source-to="${endOffset}">${parser.parser(blockTokens)}</div>`;
    }).join('');
    const safe = purifier.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'video', 'audio', 'button', 'textarea', 'select', 'base', 'link', 'meta'],
      FORBID_ATTR: ['style', 'srcset', 'autofocus'],
      SANITIZE_NAMED_PROPS: true
    });
    const fragment = windowObject.document.createElement('div');
    fragment.innerHTML = safe;
    // Give table rows and individual list items their own source locations.
    for (const block of fragment.querySelectorAll('.preview-block')) {
      const start = Number(block.dataset.sourceFrom);
      const lines = source.slice(start, Number(block.dataset.sourceTo)).split('\n');
      const rows = [...block.querySelectorAll('table tr')];
      const items = [...block.querySelectorAll('li')];
      let innerOffset = start;
      const positions = lines.map((text, i) => {
        const result = { text, line: Number(block.dataset.sourceLine) + i, from: innerOffset, to: innerOffset + text.length };
        innerOffset += text.length + 1;
        return result;
      });
      const tableLines = positions.filter((entry, i) => i !== 1 && entry.text.trim());
      const listLines = positions.filter(entry => /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+/.test(entry.text));
      const annotate = (nodes, locations) => {
        if (nodes.length !== locations.length) return;
        nodes.forEach((node, i) => {
          Object.assign(node.dataset, { sourceFrom: String(locations[i].from), sourceTo: String(locations[i].to), sourceLine: String(locations[i].line), sourceEndLine: String(locations[i].line) });
        });
      };
      if (rows.length) annotate(rows, tableLines);
      if (items.length) annotate(items, listLines);
    }
    const markers = taskMarkers(source);
    const checkboxes = fragment.querySelectorAll('input[data-qj-task]');
    fragment.querySelectorAll('input').forEach(input => { input.disabled = true; });
    if (checkboxes.length === markers.length) checkboxes.forEach((input, i) => {
      input.disabled = false;
      input.dataset.taskOffset = String(markers[i].offset);
      input.setAttribute('aria-label', `任务：${input.closest('li')?.textContent.trim() || i + 1}`);
    });
    const headings = [...fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading, i) => {
      heading.id = `qj-heading-${i}`;
      return { text: heading.textContent, level: Number(heading.tagName.slice(1)), line: Number(heading.closest('.preview-block')?.dataset.sourceLine || 1), id: heading.id };
    });
    fragment.querySelectorAll('img').forEach(img => { img.loading = 'lazy'; img.decoding = 'async'; });
    return { html: fragment.innerHTML, headings, formulas, diagrams };
  };
}
