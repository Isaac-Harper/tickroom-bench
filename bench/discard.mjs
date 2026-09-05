#!/usr/bin/env node
// One client, DISCARDED by the browser, and what it costs to come back.
//
// A hidden tab still has a renderer: its socket is up, its snapshots arrive,
// and `bench/hidden-tab.mjs` measures a client that merely stopped drawing. A
// DISCARDED tab has nothing. Chrome kills the renderer outright under memory
// pressure, the tab stays in the strip as a title and a favicon, and everything
// the page held (the socket, the connection, the tick counter, the player's
// seat) is gone with no notice to the page and no close handshake the page
// itself performed. On return the tab is RELOADED from scratch, so the room
// sees a brand new client mint a brand new player id while the old one is still
// sitting in the roster until the server times its socket out.
//
// So this run answers three things nothing else here can:
//
//   - Does a discarded client come back at all, and how fast? A reload is a
//     fresh mint, a fresh socket and a fresh join, not a reconnect, so the cost
//     is the cold join cost and not the warm swap cost.
//   - Is the returning client CLEAN? A reload starts a new connection, so
//     `reconnects` on it should be 0. Anything else means the new socket
//     immediately had trouble.
//   - Does the old seat go away? The relay's liveness deadline is what reaps a
//     socket nobody closed. A discard kills the renderer, so the socket dies
//     with it; the roster on the reloaded page has to drop back by one, and if
//     it does not, this deployment leaks a seat per discard.
//
// TWO THINGS ABOUT THE MECHANISM, BOTH LEARNED THE HARD WAY.
//
// 1. `chrome://discards` IS BEHIND A SWITCH NOW. Chrome answers it with
//    "Internal debugging pages are currently disabled" and a pointer at
//    `chrome://chrome-urls`, where a single button turns them on for the
//    profile. The throwaway profile is new every run, so the button is pressed
//    every run, from the harness, before the discards page is any use.
//
// 2. A TAB WITH A DEBUGGER ATTACHED CANNOT BE DISCARDED, WHICH RULES PLAYWRIGHT
//    OUT ENTIRELY. `connectOverCDP` attaches a session to every page in the
//    browser's default context and keeps it for the life of the page object,
//    and Chrome refuses to discard a tab in that state: the click lands, the
//    page reports success, `Discard Count` stays 0 and the tab keeps running.
//    Measured here first, and it is why this file speaks raw CDP over a
//    WebSocket instead: the client tab is attached to ONLY for the moment a
//    sample is read and is detached again immediately, so at the moment of the
//    discard nothing is holding it. The discards page itself stays attached the
//    whole time, which is fine, because it is not the tab being discarded.
//
// Everything about starting and quitting the browser process is shared with
// `bench/hidden-tab.mjs` through `bench/chrome.mjs`.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { awaitProfileGone, CDP_PORT, launchBrowser, resolveBrowserApp } from './chrome.mjs';
import { HOOK_READY_JS, PID_JS, PID_TIMEOUT_MS, seated } from './page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Let the client settle and prove it works BEFORE discarding it, for the same reason `hidden-tab.mjs` does: a run that discarded a tab which had never connected would report a client that never came back and blame the wrong thing. */
const SETTLE_MS = 8000;

/** How long a visibility change is given to reach the renderer before it is read back. */
const VISIBILITY_SETTLE_MS = 1500;

/** How long the discards page gets to admit the tab is discarded after the action is clicked. */
const DISCARD_CONFIRM_MS = 15_000;

/** How long the returning tab gets to reload, mint and draw. A reload is a cold join, so this is the mint budget plus a frame. */
const RECOVERY_TIMEOUT_MS = 60_000;

/** How often the returning tab is polled. Fast, because the whole question is how many seconds it took. */
const RECOVERY_POLL_MS = 100;

/** How often the roster is read while waiting for the discarded client's seat to go. */
const ROSTER_POLL_MS = 1000;

