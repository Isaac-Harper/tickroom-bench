// The measurement surface the page hands to the harness, and nothing else.
//
// `bench/run.mjs` drives a real browser and reads these three functions out of
// `window` every 500ms. Everything about the shape below exists to make the
// SAME analysis the library already runs on loopback
// (`tests/helpers/smoothness.ts`, `FrameRec` and `analyse()`) run unchanged on
// what a Vercel deployment actually renders. `bench/analyse.mjs` is that
// analysis ported field for field, so a field renamed here is a metric silently
// lost there.
//
// WHY A RING BUFFER AND WHY DRAINING READS. A twelve minute run at 60fps is
// roughly 43,000 frames per client and each one carries the whole roster, which
// is far past what a page should hold and past what one `page.evaluate` should
// return. So the page keeps a bounded window and the harness empties it on
// every poll: 500ms of frames is about 30 records, and the 4000 cap is the
// backstop for a harness that stopped polling (a slow page, a paused debugger)
// rather than the working size. An overflowing buffer DROPS THE OLDEST and says
// so through `dropped`, because a silent drop would read downstream as a gap in
// the render, which is exactly the quantity being measured.

/**
 * One rendered frame, in the shape `analyse()` consumes.
 *
 * `x` IS THE MARKER AND NOT THE BALL, and that is the single most important
 * choice in this file. The analysis counts backward steps, zero-motion frames
 * and peak rendered speed, and every one of those is meaningless measured
 * against something that legitimately reverses, stops, or accelerates. The
 * marker moves at a constant `MARKER_SPEED` on the server and never stops (see
 * `sim/pong.ts`), so every deviation rendered here belongs to the network path
 * and to nothing else. It is the same entity at the same speed the library's
 * loopback harness uses, which is what makes the two runs comparable at all.
 */
export interface BenchFrame {
  /** `performance.now()` at the top of the frame. Every other timestamp in a run is on this clock. */
  t: number;
  /** `conn.tick.value`: the tick this frame's inputs were stamped against. */
  tick: number;
  /** `conn.tick.anchored`. A frame taken while unanchored has no meaningful tick deviation, so the analysis skips it. */
  anchored: boolean;
  /** `conn.desiredTick()`: the tick the connection WANTS to be stamping. `tick - desired` is the deviation. */
  desired: number;
  /** The newest snapshot's server clock stamp, or null before this epoch has had one. Gaps in it are the server-side stream gaps. */
  serverTime: number | null;
  /** Which ticker instance published that snapshot. A change is a handoff, and it is the only way one is visible from a browser. */
  inst: string | null;
  /** Connection epoch, incremented on every `connecting`. A reconnect is an epoch boundary. */
  epoch: number;
  /**
   * Snapshots received THIS epoch. Zero means `frame()` is redrawing the last
   * pose it held because the new epoch has nothing yet, which is a HOLD frame
   * and not a stutter: excluding those pairs is what keeps a warm swap's one
   * held frame from reading as zero motion. The step out of a hold and into the
   * new epoch's first real frame is recorded separately as a resume step.
   */
  epochSnaps: number;
  /** The marker's rendered x, or null when the frame did not draw it (a blank frame). */
  x: number | null;
  /** True when the marker's pose was extrapolated past the newest confirmed snapshot rather than interpolated between two. */
  extrap: boolean | null;
  /** This client's OWN paddle as the interpolator rendered it. Its only mover is this client's own stamped inputs, so it is the per-sender half of fairness. */
  ownX: number | null;
  /** This client's OWN paddle as it was DRAWN: what `PredictedEntity.advance` returned, the prediction interpolated across its last stamped tick plus what is left of the last correction. The number a player's eye follows, where `ownX` is the server's delayed view of the same paddle. */
  ownY: number | null;
  /** The raw prediction alone (`PredictedEntity.pose.y`, the pose after the last stamped tick), and the drawn y minus it: the between-tick interpolation plus the correction offset, so a wobble can be attributed to the prediction or to the draw. `errZ` used to be the offset alone, when the page held the offset itself; the entity does not expose the two parts separately, so the split is now prediction versus everything the draw adds. */
  predictedY: number | null;
  errZ: number | null;
  /** Every entity this frame drew, as `[id, x, y]`. How a client's view of the ROSTER is measured rather than just its view of the marker. */
  entities: [string, number, number][];
  stalled: boolean;
}

/** One thing worth a timestamp that is not a frame. `detail` is per kind and is documented at each `record` call site. */
export interface BenchEvent {
  t: number;
  kind:
    | 'status'
    | 'terminal'
    | 'reanchor'
    | 'stall'
    | 'swap'
    | 'handoff'
    | 'rate-mismatch'
    | 'mint-error'
    | 'roster'
    /** One per snapshot naming this pid: `snapTick`, the entity's stamped `tick`, the replay `error` as a magnitude (`PredictedEntity.stats.lastError`) and `serverY`. The hand-written window's `covered` and `missing` fields are gone: the entity keeps a replay history deeper than its re-send window, so the shortfall they measured no longer occurs, and `bench/paddle.mjs`'s "window shortfalls" count reads zero by construction. */
    | 'reconcile'
    /** The underlying socket's own close, with its code and reason. Not something the library reports: it turns a close into a status change and a reconnect, and the code is gone by then. See `BenchSocket` in `game/pong.ts` for the seam that sees it. */
    | 'close';
  detail: Record<string, unknown>;
}

/** What `window.__bench` exposes. Every array-returning call CLEARS what it returned. */
export interface BenchApi {
  /** `conn.status`. */
  status(): string;
  /** `conn.stats()`, verbatim, plus the counters the connection does not keep: the roster size, the two ring-buffer drop counts, and `pingsSent`, which is the one number that separates a hidden tab whose timers were throttled from one whose socket simply died. */
  stats(): Record<string, unknown>;
  /** Every frame since the last call, oldest first, and clears the buffer. */
  frames(): BenchFrame[];
  /** Every event since the last call, oldest first, and clears the buffer. */
  events(): BenchEvent[];
  /** This client's own player id, or '' before the first mint returned. */
  pid(): string;
}

declare global {
  interface Window {
    __bench?: BenchApi;
  }
}

/** The working window: 4000 records is roughly a minute of 60fps frames, far past the 500ms the harness actually polls at. */
const CAP = 4000;

/**
 * A drop-oldest ring with a drop COUNT, because the alternative is a silent
 * gap. A harness that stalled and lost frames must be able to tell that from a
 * page that rendered none, and those two are indistinguishable from the array
 * alone.
 */
export class RingBuffer<T> {
  private items: T[] = [];
  private droppedCount = 0;

  push(item: T): void {
    if (this.items.length >= CAP) {
      this.items.shift();
      this.droppedCount += 1;
    }
    this.items.push(item);
  }

  /** Returns everything held and empties the buffer, which is the only supported read. */
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
