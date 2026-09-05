#!/usr/bin/env node
// The hidden-tab measurement, on REAL SAFARI.
//
// `bench/hidden-tab.mjs` answers "does a backgrounded client hold its seat, and
// what does it cost to come back" on Chrome. Every number it produces is about
// Chromium's throttling policy: when rAF stops, how hard timers are clamped,
// how often a hidden tab is still allowed to send. Safari's policy is a
// different piece of software written by different people, and the library's
// liveness defaults are sized against whichever browser is stingiest. This run
// is the other half of that claim.
//
// PLAYWRIGHT'S WEBKIT IS NOT SAFARI, which is why this file talks WebDriver
// instead. Playwright ships a WebKit build with its own embedder, its own
// process model and its own idea of what a backgrounded page is; measuring it
// would produce numbers about a browser nobody uses. macOS ships
// `safaridriver`, which drives the actual Safari.app the user runs, so that is
// what is driven here, over the raw WebDriver HTTP protocol with `fetch`. No
// new dependency: the protocol is JSON over HTTP and the whole client is the
// forty lines below.
//
// THE ONE TRICK THE WHOLE MEASUREMENT RESTS ON. WebDriver has a CURRENT WINDOW
// HANDLE, which is where `execute/sync` runs, and it is not the same thing as
// the tab the browser is showing. `POST /window/new` opens a tab in FRONT in
// Safari and, per the specification, does NOT change the current handle. So the
// harness keeps its handle on tab A, the client, while the browser shows the new
// empty tab: A is genuinely backgrounded and still answers scripts. Switching to
// A with `POST /window` would raise it and end the very state being measured, so
// nothing here ever does that until the recovery phase.
//
// The no-switch path is verified on the first sample rather than assumed: if
// `document.hidden` does not read true from A's context, the run falls back to
// switching to A for each sample and switching back, and SAYS SO, because that
// makes the tab visible for a moment every 30 seconds and those blips are part
// of what the numbers then mean. A run that never reads hidden at all measured
// nothing and exits 3.
//
// SAFARI MUST HAVE REMOTE AUTOMATION ENABLED (Safari Settings, Developer,
// "Allow remote automation"), and it is a setting the RUNNING Safari reads:
// turning it on after Safari started is not enough on macOS 26, Safari has to be
// restarted. `safaridriver` answers session creation with exactly that message
// when it is off, and this harness passes it through rather than translating it.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_READY_JS, PID_JS, PID_TIMEOUT_MS, seated } from './page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** How often the hidden tab is sampled. The same 30s `hidden-tab.mjs` uses, and for the same reason: every sample wakes the page a little, and waking it thirty times a minute would be measuring a tab this harness kept alive. */
const SAMPLE_MS = 30_000;

/** How long to watch after the tab comes back. */
const RECOVERY_MS = 20_000;

/** How often the recovery window is sampled. Fast, because the whole question there is how many seconds it took. */
const RECOVERY_SAMPLE_MS = 1000;

/** Let the client settle and prove it works BEFORE hiding it. */
const SETTLE_MS = 15_000;

/** How long a visibility change is given to reach the renderer before it is read back. */
const VISIBILITY_SETTLE_MS = 1500;

/** How long `safaridriver` gets to answer `/status`. */
const DRIVER_READY_TIMEOUT_MS = 20_000;

/** The port this harness starts its own `safaridriver` on. An already listening driver on the same port is used as it is and left running. */
const DRIVER_PORT = 4448;

const USAGE = `
tickroom-bench hidden-safari: background one client in REAL Safari for M
minutes, then bring it back.

  node bench/hidden-safari.mjs --url <base-url> [options]

Options:
  --url <url>        Base URL of the deployment. Required.
  --minutes <m>      How long the tab stays hidden. Default 6.5, which crosses both
                     a ticker handoff (270s) and a relay warm swap (290s).
  --room <id>        Room instance to join. Default "pong~9", not the main room,
                     because this is usually run beside the Chrome hidden-tab run.
  --port <n>         Port for safaridriver. Default ${DRIVER_PORT}. A driver already
                     listening there is reused and left running.
  --out <dir>        Where the JSON result goes. Default bench/out.
  --help             This.

Needs "Allow remote automation" on in Safari Settings, Developer. Safari reads
that setting at launch, so if it was just turned on, quit and reopen Safari.
Exits 3 when the tab never reads hidden, because then the run measured nothing.
`.trim();