/** How long any one CDP call gets to answer. Short, because the calls that matter are the ones aimed at a tab whose renderer has just been killed. */
const CDP_CALL_TIMEOUT_MS = 10_000;

/** How long the activated tab gets to come back on its own before the harness reloads it itself. See the note at the revive. */
const REVIVE_GRACE_MS = 5000;

/** How long one read of the returning tab gets. See the note at the read: it has to be well under the grace period above. */
const RECOVERY_READ_TIMEOUT_MS = 2000;

const USAGE = `
tickroom-bench discard: kill one client's renderer the way Chrome does under
memory pressure, then bring the tab back and measure the return.

  node bench/discard.mjs --url <base-url> [options]

Options:
  --url <url>        Base URL of the deployment. Required.
  --room <id>        Room instance to join. Default "pong~8", NOT the main room:
                     a discard leaves a dead player in the roster until the
                     server reaps it, which would show up in anything else
                     measuring the same room at the same time.
  --roster-seconds <n>  How long to watch the roster for the discarded client's
                     seat to disappear. Default 90, the relay's liveness
                     deadline. The watch stops early the moment the seat goes.
  --port <n>         Debugging port. Default ${CDP_PORT}.
  --app <path>       Browser bundle to drive. Default: Google Chrome if it is
                     installed, else Playwright's own Chromium build.
  --out <dir>        Where the JSON result goes. Default bench/out.
  --help             This.

Runs HEADED, always, in a browser process of its own with a throwaway profile.
Exits 3 when the discard could not be triggered at all, naming what was tried.
`.trim();

function parseArgs(argv) {
  const out = { room: 'pong~8', rosterSeconds: 90, port: CDP_PORT, app: null, out: join(HERE, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--room') out.room = argv[++i];
    else if (a === '--roster-seconds') out.rosterSeconds = Number(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--out') out.out = resolve(argv[++i]);
    else return { error: `unknown argument: ${a}` };
  }
  if (!out.url) return { error: 'missing --url' };
  if (!Number.isFinite(out.rosterSeconds) || out.rosterSeconds <= 0) return { error: '--roster-seconds must be a positive number' };
  if (!Number.isInteger(out.port) || out.port < 1024) return { error: '--port must be a port number above 1023' };
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- raw CDP ---------------------------------------------------------------

/**
 * The smallest CDP client that does this job, on Node's own `WebSocket`.
 *
 * No new dependency and, more to the point, no Playwright: see note 2 at the
 * top. The one thing this class exists to make possible is a session that can
 * be CLOSED, which is what leaves the client tab discardable between samples.
 */
class Cdp {
  constructor(url) {
    this.url = url;
    this.next = 1;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    // EVERY WAIT HERE IS BOUNDED, because the interesting ones are the ones that
    // never answer: a session opened on a target whose renderer has just been
    // killed accepts the socket and replies to nothing, and an unbounded
    // `Runtime.evaluate` against it would hang the run rather than fail it. A
    // rejection is what makes the caller go and ask which target the tab has
    // now.
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`CDP session on ${this.url} did not open in ${CDP_CALL_TIMEOUT_MS}ms`)), CDP_CALL_TIMEOUT_MS);
      this.ws.onopen = () => {
        clearTimeout(timer);
        res();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        rej(new Error(`could not open a CDP session on ${this.url}`));
      };
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    };
    return this;
  }

  send(method, params = {}, timeoutMs = CDP_CALL_TIMEOUT_MS) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} did not answer in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(timer);
          res(v);
        },
        rej: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
    });
  }

  /** `expr` is a JS expression, evaluated by value, exactly like `page.evaluate` with a string. */
  async evaluate(expr, timeoutMs = CDP_CALL_TIMEOUT_MS) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already gone, which is the state being asked for.
    }
  }
}

