import { randomUUID } from 'node:crypto';
import { createTickerRoute } from 'tickroom/adapters/vercel';

import { BASE, MAX_DURATION_S, NAMESPACE, PRESENCE_TIMEOUT_MS, TICK_HZ, isValidBase } from '@/lib/rooms';
import { SESSION_SECRET } from '@/lib/secret';
import { createPongRuntime } from '@/sim/pong';

/**
 * LITERALS, ALWAYS. Next's route-segment-config parser reads `runtime` and
 * `maxDuration` out of this file's SOURCE TEXT at build time, so
 * `export const runtime = tickerRouteConfig.runtime` fails the build with
 * "Next.js can't recognize the exported `runtime` field in route", however
 * identical the value would be at runtime.
 *
 * 300 IS THE HOBBY PLAN'S HARD CAP, not a preference, and `MAX_DURATION_S`
 * below has to be the same number: whatever this exports is the moment the
 * platform kills the function, and the loop has to be finished, checkpointed,
 * released and succeeded by then. The adapter derives `maxRunMs` as
 * `maxDurationS * 1000 - TICKER_EXIT_MARGIN_MS`, so 300 gives a 270 second tick
 * loop and therefore a planned handoff every 270 seconds. Nothing at runtime
 * can read a route module's static exports back, which is why the pair is
 * checked by eye here and by the assertion below for the parts that can be.
 */
export const runtime = 'nodejs';
export const maxDuration = 300;

// The page sizes its tick timeline from `TICK_HZ` and the runtime is what
// actually paces the room. A disagreement is a silent multiplier on the tick
// counter's step, the server-tick estimate and the underrun threshold at once,
// so it fails the build instead of desynchronising every client quietly. Run
// against a throwaway runtime at module evaluation, which is where Next
// evaluates route modules during a build.
if (createPongRuntime('probe').tickHz !== TICK_HZ) throw new Error('pong tickHz mismatch');

/**
 * The authoritative tick loop. One invocation owns the room's lease, runs the
 * simulation at a fixed rate, publishes a snapshot every tick, checkpoints
 * every second, and spawns its own successor before the platform's duration cap
 * kills it. Nobody disconnects when that happens: the sockets are held by
 * separate relay invocations with an entirely separate lifetime.
 *
 * Only the relay is meant to call this, carrying a room-bound spawn token. The
 * factory verifies that token before issuing a single Redis command, which is
 * what stands between an anonymous GET and a multi-minute simulation loop plus
 * every publish it makes for the rest of its run.
 *
 * BUILT PER REQUEST, WHICH IS THE ONLY WAY `inst` CAN BE HONEST. See `GET`
 * below for what module scope cost. `createTickerRoute` validates its numbers
 * and returns a closure, so one per invocation costs an object next to a 270
 * second loop.
 */
const tickerRouteFor = (inst: string) =>
  createTickerRoute({
    runtime: createPongRuntime(inst),
    secret: SESSION_SECRET,
    isValidBase,
    fallbackRoom: BASE,
    // Shared Redis. See the comment on NAMESPACE in lib/rooms.ts: an omission
    // here is silent and its blast radius is another application's live data.
    namespace: NAMESPACE,
    // See lib/rooms.ts. Above the library's default on purpose, because a hidden
    // tab is one of the things being measured and the sweep must not be what
    // removes it.
    presenceTimeoutMs: PRESENCE_TIMEOUT_MS,
    maxDurationS: MAX_DURATION_S,
    // Carried into `RoomStats.build`, which is the SERVER side of the same seam
    // marker the snapshot carries. The harness reads the stats key from Redis, so
    // this is what lets a handoff the client saw be lined up against the flush
    // the successor wrote, rather than the two being separately plausible.
    buildId: inst,
    /**
     * WHY `geomKey` IS NOT REALLY OPTIONAL, though the library types it that way.
     * A checkpoint carries room state as OPAQUE bytes, and a successor's job is
     * to restore its predecessor's bytes faithfully. So a deploy that changes
     * what the simulation MEANS (a field width, a rule, the shape of the state)
     * leaves every live room restoring state simulated against the old rules,
     * re-saving it a second later with the TTL refreshed, and doing that forever.
     * It never expires, nothing throws, and no metric moves: the room quietly
     * keeps simulating a build that no longer exists, which for a measurement rig
     * means a run that reports numbers about code nobody is looking at.
     *
     * A digest turns that permanent silent corruption into an ordinary fresh
     * start, because a mismatch is handled exactly like a corrupt checkpoint.
     * These are hand-written version strings rather than a computed hash, which
     * is honest about their limit: they protect only what somebody remembers to
     * bump. Change `PongState` or the rules in `sim/pong.ts`, bump this.
     */
    geomKey: () => 'bench-pong:v1',
    // Events come out of the PURE simulation and are handled here, off the hot
    // loop. Logged rather than counted because a goal is not a client-driven
    // rate: it is bounded by the ball crossing a wall, roughly once every few
    // seconds, and having them in the function log is what lets a run be checked
    // against the room actually having played.
    onEvents: (events, ctx) => {
      for (const ev of events) console.log(`[pong ${ctx.roomId} ${inst}] tick ${ctx.tick}`, ev);
    },
    // WIRE THE LOG. `ticker.room-normalised` is the only symptom of the three
    // `maxRooms` values disagreeing, and a run whose clients silently landed in
    // the fallback room instead of the one their session named would produce a
    // perfectly healthy looking set of numbers about the wrong room.
    log: (ev) => console.log(JSON.stringify(ev)),
  });

/**
 * ONE ID PER INVOCATION, AND IT IS DELIBERATELY NOT MODULE SCOPE.
 *
 * It used to be, and Fluid compute made that marker lie. A ticker spawns its
 * own successor, and on Vercel the successor lands in the SAME warm container
 * as the incumbent far more often than not: the module was already evaluated,
 * so the successor re-used the incumbent's id and published the identical
 * `inst` its predecessor had. A handoff across a warm container was then
 * indistinguishable from no handoff at all, which is the single thing this
 * deployment exists to make visible. Measured on the twelve minute run of
 * 2026-09-03: the clients reported one handoff where the platform log shows
 * two, because the 03:59:54 successor carried 71558b37 exactly as the 03:55:27
 * incumbent had, and only the 04:04:21 invocation (e4e08a89) landed cold enough
 * to look like a different instance.
 *
 * So the id, the runtime that stamps it on every snapshot and the route that
 * carries it are all built inside the request. `buildId` is the same string, so
 * the stats flush the harness reads out of Redis still names the same
 * invocation as the snapshots the browser saw.
 */
export function GET(req: Request): Promise<Response> {
  return tickerRouteFor(randomUUID().slice(0, 8))(req);
}
