// The browser half, and the instrument.
//
// This is `examples/pong/client.ts` from the library, wired exactly as the
// README's step 3 shows: tickHz matching the simulation, a plain
// `decodeSnapshot`, an interpolator the connection constructs and drives, the
// paddle predicted by the connection's own `predict` option running the
// simulation's own `stepPaddleY`, `onStallChange`, `onTickReanchor` as
// telemetry, and `onTerminal` with the documented bounded re-assign. Read the
// library's copy for why each of those is shaped the way it is; the reasoning
// is unchanged and is not repeated here.
//
// TWO OF THOSE USED TO BE THIS FILE'S OWN WORK AND ARE THE LIBRARY'S AT 1.0.0.
// The paddle was a hand-held `PredictedEntity` beside the connection, with the
// order of its `advance`, `reconcile` and `snapTo` calls left to this file; it
// is `predict: { step, maxSpeed, ownPose, wire }` on the connection now, with
// `conn.frame(now, input)` the one per-frame call and `frame().own` the pose to
// draw. And the server's playout depth used to ride this app's own snapshot as
// a per-paddle `inputLead` that `decodeSnapshot` lifted out; the library
// carries it on its own control frames now, so `PongSnapshot` is the plain
// shape `sim/pong.ts` publishes and nothing here touches the stamping lead.
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
  RoomConnection,
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
  paddles: { pid: string; side: 'left' | 'right'; y: number; score: number }[];
}

/** What one stamped record carries: the held direction, already clamped by `readDir`. Not a `DefaultInput` (`{ axes, buttons }`), which is why `predict.wire` below is `'json'`. */
interface PongInput {
  dir: number;
}

/** Must equal `pongRuntime.tickHz` and `TICK_HZ` in lib/rooms.ts. Stated once for the connection; the prediction it owns reads its timestep off the same counter. */
const TICK_HZ = 20;

/** Where a paddle sits for each side. The server owns the assignment; this is only where to draw it. */
const paddleX = (side: 'left' | 'right'): number => (side === 'left' ? 6 : FIELD_W - 6);

/** How many capacity bounces a client will follow before giving up. Bounded because the balancer and the ticker disagree for up to a stats TTL, so an unbounded loop is a client that never lands. */
const MAX_REASSIGNS = 3;

/** The bot's steering period, seconds. Slow enough that the paddle crosses the field rather than buzzing inside one clamp, which is what keeps a stamped input stream producing visible motion. */
const BOT_PERIOD_S = 7;

/**
 * MIRRORS `DEFAULT_INPUT_LEAD_MS` IN THE LIBRARY'S OWN `client/connection.ts`,
 * which is not exported: `RoomConnectionOptions.inputLeadMs` is optional
 * precisely so a host can leave the library to its own default, and this page
 * has no way to read that default back once it does. So the value the page
 * reports on `window.__bench.stats().inputLeadMs` when `?lead=` is absent is
 * this hand-kept copy, not a value read out of the connection. Bump it if the
 * library's own default ever moves.
 */
const DEFAULT_INPUT_LEAD_MS = 150;

export interface PongOptions {
  /** Room instance to join, e.g. `pong` or `pong~1`. Re-validated server side; this is a request, not an assertion. */
  room: string;
  /** Display name carried as join metadata onto the roster. */
  name: string;
  /** Steer automatically. An unattended tab must still stamp inputs; see note 1 in the module comment. */
  bot: boolean;
  /**
   * Input lead override, ms, from `?lead=`. Passed straight through as
   * `inputLeadMs`, so a sweep of the default headroom (100, 150, 200) can be
   * run against a real deployment without rebuilding the library. Validated by
   * the caller (`app/page.tsx`, a finite number 0 to 1000) before it reaches
   * here; `undefined` leaves the connection on its own default.
   */
  leadMs?: number | undefined;
}