/**
 * The client tab's CURRENT target id, asked of the browser rather than
 * remembered.
 *
 * A DISCARD DOES NOT PRESERVE THE TARGET ID. Chrome 152 destroys the page
 * target with the renderer and makes a new one for the same tab, so everything
 * held from before the discard answers `No target with given id found`, the
 * activation included. (Chrome for Testing 151 kept the id, which is exactly
 * the kind of difference that makes a harness work on one machine and not the
 * next.) `page` first because that is what can be evaluated in; the tab-level
 * target is the fallback, because a discarded tab may have nothing else.
 */
async function findClientTarget(browser, clientUrl) {
  const { targetInfos } = await browser.send('Target.getTargets');
  const matches = targetInfos.filter((t) => t.url === clientUrl);
  const page = matches.find((t) => t.type === 'page');
  return (page ?? matches[0])?.targetId ?? null;
}

/** A page session that lasts exactly one evaluate. THE DETACH IS THE POINT: a tab holding a debugger session is a tab Chrome will not discard. */
async function evalDetached(port, targetId, expr, timeoutMs = CDP_CALL_TIMEOUT_MS) {
  const cdp = await new Cdp(`ws://127.0.0.1:${port}/devtools/page/${targetId}`).open();
  try {
    return await cdp.evaluate(expr, timeoutMs);
  } finally {
    cdp.close();
  }
}

/** Wait for `expr` to answer truthy on a tab nothing may stay attached to. Same contract as `page.waitForFunction`, one detached evaluate at a time. */
async function waitForDetached(port, targetId, expr, timeoutMs, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try {
      v = await evalDetached(port, targetId, expr);
    } catch {
      // A tab mid-navigation or mid-reload has no context to evaluate in yet.
    }
    if (v) return true;
    if (Date.now() > deadline) return false;
    await sleep(pollMs);
  }
}

// ---- the discards page -----------------------------------------------------

/**
 * The walker every expression below starts with.
 *
 * `chrome://discards` is a WebUI page whose table lives inside custom elements,
 * so a plain `document.querySelectorAll` finds none of it. Playwright's own
 * selectors pierce open shadow roots for free; raw CDP has no such engine, so
 * the piercing is written out here once and reused.
 */
const DEEP_JS = `const deep=(r,x=[])=>{for(const e of r.querySelectorAll('*')){x.push(e);if(e.shadowRoot)deep(e.shadowRoot,x);}return x;};`;

/** The row of the discards table for a given tab URL, as text. `null` when the tab is not listed. */
const rowTextJs = (url) =>
  `(() => { ${DEEP_JS} const row = deep(document).filter(e => e.tagName === 'TR').find(t => t.innerText.includes(${JSON.stringify(url)})); return row ? row.innerText.replace(/\\s+/g, ' ') : null; })()`;

/** Every row the table has, for the message a run prints when it could not find the one it wanted. */
const ALL_ROWS_JS = `(() => { ${DEEP_JS} return deep(document).filter(e => e.tagName === 'TR').map(t => t.innerText.replace(/\\s+/g, ' ').slice(0, 120)); })()`;

/**
 * Turn internal debugging pages on for this profile.
 *
 * Chrome gates `chrome://discards` behind a per-profile switch and the profile
 * is new every run, so this is not optional and not cached. The button is a
 * `<cr-button>` inside the WebUI's shadow DOM.
 */
const ENABLE_DEBUG_PAGES_JS = `(() => { ${DEEP_JS} const b = deep(document).find(e => (e.tagName === 'CR-BUTTON' || e.tagName === 'BUTTON') && /enable internal debug/i.test(e.textContent || '')); if (!b) return 'no button'; b.click(); return 'clicked'; })()`;

/**
 * Click the row's `[Urgent Discard]`.
 *
 * Urgent is the memory-pressure path, which is the one being measured: it is
 * what Chrome does to a background tab when the machine runs out of room,
 * rather than the proactive path it uses on its own schedule. The actions are
 * `<div is="action-link">`, not anchors, so they are found by text within the
 * row rather than by role.
 */
