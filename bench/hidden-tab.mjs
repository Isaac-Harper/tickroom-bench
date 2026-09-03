#!/usr/bin/env node
// One client, backgrounded, for as long as it takes.
//
// THIS IS THE ONE MEASUREMENT THE LIBRARY'S LOOPBACK HARNESS CANNOT MAKE AT
// ALL, and it is the failure most likely to reach a real player. A hidden tab
// is not a slow client; it is a client whose render loop STOPS. Chromium
// suspends `requestAnimationFrame` outright for an occluded tab and throttles
// its timers hard, which means:
//
//   - `conn.frame()` stops being called, so the tick counter stops advancing
//     and stops being anchored. The library treats a frame gap past
//     `frozenFrameGapMs` as an epoch boundary for the counter precisely because
//     of this, and re-anchors on the next snapshot with an `onTickReanchor`
//     delta that can be thousands of ticks.
//   - Nothing is stamped and nothing is sent, so from the server's side this
//     socket goes quiet on the input channel while staying open.
//   - The socket itself stays up and snapshots keep arriving, because the
//     WebSocket is not driven by rAF. The relay's own liveness deadline is 90s
//     and defaults that high for exactly this reason: a BROWSER, not the
//     client, chooses the ping interval once a tab is hidden.
//
// So the question this run answers is narrow and important: does a tab that
// spent several minutes in the background still hold its seat, and what does it
// cost to come back? Default 6.5 minutes because that crosses both a ticker
// handoff (270s) and a relay warm swap (290s) while hidden, which is the
// combination nothing else exercises.
//
// PLAYWRIGHT'S DEFAULT LAUNCH FLAGS WOULD DEFEAT THIS ENTIRELY, and silently.
// It launches Chromium with `--disable-background-timer-throttling`,
// `--disable-backgrounding-occluded-windows` and `--disable-renderer-
// backgrounding` so that ordinary tests are not flaky. Those three are exactly
// the behaviour being measured, so they are removed below. A run that left them
// in would report a hidden tab behaving perfectly, which is a true statement
// about a browser nobody uses.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));

/** How often the hidden tab is sampled. Slow on purpose: every sample is a `page.evaluate`, which wakes the renderer, and waking it thirty times a minute would be measuring a tab this harness kept alive. */
const SAMPLE_MS = 30_000;

/** How long to watch after the tab comes back. Long enough for a cold reconnect ladder plus a fresh subscribe and first snapshot, with room to spare. */
const RECOVERY_MS = 30_000;

/** How often the recovery window is sampled. Fast, because the whole question there is how many seconds it took. */
const RECOVERY_SAMPLE_MS = 1000;

const READY_TIMEOUT_MS = 60_000;

/**
 * The three flags Playwright passes by default that would make this run
 * meaningless. Removed rather than overridden: `ignoreDefaultArgs` takes the
 * flags OUT of the command line, where passing the opposite flag would leave
 * both present and let Chromium pick.
 */
const BACKGROUNDING_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

const USAGE = `
tickroom-bench hidden-tab: background one client for M minutes, then bring it back.

  node bench/hidden-tab.mjs --url <base-url> [options]

Options:
  --url <url>        Base URL of the deployment. Required.
  --minutes <m>      How long the tab stays hidden. Default 6.5, which crosses both
                     a ticker handoff (270s) and a relay warm swap (290s).
  --room <id>        Room instance to join. Default "pong".
  --out <dir>        Where the JSON result goes. Default bench/out.
  --help             This.

Runs HEADED, always. An occluded tab is the thing being measured and a headless
browser has no window to occlude it with. Chromium's background throttling flags
are removed from Playwright's defaults for the same reason.
`.trim();

