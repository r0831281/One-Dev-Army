import assert from 'node:assert/strict';
import { access, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [
  process.env.ODA_BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* next browser */ }
}
assert.ok(executablePath, 'Set ODA_BROWSER_PATH to an installed Chrome, Chromium, or Edge executable.');
const output = path.join(root, '.validation', 'diagrams');
await mkdir(output, { recursive: true });
const names = ['README.md', ...(await readdir(path.join(root, 'docs'))).filter(name => name.endsWith('.md')).sort().map(name => `docs/${name}`)];
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--disable-background-networking'] });
const results = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:light}html,body{background:#fff;color:#111;margin:0}svg{background:#fff}</style></head><body></body></html>');
  await page.addScriptTag({ path: path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js') });
  await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', deterministicIds: true }));
  for (const name of names) {
    const source = await readFile(path.join(root, name), 'utf8');
    const blocks = [...source.matchAll(/^```mermaid\r?\n([\s\S]*?)^```\s*$/gm)];
    for (const [index, match] of blocks.entries()) {
      const id = `diagram-${results.length + 1}`;
      const rendered = await page.evaluate(async ({ id, definition }) => {
        const result = await window.mermaid.render(id, definition);
        document.body.innerHTML = result.svg;
        const svg = document.querySelector('svg');
        svg.style.backgroundColor = '#ffffff';
        const bounds = svg.getBoundingClientRect();
        return { svg: new XMLSerializer().serializeToString(svg), width: bounds.width, height: bounds.height };
      }, { id, definition: match[1] });
      assert.ok(rendered.svg.includes('<svg') && rendered.width > 0 && rendered.height > 0, `${name}: empty diagram`);
      const basename = `${path.basename(name, '.md')}-${index + 1}`;
      await writeFile(path.join(output, `${basename}.svg`), rendered.svg);
      const svgElement = await page.$('svg');
      assert.ok(svgElement, `${name}: SVG element missing`);
      await svgElement.screenshot({ path: path.join(output, `${basename}.png`) });
      results.push({ source: name, block: index + 1, file: `${basename}.svg`, width: rendered.width, height: rendered.height });
    }
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(results, null, 2));
process.stdout.write(`${results.length} Mermaid diagrams rendered to .validation/diagrams\n`);
