// The library's own smoothness analysis, ported.
//
// `tests/helpers/smoothness.ts` in the tickroom repo computes exactly these
// numbers over exactly this record shape, against a loopback Redis, a `ws`
// server in the same process, and a simulated one-way delay. Everything in the
// README's "Measured, end to end, on what a client actually renders" table
// comes out of it. This file is that function, copied rather than imported,
// because the library's tests are not published in its package and a bench that
// could only run from inside the library's own checkout would not be measuring
// a deployment.
//
// COPIED MEANS COPIED: the thresholds (the +-10% band, the 1e-6 backward
// epsilon, the 150ms snapshot-gap bar), the hold-frame exclusion, and the
// separate resume-step pass are all the originals. Changing one here would
// silently make a Vercel number incomparable to the loopback number it exists
// to be read against, which is the entire purpose of the exercise. If the
// library's version changes, this one has to be re-copied on purpose.
//
// TWO THINGS DIFFER, AND BOTH ARE FORCED BY THE MEASUREMENT LIVING IN A
// BROWSER RATHER THAN IN THE TEST PROCESS:
//
// 1. THE SNAPSHOT STREAM IS INFERRED FROM FRAMES, not recorded separately. The
//    library's harness owns the connection and can stamp every `onSnapshot`;
//    here the page reports the newest `serverTime` and `inst` it has seen on
//    each rendered frame, so a snapshot's arrival is known to within one frame
//    (about 16ms at 60fps). Every `snapshotGap` figure below therefore carries
//    that much quantisation, which matters for the 150ms bar and not at all for
//    the multi-second gaps a handoff or a reconnect would produce.
//
//    IT ALSO CANNOT TELL A HOLE IN THE SOCKET FROM A LOOP THAT STOPPED
//    LOOKING, which is why `socketGap` exists beside it. The page now also
//    keeps a ring of `performance.now()` taken in the socket's own `message`
//    handler (`window.__bench.arrivals()`, see `BenchSocket` in
//    `game/pong.ts`), a series that owes nothing to `requestAnimationFrame`.
//    The two agreeing puts a gap on the socket path or upstream of it; the
//    frames alone seeing it puts it in the client's own event loop. That
//    attribution is attached to each wide gap as `confirmedBySocket`.
//
// 2. THE SERVER-SIDE COUNTERS COME FROM REDIS, not from the ticker's own
//    `onStats` hook, because the ticker is a function on somebody else's
//    machine. `bench/run.mjs` reads the room's stats key on a timer; the shape
//    is `RoomStats` either way.

/** Units per second the marker travels on the server. Must equal `MARKER_SPEED` in `sim/pong.ts`. */
export const SPEED = 100;
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * How long after the first snapshot the measurement window opens.
 *
 * The interpolator adapts its playback delay from measured jitter and the tick
 * counter re-anchors itself off the first few snapshots, so the opening second
 * of any epoch is a system converging rather than a system running. The library
 * uses the same lead for the same reason; a run that included it would report
 * the convergence as stutter.
 */
export const STEADY_LEAD_MS = 3000;

/**
 * A snapshot arrival gap wide enough to name individually, ms.
 *
 * The 150ms bar below is the library's and does not move. This is a second,
 * higher bar at which a gap stops being a number in a list and gets its own
 * line with the events around it, because a bare list of milliseconds cannot be
 * placed in time at all: the 2026-09-03 run reported a 433ms gap on two of
 * three clients and there was no way to tell one platform event seen twice from
 * two unrelated pauses.
 */
export const GAP_REPORT_MS = 250;

/** How far either side of a gap an event is still a candidate explanation. Two seconds covers a warm swap's whole attempt-and-adopt sequence and a reconnect's first ladder step. */
const GAP_CONTEXT_MS = 2000;

/**
 * How wide a SOCKET gap has to be to confirm a frame-inferred one, ms.
 *
 * Lower than the 250ms the frame series reports at, on purpose. The two series
 * do not measure the same interval: the frame-inferred gap runs from one
 * RENDERED observation to the next and so carries up to a frame of quantisation
 * at each end, and a render loop recovering from its own hiccup can draw the
 * first post-gap frame late. So a 260ms hole in the arrivals can present as a
 * 250ms one to the frames, or the other way round, and a bar set equal to the
 * report bar would turn that rounding into a "render" verdict. 200 is the same
 * hole seen through a looser instrument, and still far above the 50ms tick.
 */
