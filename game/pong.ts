// The browser half, and the instrument.
//
// This is `examples/pong/client.ts` from the library, wired exactly as the
// README's step 3 shows: tickHz matching the simulation, `decodeSnapshot`
// lifting this pid's own `inputLead` out of the per-paddle field, an
// interpolator driven by the connection itself, the paddle owned by a
// `PredictedEntity` running the simulation's own `stepPaddleY`,
// `onStallChange`, `onTickReanchor` as telemetry, and `onTerminal` with the
// documented bounded re-assign. Read the library's copy for why each of those
// is shaped the way it is; the reasoning is unchanged and is not repeated here.
//
// THREE THINGS ARE ADDED, all of them because this page is measured by a robot
// rather than played by a person:
//
// 1. A BOT MODE (`?bot=1`). An unattended tab has to keep producing STAMPED
//    inputs, because a client sending nothing measures a very different thing
//    from a client sending one record per tick: no playout buffer engages, no
//    `inputLead` comes back, `lateInputs` and `refusedInputs` stay at zero
//    whatever the link is doing, and the fairness half of the analysis
//    (`ownAdvance`, how far this sender's own entity travelled) has no signal at
//    all. The bot steers on a slow sine so the paddle spends its time crossing
//    the field rather than pinned at an edge, which is where a clamped paddle
//    would stop producing motion.
//
// 2. THE `window.__bench` HOOK. See `game/bench.ts` for the record shapes and
//    why they are exactly the library's own `FrameRec`.
//
// 3. A ROOM CHOSEN BY QUERY PARAMETER (`?room=`). The harness puts every client
//    in one named room deliberately: a populated room is what is being
//    measured, and letting the balancer scatter clients across instances would
//    measure the balancer instead.

import {
  PredictedEntity,
  RoomConnection,
  SnapshotInterpolator,
  isRosterFrame,
  type EntitySample,
  type SessionInfo,
} from 'tickroom/client';
import { PING_FRAME_PREFIX } from 'tickroom/core';

import { RingBuffer, type BenchApi, type BenchEvent, type BenchFrame } from './bench';
import { FIELD_H, FIELD_W, MARKER_SPEED, PADDLE_SPEED, readDir, stepPaddleY } from '@/sim/pong';

/** A plain interface with no index signature: `decodeSnapshot`'s return type is what fixes the payload type for `onSnapshot` and for `interpolate.entities`, so this shape flows through the connection and comes back out intact. */
interface PongSnapshot {
  tick: number;
  serverTime: number;
  /** Which ticker invocation published this. A change is a handoff; see `createPongRuntime` in sim/pong.ts. */
  inst: string;
  ball: { x: number; y: number };
  /** The constant-velocity ruler. See `MARKER_SPEED` in sim/pong.ts. */
  markerX: number;
  serveIn: number;
  winner: string | null;
  paddles: { pid: string; side: 'left' | 'right'; y: number; score: number; inputLead: number }[];
  /** OUR OWN pid's playout depth, lifted out of `paddles` in `decodeSnapshot`. The one field `RoomConnection` reads out of a host's snapshot beyond `tick` and `serverTime`. */
  inputLead?: number | undefined;
}

/** Must equal `pongRuntime.tickHz` and `TICK_HZ` in lib/rooms.ts. Stated once and used twice below (the connection's basis and the prediction's timestep). */
const TICK_HZ = 20;

/** Where a paddle sits for each side. The server owns the assignment; this is only where to draw it. */
const paddleX = (side: 'left' | 'right'): number => (side === 'left' ? 6 : FIELD_W - 6);

/** How many capacity bounces a client will follow before giving up. Bounded because the balancer and the ticker disagree for up to a stats TTL, so an unbounded loop is a client that never lands. */
const MAX_REASSIGNS = 3;

/** The bot's steering period, seconds. Slow enough that the paddle crosses the field rather than buzzing inside one clamp, which is what keeps a stamped input stream producing visible motion. */
const BOT_PERIOD_S = 7;

export interface PongOptions {
  /** Room instance to join, e.g. `pong` or `pong~1`. Re-validated server side; this is a request, not an assertion. */
  room: string;
  /** Display name carried as join metadata onto the roster. */
  name: string;
  /** Steer automatically. An unattended tab must still stamp inputs; see note 1 in the module comment. */
  bot: boolean;
}

