// Starting a REAL browser process and driving it over CDP, in one place,
// because two harnesses now need exactly the same thing and getting it subtly
// wrong is invisible in the numbers.
//
// `bench/hidden-tab.mjs` explains at length why a Playwright-LAUNCHED browser
// cannot be used to measure anything about a backgrounded tab: Playwright sends
// `Emulation.setFocusEmulationEnabled` to every main frame it attaches to, the
// renderer then simulates a focused and active document forever, and
// `document.hidden` never turns true. `connectOverCDP({ noDefaults: true })` is
// the one documented way off it and it applies only to pages in the browser's
// OWN default context, which a launched browser does not have. So both
// harnesses start a browser PROCESS with a throwaway profile, attach to it, and
// drive the pages it already had. `bench/discard.mjs` needs the same process for
// a different reason: `chrome://discards` is a real Chrome page, and Playwright's
// own Chromium build has it too, but the tab it discards has to be one the
// browser owns rather than one Playwright is holding open.
//
// Everything here is keyed on the throwaway profile directory. That path exists
// only for the run that made it, so a process matching it is ours by
// construction and an already running browser can never be touched.

import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium } from 'playwright';

/** The debugging port a harness starts its own browser on. Not 9222, which is the one a human's Chrome is most likely already holding. */
export const CDP_PORT = 9333;

/** How long that browser gets to answer `/json/version`. Covers a cold app start and a fresh profile. */
export const CDP_READY_TIMEOUT_MS = 30_000;

/** How long a visibility change is given to reach the renderer before it is read back. */
export const VISIBILITY_SETTLE_MS = 1500;

/** Where a real Google Chrome lives on macOS, in the order worth trying. */
export const CHROME_APPS = [
  '/Applications/Google Chrome.app',
  join(process.env.HOME ?? '', 'Applications', 'Google Chrome.app'),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The app bundle to start.
 *
 * A real Google Chrome if there is one, because the point is to measure the
 * browser people use. Playwright's own build otherwise: it is Chromium at the
 * same milestone with the same visibility, backgrounding and discard code, it is
 * already on disk next to this harness, and driving it as a browser PROCESS
 * rather than through `chromium.launch` is what these modes are really about.
 * The fallback is announced by the caller, because "Chrome" in the output would
 * otherwise be a claim nobody checked.
 */
export async function resolveBrowserApp() {
  for (const app of CHROME_APPS) {
    try {
      await access(app);
      return { app, real: true };
    } catch {
      // Not installed here; try the next.
    }
  }
  const exe = chromium.executablePath();
  const app = exe.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  if (app === exe) return null;
  return { app, real: false };
}

/** Every process holding the throwaway profile. That path exists only for this run, so a match is ours by construction and the user's own windows can never be one. */
export function profilePids(profileDir) {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', `user-data-dir=${profileDir}`], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    // pgrep exits 1 when nothing matched, which is the ordinary answer here.
    return [];
  }
}

/**
 * Start a browser of our own and wait for it to answer CDP.
 *
 * `open -na` and not a bare spawn of the binary: `-n` is what makes this a
 * SECOND instance rather than a message to an already running one, and `-a`
 * launches it the way the window server expects so it has a real window with a
 * real frontmost tab. The throwaway `--user-data-dir` is the other half of the
 * isolation and the thing every kill below is keyed on.
 */
export async function launchBrowser(app, profileDir, port) {
  // THROWN AWAY EVERY RUN, not just named that. A kept profile makes the second
  // run of the day a different experiment from the first: Chrome restores the
  // previous session's tabs, so `contexts()[0].pages()[0]` is one of THOSE
  // rather than the fresh `about:blank` these modes are written against, and the
  // client never mints. Measured twice in a row: run one on a fresh profile
  // seated in 15 seconds, runs two and three on the kept profile timed out
  // waiting for a player id that was never going to arrive. The path is a fixed
  // subdirectory of `--out`, so this can only ever remove the one the harness
  // created.
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  spawn(
    'open',
    [
      '-na',
      app,
      '--args',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' }
  ).unref();

  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`browser did not answer CDP on 127.0.0.1:${port} within ${CDP_READY_TIMEOUT_MS}ms`);
    }
    await sleep(250);
  }
}

/**
 * Attach to that browser and hand back its OWN default context.
 *
 * `noDefaults` IS THE FLAG BOTH MODES EXIST FOR, and it applies only to the
 * browser's own default context, which is why the pages come out of
 * `contexts()[0]` rather than a fresh one. A caller that made its own context
 * would be back to a Playwright-owned page with focus emulation on it.
 */
export async function connectToBrowser(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  return { browser, context: browser.contexts()[0] ?? null };
}

/**
 * Wait for every process holding the throwaway profile to go, and SIGTERM what
 * is left.
 *
 * The belt to `Browser.close`'s braces, and separate from it because the two
 * harnesses ask for the quit differently: `hidden-tab.mjs` has a Playwright
 * browser to send it through and `discard.mjs` has a raw CDP socket. What
 * neither can skip is checking that the process actually went, keyed on the
 * profile path so the sweep cannot reach anything else.
 */
export async function awaitProfileGone(profileDir) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (profilePids(profileDir).length === 0) return true;
    await sleep(250);
  }
  for (const pid of profilePids(profileDir)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone between the listing and the signal.
    }
  }
  await sleep(1000);
  return profilePids(profileDir).length === 0;
}

/**
 * Quit the browser this run started, and only that one.
 *
 * `browser.close()` is NOT enough: Playwright documents it as closing a browser
 * it launched and merely DISCONNECTING from one it attached to, so on its own
 * it would leave a Chrome running with a throwaway profile forever. `Browser.close`
 * over a browser-level CDP session is the real quit.
 */
export async function quitBrowser(browser, profileDir) {
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close');
  } catch {
    // A browser that already went away answers nothing, which is the goal.
  }
  try {
    await browser.close();
  } catch {
    // Closing the connection to a process that just quit throws; it is done.
  }
  return awaitProfileGone(profileDir);
}

/**
 * Put page B in front and PROVE page A went hidden.
 *
 * The proof is the whole point. Without it a misconfigured browser spends the
 * next six and a half minutes measuring a foreground tab and reports it as a
 * background one, which is worse than measuring nothing because the numbers
 * look fine. `Page.bringToFront` is the ordinary request; `Target.activateTarget`
 * on the browser session is the same request one layer down, tried second
 * because there are window arrangements where the first is answered without the
 * tab activation actually happening.
 */
export async function hideBehind(browser, context, pageA, pageB) {
  await pageB.bringToFront();
  await sleep(VISIBILITY_SETTLE_MS);
  if (await pageA.evaluate(() => document.hidden)) return { hidden: true, via: 'bringToFront' };

  try {
    const pageSession = await context.newCDPSession(pageB);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    const browserSession = await browser.newBrowserCDPSession();
    await browserSession.send('Target.activateTarget', { targetId: targetInfo.targetId });
    await pageSession.detach();
  } catch (err) {
    return { hidden: false, via: null, error: String(err && err.message ? err.message : err) };
  }
  await sleep(VISIBILITY_SETTLE_MS);
  if (await pageA.evaluate(() => document.hidden)) return { hidden: true, via: 'Target.activateTarget' };
  return { hidden: false, via: null };
}
