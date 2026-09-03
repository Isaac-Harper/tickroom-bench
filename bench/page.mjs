// What both harnesses need out of a page before they can measure it, in one
// place, because they disagreed about it and one of them was wrong.
//
// A BENCH CLIENT'S OWN PLAYER ID IS NOT AVAILABLE AT THE MOMENT
// `window.__bench` IS. `game/pong.ts` publishes the hook and only then calls
// `conn.start()`, and `selfPid` is set inside the connection's `mint()`, which
// is a round trip to `/api/session` away. So `waitForFunction(() =>
// Boolean(window.__bench))` resolving says the PAGE is ready and says nothing
// about the id: `pid()` answers `''` for the first few hundred milliseconds of
// every client, and longer on a cold function.
//
// That is not theoretical. `bench/run.mjs` survived it by accident, because it
// re-reads `pid` out of every 500ms drain until one comes back non-empty and
// its roster figures are built from the entity ids themselves.
// `bench/hidden-tab.mjs` read the id once, got `''`, and then asked for the
// rest of the run whether `''` was in the roster: every sample of the 6.5
// minute run of 2026-09-03 reported `in roster false, 3 entities` for a page
// whose own paddle was one of those three, while `run.mjs` listed the same pid
// under `alwaysPresent` for a client sitting in the same room. Two harnesses
// answering one question two ways is the bug; one helper is the fix.

/**
 * How long to wait for the mint to land.
 *
 * The same 60s both harnesses give the hook itself, and it needs to be: a mint
 * is a cold Vercel function start, and a mint that FAILS is retried on the
 * connection's reconnect ladder rather than thrown, so the budget has to cover
 * a first attempt plus a retry. Measured at 30s this timed out on an otherwise
 * healthy run.
 */
export const PID_TIMEOUT_MS = 60_000;

/**
 * Wait until the page has both published its hook AND minted a session, and
 * return this client's own player id.
 *
 * The empty-string check is the whole point: `pid()` exists from the moment the
 * hook does and answers `''` until `mint()` returns, so waiting on the hook
 * alone is waiting for the wrong event.
 */
export async function waitForPid(page, timeoutMs = PID_TIMEOUT_MS) {
  await page.waitForFunction(() => Boolean(window.__bench) && window.__bench.pid() !== '', null, {
    timeout: timeoutMs,
  });
  return page.evaluate(() => window.__bench.pid());
}

/**
 * Is this client's own entity in the roster a frame drew?
 *
 * `entities` is a `BenchFrame.entities`, `[id, x, y]` per entity, and the ids
 * are exactly the keys `interpolate.entities` puts in the map in
 * `game/pong.ts`: `ball`, `marker`, and one per paddle keyed by PLAYER ID. So
 * the answer is a plain id match and always was; what it needs is a pid that
 * exists.
 *
 * `null` rather than `false` when there is nothing to answer with (no pid yet,
 * no frame yet), because "we could not tell" and "it was not seated" are the
 * two things the old check confused and the second one is alarming.
 */
export function seated(entities, pid) {
  if (!pid || !Array.isArray(entities)) return null;
  return entities.some(([id]) => id === pid);
}