const urgentDiscardJs = (url) =>
  `(() => { ${DEEP_JS} const row = deep(document).filter(e => e.tagName === 'TR').find(t => t.innerText.includes(${JSON.stringify(url)})); if (!row) return 'no row'; const link = Array.from(row.querySelectorAll('[is="action-link"]')).find(e => /urgent discard/i.test(e.textContent || '')); if (!link) return 'no action'; link.click(); return 'clicked'; })()`;

// ---- the client tab --------------------------------------------------------

/** One read of the client, in the shape the summary needs. Kept to one expression because every read costs an attach and a detach. */
const SAMPLE_JS = `(() => { const b = window.__bench; if (!b) return null; const frames = b.frames(); const last = frames.length ? frames[frames.length - 1] : null; const stats = b.stats(); return { status: b.status(), pid: b.pid(), hidden: document.hidden, visibilityState: document.visibilityState, wasDiscarded: document.wasDiscarded === true, frames: frames.length, rosterSize: stats.rosterSize, reconnects: stats.reconnects, relaySwaps: stats.relaySwaps, swapsFailed: stats.swapsFailed, entities: last ? last.entities : null, serverTime: last ? last.serverTime : null }; })()`;

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
  console.error(`[discard] room ${args.room}, ${args.url} (real browser over CDP on ${args.port})`);

  let found = args.app ? { app: args.app, real: false } : await resolveBrowserApp();
  if (!found) {
    console.error('[discard] no Google Chrome and no Playwright browser bundle to fall back to');
    return 2;
  }
  if (!found.real) console.error(`[discard] driving ${found.app}`);

  const profileDir = join(args.out, 'discard-profile');
  const version = await launchBrowser(found.app, profileDir, args.port);
  const browserLabel = `${version.Browser} (${found.app})`;
  console.error(`[discard] ${browserLabel}`);

  const browser = await new Cdp(version.webSocketDebuggerUrl).open();
  // QUIT EXACTLY ONCE, HOWEVER THE RUN ENDS, for the reason `hidden-tab.mjs`
  // gives: everything below can throw, and a run that threw used to leave a real
  // browser process holding the throwaway profile with nobody to close it.
  let quitResult;
  const closeBrowser = async () => {
    if (quitResult !== undefined) return quitResult;
    try {
      await browser.send('Browser.close');
    } catch {
      // A browser that already went away answers nothing, which is the goal.
    }
    browser.close();
    quitResult = await awaitProfileGone(profileDir);
    return quitResult;
  };

  try {
    const target = new URL(args.url);
    target.searchParams.set('bot', '1');
    target.searchParams.set('room', args.room);
    target.searchParams.set('name', 'discard');
    const clientUrl = target.toString();

    let { targetId: tabA } = await browser.send('Target.createTarget', { url: clientUrl });
    await browser.send('Target.activateTarget', { targetId: tabA });
    const ready = await waitForDetached(args.port, tabA, HOOK_READY_JS, PID_TIMEOUT_MS);
    if (!ready) {
      console.error('[discard] the client never minted a player id');
      return 1;
    }
    const oldPid = await evalDetached(args.port, tabA, PID_JS);
    await sleep(SETTLE_MS);
    const before = await evalDetached(args.port, tabA, SAMPLE_JS);
    console.error(
      `[discard] baseline: status ${before.status}, pid ${oldPid}, roster ${before.rosterSize}, ${before.frames} frames in the last ${SETTLE_MS}ms`
    );

    // THE SECOND TAB IS BOTH THE OCCLUDER AND THE INSTRUMENT. Chrome will not
    // discard the active tab, so A has to be behind something; the something may
    // as well be the page that does the discarding.
    const { targetId: tabB } = await browser.send('Target.createTarget', { url: 'about:blank' });
    await browser.send('Target.activateTarget', { targetId: tabB });
    await sleep(VISIBILITY_SETTLE_MS);
    const hiddenCheck = await evalDetached(args.port, tabA, 'document.hidden');
    console.error(`[discard] tab A hidden: ${hiddenCheck}`);
    if (!hiddenCheck) {
      console.error(
        '\n[discard] ABORTING: tab A is still the active tab, and Chrome does not discard the tab a\n' +
          'user is looking at. Nothing below would be a discard.\n'
      );
      return 3;
    }

    const pageB = await new Cdp(`ws://127.0.0.1:${args.port}/devtools/page/${tabB}`).open();
    const tried = [];

    await pageB.send('Page.navigate', { url: 'chrome://chrome-urls/?host=chrome://discards/#internal-debug-pages' });
    await sleep(VISIBILITY_SETTLE_MS);
    const enabled = await pageB.evaluate(ENABLE_DEBUG_PAGES_JS);
    tried.push(`chrome://chrome-urls enable button: ${enabled}`);
    console.error(`[discard] internal debugging pages: ${enabled}`);

    await pageB.send('Page.navigate', { url: 'chrome://discards/' });
    // POLLED, NOT SLEPT. The table is populated from a mojo round trip after the
    // page loads, so a fixed wait is a race: the same run found the row on one
    // attempt and an empty table on the next.
    let rowBefore = null;
    const rowBy = Date.now() + DISCARD_CONFIRM_MS;
    while (Date.now() < rowBy) {
      await sleep(500);
      rowBefore = await pageB.evaluate(rowTextJs(clientUrl)).catch(() => null);
      if (rowBefore) break;
    }
    if (!rowBefore) {
      const rows = await pageB.evaluate(ALL_ROWS_JS).catch(() => []);
      tried.push(
        `the client tab was not listed on chrome://discards within ${DISCARD_CONFIRM_MS}ms. Rows seen: ${
          rows.length ? rows.join(' / ') : 'none at all'
        }`
      );
      console.error(`\n[discard] ABORTING. Tried:\n  - ${tried.join('\n  - ')}\n`);
      return 3;
    }
    console.error(`[discard] row before: ${rowBefore.slice(0, 160)}`);

    const clicked = await pageB.evaluate(urgentDiscardJs(clientUrl));
    tried.push(`chrome://discards [Urgent Discard] on the client's row: ${clicked}`);
    if (clicked !== 'clicked') {
      console.error(`\n[discard] ABORTING. Tried:\n  - ${tried.join('\n  - ')}\n`);
      return 3;
    }

    // THE PAGE'S OWN ADMISSION IS THE CONFIRMATION, and it has to be, because
    // the obvious check is destructive: attaching to a discarded tab is enough
    // to make Chrome reload it, so "can I still evaluate in A" would answer the
    // question by undoing the answer. The row's lifecycle state says
    // `discarded (urgent)` with a timestamp, and its discard count goes to 1.
    let rowAfter = rowBefore;
    const confirmBy = Date.now() + DISCARD_CONFIRM_MS;
    while (Date.now() < confirmBy) {
      await sleep(500);
      rowAfter = (await pageB.evaluate(rowTextJs(clientUrl))) ?? rowAfter;
      if (/discarded/i.test(rowAfter)) break;
    }
    const discarded = /discarded/i.test(rowAfter);
    console.error(`[discard] row after: ${rowAfter.slice(0, 160)}`);
    if (!discarded) {
      tried.push(`the click was accepted but the row never said discarded: ${rowAfter.slice(0, 200)}`);
      console.error(
        `\n[discard] ABORTING. Tried:\n  - ${tried.join('\n  - ')}\n\n` +
          'A tab with a debugger session attached is not discardable, so if this run was\n' +
          'driven by anything that holds one open on the client tab, that is the cause.\n'
      );
      return 3;
    }

    // ---- back to the front ------------------------------------------------

    console.error('[discard] bringing the tab back');
    // The id the tab had before the discard is gone with the renderer, so it is
    // asked for again here and re-asked below whenever a read fails.
    tabA = (await findClientTarget(browser, clientUrl)) ?? tabA;
    const shownAt = Date.now();
    await browser.send('Target.activateTarget', { targetId: tabA });

    // FOUR MILESTONES, NOT ONE, because the first one is nearly free and means
    // nothing on its own. A discarded tab reloads out of the HTTP cache and
    // starts drawing in about a tenth of a second, with no session, no socket
    // and an empty roster; the cost of a discard is the COLD JOIN behind that
    // frame. So the run holds on until the reloaded client has minted, opened
    // its socket and been drawn in the room again, and reports each step.
    const recovery = [];
    let firstFrame = null;
    let newPid = null;
    let secondsToPid = null;
    let secondsToOpen = null;
    let secondsToSeated = null;
    let wasDiscarded = null;
    let oldSeatGoneAtS = null;
    let oldSeatSeenAfterShow = false;
    // WHAT WAKES A DISCARDED TAB IS NOT THE SAME EVERYWHERE. Chrome for Testing
    // 151 reloads the tab the moment it is activated, which is the faithful
    // trigger and the one tried first. Chrome 152 accepts the activation, and
    // the tab stays dead: it comes back when the tab is actually SHOWN, and a
    // window that is not the frontmost thing on the machine never shows it. So
    // after a short grace period the harness sends the reload itself, which is
    // the same restore Chrome would have done (`document.wasDiscarded` is still
    // true afterwards, where a fresh navigation would clear it) and is recorded
    // as such rather than passed off as the activation having worked.
    let revivedBy = 'Target.activateTarget';
    let reloadSentAtS = null;
    const recoveryBy = Date.now() + RECOVERY_TIMEOUT_MS;
    while (Date.now() < recoveryBy && secondsToSeated === null) {
      await sleep(RECOVERY_POLL_MS);
      // Checked BEFORE the read rather than after it: a read aimed at a tab
      // with no renderer costs the whole CDP call timeout, so waiting for one
      // to fail would push the grace period out by that much and put it in
      // every number below.
      if (reloadSentAtS === null && recovery.length === 0 && Date.now() - shownAt > REVIVE_GRACE_MS) {
        tabA = (await findClientTarget(browser, clientUrl)) ?? tabA;
        reloadSentAtS = Math.round(Date.now() - shownAt) / 1000;
        revivedBy = 'Page.reload';
        console.error(`[discard] the tab did not come back on activation; reloading it at ${reloadSentAtS}s`);
        const cdp = await new Cdp(`ws://127.0.0.1:${args.port}/devtools/page/${tabA}`).open().catch(() => null);
        if (cdp) {
          await cdp.send('Page.reload').catch(() => {});
          cdp.close();
        }
      }
      let s = null;
      try {
        // A SHORT read timeout here, not the ordinary one: a tab that is still
        // dead accepts the session and answers nothing, and a ten second wait
        // on that would sit through the grace period above and land in every
        // number below. A tab that is alive answers in milliseconds.
        s = await evalDetached(args.port, tabA, SAMPLE_JS, RECOVERY_READ_TIMEOUT_MS);
      } catch {
        // The reload has not produced a context to evaluate in yet, or it made
        // one under a new target id.
        tabA = (await findClientTarget(browser, clientUrl)) ?? tabA;
      }
      if (!s) continue;
      const atS = Math.round(Date.now() - shownAt) / 1000;
      const ownSeated = seated(s.entities, s.pid);
      const oldSeated = seated(s.entities, oldPid);
      recovery.push({ atS, ...s, entities: undefined, ownSeated, oldPidDrawn: oldSeated });
      if (oldSeated === true) oldSeatSeenAfterShow = true;
      // The seat can be gone before the roster watch below ever runs: the
      // discard killed the socket, so the relay may well have dropped that
      // player before the reloaded client finished joining.
      if (oldSeatGoneAtS === null && ownSeated === true && oldSeated === false) oldSeatGoneAtS = atS;
      if (wasDiscarded === null) wasDiscarded = s.wasDiscarded;
      if (firstFrame === null && s.frames > 0) firstFrame = atS;
      if (secondsToPid === null && s.pid) {
        secondsToPid = atS;
        newPid = s.pid;
      }
      if (secondsToOpen === null && s.status === 'open') secondsToOpen = atS;
      if (secondsToSeated === null && ownSeated === true) secondsToSeated = atS;
    }
    const secs = (v) => (v === null ? 'never' : `${v}s`);
    console.error(
      `[discard] wasDiscarded ${wasDiscarded}, revived by ${revivedBy}, first frame ${secs(firstFrame)}, ` +
        `pid ${secs(secondsToPid)}, open ${secs(secondsToOpen)}, drawn in the roster ${secs(secondsToSeated)}`
    );
    console.error(`[discard] new pid ${newPid} (old ${oldPid})`);

    // ---- does the old seat go away ----------------------------------------
    //
    // The discard killed the renderer, so the old socket died with it and the
    // relay should drop that player the moment the close reaches it rather than
    // at the liveness deadline. Both are watched: the roster SIZE, which is what
    // the page counts, and whether the old player id is still being DRAWN, which
    // is the same `seated` check every other harness here uses.
    //
    // ONLY A SAMPLE THAT DREW THE RELOADED CLIENT ITSELF CAN ANSWER THIS. A
    // roster the new client has not received yet is empty, the old id is not in
    // it, and reading that as "the seat is gone" would report a pass on every
    // run before the new socket even opened. So a sample counts only once the
    // new client is in its own roster.
    const rosterSamples = [];
    const rosterBy = Date.now() + args.rosterSeconds * 1000;
    while (secondsToSeated !== null && oldSeatGoneAtS === null && Date.now() < rosterBy) {
      let s = null;
      try {
        s = await evalDetached(args.port, tabA, SAMPLE_JS);
      } catch {
        // Same as above: nothing to read from this instant.
        tabA = (await findClientTarget(browser, clientUrl)) ?? tabA;
      }
      const atS = Math.round(Date.now() - shownAt) / 1000;
      if (s && seated(s.entities, s.pid) === true) {
        const oldSeated = seated(s.entities, oldPid);
        rosterSamples.push({ atS, rosterSize: s.rosterSize, oldPidDrawn: oldSeated, status: s.status });
        if (oldSeated === true) oldSeatSeenAfterShow = true;
        if (oldSeated === false) {
          oldSeatGoneAtS = atS;
          console.error(`[discard] the discarded client's seat is gone at ${atS}s, roster ${s.rosterSize}`);
          break;
        }
      }
      await sleep(ROSTER_POLL_MS);
    }
    if (oldSeatGoneAtS === null && secondsToSeated !== null) {
      console.error(`[discard] the old seat was still drawn after ${args.rosterSeconds}s`);
    } else if (!oldSeatSeenAfterShow) {
      console.error("[discard] the discarded client's seat was already gone in the first roster the reloaded client drew");
    }

    const after = await evalDetached(args.port, tabA, SAMPLE_JS);
    pageB.close();
    const quitClean = await closeBrowser();

    // ---- what it cost ------------------------------------------------------

    const result = {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      args: { url: args.url, room: args.room, rosterSeconds: args.rosterSeconds },
      browser: browserLabel,
      clientUrl,
      oldPid,
      newPid,
      before,
      after: { ...after, entities: undefined },
      discardsRow: { before: rowBefore, after: rowAfter },
      recovery,
      rosterSamples,
      summary: {
        /** Whether Chrome admitted the discard on its own page, which is the only non-destructive confirmation there is. */
        discarded,
        discardMechanism: 'chrome://chrome-urls enable button, then [Urgent Discard] on the client row of chrome://discards',
        /** True on a document the browser reloaded after discarding it. The page's own evidence, independent of the discards table. */
        wasDiscarded,
        /** A reload is a new session, so a new id here is expected and correct. */
        reloaded: Boolean(newPid) && newPid !== oldPid,
        /** What actually brought the tab back: the activation alone, or the reload the harness had to send after it. */
        revivedBy,
        reloadSentAtS,
        /** The cheap one: the page is back out of the cache and drawing, with no session and no socket behind it yet. */
        secondsToFirstFrameAfterShow: firstFrame,
        /** The cold join, in three steps: the mint, the socket, and being drawn in the room again. */
        secondsToPidAfterShow: secondsToPid,
        secondsToOpenAfterShow: secondsToOpen,
        secondsToSeatedAfterShow: secondsToSeated,
        /** On a RELOAD this must be 0: the connection is new, so anything else means the fresh socket had trouble immediately. */
        reconnectsOnNewConnection: after ? after.reconnects : null,
        relaySwapsOnNewConnection: after ? after.relaySwaps : null,
        statusAtEnd: after ? after.status : null,
        rosterAtEnd: after ? after.rosterSize : null,
        /** When the discarded client stopped being drawn in the room, measured from the moment the tab was brought back. */
        oldSeatGoneAtS,
        /** Whether the dead client was ever drawn again at all. False means the relay had already dropped it before the reloaded client saw its first roster, which is the socket dying with the renderer. */
        oldSeatSeenAfterShow,
        rosterWatchedForS: args.rosterSeconds,
        browserQuitCleanly: quitClean !== false,
      },
    };

    await mkdir(args.out, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const file = join(args.out, `discard-${stamp}.json`);
    await writeFile(file, JSON.stringify(result, null, 2));

    const s = result.summary;
    const lines = [
      `# tickroom bench, tab discard, ${result.startedAt}`,
      '',
      `One client discarded and brought back against \`${args.url}\`, room \`${args.room}\`, on ${browserLabel}. Raw JSON: \`${file}\`.`,
      '',
      '| | |',
      '| --- | --- |',
      `| the browser discarded the tab | ${s.discarded} |`,
      `| how | ${s.discardMechanism} |`,
      `| \`document.wasDiscarded\` on return | ${s.wasDiscarded} |`,
      `| what brought the tab back | ${s.revivedBy}${s.reloadSentAtS === null ? '' : ` (sent at ${s.reloadSentAtS}s)`} |`,
      `| the tab reloaded (a new player id) | ${s.reloaded} (${oldPid} to ${newPid}) |`,
      `| seconds to first rendered frame after showing | ${s.secondsToFirstFrameAfterShow ?? 'never'} |`,
      `| seconds to a minted player id | ${s.secondsToPidAfterShow ?? 'never'} |`,
      `| seconds to the socket being open | ${s.secondsToOpenAfterShow ?? 'never'} |`,
      `| seconds to being drawn in the roster again | ${s.secondsToSeatedAfterShow ?? 'never'} |`,
      `| reconnects on the new connection | ${s.reconnectsOnNewConnection} |`,
      `| relay warm swaps on the new connection | ${s.relaySwapsOnNewConnection} |`,
      `| status at the end | ${s.statusAtEnd} |`,
      `| the discarded client's seat was gone at | ${s.oldSeatGoneAtS === null ? `never, watched ${s.rosterWatchedForS}s` : `${s.oldSeatGoneAtS}s${s.oldSeatSeenAfterShow ? '' : ', already gone in the first roster drawn'}`} |`,
      `| roster at the end | ${s.rosterAtEnd} |`,
      '',
      'A discard is not a reconnect: the renderer is killed, the socket dies with it,',
      'and the tab is reloaded on return, so the returning client is a NEW player with a',
      'new id and a cold join behind it. The old seat leaving the roster is the server',
      'noticing the socket went away; the relay would reap it at the liveness deadline',
      'even if the close itself were lost.',
    ];
    console.log(lines.join('\n'));
    return s.discarded && s.reloaded && s.secondsToSeatedAfterShow !== null ? 0 : 1;
  } finally {
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