export function startPong(canvas: HTMLCanvasElement, opts: PongOptions): () => void {
  const ctx = canvas.getContext('2d')!;

  // ---- the measurement buffers -------------------------------------------

  const frameBuf = new RingBuffer<BenchFrame>();
  const eventBuf = new RingBuffer<BenchEvent>();
  /**
   * Snapshot arrivals as the SOCKET saw them, not as the render loop inferred
   * them. See `arrivals()` in `game/bench.ts` for why the distinction is the
   * last one the arrival tail needed, and `BenchSocket` below for where the
   * timestamp is taken.
   *
   * BOTH SOCKETS OF A WARM SWAP PUSH INTO THIS ONE RING, because nothing
   * outside the connection can say which of the two it currently considers
   * live. So a swap contributes the replacement's own first frames to the
   * series, which is honest (they arrived) and is placed in time by the `swap`
   * event sitting beside them.
   */
  const arrivalBuf = new RingBuffer<number>();
  /** `performance.now()` at start, so every `t` in a run is relative to the same origin as the harness's own samples. */
  const record = (kind: BenchEvent['kind'], detail: Record<string, unknown>): void => {
    eventBuf.push({ t: performance.now(), kind, detail });
  };

  /**
   * THE ONE RECORD THIS PAGE CANNOT FILL IN WHERE IT WRITES IT, and the whole
   * of what the fold of `PredictedEntity` into the connection cost the
   * instrument.
   *
   * A `reconcile` event is written in `onSnapshot`, because that is the only
   * callback a snapshot reaches. The connection reconciles the prediction
   * AFTER `onSnapshot` returns (deliberately: the replay runs the host's `step`
   * from the server's pose, so a step reading context the host refreshes from
   * this snapshot has to see this snapshot's context and not the previous
   * one's), so `conn.ownStats.lastError` inside the callback is still the
   * PREVIOUS snapshot's error. The event is therefore parked here without its
   * `error` and settled from the first thing that runs afterwards, which is
   * either the next frame or the next snapshot: the reconcile has certainly
   * happened by then, and `lastError` is a value the reconcile writes and
   * nothing else touches.
   *
   * `bench/paddle.mjs` reads `detail.error` on every reconcile past the first,
   * so what this buys is one frame of lag, roughly 16ms, between the event's
   * own `t` and the number attached to it. The only event that can be drained
   * unsettled is the very last one before a read, and `Math.abs(undefined)` is
   * NaN, which fails every comparison the script makes rather than reading as a
   * zero error it did not measure.
   *
   * A SECOND SNAPSHOT LANDING BEFORE ANY FRAME leaves the older event
   * unsettled, because `lastError` is a single value and by then it describes
   * the newer reconcile. At 20Hz snapshots against a 60fps loop that is the
   * hidden-tab case rather than the ordinary one, and attributing the newer
   * error to the newer event is the only honest reading available.
   */
  let pendingReconcile: BenchEvent | null = null;
  const settleReconcile = (): void => {
    if (pendingReconcile === null) return;
    pendingReconcile.detail.error = +(conn.ownStats?.lastError ?? 0).toFixed(3);
    pendingReconcile = null;
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
   * replacement, so a subclass sees every frame sent, every frame received and
   * every close. That is the only way this page can report any of the three:
   * the library consumes `ping`, `pong` and `relay-expiring` internally as
   * transport bookkeeping, it turns a close into a status change and a
   * reconnect with the CODE dropped, and it hands a snapshot to `onSnapshot`
   * only after decoding it on a render loop that may not be running. A run
   * that reconnected once and cannot say whether that was 1006, a 1001 from a
   * function exiting, or a policy close has measured that something happened
   * and nothing about what.
   *
   * The ping match is on the library's own `PING_FRAME_PREFIX` rather than a
   * string retyped here, because a prefix that drifted would silently count
   * zero.
   */
  class BenchSocket extends WebSocket {
    constructor(url: string) {
      super(url);
      // ARRIVAL TIME, TAKEN BEFORE THE LIBRARY EVER SEES THE MESSAGE. The
      // connection attaches its reader by assigning `socket.onmessage` after
      // `new WebSocketImpl(url)` has returned, and a property handler takes its
      // place in the listener order from the moment it is first assigned, so a
      // listener registered here in the constructor cannot help but run first.
      // The timestamp is the first statement of the handler for the same
      // reason: anything above it would be charged to the arrival.
      //
      // TEXT FRAMES ARE DELIBERATELY NOT RECORDED, and that is not a
      // simplification. The library's own transport frames share this socket:
      // a `pong` every 2000ms, `relay-expiring`, the roster seed, and since
      // 1.0.0 the `input-lead` frame that carries the server's playout depth
      // about once a second. Every one of them is JSON text, which is what
      // keeps this ring a series of SNAPSHOT arrivals for free. A pong
      // landing inside a 400ms snapshot hole would split it into two 200ms
      // gaps and report a healthy socket, which is the exact wrong answer for
      // the one question this ring exists to settle. Snapshots are the binary
      // frames (`binaryType` is `arraybuffer`), so the test is the same one the
      // library's own `handleMessage` splits on.
      this.addEventListener('message', (ev) => {
        const at = performance.now();
        if (typeof ev.data !== 'string') arrivalBuf.push(at);
      });
      this.addEventListener('close', (ev) => {
        record('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      });
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === 'string' && data.startsWith(PING_FRAME_PREFIX)) pingsSent += 1;
      super.send(data);
    }
  }

  /** What actually reaches the connection: the override if one was given, else the library's own default (mirrored above, since the library does not hand it back). Reported on `stats()` as `inputLeadMs` rather than recomputed there, so the two can never disagree. */
  const inputLeadMs = opts.leadMs ?? DEFAULT_INPUT_LEAD_MS;

  const conn = new RoomConnection<PongSnapshot, string, PongInput>({
    WebSocketImpl: BenchSocket,
    // Required rather than defaulted, because a client silently running on the
    // wrong basis skews the tick counter, the server-tick estimate and the
    // underrun threshold at once.
    tickHz: TICK_HZ,
    // Left to the library's own default unless `?lead=` asked for a specific
    // one; see `DEFAULT_INPUT_LEAD_MS` above for why the default is a mirrored
    // constant rather than an omitted option read back from the connection.
    inputLeadMs: opts.leadMs,

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

    // THE HOST'S DECODER AND NOTHING ELSE. It used to lift this pid's own
    // playout depth out of the per-paddle field and hand it back as
    // `inputLead`, which was the third of four host-owned steps in a feedback
    // loop the library now runs end to end on its own `depth` and `input-lead`
    // frames. `DecodedSnapshotLike` is `tick` and `serverTime` and nothing
    // else at 1.0.0.
    decodeSnapshot: (buf) => JSON.parse(new TextDecoder().decode(buf)) as PongSnapshot,

    // The connection owns the interpolator: it CONSTRUCTS one (`into` is
    // optional at 1.0.0, and this page pins no delay bounds, so the hand-held
    // `new SnapshotInterpolator()` on the line above is gone), pushes every
    // decoded snapshot in with the right two timestamps, and clears the buffer
    // on every epoch change. All this side has to say is which parts of a
    // snapshot MOVE. `conn.interpolator` is the handle either way, so nothing
    // is lost by letting it build its own.
    interpolate: {
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

    // ---- our own paddle, predicted locally --------------------------------
    //
    // THE WHOLE OF THE STAMPED PATH'S CLIENT HALF, OWNED BY THE CONNECTION.
    // Once per frame it stamps a record for every tick the counter crossed
    // (never per frame, never per keydown: the tick is the unit the server
    // applies input on), predicts each through `step`, sends the last six as
    // one frame, and returns the pose to draw as `frame().own`: the pose
    // history read at a render playhead that moves at real time one tick behind
    // the newest stamp, with what is left of the last correction added, so a
    // counter re-anchor is caught up over a second rather than drawn as a
    // lurch. Once per snapshot it replays from `ownPose` and re-seats, AFTER
    // `onSnapshot` has run. This was a `PredictedEntity` held beside the
    // connection with its three calls ordered by hand until 1.0.0.
    predict: {
      // THE SAME FUNCTION THE SIMULATION RUNS, on the same input, on the tick
      // the record names. The fourth argument is the tick this call produces,
      // ignored here because a paddle collides with nothing that changes over
      // time.
      step: (pose, input, dt) => ({ x: pose.x, y: stepPaddleY(pose.y, input.dir, dt) }),
      // Bounds the correction glide to the paddle's own top speed and sets the
      // snap distance at half a second of travel.
      maxSpeed: PADDLE_SPEED,
      initial: { x: 0, y: FIELD_H / 2 },
      // OUR AUTHORITATIVE POSE, out of each snapshot. The connection replays
      // its stored records from here, adopts the result and glides the
      // difference away; the first confirmation snaps instead, which is also
      // what seats the paddle's x on the side the server assigned. `null` until
      // the roster names us, and nothing is reconciled until then.
      ownPose: (snap) => {
        const mine = snap.paddles.find((p) => p.pid === selfPid);
        return mine === undefined ? null : { x: paddleX(mine.side), y: mine.y };
      },
      // JSON ON THE WIRE, and it is load bearing for this rig rather than a
      // preference. `{ dir }` is not the default binary shape (a two-axis stick
      // and a button mask), so the binary wire would refuse the first input
      // with a `TypeError`; more to the point, `'json'` is byte for byte the
      // 0.3.x frame, which is what keeps `lib/wire.ts`'s decoder, the
      // `onBadInput` count taken off it, and every stamped-input number in the
      // Results table measuring the same contract they measured before.
      wire: 'json',
    },

    onSnapshot: (snap) => {
      // The PREVIOUS snapshot's reconcile has certainly run by now, so settle
      // its event before this one's is written. See `pendingReconcile`.
      settleReconcile();
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

      // NOTHING RECONCILES HERE ANY MORE, and nothing keeps the side either.
      // The connection does both, from `predict.ownPose` above, the moment this
      // callback returns: the first confirmation seats the paddle's x on the
      // side the server chose and every frame after it draws from
      // `frame().own`. All that is left on this side is the diagnostic.
      const mine = snap.paddles.find((p) => p.pid === selfPid);
      if (!mine) return;
      // DIAGNOSTIC. The tick the snapshot named, the tick the counter had
      // stamped to, the server's own y, and the error the replay leaves: an
      // error nonzero anywhere but the first confirmation means the two ends
      // disagreed about the input timeline, which `bench/paddle.mjs` provokes
      // on purpose by changing the input mid-run. The error is the one field
      // that cannot be filled in here, because the reconcile that produces it
      // has not run yet; see `pendingReconcile` for how it is attached and what
      // that costs.
      pendingReconcile = {
        t: performance.now(),
        kind: 'reconcile',
        detail: { snapTick: snap.tick, tick: conn.tick.value, serverY: +mine.y.toFixed(3) },
      };
      eventBuf.push(pendingReconcile);
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
    // BEFORE `frame()`, unlike the two calls this replaced. The input is an
    // ARGUMENT to the per-frame call now, so the direction has to be current
    // when it is made; the counter it stamps against is advanced inside that
    // same call, which is the ordering the old `advance`-after-`frame()` rule
    // existed to keep by hand.
    if (opts.bot) dir = botDir(now);
    // The reconcile the previous snapshot triggered has run by now, so its
    // event can be given its error. See `pendingReconcile`.
    settleReconcile();
    // THE ONE PER-FRAME CALL. It advances the tick counter inputs are stamped
    // against, polls the stall detector, samples the interpolator, and THEN
    // stamps, predicts and sends this frame's ticks with the input, all from
    // one delta the connection measures for itself. `readDir` is the
    // simulation's own clamp, run here so the record predicted with is byte for
    // byte the record the server applies. `own` is the pose to DRAW, and it is
    // `null` until the first authoritative pose has been reconciled.
    const { entities: view, own: drawn, stalled } = conn.frame(now, { dir: readDir(dir) });

    // RECORDED BEFORE ANY DRAWING, so a slow canvas cannot show up as a late
    // frame in the measurement. Everything below this line is presentation.
    const marker = view.get('marker');
    const own = selfPid ? view.get(selfPid) : undefined;
    // The RAW prediction, the pose after the last stamped tick, with no
    // playhead and no glide in it. `frame().own` is the same prediction as it
    // is drawn, so the difference between the two is exactly what the draw
    // adds.
    const predicted = conn.own;
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
      ownY: drawn ? drawn.y : null,
      predictedY: predicted ? predicted.y : null,
      errZ: drawn && predicted ? +(drawn.y - predicted.y).toFixed(3) : null,
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
    // interpolation delay and no round trip in it. `null` until the server has
    // confirmed we have a paddle, so there is nothing of ours to draw yet.
    if (drawn !== null) {
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
      arrivalsDropped: arrivalBuf.dropped,
      // See `BenchSocket`: the count of round-trip probes that reached the wire,
      // which is what a throttled hidden tab stops producing.
      pingsSent,
      room,
      terminal: terminalText,
      hidden: document.hidden,
      markerSpeed: MARKER_SPEED,
      tickHz: TICK_HZ,
      // See `inputLeadMs` above: the override if `?lead=` supplied one, else
      // the mirrored copy of the library's own default. This is what actually
      // reached `RoomConnection`, not a recomputation of it.
      inputLeadMs,
    }),
    frames: () => frameBuf.drain(),
    events: () => eventBuf.drain(),
    arrivals: () => arrivalBuf.drain(),
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
