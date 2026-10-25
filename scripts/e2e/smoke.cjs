// Browser smoke test: every screen of the app against a local server with a sloppy fake AI.
// Fails on any page error or error message on screen. Run before every deploy:
//   npm run build && CLASSPILOT_INSECURE_COOKIE=1 CLASSPILOT_CONFIG=<cfg> CLASSPILOT_DATA=<tmp> CLASSPILOT_STATIC=dist \
//     node --import ./scripts/e2e/stub-ai.mjs dist-server/server.mjs &   then   node scripts/e2e/smoke.cjs http://127.0.0.1:8787 <passcode> <fake-audio.wav>
const { chromium } = require('playwright');
const [base, passcode, wav] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : []), '--autoplay-policy=no-user-gesture-required'] });
  const p = await (await b.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } })).newPage();
  const problems = [];
  p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const api = (method, path, body) => p.evaluate(async ([m, pa, bo]) => { const r = await fetch('/api/' + pa, { method: m, headers: { 'content-type': 'application/json' }, body: bo ? JSON.stringify(bo) : undefined }); return r.json().catch(() => null); }, [method, path, body]);
  const check = async (label) => {
    await p.waitForTimeout(1200);
    const text = await p.evaluate(() => document.body.innerText);
    const bad = text.match(/Cannot read|undefined|NaN|\[object Object\]|TypeError|出错了/);
    if (bad) problems.push(`${label}: "${bad[0]}" on screen — ${text.slice(Math.max(0, bad.index - 60), bad.index + 80).replace(/\n/g, ' / ')}`);
    console.log(`ok? ${label}${bad ? '  <-- ' + bad[0] : ''}`);
  };
  await p.goto(base + '/');
  await api('POST', 'login', { passcode });
  await p.reload();
  // A class with live lines, ended and reviewed (by the sloppy AI).
  const s = await api('POST', 'sessions', { school: 'WSE', topic: 'my body', mode: 'class', deepReview: true });
  await p.evaluate((id) => (location.hash = '#/live/' + id), s.id);
  await p.waitForTimeout(wav ? 9000 : 2000);
  await check('live class');
  await p.getByText('下课', { exact: true }).click();
  for (let i = 0; i < 40; i++) {
    const d = await api('GET', 'sessions/' + s.id);
    if (d.session.status !== 'live' && d.session.status !== 'processing') break;
    await p.waitForTimeout(1500);
  }
  await p.evaluate((id) => (location.hash = '#/review/' + id), s.id);
  await p.waitForFunction(() => !document.body.innerText.includes('正在整理'), null, { timeout: 60000 }).catch(() => {});
  await check('class review');
  for (const tab of ['生词', '纠错', '要点', '对话', '完整记录', '问题']) {
    const btn = p.locator('.tabs button', { hasText: tab }).first();
    if (!(await btn.count())) {
      problems.push(`class review: tab ${tab} missing (page did not render)`);
      continue;
    }
    await btn.click();
    await check(`class review tab ${tab}`);
  }
  if (await p.getByText('一键复制 MD').count()) {
    await p.getByText('一键复制 MD').click();
    await check('copy MD');
  } else problems.push('class review: no 一键复制 MD button');
  for (const r of ['', 'review', 'plan', 'scores', 'ask', 'talk', 'settings', 'bin']) {
    await p.evaluate((r) => (location.hash = '#/' + r), r);
    await check(`#/${r}`);
  }
  await b.close();
  if (problems.length) {
    console.error('\nFAILED:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log('\nall screens OK');
})().catch((e) => { console.error(e); process.exit(1); });
