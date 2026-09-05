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
// TWO THINGS DEFEAT THIS ENTIRELY, AND BOTH DO IT SILENTLY.
//
// 1. PLAYWRIGHT'S DEFAULT LAUNCH FLAGS. It launches Chromium with
//    `--disable-background-timer-throttling`,
//    `--disable-backgrounding-occluded-windows` and
//    `--disable-renderer-backgrounding` so that ordinary tests are not flaky.
//    Those three are exactly the behaviour being measured, so they are removed
//    below.
//
// 2. `Emulation.setFocusEmulationEnabled`, WHICH IS THE ONE THAT ACTUALLY BIT.
//    Playwright sends it, enabled, to every main frame it attaches to
//    (`coreBundle.js`, in `CRPage`'s frame setup), and it does what it says:
//    the renderer is told to simulate a focused and active page forever. So
//    `document.hidden` never turns true however the tab is occluded, rAF never
//    stops, and the harness happily reports 1800 frames per 30 second sample of
//    a "hidden" tab. THAT IS WHAT THE 2026-09-03 RUN MEASURED: six and a half
//    minutes of a tab rendering at 60fps with `hidden=false` on every sample,
//    which is a true statement about a page nobody has ever loaded.
//
//    There is exactly one documented way off it: `connectOverCDP` accepts
//    `noDefaults`, and a page in the browser's OWN default context is then left
//    alone. Which means the browser cannot be one Playwright launched, because
//    a launched browser's pages are Playwright's from birth. Hence `--chrome`:
//    start a real browser process with a throwaway profile, attach to it over
//    CDP, and drive tabs in the context it already had. Measured, on this Mac:
//    A hidden true, visibilityState hidden, and ZERO rAF callbacks in five
//    seconds, against 187 in the same five seconds without `noDefaults`.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

// The real-browser half lives in `bench/chrome.mjs`, because `bench/discard.mjs`
// needs the identical process, profile and attach. Only the Playwright-launched
// fallback below is still this file's own.
import { CDP_PORT, connectToBrowser, hideBehind, launchBrowser, quitBrowser, resolveBrowserApp } from './chrome.mjs';
import { seated, waitForPid } from './page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** How often the hidden tab is sampled. Slow on purpose: every sample is a `page.evaluate`, which wakes the renderer, and waking it thirty times a minute would be measuring a tab this harness kept alive. */
const SAMPLE_MS = 30_000;

/** How long to watch after the tab comes back. */
const RECOVERY_MS = 20_000;

/** How often the recovery window is sampled. Fast, because the whole question there is how many seconds it took. */
const RECOVERY_SAMPLE_MS = 1000;

const READY_TIMEOUT_MS = 60_000;

/** Let the client settle and prove it works BEFORE hiding it. A run that backgrounded a tab which had never connected would report a client that never came back and blame the wrong thing. */
const SETTLE_MS = 15_000;