function parseArgs(argv) {
  const out = { minutes: 6.5, room: 'pong~9', port: DRIVER_PORT, out: join(HERE, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--minutes') out.minutes = Number(argv[++i]);
    else if (a === '--room') out.room = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--out') out.out = resolve(argv[++i]);
    else return { error: `unknown argument: ${a}` };
  }
  if (!out.url) return { error: 'missing --url' };
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) return { error: '--minutes must be a positive number' };
  if (!Number.isInteger(out.port) || out.port < 1024) return { error: '--port must be a port number above 1023' };
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the WebDriver client --------------------------------------------------

/**
 * WebDriver is JSON over HTTP, so this is the whole client.
 *
 * Every response carries a `value`; an error carries `value.error` and
 * `value.message` with a non-2xx status, and those messages are the useful part
 * (the remote automation one especially), so they are thrown verbatim rather
 * than summarised.
 */
class Driver {
  constructor(base) {
    this.base = base;
    this.sessionId = null;
  }

  async call(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const v = json.value ?? {};
      throw new Error(`${method} ${path}: ${v.error ?? res.status}: ${v.message ?? text.slice(0, 200)}`);
    }
    return json.value;
  }

  session(path, body, method = 'POST') {
    return this.call(method, `/session/${this.sessionId}${path}`, body);
  }

  /**
   * `execute/sync` runs a FUNCTION BODY, so everything handed to it returns.
   * The page's hook answers JSON-safe values by construction (see
   * `game/bench.ts`), which is what lets the same expressions the Playwright
   * harnesses evaluate be used here unchanged.
   */
  async evaluate(expr) {
    return this.session('/execute/sync', { script: `return (${expr});`, args: [] });
  }
}

/** Poll `expr` until it answers truthy. The WebDriver equivalent of `page.waitForFunction`. */
async function waitFor(driver, expr, timeoutMs, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try {
      v = await driver.evaluate(expr);
    } catch {
      // A page mid-navigation has no context to evaluate in yet.
    }
    if (v) return true;
    if (Date.now() > deadline) return false;
    await sleep(pollMs);
  }
}

/** Start `safaridriver`, or adopt one already listening on that port. */
async function startDriver(port) {
  const base = `http://127.0.0.1:${port}`;
  const ready = async () => {
    try {
      const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2000) });
      const json = await res.json();
      return json.value?.ready === true;
    } catch {
      return false;
    }
  };
  if (await ready()) return { base, child: null, adopted: true };

  const child = spawn('safaridriver', ['--port', String(port)], { stdio: 'ignore' });
  const deadline = Date.now() + DRIVER_READY_TIMEOUT_MS;
  for (;;) {
    if (await ready()) return { base, child, adopted: false };
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`safaridriver did not answer ${base}/status within ${DRIVER_READY_TIMEOUT_MS}ms`);
    }
    await sleep(250);
  }
}

// ---- what one sample is ----------------------------------------------------

/**
 * One read of the client, in one round trip, because every round trip to a
 * hidden tab is a nudge to a page whose stillness is the measurement.
 *
 * The shape matches `bench/hidden-tab.mjs`'s sample field for field so the two
 * runs can be read against each other: `frames` is the count since the previous
 * read (the ring drains on read), `pingsSent` is lifetime and differenced here,
 * and `entities` comes back raw so `seated` can answer the roster question the
 * same way for both harnesses.
 */
const SAMPLE_JS = `(() => {
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
    pingsSent: typeof stats.pingsSent === 'number' ? stats.pingsSent : null,
    framesSincePrevious: frames.length,
    lastFrameTick: last ? last.tick : null,
    lastServerTime: last ? last.serverTime : null,
    lastInst: last ? last.inst : null,
    entities: last ? last.entities : null,
    entityCount: last ? last.entities.length : null,
    events,
  };
})()`;

const NOT_HIDDEN_MESSAGE = [
  'document.hidden never read true in tab A.',
  'Nothing about a backgrounded tab can be measured from here: the render loop is',
  'running, rAF is not throttled, and every number this run would print would be a',
  'number about a foreground tab. In Safari the second tab is supposed to open in',
  'front while WebDriver keeps its handle on the first, so the usual causes are a',
  'Safari that opened the new tab behind the current one, or a window that was not',
  'frontmost to begin with.',
].join('\n');

