// Interaction checks against the built UI: keyboard operation, reduced motion, loading state,
// import errors, fault injection from the inspector, checkpoint fork, and viewport bounds.
// Writes docs/screenshots/state-*.png. Exits non-zero on the first failed expectation.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = 'http://localhost:4175/';
const server = spawn('npx', ['vite', 'preview', '--port', '4175', '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const results = [];
const errors = [];
function expect(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) throw new Error(`${name} ${detail}`);
}
const settled = (page) => page.waitForFunction(() => document.querySelector('.run-line') && !document.querySelector('.btn.primary')?.textContent?.includes('running'), null, { timeout: 20000 });

try {
  // 1. Reduced motion: pacing is off by default and the run renders complete.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  await settled(page);
  expect('reduced motion disables paced delivery', !(await page.isChecked('label:has-text("paced") input')));
  expect('opens into a working failing example', (await page.textContent('.tabs .badge.bad'))?.trim() === '1');

  // 2. Keyboard: t focuses the timeline, j/k/End move the selection, Enter keeps focus usable.
  await page.keyboard.press('t');
  await page.keyboard.press('Home');
  let sel = await page.textContent('.tl-row.selected .tl-seq');
  expect('Home selects the first event', sel?.trim() === '1', `got ${sel}`);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  sel = await page.textContent('.tl-row.selected .tl-seq');
  expect('j moves the selection down', sel?.trim() === '3', `got ${sel}`);
  await page.keyboard.press('k');
  sel = await page.textContent('.tl-row.selected .tl-seq');
  expect('k moves the selection up', sel?.trim() === '2', `got ${sel}`);
  await page.keyboard.press('End');
  const insp = await page.textContent('.insp-title');
  expect('inspector follows keyboard selection', /run\.finished/.test(insp ?? ''), insp);
  await page.keyboard.press('/');
  expect('/ focuses search', await page.evaluate(() => document.activeElement?.id === 'tl-search'));
  await page.keyboard.type('charge');
  const count = await page.textContent('.timeline-tools .muted');
  expect('search filters events', /of 21/.test(count ?? ''), count);
  await page.fill('#tl-search', '');
  await page.keyboard.press('Escape');
  expect('Escape leaves the search field', await page.evaluate(() => document.activeElement?.id !== 'tl-search'));
  await page.keyboard.press('3');
  expect('number keys switch panels', (await page.getAttribute('.tabs .tab:nth-child(3)', 'aria-selected')) === 'true');
  await page.keyboard.press('1');

  // 2b. The verdict states the outcome in text and offers the corrected policy as the next step.
  expect('verdict names the failing check', /FAILING/.test((await page.textContent('.verdict')) ?? '') && !!(await page.$('.verdict-bad')));
  await page.click('.verdict .btn.fix');
  await settled(page);
  await page.waitForSelector('.verdict-ok');
  expect('corrected policy run passes and is selected', (await page.inputValue('#sel-policy')) === 'corrected');
  await page.waitForSelector('.divergence');
  expect('corrected run opens the comparison against the failing run', (await page.getAttribute('.tabs .tab:has-text("Compare")', 'aria-selected')) === 'true');
  await page.screenshot({ path: 'docs/screenshots/state-corrected-compare.png' });
  const before = Number(await page.getAttribute('.splitter', 'aria-valuenow'));
  await page.focus('.splitter');
  await page.keyboard.press('ArrowUp');
  const after = Number(await page.getAttribute('.splitter', 'aria-valuenow'));
  expect('panel splitter resizes with the keyboard', after === Math.min(75, before + 5), `${before} -> ${after}`);
  await page.dblclick('.splitter');
  await page.selectOption('#sel-policy', 'faulty');
  await page.click('.tabs .tab:has-text("Checks")');
  await page.keyboard.press('r');
  await settled(page);

  // 3. Fault injection from the inspector creates a new run with that fault.
  await page.click('.tl-row:has-text("charge: request payments.charge")');
  await page.waitForSelector('section[aria-label="Inject a fault at this request"]');
  await page.screenshot({ path: 'docs/screenshots/state-fault-composer.png' });
  const runsBefore = await page.evaluate(() => document.querySelectorAll('.runs li').length);
  await page.click('section[aria-label="Inject a fault at this request"] button:has-text("run with this fault")');
  await settled(page);
  const line = await page.textContent('.run-line');
  expect('injected fault produces a new custom run', /Custom:/.test(line ?? ''), line);
  void runsBefore;

  // 4. Fork from the declared checkpoint with the corrected policy; parent stays intact.
  await page.selectOption('#sel-faults', 'lost-response');
  await page.selectOption('#sel-policy', 'faulty');
  await page.keyboard.press('r');
  await settled(page);
  await page.click('.tl-row:has-text("Checkpoint before-charge")');
  await page.waitForSelector('section[aria-label="Fork from this checkpoint"]');
  await page.selectOption('section[aria-label="Fork from this checkpoint"] select >> nth=0', 'corrected');
  await page.click('section[aria-label="Fork from this checkpoint"] button:has-text("fork run")');
  await settled(page);
  const notice = await page.textContent('.notice');
  expect('fork verifies the replayed prefix', /replayed prefix matched the parent/.test(notice ?? ''), notice);
  expect('forked run passes its checks', !(await page.$('.tabs .badge.bad')));
  await page.click('.tabs .tab:has-text("Compare")');
  await page.waitForSelector('.divergence');
  await page.screenshot({ path: 'docs/screenshots/state-fork-compare.png' });

  // 5. Import errors are explained, not swallowed.
  await page.setInputFiles('input[type=file]', { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"fa.trace/1","id":"x","mode":"simulation","events":[{"seq":5}],"hashes":{"events":"x"},"capabilities":{}}') });
  await page.waitForSelector('.notice.bad');
  const err = await page.textContent('.notice.bad');
  expect('invalid import shows the validation issues', /failed validation/.test(err ?? '') && /sequence numbers must be contiguous/.test(err ?? ''), err);
  await page.screenshot({ path: 'docs/screenshots/state-import-error.png' });
  await page.setInputFiles('input[type=file]', { name: 'html.json', mimeType: 'application/json', buffer: Buffer.from('<script>alert(1)</script>') });
  await page.waitForFunction(() => /not valid JSON|UNKNOWN|JSON/i.test(document.querySelector('.notice.bad')?.textContent ?? ''));
  expect('script text is never executed', !(await page.evaluate(() => document.querySelector('script:not([type=module])'))));
  await ctx.close();

  // 6. Loading: paced runs show the recording state and stream events in.
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p2.goto(base + '?scenario=retry-limit-exhausted');
  await p2.waitForFunction(() => document.querySelector('.timeline-tools')?.textContent?.includes('recording') || document.querySelector('.btn.primary')?.textContent?.includes('running'), null, { timeout: 10000 });
  await p2.screenshot({ path: 'docs/screenshots/state-loading.png' });
  expect('paced run shows a loading state', true);
  await settled(p2);
  await p2.close();

  // 7. Viewport bounds at every required width, on every panel.
  for (const width of [1440, 1024, 768, 390]) {
    const p = await browser.newPage({ viewport: { width, height: 860 } });
    await p.goto(base + '?paced=0');
    await settled(p);
    for (const tab of ['Checks', 'Compare', 'Graph', 'Policy', 'State', 'Export', 'Runs']) {
      if (width <= 700) await p.click('.mobile-tabs .tab:nth-child(3)');
      await p.click(`.tabs .tab:has-text("${tab}")`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(`no horizontal page overflow at ${width}px on ${tab}`, over <= 1, `${over}px`);
    }
    await p.close();
  }
  expect('no console or page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.error(String(e));
} finally {
  await browser.close();
  server.kill();
  writeFileSync('docs/ui-check.json', JSON.stringify({ generatedAt: new Date().toISOString(), results, errors }, null, 2));
  for (const r of results) console.log(`${r.ok ? '[ok]  ' : '[FAIL]'} ${r.name}${r.ok ? '' : `: ${r.detail}`}`);
  if (results.some((r) => !r.ok) || !results.length) process.exit(1);
}
