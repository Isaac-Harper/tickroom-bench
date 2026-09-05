// The one registry of what this deployment serves, shared by every route and by
// the page. Nothing here imports the simulation: a room's RUNTIME is only needed
// by the ticker route, and keeping it out of this module is what lets the relay,
// the balancer and the session route import the registry without dragging a
// simulation into their bundles.

/**
 * EVERY REDIS KEY THIS APP WRITES IS PREFIXED WITH THIS, AND IT IS NOT
 * COSMETIC. This deployment points at a Redis instance that already holds two
 * other applications' keys: the bare `room:*` prefix (tickroom's own
 * `DEFAULT_NAMESPACE` in `tickroom/core`) and the `tickroom:*` prefix the older
 * demo deployment writes. Running the bench under either one would not merely
 * clutter a keyspace, it would write this app's room state, lease, stats and
 * roster straight over a live room's. A lease collision alone means two
 * unrelated simulations each believing they are the single authoritative writer
 * for the other's room, and the measurement that came out of that would be
 * confidently wrong rather than obviously broken.
 *
 * So it is passed to every tickroom call that accepts a `namespace`:
 * `createTickerRoute`, `createRelayRoute`, `createBalancerRoute`, and through
 * them `roomKeys` and `checkAdmission` (which namespaces the per-subject
 * connection set as `bench:conns:<subject>` as well as the room keys). There is
 * no global default to set; an omission is silent, and its blast radius is
 * somebody else's live data.
 *
 * The harness reads the same prefix to find the stats key, so changing it here
 * means changing `--redis` reads in `bench/run.mjs` too. `STATS_KEY_FOR` below
 * is the one place that shape is written down.
 */
export const NAMESPACE = 'bench';

/**
 * The one base this deployment serves. A single base keeps the routes free of
 * the per-base dispatch the older demo needed for two games, which matters for
 * a measurement app: fewer moving parts between the harness and the number.
 */
export const BASE = 'pong';

/**
 * Capacity, enforced at the relay's admission gate and by the balancer, and
 * kept in step with the simulation's own `isFull` (see `SEATS` in
 * `sim/pong.ts`). A refused joiner then gets refused for the same reason at
 * both layers rather than being admitted by one and ignored by the other.
 *
 * Twenty rather than pong's usual two, because the thing being measured here is
 * a POPULATED room: `RoomStats.bytesDelivered` is `bytesPublished * players`,
 * the per-socket subscriber fan-out is what a managed Redis plan actually
 * bills, and a two-seat table cannot show either. It is also what lets the
 * harness put every bench client in ONE room instead of watching the balancer
 * scatter them across instances, which would measure something else entirely.
 */
export const MAX_PLAYERS = 20;

/** Must equal `pongRuntime.tickHz`. The page uses it to size its tick timeline; the ticker route asserts the two agree. */
export const TICK_HZ = 20;

/**
 * How long a player may go without a join heartbeat before the ticker treats
 * them as departed.
 *
 * Left at a value ABOVE the library's own default (25s: five heartbeats of
 * five seconds) on purpose, because this app exists to measure a hidden tab. A
 * backgrounded tab keeps its socket and therefore keeps its relay's heartbeat,
 * so the sweep should not be what removes it; if a hidden tab ever does drop
 * out of the roster, the cause needs to be the socket dying rather than a
 * timeout this app chose. Sixty seconds is comfortably past the relay's 90s
 * liveness deadline being the interesting number instead.
 */
export const PRESENCE_TIMEOUT_MS = 60_000;

/**
 * The platform duration cap, in seconds, and the single number every lifetime
 * in this deployment is derived from.
 *
 * 800 is the HARD cap on Vercel's Pro plan (the team this deploys to is Pro;
 * the first runs used 300, which is both the Hobby cap and the default, and
 * the README keeps those numbers as run A to C): a `maxDuration` above it is not
 * merely ignored, the deployment is rejected. Everything downstream follows
 * from it and neither number is a preference:
 *
 *   ticker  maxRunMs  = min(700s, 800s - TICKER_EXIT_MARGIN_MS 30s) = 700s
 *   relay   lifetimeMs = 800s - RELAY_EXIT_MARGIN_MS 10s            = 790s
 *   (at 300s, the first measurements: 270s and 290s)
 *
 * So a room hands off between ticker invocations every 700 seconds and every
 * socket warm-swaps to a fresh relay every 790 seconds (270 and 290 in the
 * first runs at 300). A twelve minute run
 * therefore crosses roughly two of each, which is why twelve minutes is the
 * shortest run worth doing: a run under one relay lifetime measures a deployment that never
 * exercised either mechanism.
 *
 * IT MUST EQUAL THE `maxDuration` LITERAL EACH ROUTE FILE EXPORTS. Next reads
 * that export out of the source text at build time and cannot see a value
 * assigned from anything but a literal, so the two are written separately and
 * this constant is what they are checked against by hand. Getting them out of
 * step means the ticker announces a lifetime that lands after it is already
 * dead.
 */
export const MAX_DURATION_S = 800;

/**
 * `hasOwnProperty`-grade validation with one legal answer. A bare `raw === BASE`
 * is exactly right here and does not have the inherited-property hazard a
 * `raw in ROOMS` lookup would: this value is interpolated into Redis key names,
 * which have no escaping of any kind, so this is the trust boundary between an
 * untrusted query parameter and the keyspace.
 */
export function isValidBase(base: string): base is typeof BASE {
  return base === BASE;
}

/**
 * The room's stats key, written once a second by the ticker and read by the
 * harness's `--redis` sampler. Written here rather than in the harness because
 * the namespace and the key layout are this app's decision and the harness is
 * only a reader; `roomKeys` in `tickroom/core` is the definition both follow.
 */
export function statsKeyFor(roomId: string): string {
  return `${NAMESPACE}:${roomId}:stats`;
}