function parseArgs(argv) {
  const out = { minutes: 6.5, room: 'pong', out: join(HERE, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--minutes') out.minutes = Number(argv[++i]);
    else if (a === '--room') out.room = argv[++i];
    else if (a === '--out') out.out = resolve(argv[++i]);
    // Accepted and ignored, so the same flag set works on both harnesses.
    else if (a === '--headed') continue;
    else return { error: `unknown argument: ${a}` };
  }
  if (!out.url) return { error: 'missing --url' };
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) return { error: '--minutes must be a positive number' };
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One sample of the hidden tab.
 *
 * `stillSeated` is the question the whole run is about: the client is in the
 * room's roster AND the room is still simulating it, and the only evidence a
 * browser has of both at once is its own entity appearing in a rendered frame.
 * A hidden tab renders nothing, so the check reads the newest frame the ring
 * still holds rather than a live one, which is why the ring is drained here and
 * the last record kept.
 */
async function sample(page, pid) {
  return page.evaluate((selfPid) => {
    const b = window.__bench;
    if (!b) return null;
    const frames = b.frames();
    const events = b.events();
    const last = frames.length ? frames[frames.length - 1] : null;
    return {
      hidden: document.hidden,
      status: b.status(),
      stats: b.stats(),
      framesSincePrevious: frames.length,
      lastFrameTick: last ? last.tick : null,
      lastServerTime: last ? last.serverTime : null,
      lastInst: last ? last.inst : null,
      // The roster as this client last rendered it: is our own entity in it?
      inRoster: last ? last.entities.some(([id]) => id === selfPid) : null,
      entityCount: last ? last.entities.length : null,
      events,
    };
  }, pid);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }

  const startedAt = new Date();
  console.error(`[hidden] ${args.minutes} min hidden, room ${args.room}, ${args.url}`);

  const browser = await chromium.launch({ headless: false, ignoreDefaultArgs: BACKGROUNDING_FLAGS });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

  const target = new URL(args.url);
  target.searchParams.set('bot', '1');
  target.searchParams.set('room', args.room);
  target.searchParams.set('name', 'hidden');
  await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__bench), null, { timeout: READY_TIMEOUT_MS });
  const pid = await page.evaluate(() => window.__bench.pid());

  // Let it settle and prove it works BEFORE hiding it. A run that backgrounded
  // a tab which had never connected would report a client that never came back
  // and blame the wrong thing.
  await sleep(15_000);
  const before = await sample(page, pid);
  console.error(`[hidden] baseline: status ${before.status}, in roster ${before.inRoster}, ${before.entityCount} entities`);

  // THE SECOND TAB IS THE OCCLUDER. Playwright's `newPage` on the same context
  // opens a tab in the same window and focuses it, which is what puts the first
  // one behind and makes `document.hidden` true there. Nothing else about it
  // matters, so it is `about:blank`.
  const blocker = await context.newPage();
  await blocker.goto('about:blank');
  await blocker.bringToFront();

  const hiddenMs = args.minutes * 60_000;
  const hiddenStart = Date.now();
  const samples = [];
  while (Date.now() - hiddenStart < hiddenMs) {
    await sleep(SAMPLE_MS);
    let s;
    try {
      s = await sample(page, pid);
    } catch (err) {
      s = { error: String(err && err.message ? err.message : err) };
    }
    const atS = Math.round((Date.now() - hiddenStart) / 1000);
    samples.push({ atS, phase: 'hidden', ...s });
    console.error(
      `[hidden] ${atS}s hidden=${s.hidden} status=${s.status} frames=${s.framesSincePrevious} ` +
        `inRoster=${s.inRoster} serverTime=${s.lastServerTime} reconnects=${s.stats ? s.stats.reconnects : '?'}`
    );
  }

  // ---- back to the front -------------------------------------------------

  console.error('[hidden] bringing the tab back');
  const shownAt = Date.now();
  await page.bringToFront();

  while (Date.now() - shownAt < RECOVERY_MS) {
    await sleep(RECOVERY_SAMPLE_MS);
    let s;
    try {
      s = await sample(page, pid);
    } catch (err) {
      s = { error: String(err && err.message ? err.message : err) };
    }
    samples.push({ atS: (Date.now() - shownAt) / 1000, phase: 'recovery', ...s });
  }

  const after = await sample(page, pid);
  await browser.close();

  // ---- what it cost ------------------------------------------------------

  const recovery = samples.filter((s) => s.phase === 'recovery');
  // The first recovery sample that drew a frame at all: rAF restarting is what
  // ends the freeze, and every other recovery number is measured from there.
  const firstDrawn = recovery.find((s) => s.framesSincePrevious > 0);
  const firstSeated = recovery.find((s) => s.inRoster === true);
  const allEvents = samples.flatMap((s) => s.events ?? []);
  const reanchors = allEvents.filter((e) => e.kind === 'reanchor').map((e) => e.detail.delta);
  const terminals = allEvents.filter((e) => e.kind === 'terminal').map((e) => e.detail.reason);
  const handoffs = allEvents.filter((e) => e.kind === 'handoff').length;

  const result = {
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    args: { url: args.url, minutes: args.minutes, room: args.room },
    pid,
    before,
    after,
    samples,
    summary: {
      hiddenSamples: samples.filter((s) => s.phase === 'hidden').length,
      /** True the whole time it was hidden: the socket never went away. */
      stayedOpenWhileHidden: samples
        .filter((s) => s.phase === 'hidden')
        .every((s) => s.status === 'open'),
      /** Reconnects charged over the whole run, hidden and recovery together. */
      reconnects: after && after.stats ? after.stats.reconnects : null,
      relaySwaps: after && after.stats ? after.stats.relaySwaps : null,
      swapsAttempted: after && after.stats ? after.stats.swapsAttempted : null,
      swapsFailed: after && after.stats ? after.stats.swapsFailed : null,
      tickerHandoffsSeen: handoffs,
      reanchors: { count: reanchors.length, maxAbs: reanchors.reduce((m, d) => Math.max(m, Math.abs(d)), 0) },
      terminals,
      firstDrawnFrameAfterShowS: firstDrawn ? firstDrawn.atS : null,
      firstSeatedAfterShowS: firstSeated ? firstSeated.atS : null,
      pageErrors,
    },
  };

  await mkdir(args.out, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const file = join(args.out, `hidden-${stamp}.json`);
  await writeFile(file, JSON.stringify(result, null, 2));

  const s = result.summary;
  const lines = [
    `# tickroom bench, hidden tab, ${result.startedAt}`,
    '',
    `${args.minutes} minutes hidden against \`${args.url}\`, room \`${args.room}\`. Raw JSON: \`${file}\`.`,
    '',
    '| | |',
    '| --- | --- |',
    `| socket stayed open the whole time hidden | ${s.stayedOpenWhileHidden} |`,
    `| status when it came back | ${after ? after.status : '?'} |`,
    `| still in the roster when it came back | ${after ? after.inRoster : '?'} |`,
    `| reconnects charged | ${s.reconnects} |`,
    `| relay warm swaps (ok / attempted / failed) | ${s.relaySwaps} / ${s.swapsAttempted} / ${s.swapsFailed} |`,
    `| ticker handoffs seen | ${s.tickerHandoffsSeen} |`,
    `| tick re-anchors (max abs delta) | ${s.reanchors.count} (${s.reanchors.maxAbs}) |`,
    `| terminals | ${s.terminals.length ? s.terminals.join(', ') : 'none'} |`,
    `| seconds to first rendered frame after showing | ${s.firstDrawnFrameAfterShowS ?? 'never'} |`,
    `| seconds to being drawn in the roster again | ${s.firstSeatedAfterShowS ?? 'never'} |`,
    '',
    'A hidden tab renders nothing, so "in the roster" during the hidden phase reads',
    'from the last frame the page drew before it was backgrounded and is expected to',
    'be stale. The socket status, the reconnect count and the swap counters are live',
    'throughout, because none of them is driven by the render loop.',
  ];
  console.log(lines.join('\n'));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