export const SOCKET_CONFIRM_MS = 200;

/**
 * How far apart the two series' timestamps may sit and still be one hole, ms.
 *
 * Both are stamped at the END of the gap (the frame that first showed the new
 * `serverTime`, and the arrival that ended the socket's silence), so a match
 * should be near-exact and the slack is for the render loop's own recovery
 * delay. Wide enough to survive several dropped frames, narrow enough that it
 * cannot reach the next snapshot gap in a run whose gaps are seconds apart.
 */
export const SOCKET_MATCH_MS = 300;

/** The event kinds that can explain a hole in the snapshot stream. A roster frame or a mint error cannot, and listing those would bury the ones that can. */
const GAP_CONTEXT_KINDS = new Set(['status', 'close', 'swap', 'handoff', 'reanchor', 'stall', 'terminal']);

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * One client's whole run, reduced.
 *
 * `frames` is every `BenchFrame` in order, `events` every `BenchEvent`,
 * `statsSeries` the `stats()` object from each 500ms poll, and `endStats` the
 * last of those. `t0` is the `performance.now()` of the first frame, so every
 * `atMs` below is relative to the client's own clock and not to the harness's.
 * `arrivals` is every `window.__bench.arrivals()` timestamp in order, on that
 * same clock; a harness that does not drain it passes nothing and gets a
 * `socketGap` that says so rather than one that reads as a silent socket.
 */
