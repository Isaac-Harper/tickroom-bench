// The reconciliation check the smoothness harness cannot make.
//
// `run.mjs` measures a server-driven marker, which says nothing about the one
// entity a player actually steers: their own paddle, predicted locally and
// reconciled against every snapshot. A one-tick disagreement between where the
// client predicts an input change and where the server applies it is invisible
// during steady motion and shows up ONLY when the input changes, as a
// correction of exactly one tick of travel at every start and stop, which the
// player sees as a paddle that runs behind, creeps back and lurches once more
// after the key is released. So this script changes the input on purpose:
// hold a key, release, wait, several times, and count every reconcile whose
// error was not zero plus every direction flip in the DRAWN paddle after a
// release. A healthy deployment prints zero for both.
//
//   node bench/paddle.mjs --url https://tickroom-bench.vercel.app [--room pong~6] [--moves 8] [--hold 350]
//
// Exits 1 when any nonzero reconcile error or any post-release flip was seen.
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null)).filter(Boolean),
);
if (!args.url || args.help) {
  console.log('usage: node bench/paddle.mjs --url <base-url> [--room <id>] [--moves N] [--hold MS]');
  process.exit(args.help ? 0 : 2);
}
const room = args.room ?? 'pong~6';
const moves = Number(args.moves ?? 8);
const hold = Number(args.hold ?? 350);
const url = `${args.url.replace(/\/$/, '')}/?room=${encodeURIComponent(room)}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url);
await page.waitForFunction(() => window.__bench && window.__bench.status() === 'open', null, { timeout: 30000 });
// Let the lead settle before the first key, so the measurement is of the
// steady contract and not of the first seconds of a fresh connection.
await page.waitForTimeout(4000);
await page.evaluate(() => { window.__bench.frames(); window.__bench.events(); });
const releases = [];
for (let i = 0; i < moves; i++) {
  const key = i % 2 === 0 ? 'ArrowDown' : 'ArrowUp';
  await page.keyboard.down(key);
  await page.waitForTimeout(hold);
  await page.keyboard.up(key);
  releases.push(await page.evaluate(() => performance.now()));
  await page.waitForTimeout(900);
}
const fr = await page.evaluate(() => window.__bench.frames());
const ev = await page.evaluate(() => window.__bench.events());
const st = await page.evaluate(() => window.__bench.stats());
await browser.close();

const rec = ev.filter((e) => e.kind === 'reconcile');
const nonzero = rec.filter((e) => e.detail.error !== 0);
const lags = rec.map((e) => e.detail.tick - e.detail.snapTick);
console.log(`room ${room}, rtt ${st.rttMs.toFixed(1)}ms, ${moves} moves of ${hold}ms, ${fr.length} frames, ${rec.length} reconciles`);
console.log(`lead over the snapshot: ${Math.min(...lags)} to ${Math.max(...lags)} ticks, window shortfalls: ${rec.filter((e) => e.detail.missing > 0).length}`);
console.log(`reconciles with a nonzero error: ${nonzero.length}`);
if (nonzero.length) {
  console.log(
    '  (ms from nearest release: error) ' +
      nonzero.map((e) => { const r = releases.map((x) => e.t - x).sort((a, b) => Math.abs(a) - Math.abs(b))[0]; return `${Math.round(r)}:${e.detail.error}`; }).join('  '),
  );
}
let totalFlips = 0;
releases.forEach((R, i) => {
  const win = fr.filter((f) => f.t >= R + 100 && f.t <= R + 700 && f.ownY !== null);
  let last = 0, flips = 0, prev = null;
  for (const f of win) {
    if (prev !== null) { const s = Math.sign(+(f.ownY - prev).toFixed(2)); if (s !== 0) { if (last && s !== last) flips++; last = s; } }
    prev = f.ownY;
  }
  totalFlips += flips;
  const errs = win.map((f) => Math.abs(f.errZ ?? 0));
  console.log(`release ${i}: drawn-paddle direction flips ${flips}, max |offset| ${Math.max(0, ...errs).toFixed(2)}`);
});
console.log(nonzero.length === 0 && totalFlips === 0 ? 'PASS: no correction at any input change' : 'FAIL: the input timeline disagrees between client and server');
process.exit(nonzero.length === 0 && totalFlips === 0 ? 0 : 1);