// ---- the run ---------------------------------------------------------------

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
  console.error(`[safari] ${args.minutes} min hidden, room ${args.room}, ${args.url} (safaridriver on ${args.port})`);

  const { base, child, adopted } = await startDriver(args.port);
  console.error(`[safari] safaridriver ready on ${base}${adopted ? ' (already running, left alone at the end)' : ''}`);
  const driver = new Driver(base);

  // END THE SESSION AND THE DRIVER EXACTLY ONCE, HOWEVER THE RUN ENDS. A
  // session left open holds an automation window of the user's Safari open with
  // nobody driving it.
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (driver.sessionId) {
      try {
        await driver.call('DELETE', `/session/${driver.sessionId}`);
      } catch {
        // A session that already went away answers nothing, which is the goal.
      }
    }
    if (child) child.kill('SIGTERM');
  };

  try {
    const created = await driver.call('POST', '/session', {
      capabilities: { alwaysMatch: { browserName: 'safari' } },
    });
    driver.sessionId = created.sessionId;
    console.error(`[safari] session ${driver.sessionId}`);

    const target = new URL(args.url);
    target.searchParams.set('bot', '1');
    target.searchParams.set('room', args.room);
    target.searchParams.set('name', 'safari');
    await driver.session('/url', { url: target.toString() });

    const ready = await waitFor(driver, HOOK_READY_JS, PID_TIMEOUT_MS);
    if (!ready) {
      console.error('[safari] the client never minted a player id');
      return 1;
    }
    const pid = await driver.evaluate(PID_JS);
    const userAgent = await driver.evaluate('navigator.userAgent');
    console.error(`[safari] ${userAgent}`);

    await sleep(SETTLE_MS);
    const handleA = await driver.session('/window', undefined, 'GET');
    const before = await driver.evaluate(SAMPLE_JS);
    before.inRoster = seated(before.entities, pid);
    console.error(
      `[safari] baseline: status ${before.status}, in roster ${before.inRoster}, ${before.entityCount} entities, pid ${pid}`
    );

    // THE SECOND TAB IS THE OCCLUDER, and per the specification opening it does
    // not move the current handle, so scripts keep running in A while Safari
    // shows B.
    const newWindow = await driver.session('/window/new', { type: 'tab' });
    const handleB = newWindow.handle;
    await sleep(VISIBILITY_SETTLE_MS);
    const handleNow = await driver.session('/window', undefined, 'GET');
    let mode = handleNow === handleA ? 'background-read' : 'switch-and-return';
    let hiddenNow = false;
    if (mode === 'background-read') {
      try {
        hiddenNow = (await driver.evaluate('document.hidden')) === true;
      } catch (err) {
        // Safari refusing to run a script in a background tab is the one thing
        // that would force the fallback, so it is caught rather than fatal.
        console.error(`[safari] reading tab A in the background failed: ${err.message}`);
        mode = 'switch-and-return';
      }
    }
    if (!hiddenNow && mode === 'background-read') {
      console.error('[safari] tab A did not read hidden with B in front; falling back to switching per sample');
      mode = 'switch-and-return';
    }
    if (mode === 'switch-and-return') {
      // Make sure B really is the front tab before leaving it there.
      await driver.session('/window', { handle: handleB });
      await sleep(VISIBILITY_SETTLE_MS);
    }
    console.error(`[safari] tab A hidden: ${hiddenNow} (mode ${mode})`);

    /** One sample, in whichever mode this run ended up in. In the fallback, A is raised for the length of the read and put back, which is the visibility blip the summary warns about. */
    const sampleA = async () => {
      if (mode === 'switch-and-return') await driver.session('/window', { handle: handleA });
      try {
        const s = await driver.evaluate(SAMPLE_JS);
        if (!s) return { error: 'no window.__bench' };
        return { ...s, inRoster: seated(s.entities, pid) };
      } finally {
        if (mode === 'switch-and-return') await driver.session('/window', { handle: handleB });
      }
    };

    const hiddenMs = args.minutes * 60_000;
    const hiddenStart = Date.now();
    const samples = [];
    let prevPings = before.pingsSent;
    while (Date.now() - hiddenStart < hiddenMs) {
      await sleep(SAMPLE_MS);
      let s;
      try {
        s = await sampleA();
      } catch (err) {
        s = { error: String(err && err.message ? err.message : err) };
      }
      const atS = Math.round((Date.now() - hiddenStart) / 1000);
      samples.push({ atS, phase: 'hidden', ...s });
      const pings =
        typeof s.pingsSent === 'number'
          ? `${s.pingsSent}${typeof prevPings === 'number' ? ` (+${s.pingsSent - prevPings})` : ''}`
          : 'n/a';
      if (typeof s.pingsSent === 'number') prevPings = s.pingsSent;
      console.error(
        `[safari] ${atS}s hidden=${s.hidden} vis=${s.visibilityState} status=${s.status} frames=${s.framesSincePrevious} ` +
          `pings=${pings} inRoster=${s.inRoster} serverTime=${s.lastServerTime} reconnects=${s.stats ? s.stats.reconnects : '?'} ` +
          `swaps=${s.stats ? s.stats.relaySwaps : '?'}`
      );
    }

    // ---- back to the front -------------------------------------------------
    //
    // Closing the occluder rather than switching away from it: the tab in front
    // goes, and A is the tab Safari shows next, which is the same thing a person
    // does when they finish with the tab they were reading.
    console.error('[safari] closing the front tab');
    if (mode === 'background-read') await driver.session('/window', { handle: handleB });
    await driver.session('/window', undefined, 'DELETE');
    await driver.session('/window', { handle: handleA });
    const shownAt = Date.now();

    while (Date.now() - shownAt < RECOVERY_MS) {
      await sleep(RECOVERY_SAMPLE_MS);
      let s;
      try {
        const raw = await driver.evaluate(SAMPLE_JS);
        s = raw ? { ...raw, inRoster: seated(raw.entities, pid) } : { error: 'no window.__bench' };
      } catch (err) {
        s = { error: String(err && err.message ? err.message : err) };
      }
      samples.push({ atS: (Date.now() - shownAt) / 1000, phase: 'recovery', ...s });
    }

    const afterRaw = await driver.evaluate(SAMPLE_JS);
    const after = afterRaw ? { ...afterRaw, inRoster: seated(afterRaw.entities, pid) } : { error: 'no window.__bench' };
    await close();

    // ---- what it cost ------------------------------------------------------

    const hiddenSamples = samples.filter((s) => s.phase === 'hidden');
    const recovery = samples.filter((s) => s.phase === 'recovery');
    const firstDrawn = recovery.find((s) => s.framesSincePrevious > 0);
    const firstSeated = recovery.find((s) => s.inRoster === true);
    // THE NEWEST SAMPLE THAT ACTUALLY HAD A FRAME TO READ A ROSTER OUT OF, which
    // is emphatically not `after`: every read drains the ring, a properly hidden
    // tab refills it with nothing, and `after` is taken a moment after the last
    // recovery sample emptied it.
    const rosterReads = [before, ...samples].filter((s) => s.inRoster === true || s.inRoster === false);
    const lastRoster = rosterReads.length ? rosterReads[rosterReads.length - 1] : null;
    const allEvents = samples.flatMap((s) => s.events ?? []);
    const reanchors = allEvents.filter((e) => e.kind === 'reanchor').map((e) => e.detail.delta);
    const terminals = allEvents.filter((e) => e.kind === 'terminal').map((e) => e.detail.reason);
    const closes = allEvents
      .filter((e) => e.kind === 'close')
      .map((e) => `${e.detail.code}${e.detail.reason ? ` ${e.detail.reason}` : ''}`);
    const handoffs = allEvents.filter((e) => e.kind === 'handoff').length;
    const everHidden = hiddenNow || hiddenSamples.some((s) => s.hidden === true);
    const pingsWhileHidden =
      typeof before.pingsSent === 'number' && after && typeof after.pingsSent === 'number'
        ? after.pingsSent - before.pingsSent
        : null;

    const result = {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      args: { url: args.url, minutes: args.minutes, room: args.room, port: args.port },
      browser: userAgent,
      mode,
      pid,
      before,
      after,
      samples,
      summary: {
        hiddenSamples: hiddenSamples.length,
        everHidden,
        /** How A was read while B was in front: `background-read` is the honest one, `switch-and-return` raises A for the length of every sample. */
        mode,
        framesWhileHidden: hiddenSamples.reduce((n, s) => n + (s.framesSincePrevious ?? 0), 0),
        pingsWhileHidden,
        seatedAtEnd: lastRoster ? lastRoster.inRoster : null,
        stayedOpenWhileHidden: hiddenSamples.every((s) => s.status === 'open'),
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
      },
    };

    await mkdir(args.out, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const file = join(args.out, `hidden-safari-${stamp}.json`);
    await writeFile(file, JSON.stringify(result, null, 2));

    const s = result.summary;
    const lines = [
      `# tickroom bench, hidden tab in Safari, ${result.startedAt}`,
      '',
      `${args.minutes} minutes hidden against \`${args.url}\`, room \`${args.room}\`, on ${userAgent}. Raw JSON: \`${file}\`.`,
      '',
      '| | |',
      '| --- | --- |',
      `| the tab was actually hidden | ${s.everHidden} (${s.mode}) |`,
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
    if (!s.everHidden) lines.push('**THIS RUN MEASURED NOTHING.** ' + NOT_HIDDEN_MESSAGE.replace(/\n/g, ' '), '');
    if (s.mode === 'switch-and-return') {
      lines.push(
        '**Tab A was raised for the length of every sample.** Safari did not leave the',
        'current window handle on A when the second tab opened, so each 30 second sample',
        'switched to A, read it, and switched back: the tab was visible for a moment',
        `every 30 seconds, ${s.hiddenSamples} times in all. Read the frame counts with that in mind.`,
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
    return s.everHidden ? 0 : 3;
  } finally {
    await close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