export function analyse(frames, events, statsSeries, endStats, t0, arrivals = [], steadyLeadMs = STEADY_LEAD_MS) {
  // The first frame that had a snapshot in its epoch is the earliest moment
  // anything below is meaningful.
  const firstSnapFrame = frames.find((f) => f.epochSnaps > 0);
  const firstSnapAt = firstSnapFrame ? firstSnapFrame.t : t0;
  const steadyFrom = firstSnapAt + steadyLeadMs;

  const speeds = [];
  let outside = 0;
  let backward = 0;
  let worstBack = 0;
  let zeroMotion = 0;
  let measured = 0;
  let missingMarker = 0;
  let extrapFrames = 0;
  const resumeSteps = [];

  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (b.t < steadyFrom) continue;
    if (b.x === null || b.x === undefined) {
      missingMarker++;
      continue;
    }
    if (b.extrap) extrapFrames++;
    if (a.x === null || a.x === undefined) continue;
    // The one step the pass below cannot see: out of the poses this client was
    // holding and into the new epoch's own first rendered frame. This is the
    // number a warm swap or a reconnect is actually judged on, and the
    // frame-to-frame pass deliberately skips any pair touching a hold frame,
    // which would otherwise hide it.
    if (a.epochSnaps === 0 && b.epochSnaps > 0 && b.t > a.t) {
      resumeSteps.push({
        atMs: +(b.t - t0).toFixed(1),
        dx: +(b.x - a.x).toFixed(3),
        speed: +(((b.x - a.x) / (b.t - a.t)) * 1000).toFixed(2),
      });
    }
    // HOLD frames (this epoch has had no snapshot yet, so `frame()` is
    // redrawing the last pose it had) are not "should be moving": there is
    // nothing to move them with. Excluding them is what keeps a warm swap's one
    // held frame from reading as a zero-motion stutter.
    if (b.epochSnaps === 0 || a.epochSnaps === 0) continue;
    const dtS = (b.t - a.t) / 1000;
    if (dtS <= 0) continue;
    const dx = b.x - a.x;
    measured++;
    speeds.push(dx / dtS);
    if (dx / dtS < SPEED * 0.9 || dx / dtS > SPEED * 1.1) outside++;
    if (dx < -1e-6) {
      backward++;
      if (dx < worstBack) worstBack = dx;
    }
    if (Math.abs(dx) < 1e-9) zeroMotion++;
  }

  // The roster, as this client rendered it: every id it drew in the steady
  // window, and the subset it drew in EVERY frame of it. A fan-out that reaches
  // a client late is in the first list and not the second.
  const steadyFrames = frames.filter((f) => f.t >= steadyFrom);
  const seenIds = new Set();
  for (const f of steadyFrames) for (const [id] of f.entities) seenIds.add(id);
  const alwaysPresent = [...seenIds]
    .filter((id) => steadyFrames.every((f) => f.entities.some(([eid]) => eid === id)))
    .sort();
  const ownDrawn = steadyFrames.filter((f) => f.ownX !== null && f.ownX !== undefined);
  const ownAdvance =
    ownDrawn.length >= 2 ? ownDrawn[ownDrawn.length - 1].ownX - ownDrawn[0].ownX : 0;

  const mean = speeds.reduce((s, v) => s + v, 0) / Math.max(1, speeds.length);
  const sd = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, speeds.length));
  const peak = speeds.length ? speeds.reduce((m, v) => Math.max(m, v), -Infinity) : 0;
  const minV = speeds.length ? speeds.reduce((m, v) => Math.min(m, v), Infinity) : 0;

  // Snapshot arrivals, inferred: a frame whose `serverTime` differs from the
  // previous frame's is the first frame after a snapshot landed. See note 1 in
  // the module comment for the quantisation that costs.
  let maxGap = 0;
  let maxServerGapMs = 0;
  const over150 = [];
  const handoffs = [];
  let prevArrivalT = null;
  let prevServerTime = null;
  let prevInst = null;
  for (const f of frames) {
    if (f.serverTime === null || f.serverTime === undefined) continue;
    if (prevServerTime !== null && f.serverTime === prevServerTime) continue;
    if (prevArrivalT !== null) {
      const g = f.t - prevArrivalT;
      if (g > maxGap) maxGap = g;
      // TIMESTAMPED, NOT JUST MEASURED. `atMs` is on the same page-relative
      // clock as every event below, which is the only thing that lets a gap be
      // lined up with a swap, a handoff or a reconnect rather than filed as an
      // anonymous number. `epoch` says whether the gap crossed a socket.
      if (g > 150) over150.push({ atMs: +(f.t - t0).toFixed(1), gapMs: +g.toFixed(1), epoch: f.epoch });
      const sg = f.serverTime - prevServerTime;
      if (sg > maxServerGapMs) maxServerGapMs = sg;
      if (f.inst !== prevInst) {
        handoffs.push({
          atMs: +(f.t - t0).toFixed(1),
          from: prevInst,
          to: f.inst,
          gapMs: +g.toFixed(1),
          serverGapMs: +sg.toFixed(1),
          tickTo: f.tick,
        });
      }
    }
    prevArrivalT = f.t;
    prevServerTime = f.serverTime;
    prevInst = f.inst;
  }

  // THE SAME ARRIVALS, MEASURED AT THE SOCKET. No inference and no rAF: each of
  // these is a `performance.now()` taken as the first statement of the message
  // handler, before the library decoded anything. The cadence figures (median,
  // p99) are the socket's own health and should sit on the tick period; the
  // wide ones are what the frame-inferred gaps above are checked against.
  let socketMax = 0;
  let socketOver150 = 0;
  const socketGaps = [];
  const socketWide = [];
  for (let i = 1; i < arrivals.length; i++) {
    const g = arrivals[i] - arrivals[i - 1];
    if (!(g >= 0)) continue;
    socketGaps.push(g);
    if (g > socketMax) socketMax = g;
    if (g > 150) socketOver150 += 1;
    // Stamped at the END of the gap, like the frame-inferred ones, so the two
    // can be compared without an offset.
    if (g >= SOCKET_CONFIRM_MS) socketWide.push({ atMs: +(arrivals[i] - t0).toFixed(1), gapMs: +g.toFixed(1) });
  }
  const sortedSocketGaps = [...socketGaps].sort((a, b) => a - b);
  const socketMedian = percentile(sortedSocketGaps, 50);
  const socketP99 = percentile(sortedSocketGaps, 99);

  // Tick deviation from the tick the client WANTS to be stamping. A frame taken
  // while unanchored has no meaningful answer, so it is skipped rather than
  // counted as a huge deviation.
  let maxDev = 0;
  for (const f of frames) {
    if (!f.anchored || f.t < steadyFrom) continue;
    const dev = f.tick - f.desired;
    if (Math.abs(dev) > Math.abs(maxDev)) maxDev = dev;
  }

  // WHAT THE CLIENT WAS DOING AROUND THE WIDE GAPS. Attached to the gap rather
  // than left for a reader to correlate by eye, because that correlation is the
  // whole question a gap raises: a 400ms hole that sits on a swap is the swap's
  // adoption cost and expected, and the same hole with nothing near it is the
  // network or the room, which is not.
  const contextEvents = events
    .filter((e) => GAP_CONTEXT_KINDS.has(e.kind))
    .map((e) => ({ kind: e.kind, atMs: +(e.t - t0).toFixed(1), detail: e.detail }));
  for (const g of over150) {
    if (g.gapMs < GAP_REPORT_MS) continue;
    g.near = contextEvents
      .filter((e) => Math.abs(e.atMs - g.atMs) <= GAP_CONTEXT_MS)
      .map((e) => ({ ...e, dtMs: +(e.atMs - g.atMs).toFixed(1) }));
    // WHICH SERIES SAW THE HOLE, which is the question the whole socket ring
    // exists to answer. A frame gap with a socket gap beside it is a hole in
    // the arrivals themselves (the socket path, or anything upstream of it);
    // a frame gap the socket never saw is the client's own event loop, which
    // kept receiving and stopped drawing.
    //
    // `null` RATHER THAN `false` WHEN THERE IS NOTHING TO ANSWER WITH. A page
    // built before the ring existed, or a harness that never drained it,
    // reports no arrivals at all, and calling that "the socket was fine" would
    // attribute every gap in the run to a render loop on no evidence. Same
    // reasoning as `countSubscribers` in `bench/run.mjs`: the honest answer to
    // an instrument that did not report is not zero.
    if (arrivals.length < 2) {
      g.confirmedBySocket = null;
      g.socketGapMs = null;
      continue;
    }
    let hit = null;
    for (const w of socketWide) {
      if (Math.abs(w.atMs - g.atMs) > SOCKET_MATCH_MS) continue;
      if (hit === null || w.gapMs > hit.gapMs) hit = w;
    }
    g.confirmedBySocket = hit !== null;
    g.socketGapMs = hit === null ? null : hit.gapMs;
  }

  const reanchors = events
    .filter((e) => e.kind === 'reanchor')
    .map((e) => ({ atMs: +(e.t - t0).toFixed(1), delta: e.detail.delta }));
  // The socket's own close, code and all. The library turns a close into a
  // status change and a reconnect and the code is gone by then, so a run that
  // reconnected once could say that it happened and nothing about why. See
  // `BenchSocket` in `game/pong.ts` for the seam this comes through.
  const closes = events
    .filter((e) => e.kind === 'close')
    .map((e) => ({
      atMs: +(e.t - t0).toFixed(1),
      code: e.detail.code,
      reason: e.detail.reason,
      wasClean: e.detail.wasClean,
    }));
  const terminals = events
    .filter((e) => e.kind === 'terminal')
    .map((e) => ({ atMs: +(e.t - t0).toFixed(1), reason: e.detail.reason, room: e.detail.room }));
  const stalls = events
    .filter((e) => e.kind === 'stall' && e.detail.stalled === true)
    .map((e) => +(e.t - t0).toFixed(1));
  const swapEvents = events
    .filter((e) => e.kind === 'swap')
    .map((e) => ({ atMs: +(e.t - t0).toFixed(1), ...e.detail }));
  const clientHandoffEvents = events
    .filter((e) => e.kind === 'handoff')
    .map((e) => ({ atMs: +(e.t - t0).toFixed(1), ...e.detail }));

  const rtts = statsSeries.map((s) => s.rttMs).filter((v) => typeof v === 'number' && v > 0);
  const sortedRtt = [...rtts].sort((a, b) => a - b);

  return {
    frames: frames.length,
    steadyFromMs: +(steadyFrom - t0).toFixed(1),
    rendered: {
      peak: +peak.toFixed(2),
      min: +minV.toFixed(2),
      mean: +mean.toFixed(2),
      sd: +sd.toFixed(2),
      outside10pct: outside,
      backward,
      worstBackward: +worstBack.toFixed(3),
      zeroMotion,
      extrapFrames,
      missingMarker,
      holdFrames: frames.filter((f) => f.t >= steadyFrom && f.epochSnaps === 0 && f.x !== null).length,
      blankFrames: frames.filter((f) => f.t >= steadyFrom && (f.x === null || f.x === undefined)).length,
      measured,
      resumeSteps,
    },
    entities: { ids: [...seenIds].sort(), alwaysPresent, ownAdvance: +ownAdvance.toFixed(2) },
    snapshotGap: {
      maxMs: +maxGap.toFixed(1),
      over150,
      /** The gap on the SERVER's own grid, which is what a handoff actually costs; the arrival gap above also carries the network. */
      maxServerMs: +maxServerGapMs.toFixed(1),
      maxServerTicks: +(maxServerGapMs / TICK_MS).toFixed(2),
      handoffs,
    },
    /**
     * The same stream measured at the socket instead of at the render loop.
     * `arrivals` of 0 means the page reported none (no socket, or a harness
     * that does not drain the ring), and every figure below is then empty
     * rather than healthy.
     */
    socketGap: {
      arrivals: arrivals.length,
      maxMs: +socketMax.toFixed(1),
      medianMs: socketMedian === null ? null : +socketMedian.toFixed(1),
      p99Ms: socketP99 === null ? null : +socketP99.toFixed(1),
      over150: socketOver150,
      over250: socketWide.filter((w) => w.gapMs >= GAP_REPORT_MS),
    },
    tick: { maxDev: +maxDev.toFixed(2), reanchors, maxAbsReanchor: reanchors.reduce((m, r) => Math.max(m, Math.abs(r.delta)), 0) },
    client: {
      ...endStats,
      stalledFrames: frames.filter((f) => f.stalled).length,
      rttMinMs: sortedRtt.length ? sortedRtt[0] : null,
      rttMedianMs: percentile(sortedRtt, 50),
    },
    events: { terminals, stalls, swaps: swapEvents, handoffs: clientHandoffEvents, closes },
  };
}