/**
 * The three flags Playwright passes by default that would make this run
 * meaningless. Removed rather than overridden: `ignoreDefaultArgs` takes the
 * flags OUT of the command line, where passing the opposite flag would leave
 * both present and let Chromium pick. Only the Playwright-launched mode needs
 * this; a browser started by `--chrome` was never passed them at all.
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
  --chrome           Drive a REAL browser process over CDP instead of letting
                     Playwright launch one. THIS IS THE MODE THAT ACTUALLY HIDES
                     THE TAB: a Playwright-launched page is sent
                     Emulation.setFocusEmulationEnabled and reports itself
                     visible forever. Starts Google Chrome (or Playwright's own
                     Chromium build if Chrome is not installed) with a throwaway
                     profile under <out>/chrome-profile, attaches with
                     connectOverCDP({ noDefaults: true }), and quits that
                     process at the end. Never touches an already running
                     browser: the throwaway profile forces a separate process.
  --port <n>         Debugging port for --chrome. Default ${CDP_PORT}.
  --out <dir>        Where the JSON result goes. Default bench/out.
  --help             This.

Runs HEADED, always. An occluded tab is the thing being measured and a headless
browser has no window to occlude it with. Without --chrome the run still works,
still removes Chromium's background throttling flags from Playwright's
defaults, and still cannot make document.hidden true; it says so, loudly.
`.trim();

function parseArgs(argv) {
  const out = { minutes: 6.5, room: 'pong', chrome: false, port: CDP_PORT, out: join(HERE, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--minutes') out.minutes = Number(argv[++i]);
    else if (a === '--room') out.room = argv[++i];
    else if (a === '--chrome') out.chrome = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--out') out.out = resolve(argv[++i]);
    // Accepted and ignored, so the same flag set works on both harnesses.
    else if (a === '--headed') continue;
    else return { error: `unknown argument: ${a}` };
  }
  if (!out.url) return { error: 'missing --url' };
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) return { error: '--minutes must be a positive number' };
  if (!Number.isInteger(out.port) || out.port < 1024) return { error: '--port must be a port number above 1023' };
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One sample of the hidden tab.
 *
 * `entities` comes back rather than an answer about them, because deciding
 * whether this client is in its own roster is `seated`'s job and `seated` is
 * shared with `bench/run.mjs`. See `bench/page.mjs` for what that check used to
 * get wrong. A hidden tab renders nothing, so the roster read here is the
 * NEWEST FRAME THE RING STILL HOLDS rather than a live one, which is why the
 * ring is drained and the last record kept.
 */
async function sample(page) {
  return page.evaluate(() => {
    const b = window.__bench;
    if (!b) return null;
    const frames = b.frames();
    const events = b.events();
    const last = frames.length ? frames[frames.length - 1] : null;
    const stats = b.stats();
    return {
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      status: b.status(),
      stats,
      // Outgoing round-trip probes, lifetime. `game/pong.ts` counts them off the
      // socket itself because `ConnectionStats` has no such field: the ping is
      // on a 2000ms `setInterval` inside the connection, and a `setInterval` is
      // precisely what a browser throttles once a tab is backgrounded. A socket
      // that stayed open with a ping count that stopped climbing is the shape of
      // the failure this run exists to catch. `null` on a deployment older than
      // that counter rather than a fabricated zero.
      pingsSent: typeof stats.pingsSent === 'number' ? stats.pingsSent : null,
      framesSincePrevious: frames.length,
      lastFrameTick: last ? last.tick : null,
      lastServerTime: last ? last.serverTime : null,
      lastInst: last ? last.inst : null,
      entities: last ? last.entities : null,
      entityCount: last ? last.entities.length : null,
      events,
    };
  });
}

/** A sample plus the parts of it only this side can answer. */
async function sampleWith(page, pid) {
  const s = await sample(page);
  if (!s) return { error: 'no window.__bench' };
  return { ...s, inRoster: seated(s.entities, pid) };
}

const NOT_HIDDEN_MESSAGE = [
  'document.hidden is still false after bringing the second tab to the front.',
  'Nothing about a backgrounded tab can be measured from here: the render loop is',
  'running, rAF is not throttled, and every number this run would print would be a',
  'number about a foreground tab. The usual cause is Playwright telling the page to',
  'simulate a focused and active document (Emulation.setFocusEmulationEnabled),',
  'which only connectOverCDP with noDefaults, on the browser\'s own default context,',
  'avoids. That is what --chrome does.',
].join('\n');