export function startPong(canvas: HTMLCanvasElement, opts: PongOptions): () => void {
  const ctx = canvas.getContext('2d')!;
  const interp = new SnapshotInterpolator<string>();

  // ---- the measurement buffers -------------------------------------------

  const frameBuf = new RingBuffer<BenchFrame>();
  const eventBuf = new RingBuffer<BenchEvent>();
  /** `performance.now()` at start, so every `t` in a run is relative to the same origin as the harness's own samples. */
  const record = (kind: BenchEvent['kind'], detail: Record<string, unknown>): void => {
    eventBuf.push({ t: performance.now(), kind, detail });
  };

  /**
   * The connection epoch, and the count of snapshots inside it.
   *
   * `epochSnaps === 0` is what marks a HOLD frame: `frame()` is redrawing the
   * last pose it had because the new epoch has delivered nothing yet. The
   * analysis excludes those pairs, so getting this wrong turns every warm swap
   * into a fabricated zero-motion stutter. Both are reset on `connecting`,
   * which is the one status every new epoch passes through.
   */
  let epoch = 0;
  let epochSnaps = 0;
  let lastServerTime: number | null = null;
  let lastInst: string | null = null;
  /** The last swap counters seen, so a change becomes one event rather than a value the harness has to diff itself. */
  let lastSwaps = { relaySwaps: 0, swapsAttempted: 0, swapsFailed: 0 };
  let rosterSize = 0;

  // ---- everything the interpolator does not smooth ------------------------

  let scores = new Map<string, number>();
  let winner: string | null = null;
  let serveIn = 0;
  let selfPid = '';
  /** Which end we defend, from the first snapshot that names us. `null` until then, which is also "there is nothing of ours to draw or to predict against". */
  let selfSide: 'left' | 'right' | null = null;
  /** Rooms that have refused this client for capacity. ALL of them are sent on the next assign; see the balancer route for why one is not enough. */
  const refusedRooms: string[] = [];
  let reassigns = 0;
  let terminalText = '';

  // ---- our own paddle, predicted locally ----------------------------------

  /** Held input, -1 up through +1 down. A STATE the player holds, not an event that fires once, which is what makes a dropped packet harmless. */
  let dir = 0;

  /**
   * The room this client is currently trying to join. It starts as the one the
   * URL asked for and only changes when the balancer moves us after a capacity
   * refusal, which is the whole reason `mint` is a function rather than a
   * constant: a re-mint has to be able to land somewhere else.
   */
  let room = opts.room;

  // ---- the socket, seen from outside the library --------------------------

  /**
   * Round-trip probes this client actually got onto the wire, lifetime.
   *
   * `ConnectionStats` cannot report this and should not: the ping is transport
   * bookkeeping the connection sends on its own 2000ms `setInterval`, and a
   * host has no business in it. A BENCH does, for one reason: a `setInterval`
   * is precisely what a browser throttles once a tab is backgrounded, so a
   * socket that stayed open with a ping count that stopped climbing is the exact
   * shape of the hidden-tab failure, and `rttMs` cannot show it because a
   * sample taken across a frozen render loop is discarded before it reaches the
   * window.
   */
  let pingsSent = 0;

  /**
   * The one seam that can see a socket from outside the connection.
   *
   * `WebSocketImpl` is documented for supplying a non-DOM implementation, and
   * the connection builds every socket through it including the warm swap's
   * replacement, so a subclass sees every frame sent and every close. That is
   * the only way this page can report either: the library consumes `ping`,
   * `pong` and `relay-expiring` internally as transport bookkeeping, and it
   * turns a close into a status change and a reconnect with the CODE dropped.
   * A run that reconnected once and cannot say whether that was 1006, a 1001
   * from a function exiting, or a policy close has measured that something
   * happened and nothing about what.
   *
   * The ping match is on the library's own `PING_FRAME_PREFIX` rather than a
   * string retyped here, because a prefix that drifted would silently count
   * zero.
   */
  class BenchSocket extends WebSocket {
    constructor(url: string) {
      super(url);
      this.addEventListener('close', (ev) => {
        record('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      });
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === 'string' && data.startsWith(PING_FRAME_PREFIX)) pingsSent += 1;
      super.send(data);
    }
  }

  const conn = new RoomConnection<PongSnapshot, string>({
    WebSocketImpl: BenchSocket,
    // Required rather than defaulted, because a client silently running on the
    // wrong basis skews the tick counter, the server-tick estimate and the
    // underrun threshold at once.
    tickHz: TICK_HZ,

    mint: async (): Promise<SessionInfo> => {
      // ASK THE BALANCER ONLY AFTER A REFUSAL, not on every mint. On a first
      // connect the harness has already decided which room every client belongs
      // in, and consulting the balancer would let it split them; after a
      // capacity bounce the balancer is the only thing that knows where there
      // is space.
      if (refusedRooms.length > 0) {
        const q = new URLSearchParams({ base: 'pong', not: refusedRooms.join(',') });
        const assigned = await fetch(`/api/room?${q}`);
        if (assigned.ok) {
          const body = (await assigned.json()) as { room?: unknown };
          if (typeof body.room === 'string') room = body.room;
        }
      }

      const res = await fetch(`/api/session?room=${encodeURIComponent(room)}`, { method: 'POST' });
      // A mint has more than one failure shape and only one of them is JSON. A
      // rate limiter answering 429 with a text body makes `res.json()` throw,
      // and an unguarded throw here rejects the whole boot: blank canvas, no
      // message, no retry. Check ok before parsing.
      if (!res.ok) {
        record('mint-error', { status: res.status });
        throw new Error(`mint failed: ${res.status}`);
      }
      const session = (await res.json()) as SessionInfo;
      selfPid = session.playerId;
      return session;
    },

    // BUILT BY HAND RATHER THAN THROUGH `path`, and the difference is not
    // cosmetic: the default builder appends its own `?token=...` to whatever
    // `path` holds, so a `path` carrying a query string produces
    // `/api/ws?n=x?token=...` and the relay reads no token at all. `socketUrl`
    // is the documented escape hatch for exactly this, and it is the same four
    // parameters the default builder interpolates plus the display name the
    // relay turns into join metadata.
    socketUrl: (session) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({
        token: session.token,
        pid: session.playerId,
        h: String(session.handle),
        room: session.room,
        n: opts.name,
      });
      return `${proto}//${location.host}/api/ws?${params.toString()}`;
    },

    decodeSnapshot: (buf) => {
      const snap = JSON.parse(new TextDecoder().decode(buf)) as PongSnapshot;
      // STEP 3 OF THE FEEDBACK LOOP `onBufferHealth` OPENED: pick OUR OWN pid's
      // depth out of the per-paddle field and hand it back as `inputLead`. The
      // connection folds it into its stamping lead, trimming toward a two-tick
      // cushion, so the lead converges on the smallest one that keeps the
      // server's buffer fed rather than staying at the open-loop guess.
      const mine = snap.paddles.find((p) => p.pid === selfPid);
      return { ...snap, inputLead: mine?.inputLead };
    },

    // The connection owns the interpolator: it pushes every decoded snapshot in
    // with the right two timestamps and clears the buffer on every epoch
    // change. All this side has to say is which parts of a snapshot MOVE.
    interpolate: {
      into: interp,
      entities: (snap) => {
        const entities = new Map<string, EntitySample>();
        entities.set('ball', { x: snap.ball.x, y: snap.ball.y });
        // THE RULER. It is an entity like any other precisely so that it goes
        // through the identical interpolation path the analysis is measuring:
        // a marker sampled some other way would report the smoothness of a code
        // path no player uses.
        entities.set('marker', { x: snap.markerX, y: 0 });
        for (const p of snap.paddles) {
          entities.set(p.pid, { x: paddleX(p.side), y: p.y });
        }
        return entities;
      },
    },

    onSnapshot: (snap) => {
      epochSnaps += 1;
      lastServerTime = snap.serverTime;
      if (snap.inst !== lastInst) {
        // A TICKER HANDOFF, as the client saw it. This is the library's central
        // claim made observable: the successor restored the checkpoint and
        // continued, so everything else about this frame should look ordinary.
        if (lastInst !== null) record('handoff', { from: lastInst, to: snap.inst, tick: snap.tick, serverTime: snap.serverTime });
        lastInst = snap.inst;
      }

      winner = snap.winner;
      serveIn = snap.serveIn;
      const next = new Map<string, number>();
      for (const p of snap.paddles) next.set(p.pid, p.score);
      scores = next;

      // RECONCILE THE PREDICTION. The snapshot is authoritative for tick
      // `snap.tick`, but the entity has already stamped and simulated inputs
      // for ticks after that, so the server's y is where our paddle was
      // several ticks ago. The entity replays its own stored records from
      // there, adopts the result, and glides the difference away; the first
      // confirmation snaps, which is also what seats the paddle's x.
      const mine = snap.paddles.find((p) => p.pid === selfPid);
      if (!mine) return;
      selfSide = mine.side;
      paddle.reconcile({ x: paddleX(mine.side), y: mine.y }, snap.tick);
      // DIAGNOSTIC. The tick the snapshot named, the tick the entity had
      // stamped to, and the error the replay left, as a magnitude: nonzero
      // anywhere but the first confirmation means the two ends disagreed
      // about the input timeline, which `bench/paddle.mjs` provokes on
      // purpose by changing the input mid-run. The old `covered` and
      // `missing` fields are gone with the hand-written window: the entity
      // keeps a replay history deeper than its re-send window, so a lead
      // past six ticks no longer comes up short.
      record('reconcile', {
        snapTick: snap.tick,
        tick: conn.tick.value,
        error: +paddle.stats.lastError.toFixed(3),
        serverY: +mine.y.toFixed(3),
      });
    },

    onText: (msg) => {
      if (!isRosterFrame(msg)) return;
      rosterSize = Object.keys(msg.map).length;
      record('roster', { size: rosterSize, seed: msg.seed === true });
    },

    onStatus: (status) => {
      if (status === 'connecting') {
        // THE EPOCH BOUNDARY. Both counters reset here rather than on `open`,
        // because a hold frame is any frame drawn after the attempt began and
        // before the new epoch delivered, and `open` is inside that window.
        epoch += 1;
        epochSnaps = 0;
      }
      record('status', { status });
    },

    onStallChange: (stalled) => {
      // NON-BLOCKING on purpose. A stall usually self-heals (a ticker handoff, a
      // brief network gap), so the page keeps the live world while it does.
      record('stall', { stalled });
      const el = document.getElementById('stall');
      if (el) el.style.display = stalled ? 'block' : 'none';
    },

    // THE COUNTER JUST JUMPED. TELEMETRY ONLY, now: this handler used to move
    // the send high-water mark by the delta and drop the in-flight window,
    // because a NEGATIVE delta (a handoff, a backgrounded tab, a clock step)
    // otherwise left the send loop silent until the counter climbed back past
    // the old mark, measured on a real socket at 5.6 seconds of input silence
    // and 100 self-inflicted starves. `PredictedEntity` reads the jump off the
    // counter itself and does both, so all that is left here is the count,
    // which for a HIDDEN TAB is the whole measurement.
    onTickReanchor: (delta) => {
      record('reanchor', { delta });
    },

    onTickRateMismatch: (hz) => {
      record('rate-mismatch', { measuredHz: hz, configuredHz: TICK_HZ });
    },

    onTerminal: (reason) => {
      record('terminal', { reason, room });
      // `'capacity'` is the one worth handling: this room instance is full, and
      // `remint: true` lets the mint above consult the balancer and come back
      // with a different instance. Bounded, because the balancer's stats key
      // and the ticker's authoritative count disagree for up to a TTL.
      //
      // RESTARTING FROM IN HERE IS SAFE: `onTerminal` is the LAST thing the
      // connection does, after it has latched, closed the old socket and
      // settled the status.
      if (reason === 'capacity' && reassigns < MAX_REASSIGNS) {
        reassigns += 1;
        if (!refusedRooms.includes(room)) refusedRooms.push(room);
        void conn.start({ remint: true });
        return;
      }
      terminalText = {
        capacity: 'This room is full.',
        'conn-limit': 'Already connected in another tab.',
        'version-skew': 'Update needed. Reload to continue.',
        'closed-by-server': 'Session ended.',
        'connect-error': 'Could not reach the room. Reload to try again.',
        'mint-failed': 'Could not start a session. Reload to try again.',
        stopped: '',
      }[reason];
      const el = document.getElementById('terminal');
      if (el) {
        el.textContent = terminalText;
        el.style.display = terminalText ? 'block' : 'none';
      }
    },
  });

  // ---- our own paddle, the stamped path's client half ----------------------
  //
  // Once per frame `advance` stamps a record for every tick the counter
  // crossed, predicts each through `step`, sends the last six as one JSON array
  // (what the relay's `decodeInput` parses), and returns the pose to draw,
  // interpolated across the last stamped tick by `conn.tick.fraction` with what
  // is left of the last correction added. Once per snapshot `reconcile` replays
  // and re-seats. The x never changes under `step`; the first reconcile seats
  // it on the side the server chose.
  const paddle = new PredictedEntity<{ dir: number }>({
    conn,
    tickHz: TICK_HZ,
    // THE SAME FUNCTION THE SIMULATION RUNS, on the same input, on the tick the
    // record names.
    step: (pose, input, dt) => ({ x: pose.x, y: stepPaddleY(pose.y, input.dir, dt) }),
    // Bounds the correction glide to the paddle's own top speed and sets the
    // snap distance at half a second of travel.
    maxSpeed: PADDLE_SPEED,
    initial: { x: 0, y: FIELD_H / 2 },
  });

  // ---- input --------------------------------------------------------------

  // The keys only ever move `dir`. Nothing is sent from here: a send is one
  // record per TICK, driven from the frame loop, because the tick is the unit
  // the server applies input on and a keydown is not.
  const onKey = (e: KeyboardEvent, down: boolean): void => {
    if (e.key === 'ArrowUp' || e.key === 'w') dir = down ? -1 : 0;
    else if (e.key === 'ArrowDown' || e.key === 's') dir = down ? 1 : 0;
    else return;
    e.preventDefault();
  };
  const keydown = (e: KeyboardEvent): void => onKey(e, true);
  const keyup = (e: KeyboardEvent): void => onKey(e, false);
  if (!opts.bot) {
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
  }

  /**
   * The bot's steering, phase-shifted per client so a room full of them does
   * not move as one block. A sine rather than a random walk because it is
   * deterministic and its period is stated: a paddle that spends most of its
   * time mid-field is a paddle whose motion the analysis can see, and a random
   * walk drifts into a clamp and stops.
   */
  const phase = Math.random() * Math.PI * 2;
  const startedAt = performance.now();
  const botDir = (now: number): number => {
    const s = (now - startedAt) / 1000;
    return Math.sin((s / BOT_PERIOD_S) * Math.PI * 2 + phase);
  };

  // ---- the frame ----------------------------------------------------------

  let raf = 0;
  const frame = (now: number): void => {
    // THE ONE PER-FRAME CALL. It advances the tick counter inputs are stamped
    // against, polls the stall detector, and samples the interpolator, all from
    // one delta the connection measures for itself.
    const { entities: view, dt, stalled } = conn.frame(now);
    if (opts.bot) dir = botDir(now);
    // AFTER `frame()`, never before: the counter this stamps against is
    // advanced by that call, so advancing first stamps every record one frame
    // into the past. `readDir` is the simulation's own clamp, run here so the
    // record predicted with is byte for byte the record the server applies.
    // ONE CALL PER FRAME: it stamps, sends, and returns the pose to draw, so
    // the draw below reuses `drawn` rather than advancing again.
    const drawn = paddle.advance({ dir: readDir(dir) }, dt);

    // RECORDED BEFORE ANY DRAWING, so a slow canvas cannot show up as a late
    // frame in the measurement. Everything below this line is presentation.
    const marker = view.get('marker');
    const own = selfPid ? view.get(selfPid) : undefined;
    const predicted = paddle.pose;
    const entities: [string, number, number][] = [];
    for (const [id, e] of view) entities.push([id, e.x, e.y]);
    frameBuf.push({
      t: now,
      tick: conn.tick.value,
      anchored: conn.tick.anchored,
      desired: conn.desiredTick(),
      serverTime: lastServerTime,
      inst: lastInst,
      epoch,
      epochSnaps,
      x: marker ? marker.x : null,
      extrap: marker ? marker.extrapolated : null,
      ownX: own ? own.y : null,
      ownY: selfSide !== null ? drawn.y : null,
      predictedY: selfSide !== null ? predicted.y : null,
      errZ: selfSide !== null ? +(drawn.y - predicted.y).toFixed(3) : null,
      entities,
      stalled,
    });

    // The swap counters are lifetime totals with no callback behind them, so a
    // change is only visible by polling. Once per frame is free and turns three
    // numbers the harness would have to diff into one timestamped event.
    const s = conn.stats();
    if (
      s.relaySwaps !== lastSwaps.relaySwaps ||
      s.swapsAttempted !== lastSwaps.swapsAttempted ||
      s.swapsFailed !== lastSwaps.swapsFailed
    ) {
      lastSwaps = { relaySwaps: s.relaySwaps, swapsAttempted: s.swapsAttempted, swapsFailed: s.swapsFailed };
      record('swap', { ...lastSwaps });
    }

    const sx = canvas.width / FIELD_W;
    const sy = canvas.height / FIELD_H;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#fff';
    for (const [id, e] of view) {
      if (id === 'marker') {
        // Drawn modulo the field so it stays on screen; the value REPORTED
        // above is the raw unbounded one, because a wrap in the measurement
        // would be a discontinuity in the one signal that must have none.
        const mx = ((e.x % FIELD_W) + FIELD_W) % FIELD_W;
        ctx.fillStyle = '#3b6';
        ctx.fillRect(mx * sx - 1, canvas.height - 6, 2, 6);
      } else if (id === 'ball') {
        if (serveIn === 0) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(e.x * sx - 3, e.y * sy - 3, 6, 6);
        }
      } else if (id !== selfPid) {
        // REMOTE PADDLES COME FROM THE INTERPOLATOR, on the deliberate playback
        // delay, because nobody here is steering them and a delay is invisible
        // on an entity you do not control.
        ctx.fillStyle = '#888';
        ctx.fillRect(e.x * sx - 2, e.y * sy - 12 * sy, 4, 24 * sy);
      }
    }

    // OUR OWN PADDLE COMES FROM THE PREDICTION, drawn between its last two
    // stamped ticks plus whatever is left of the last correction. No
    // interpolation delay and no round trip in it.
    if (selfSide !== null) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(drawn.x * sx - 2, drawn.y * sy - 12 * sy, 4, 24 * sy);
    }

    ctx.fillStyle = '#aaa';
    ctx.font = '12px monospace';
    ctx.fillText(`${conn.status}  players ${rosterSize}  tick ${conn.tick.value}`, 8, 16);
    if (winner) ctx.fillText('match point', canvas.width / 2 - 36, canvas.height / 2);
    ctx.fillText([...scores.values()].join(' '), 8, canvas.height - 8);

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  // ---- the harness surface ------------------------------------------------

  const api: BenchApi = {
    status: () => conn.status,
    stats: () => ({
      ...conn.stats(),
      // Not on `ConnectionStats` because the library has no concept of either:
      // how many entities this client currently believes are in the room, and
      // how many records the page had to drop because the harness stopped
      // draining. The second is what tells a gap in the frames apart from a
      // gap in the render.
      rosterSize,
      framesDropped: frameBuf.dropped,
      eventsDropped: eventBuf.dropped,
      // See `BenchSocket`: the count of round-trip probes that reached the wire,
      // which is what a throttled hidden tab stops producing.
      pingsSent,
      room,
      terminal: terminalText,
      hidden: document.hidden,
      markerSpeed: MARKER_SPEED,
      tickHz: TICK_HZ,
    }),
    frames: () => frameBuf.drain(),
    events: () => eventBuf.drain(),
    pid: () => selfPid,
  };
  window.__bench = api;

  void conn.start();

  // Every client returns its teardown. A connection that outlives its canvas
  // keeps a socket open, keeps the room's player count wrong, and on a metered
  // deployment keeps billing.
  return () => {
    cancelAnimationFrame(raf);
    if (!opts.bot) {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    }
    if (window.__bench === api) delete window.__bench;
    conn.stop();
  };
}