/**
 * The server's own counters, summed across the run.
 *
 * `RoomStats` is a per-flush DELTA for the counter fields (the ticker clears
 * its histograms and counters on every flush), so summing is right and taking
 * the last sample would be wrong. `players` is a gauge, so it takes a max
 * instead: the run's answer to "how full did this room actually get" is the
 * peak, not whatever it happened to be at the end.
 */
export function summariseRoomStats(samples) {
  const totals = {
    starves: 0,
    lateInputs: 0,
    refusedInputs: 0,
    hostErrors: 0,
    publishSkipped: 0,
    publishFails: 0,
    publishes: 0,
    renewFails: 0,
    dropped: 0,
    badEnvelopes: 0,
    unknownEnvelopes: 0,
    rejectsSuppressed: 0,
    bytesPublished: 0,
    bytesDelivered: 0,
  };
  let maxPlayers = 0;
  let minTickHz = Infinity;
  let maxTickHz = 0;
  const instances = new Set();
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    for (const k of Object.keys(totals)) {
      if (typeof s[k] === 'number') totals[k] += s[k];
    }
    if (typeof s.players === 'number') maxPlayers = Math.max(maxPlayers, s.players);
    if (typeof s.tickHz === 'number' && s.tickHz > 0) {
      minTickHz = Math.min(minTickHz, s.tickHz);
      maxTickHz = Math.max(maxTickHz, s.tickHz);
    }
    if (s.build) instances.add(s.build);
  }
  return {
    samples: samples.length,
    totals,
    maxPlayers,
    tickHz: { min: minTickHz === Infinity ? null : +minTickHz.toFixed(2), max: +maxTickHz.toFixed(2) },
    builds: [...instances],
  };
}