// ---- the run --------------------------------------------------------------

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
  console.error(
    `[hidden] ${args.minutes} min hidden, room ${args.room}, ${args.url}` +
      (args.chrome ? ` (real browser over CDP on ${args.port})` : ' (playwright chromium)')
  );

  const profileDir = join(args.out, 'chrome-profile');
  let browser;
  let context;
  let browserLabel;
  let quit;

  if (args.chrome) {
    const found = await resolveBrowserApp();
    if (!found) {
      console.error('[hidden] no Google Chrome and no Playwright browser bundle to fall back to');
      return 2;
    }
    if (!found.real) {
      console.error(`[hidden] Google Chrome is not installed; using Playwright's own build at ${found.app}`);
    }
    const version = await launchBrowser(found.app, profileDir, args.port);
    browserLabel = `${version.Browser} (${found.app})`;
    console.error(`[hidden] ${browserLabel}`);
    // `noDefaults` IS THE FLAG THE WHOLE MODE EXISTS FOR. See note 2 at the top:
    // without it every page Playwright attaches to is told to simulate a focused
    // and active document, and `document.hidden` can never turn true. It applies
    // only to the browser's OWN default context, which is why the pages below
    // come out of the browser's own context rather than a fresh one.
    ({ browser, context } = await connectToBrowser(args.port));
    if (!context) {
      console.error('[hidden] the browser reported no default context to attach to');
      await quitBrowser(browser, profileDir);
      return 1;
    }
    quit = () => quitBrowser(browser, profileDir);
  } else {
    browser = await chromium.launch({ headless: false, ignoreDefaultArgs: BACKGROUNDING_FLAGS });
    browserLabel = `playwright chromium ${browser.version()}`;
    context = await browser.newContext();
    quit = () => browser.close();
  }

  // QUIT EXACTLY ONCE, HOWEVER THE RUN ENDS. Everything below can throw (a
  // mint that never lands, a page that navigated away, an abort), and a
  // `--chrome` run that threw used to leave a real browser process holding the
  // throwaway profile with nobody to close it. The `finally` around the body is
  // the other half of this.
  let quitResult;
  const pageErrors = [];
  const closeBrowser = async () => {
    if (quitResult === undefined) quitResult = await quit();
    return quitResult;
  };

  // A browser started with `about:blank` already has the page; a fresh
  // Playwright context has none.
  try {
    const pageA = context.pages()[0] ?? (await context.newPage());
    pageA.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

    const target = new URL(args.url);
    target.searchParams.set('bot', '1');
    target.searchParams.set('room', args.room);
    target.searchParams.set('name', 'hidden');
    await pageA.goto(target.toString(), { waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => Boolean(window.__bench), null, { timeout: READY_TIMEOUT_MS });
    // WAITS FOR THE MINT, not just for the hook. See `bench/page.mjs`: reading the
    // id at hook time is what made every sample of the previous run report this
    // client as absent from its own roster.
    const pid = await waitForPid(pageA);

    await sleep(SETTLE_MS);
    const before = await sampleWith(pageA, pid);
    console.error(
      `[hidden] baseline: status ${before.status}, in roster ${before.inRoster}, ${before.entityCount} entities, pid ${pid}`
    );

    // THE SECOND TAB IS THE OCCLUDER. `newPage` on the same context opens a tab in
    // the same window and activating it is what puts the first one behind.
    // Nothing else about it matters, so it is `about:blank`.
    const pageB = await context.newPage();
    await pageB.goto('about:blank');
    const hiding = await hideBehind(browser, context, pageA, pageB);
    console.error(
      hiding.hidden
        ? `[hidden] tab A is hidden (via ${hiding.via})`
        : `[hidden] tab A did NOT go hidden${hiding.error ? `: ${hiding.error}` : ''}`
    );
    if (!hiding.hidden) {
      console.error(`\n[hidden] ABORTING.\n${NOT_HIDDEN_MESSAGE}\n`);
      if (args.chrome) {
        // Aborting is the point of the check: six and a half minutes of a
        // foreground tab is not a cheaper answer than no answer.
        return 3;
      }
      console.error('[hidden] continuing anyway because this is the default mode; re-run with --chrome.\n');
    }

    const hiddenMs = args.minutes * 60_000;
    const hiddenStart = Date.now();
    const samples = [];
    let prevPings = before.pingsSent;
    while (Date.now() - hiddenStart < hiddenMs) {
      await sleep(SAMPLE_MS);
      let s;
      try {
        s = await sampleWith(pageA, pid);
      } catch (err) {
        s = { error: String(err && err.message ? err.message : err) };
      }
      const atS = Math.round((Date.now() - hiddenStart) / 1000);
      samples.push({ atS, phase: 'hidden', ...s });
      const pings =
        typeof s.pingsSent === 'number' ? `${s.pingsSent}${typeof prevPings === 'number' ? ` (+${s.pingsSent - prevPings})` : ''}` : 'n/a';
      if (typeof s.pingsSent === 'number') prevPings = s.pingsSent;
      console.error(
        `[hidden] ${atS}s hidden=${s.hidden} vis=${s.visibilityState} status=${s.status} frames=${s.framesSincePrevious} ` +
          `pings=${pings} inRoster=${s.inRoster} serverTime=${s.lastServerTime} reconnects=${s.stats ? s.stats.reconnects : '?'} ` +
          `swaps=${s.stats ? s.stats.relaySwaps : '?'}`
      );
    }

    // ---- back to the front -------------------------------------------------

    console.error('[hidden] bringing the tab back');
    const shownAt = Date.now();
    await pageA.bringToFront();

    while (Date.now() - shownAt < RECOVERY_MS) {
      await sleep(RECOVERY_SAMPLE_MS);
      let s;
      try {
        s = await sampleWith(pageA, pid);
      } catch (err) {
        s = { error: String(err && err.message ? err.message : err) };
      }
      samples.push({ atS: (Date.now() - shownAt) / 1000, phase: 'recovery', ...s });
    }

    const after = await sampleWith(pageA, pid);
    const quitClean = await closeBrowser();

    // ---- what it cost ------------------------------------------------------

    const hiddenSamples = samples.filter((s) => s.phase === 'hidden');
    const recovery = samples.filter((s) => s.phase === 'recovery');
    // The first recovery sample that drew a frame at all: rAF restarting is what
    // ends the freeze, and every other recovery number is measured from there.
    const firstDrawn = recovery.find((s) => s.framesSincePrevious > 0);
    const firstSeated = recovery.find((s) => s.inRoster === true);
    // THE NEWEST SAMPLE THAT ACTUALLY HAD A FRAME TO READ A ROSTER OUT OF, which
    // is emphatically not `after`. Every read drains the ring, a properly hidden
    // tab refills it with nothing, and `after` is taken a moment after the last
    // recovery sample emptied it, so asking `after` alone answers "could not
    // tell" on precisely the run where everything worked.
    const rosterReads = [before, ...samples].filter((s) => s.inRoster === true || s.inRoster === false);
    const lastRoster = rosterReads.length ? rosterReads[rosterReads.length - 1] : null;
    const allEvents = samples.flatMap((s) => s.events ?? []);
    const reanchors = allEvents.filter((e) => e.kind === 'reanchor').map((e) => e.detail.delta);
    const terminals = allEvents.filter((e) => e.kind === 'terminal').map((e) => e.detail.reason);
    const closes = allEvents
      .filter((e) => e.kind === 'close')
      .map((e) => `${e.detail.code}${e.detail.reason ? ` ${e.detail.reason}` : ''}`);
    const handoffs = allEvents.filter((e) => e.kind === 'handoff').length;
    // The headline: did the tab ever actually go dark. A sample that says
    // otherwise is the run reporting that it measured nothing.
    const everHidden = hiding.hidden || hiddenSamples.some((s) => s.hidden === true);
    const pingsWhileHidden =
      typeof before.pingsSent === 'number' && typeof after.pingsSent === 'number'
        ? after.pingsSent - before.pingsSent
        : null;

    const result = {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      args: { url: args.url, minutes: args.minutes, room: args.room, chrome: args.chrome },
      browser: browserLabel,
      pid,
      before,
      after,
      samples,
      summary: {
        hiddenSamples: hiddenSamples.length,
        /** Whether the tab was measurably hidden at all. False means every other number below is about a foreground tab. */
        everHidden,
        hiddenVia: hiding.via,
        /** Frames rendered across every hidden sample. A properly backgrounded tab renders none. */
        framesWhileHidden: hiddenSamples.reduce((n, s) => n + (s.framesSincePrevious ?? 0), 0),
        /** Round-trip probes the connection got out while hidden, or null on a deployment that does not count them. */
        pingsWhileHidden,
        /** The last roster read that had a rendered frame behind it, and whether this client was in it. */
        seatedAtEnd: lastRoster ? lastRoster.inRoster : null,
        /** True the whole time it was hidden: the socket never went away. */
        stayedOpenWhileHidden: hiddenSamples.every((s) => s.status === 'open'),
        /** Reconnects charged over the whole run, hidden and recovery together. */
        reconnects: after && after.stats ? after.stats.reconnects : null,
        relaySwaps: after && after.stats ? after.stats.relaySwaps : null,
        swapsAttempted: after && after.stats ? after.stats.swapsAttempted : null,
        swapsFailed: after && after.stats ? after.stats.swapsFailed : null,
        tickerHandoffsSeen: handoffs,
        reanchors: { count: reanchors.length, maxAbs: reanchors.reduce((m, d) => Math.max(m, Math.abs(d)), 0) },
        closes,
        terminals,
        firstDrawnFrameAfterShowS: firstDrawn ? firstDrawn.atS : null,
        firstSeatedAfterShowS: firstSeated ? firstSeated.atS : null,
        browserQuitCleanly: quitClean !== false,
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
      `${args.minutes} minutes hidden against \`${args.url}\`, room \`${args.room}\`, on ${browserLabel}. Raw JSON: \`${file}\`.`,
      '',
      '| | |',
      '| --- | --- |',
      `| the tab was actually hidden | ${s.everHidden}${s.hiddenVia ? ` (via ${s.hiddenVia})` : ''} |`,
      `| frames rendered while hidden | ${s.framesWhileHidden} |`,
      `| round-trip probes sent while hidden | ${s.pingsWhileHidden ?? 'not counted by this deployment'} |`,
      `| socket stayed open the whole time hidden | ${s.stayedOpenWhileHidden} |`,
      `| status when it came back | ${after ? after.status : '?'} |`,
      `| still in the roster when it came back | ${s.seatedAtEnd ?? 'no frame drew one'} |`,
      `| reconnects charged | ${s.reconnects} |`,
      `| relay warm swaps (ok / attempted / failed) | ${s.relaySwaps} / ${s.swapsAttempted} / ${s.swapsFailed} |`,
      `| ticker handoffs seen | ${s.tickerHandoffsSeen} |`,
      `| tick re-anchors (max abs delta) | ${s.reanchors.count} (${s.reanchors.maxAbs}) |`,
      `| socket closes | ${s.closes.length ? s.closes.join(', ') : 'none'} |`,
      `| terminals | ${s.terminals.length ? s.terminals.join(', ') : 'none'} |`,
      `| seconds to first rendered frame after showing | ${s.firstDrawnFrameAfterShowS ?? 'never'} |`,
      `| seconds to being drawn in the roster again | ${s.firstSeatedAfterShowS ?? 'never'} |`,
      '',
    ];
    if (!s.everHidden) {
      lines.push(
        '**THIS RUN MEASURED NOTHING.** ' + NOT_HIDDEN_MESSAGE.replace(/\n/g, ' '),
        ''
      );
    }
    lines.push(
      'A hidden tab renders nothing, so "in the roster" during the hidden phase reads',
      'from the last frame the page drew before it was backgrounded and is expected to',
      'be stale. The socket status, the reconnect count and the swap counters are live',
      'throughout, because none of them is driven by the render loop.'
    );
    console.log(lines.join('\n'));
    return s.everHidden ? 0 : 1;
  } finally {
    // Printed here rather than only in the summary, because the run that needs
    // them most is the one that threw before there was a summary.
    if (pageErrors.length) console.error(`[hidden] page errors: ${pageErrors.length}. First: ${pageErrors[0]}`);
    await closeBrowser();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
