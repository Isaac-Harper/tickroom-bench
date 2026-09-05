import { createRelayRoute } from 'tickroom/adapters/vercel';

import { BASE, MAX_DURATION_S, MAX_PLAYERS, NAMESPACE, isValidBase } from '@/lib/rooms';
import { SESSION_SECRET } from '@/lib/secret';
import { TICKER_URL } from '@/lib/tickerUrl';
import { upgradeWebSocket } from '@/lib/upgradeWebSocket';
import { decodeJsonInput } from '@/lib/wire';

/**
 * Same rule as the ticker route: Next only sees these as literal exports of the
 * route module itself, and 800 is the Pro plan's hard cap (300 was the first
 * configuration, also the Hobby cap). The adapter
 * derives `lifetimeMs` as `maxDurationS * 1000 - RELAY_EXIT_MARGIN_MS`, so this
 * announces `relay-expiring` at 785 seconds and closes at 790 (285 and 290 at the
 * first configuration of 300), and the client
 * swaps to a replacement socket in between. Without that the socket would
 * simply be dropped at every cap.
 */
export const runtime = 'nodejs';
export const maxDuration = 800;

/**
 * MODULE SCOPE, so these live as long as this function instance does and every
 * socket it serves shares one flush.
 *
 * WIRING `onBadInput` MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS APP. A
 * decoder that throws is caught and dropped in silence by design (that path
 * runs at the client's own rate, so a log line per bad frame is an amplifier
 * handed to whoever is sending them), which means the only symptom of a broken
 * decoder is one player whose inputs stop while the room, the roster, the
 * snapshots and every other player stay perfectly healthy. Nothing closes,
 * nothing warns. On a bench that reads as a client the server starved, which is
 * a conclusion about the platform drawn from a bug in this file. So it is
 * counted in process and flushed on a cadence the client cannot drive.
 * `onRateDrop` is its twin for the frames the token bucket rejects before the
 * decoder ever runs, and `onLivenessDrop` for the sockets the relay terminates
 * as silent, which is the number the hidden-tab run is about.
 */
let badInputs = 0;
let rateDrops = 0;
let livenessDrops = 0;
setInterval(() => {
  if (badInputs || rateDrops || livenessDrops) {
    console.log(JSON.stringify({ kind: 'relay.input-refused', badInputs, rateDrops, livenessDrops }));
  }
  badInputs = 0;
  rateDrops = 0;
  livenessDrops = 0;
}, 10_000);

/**
 * One relay invocation per socket, and it is a dumb pipe on purpose: it decodes
 * a frame, publishes it on the room's input channel, and forwards whatever the
 * ticker publishes back down the socket. No simulation lives here, which is
 * precisely what lets a function that can hold ONE socket be part of a room
 * shared by everyone else.
 *
 * `upgradeWebSocket` is INJECTED, not imported by the library. tickroom takes
 * no hard dependency on any host, so the identical relay logic runs behind a
 * plain `ws` server on a VM. `lib/upgradeWebSocket.ts` is the only place this
 * app names the platform.
 */
export const GET = createRelayRoute({
  secret: SESSION_SECRET,
  isValidBase,
  fallbackRoom: BASE,
  // Shared Redis. The relay namespaces both the room keys AND the per-subject
  // connection set (`bench:conns:<sub>`), so neither can collide with the other
  // applications on this instance. See lib/rooms.ts.
  namespace: NAMESPACE,
  // The admission gate, kept equal to the simulation's own `SEATS` so a refused
  // joiner is refused for the same reason at both layers.
  maxPlayers: MAX_PLAYERS,
  // Relative, so it resolves against this request's own origin: right here,
  // because the ticker route lives in this same deployment. See lib/tickerUrl.ts
  // for the one case where it is not the bare path.
  tickerUrl: TICKER_URL,
  decodeInput: decodeJsonInput,
  maxDurationS: MAX_DURATION_S,
  // The display name rides the socket URL and becomes join metadata, which is
  // what the roster frame carries. It is bounded here rather than trusted:
  // this value reaches every other socket in the room on the roster channel.
  joinMeta: (_claims, url) => ({ name: (url.searchParams.get('n') ?? '').slice(0, 24) }),
  onBadInput: () => void (badInputs += 1),
  onRateDrop: () => void (rateDrops += 1),
  onLivenessDrop: () => void (livenessDrops += 1),
  // See the ticker route: `relay.room-normalised` is the only symptom of a
  // client being silently attached to a room its session did not name.
  log: (ev) => console.log(JSON.stringify(ev)),
  upgradeWebSocket,
});
