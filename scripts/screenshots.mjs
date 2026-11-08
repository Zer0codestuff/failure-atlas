// Capture the web UI at four widths and fail on console errors or page-level horizontal overflow.
// Usage: node scripts/screenshots.mjs [baseUrl]   (default: starts `vite preview` on port 4173)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'docs/screenshots';
const WIDTHS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'phone-390', width: 390, height: 844 },
];

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not start`);
}

let server = null;
let base = process.argv[2];
if (!base) {
  server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
  base = 'http://localhost:4173/';
  await waitFor(base);
}
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const problems = [];
try {
  for (const w of WIDTHS) {
    const shots = [
      { file: `${w.name}-timeline.png`, query: '?paced=0', act: async () => {} },
      { file: `${w.name}-compare.png`, query: '?paced=0&panel=compare', act: async () => {} },
    ];
    if (w.width >= 1024) shots.push({ file: `${w.name}-graph.png`, query: '?paced=0&panel=graph', act: async () => {} });
    if (w.width <= 700) shots.push({ file: `${w.name}-inspector.png`, query: '?paced=0', act: async (page) => { await page.click('.tabs .tab:has-text("Inspector")'); } });
    for (const s of shots) {
      const page = await browser.newPage({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: 1 });
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${w.name} ${s.file}: console error ${m.text()}`); });
      page.on('pageerror', (e) => problems.push(`${w.name} ${s.file}: page error ${e.message}`));
      await page.goto(base + s.query);
      await page.waitForSelector('.run-line', { timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector('.btn.primary')?.textContent?.includes('running'));
      await s.act(page);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) problems.push(`${w.name} ${s.file}: page overflows horizontally by ${overflow}px`);
      await page.screenshot({ path: `${OUT}/${s.file}` });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`screenshots written to ${OUT}`);
