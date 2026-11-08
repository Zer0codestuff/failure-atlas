// Measure import, first render, search, scrolling and comparison of the generated 10k-event traces
// in the built web UI. Run `npm run bench` first to produce bench/out/trace-{a,b}.json.
// Usage: node scripts/browser-bench.mjs
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const base = 'http://localhost:4174/';
const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const eventsA = JSON.parse(readFileSync('bench/out/trace-a.json', 'utf8')).events.length;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-precise-memory-info'] });
const REPS = 3;
const samples = { importAndRender: [], searchFilter: [], searchClear: [], scrollToEnd: [], importSecondAndCompare: [] };
let heap = null;
let rowsInDom = null;
try {
  for (let rep = 0; rep < REPS; rep++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base + '?paced=0');
    await page.waitForSelector('.run-line');
    await page.waitForFunction(() => !document.querySelector('.btn.primary')?.textContent?.includes('running'));
    // Import A and wait for the timeline to show every event.
    let t0 = Date.now();
    await page.setInputFiles('input[type=file]', 'bench/out/trace-a.json');
    await page.waitForFunction((n) => document.querySelector('.timeline-tools')?.textContent?.includes(`${n} events`) && document.querySelectorAll('.tl-row').length > 0, eventsA, { timeout: 60000 });
    samples.importAndRender.push(Date.now() - t0);
    rowsInDom = await page.evaluate(() => document.querySelectorAll('.tl-row').length);
    // Search for one order.
    t0 = Date.now();
    await page.fill('#tl-search', 'B-00377');
    await page.waitForFunction(() => /\b3 of \d+|^3 /.test(document.querySelector('.timeline-tools')?.textContent ?? '') || document.querySelectorAll('.tl-row').length === 3, null, { timeout: 10000 });
    samples.searchFilter.push(Date.now() - t0);
    t0 = Date.now();
    await page.fill('#tl-search', '');
    await page.waitForFunction(() => document.querySelectorAll('.tl-row').length > 3);
    samples.searchClear.push(Date.now() - t0);
    // Scroll to the last event.
    t0 = Date.now();
    await page.evaluate(() => { const el = document.querySelector('.timeline-scroll'); el.scrollTop = el.scrollHeight; });
    await page.waitForFunction((n) => [...document.querySelectorAll('.tl-seq')].some((s) => s.textContent?.trim() === String(n)), eventsA);
    samples.scrollToEnd.push(Date.now() - t0);
    // Import B, make A the baseline, and wait for the first divergence to render.
    t0 = Date.now();
    await page.setInputFiles('input[type=file]', 'bench/out/trace-b.json');
    await page.waitForFunction(() => document.querySelector('.run-line')?.textContent?.includes('trace-b'), null, { timeout: 60000 }).catch(() => {});
    await page.click('.tabs .tab:has-text("Runs")');
    await page.click('.runs li:has-text("trace-a") button:has-text("set as baseline")');
    await page.click('.tabs .tab:has-text("Compare")');
    await page.waitForSelector('.divergence', { timeout: 60000 });
    samples.importSecondAndCompare.push(Date.now() - t0);
    heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const result = {
  generatedAt: new Date().toISOString(),
  input: { traceA: 'bench/out/trace-a.json', traceB: 'bench/out/trace-b.json', eventsA },
  browser: `${browser.version?.() ?? 'chromium'} headless`,
  host: { platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length },
  repetitions: REPS,
  medianMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)])),
  samplesMs: samples,
  timelineRowsInDom: rowsInDom,
  mainThreadHeapMb: heap,
  notes: 'Wall-clock time measured from Playwright, so each number includes protocol overhead of a few ms. Import includes file read, worker parse/validate/integrity hash, structured clone to the main thread and first render. The worker heap is not included in mainThreadHeapMb.',
};
writeFileSync('bench/out/browser-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
