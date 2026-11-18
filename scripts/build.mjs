import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.resolve(root, process.env.QINGJIAN_OUTPUT_DIR || 'dist');
if (!distRoot.startsWith(root + path.sep)) throw new Error('Output must stay inside the project workspace.');
const output = path.join(distRoot, 'web');
await fs.mkdir(output, { recursive: true });
const previewCSS = await fs.readFile(path.join(root, 'src', 'preview.css'), 'utf8');
const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/app.mjs'],
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: ['chrome120'],
  outdir: output,
  legalComments: 'external',
  define: { __PREVIEW_CSS__: JSON.stringify(previewCSS) },
  metafile: true
});
const styles = (await esbuild.transform(await fs.readFile(path.join(root, 'src', 'style.css'), 'utf8') + '\n' + previewCSS, { loader: 'css', minify: true })).code;
await fs.writeFile(path.join(output, 'app.css'), styles);
const katexPath = path.join(root, 'node_modules', 'katex', 'dist');
let mathCSS = await fs.readFile(path.join(katexPath, 'katex.min.css'), 'utf8');
mathCSS = mathCSS.replace(/src:url\(([^)]*\.woff2)\) format\("woff2"\)[^}]*/g, 'src:url($1) format("woff2")');
await fs.mkdir(path.join(output, 'fonts'), { recursive: true });
for (const name of (await fs.readdir(path.join(katexPath, 'fonts'))).filter(name => name.endsWith('.woff2'))) await fs.copyFile(path.join(katexPath, 'fonts', name), path.join(output, 'fonts', name));
await fs.writeFile(path.join(output, 'katex.css'), mathCSS);
let exportCSS = mathCSS;
for (const name of (await fs.readdir(path.join(output, 'fonts'))).filter(name => name.endsWith('.woff2'))) {
  const bytes = await fs.readFile(path.join(output, 'fonts', name));
  exportCSS = exportCSS.replaceAll(`url(fonts/${name})`, `url(data:font/woff2;base64,${bytes.toString('base64')})`);
}
await fs.writeFile(path.join(output, 'katex-export.css'), exportCSS);
for (const name of ['index.html', 'icon.svg']) await fs.copyFile(path.join(root, 'src', name), path.join(output, name));
await fs.mkdir(path.join(root, '.build'), { recursive: true });
await fs.writeFile(path.join(root, '.build', 'bundle-meta.json'), JSON.stringify(result.metafile));

// Include license texts for production dependencies, including transitive ones.
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
let notices = '轻笺 third-party notices\n\n';
for (const [folder, info] of Object.entries(lock.packages)) {
  if (!folder || info.dev || info.optional) continue;
  const packagePath = path.join(root, folder);
  const metadata = JSON.parse(await fs.readFile(path.join(packagePath, 'package.json'), 'utf8'));
  notices += `\n--- ${metadata.name} ${metadata.version} (${metadata.license || 'see license'}) ---\n\n`;
  const files = await fs.readdir(packagePath);
  for (const filename of files.filter(name => /^(?:license|licence|copying)(?:\.|$)/i.test(name))) {
    notices += await fs.readFile(path.join(packagePath, filename), 'utf8') + '\n';
  }
}
await fs.writeFile(path.join(distRoot, 'THIRD_PARTY_NOTICES.txt'), notices);
const bundle = await fs.readFile(path.join(output, 'app.js'));
console.log(`Web bundle: ${(bundle.length / 1024).toFixed(1)} KiB, gzip ${(gzipSync(bundle).length / 1024).toFixed(1)} KiB`);
