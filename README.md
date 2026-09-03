# tickroom-bench

A single [tickroom](https://github.com/Isaac-Harper/tickroom) room on a real
Vercel deployment, instrumented so a robot can measure what a browser actually
renders.

**This exists because every platform claim tickroom currently makes was measured
on loopback.** The library's own smoothness harness runs a `ws` server in the
test process, a Redis on 127.0.0.1, and a simulated one-way delay standing in
for a network. That measures the mechanism, which is the right thing for a test
suite to do, and it says nothing about the platform: no cold function start, no
real round trip, no Chromium, no `requestAnimationFrame` being throttled, no
serverless duration cap arriving on somebody else's schedule. This app plus
`bench/` runs the identical analysis where all of that is true.

It is a measurement rig, not a product. The room is public, there are no
accounts, and nothing is saved.

## Shape

```
browser  ──ws──►  /api/ws       one relay per socket, a dumb pipe with no
   ▲              (Node fn)     simulation in it
   │                 │  publishes decoded input on  bench:{room}:in
   │                 ▼  subscribes to snapshots on  bench:{room}:out
   │              REDIS pub/sub
   │                 ▲  subscribes to input
   │                 │  publishes a snapshot every tick
   └──snapshots──  /api/ticker  holds the room's lease, runs the RoomRuntime,
                  (Node fn)     checkpoints every second, spawns its successor
                                before the platform's duration cap kills it
```

`/api/session` mints the HMAC token the relay verifies for the whole life of a
socket. `/api/room` is the balancer: it answers which room instance a joiner
should land in, and it is here so the documented capacity re-assign recipe has
something to call rather than to spread bench clients around.

## The Hobby 300s arithmetic, which is the whole reason for the numbers below

The personal Vercel org is on the Hobby plan, where **300 seconds is the hard
cap** on a function's `maxDuration`. Both long-lived routes export that literal,
and both pass the same number to the library as `maxDurationS`. Everything else
follows by subtraction:

| | derived as | value |
| --- | --- | --- |
| ticker `maxRunMs` | `min(700s, 300s - TICKER_EXIT_MARGIN_MS 30s)` | **270s** |
| relay `lifetimeMs` | `300s - RELAY_EXIT_MARGIN_MS 10s` | **290s** |
| relay announces `relay-expiring` | `lifetimeMs - RELAY_EXPIRY_LEAD_MS 5s` | **285s** |

So the room hands off between ticker invocations every 270 seconds, and every
socket warm-swaps onto a fresh relay every 290 seconds. Those two events are the
only things a real deployment does that loopback never will, which is why **a
run shorter than about five minutes measures nothing interesting**: it never
crosses either one. Twelve minutes crosses roughly two of each.

The margins are not slack anyone chose to leave: the ticker's final checkpoint,
its lease release and its successor spawn all happen after `maxRunMs`, and the
relay's swap needs the client to open a replacement socket and receive a
snapshot on it before the old one closes. If the platform kills the function
before that lands, the room loses its last second of state and holds a lease
nobody released for the rest of the TTL, silently, once per cycle.

`maxDuration` and `maxDurationS` must be the same number and nothing at runtime
can check it: Next reads `maxDuration` out of the route file's source text at
build time, so it has to be a literal. `MAX_DURATION_S` in `lib/rooms.ts` is
what the literals are kept against, by hand.

## The marker, and why the analysis is measured on it

`sim/pong.ts` is tickroom's own `examples/pong/sim.ts` with one entity added: a
`marker` travelling at a constant **100 units per second**, never stopping,
never wrapping, and checkpointed so it survives a ticker handoff.

Everything else in a pong room is a bad ruler. The ball bounces, so a backward
rendered step is correct rather than a stutter. A paddle clamps at the field
edge and stops, so a zero-motion frame is correct too. The library's loopback
harness measures a `bot` at a constant 100 u/s for exactly that reason: against
a constant velocity, **every** deviation a client renders belongs to the network
path and to nothing else. A backward step is a rewind, a zero-motion frame is a
stall, and a peak above 100 is jitter being replayed as motion.

Same entity, same speed, so a number off this deployment can be read directly
against the number the library's README already publishes.

## Deploying

Vercel, Node runtime, no `vercel.json`. From this directory:

```bash
vercel --scope isaacs-projects-b02601f4        # first run: link, project name tickroom-bench
vercel env add REDIS_URL production            # a real TCP rediss:// URL
vercel env add SESSION_SECRET production       # any high-entropy string
vercel --prod --scope isaacs-projects-b02601f4
```

Environment variables:

- **`REDIS_URL`**, a real TCP connection (`rediss://...`). A REST-style Redis
  API cannot `SUBSCRIBE`, and the ticker-to-socket fan-out is pub/sub, so an
  HTTP Redis product cannot be the bus however good it is at ordinary commands.
- **`SESSION_SECRET`**, any high-entropy string. Required at build time as well
  as at runtime: `next build` runs with `NODE_ENV=production` and route modules
  are evaluated during the build, so tickroom's fail-closed `requireSecret`
  throws on a missing value. That is the guard working.
- **`VERCEL_AUTOMATION_BYPASS_SECRET`**, optional, and only when Deployment
  Protection is left on. See `lib/tickerUrl.ts`: Protection guards every request
  to the deployment including one function calling another, so it answers the
  relay's ticker spawn with an SSO redirect. The spawn is fire-and-forget with a
  catch, correctly, so nothing errors: a socket opens, joins, and sits in
  perfect silence with no ticker ever started, and `/api/ticker` simply never
  appears in the invocation log. That absence is the only symptom. **Turning
  Protection off is the better answer for this project**, because a bench should
  measure the public path.

`vendor/tickroom-0.2.0.tgz` is committed on purpose. The library repo is
private, so a git or registry dependency would not install on a build machine
with no credentials, and a committed tarball is the only form that resolves with
no auth at all. To pick up a library change: `npm pack` in the tickroom repo,
copy the tarball into `vendor/`, update the path in `package.json` if the
version moved, delete the stale tarball, and `npm install`.

## Running the harness

Two harnesses, both driving real Chromium through Playwright. A real browser
rather than a headless Node client because `frame()` is driven by
`requestAnimationFrame`, and rAF is what a browser throttles, what a hidden tab
stops entirely, and what a busy tab delays. The frame loop **is** the
measurement surface.

```bash
# the main run: three clients in one room for twelve minutes
node bench/run.mjs --url https://tickroom-bench.vercel.app \
  --clients 3 --minutes 12 --redis "$REDIS_URL"

# the hidden-tab run: one client backgrounded for 6.5 minutes, then brought back
node bench/hidden-tab.mjs --url https://tickroom-bench.vercel.app --minutes 6.5 --chrome
```

Both write a timestamped JSON to `bench/out/` and print a markdown summary to
stdout. `node bench/run.mjs --help` lists every flag.

**Per client**, `run.mjs` reports frames, backward steps, blank frames,
zero-motion frames, peak and mean rendered speed, the largest snapshot arrival
gap and the largest gap on the server's own grid in ticks, reconnects, relay
swaps (completed, attempted and failed), tick re-anchors with their largest
delta, stalls, terminals, and the round trip. It also lists every ticker handoff
the client saw and every resume step across an epoch boundary, which are the two
events the whole exercise is about.

**With `--redis`**, it also reports what the room itself said: starves, late
inputs, refused inputs, host errors, skipped publishes, bytes published and
delivered, peak players, the measured tick rate, and a `CLIENT LIST` count split
by how many of those connections are in subscribe mode. That last number is the
one that matters at scale: every relay socket holds its own subscriber, because
a connection in subscribe mode cannot run ordinary commands, so concurrent
connections is the first ceiling this architecture hits and not command count.

**Upstash does not report the split, and the run now says so instead of saying
zero.** A real Redis answers `CLIENT LIST` with `flags=`, `sub=`, `psub=` and
`ssub=` on every line; this deployment's database (Upstash 1.17.11 in front of
Redis 8.2.0) answers `id addr laddr db name lib-name lib-ver` and stops. So the
count matched nothing and the summary read `0 in subscribe mode` while a ticker
subscriber and one subscriber per relay socket were certainly live. The total is
real and agrees with `connected_clients`; the split prints as not reported.

Two things worth knowing about how it samples:

- **Every client gets its own browser context**, not another tab. Tabs in one
  context share a cookie jar, and the session route's device cookie is what the
  relay's per-subject socket cap counts against. Sharing it means every client
  after the first is refused with `conn-limit`, and the run measures the cap
  working rather than the room working.
- **The stats key is read every 500ms and deduped on the flush's own
  timestamp**, not every 5 seconds. `RoomStats`'s counter fields are
  read-and-zero: the ticker writes what happened in the last second and resets,
  so a 5 second poll would see one flush in five and under-report every counter
  by a factor of five while still looking plausible.

**`bench/hidden-tab.mjs` needs `--chrome`, and without it the run is worthless.**
Two separate things stop Playwright from ever backgrounding a tab, and only one
of them is a launch flag:

- **Three default flags.** Playwright launches Chromium with
  `--disable-background-timer-throttling`,
  `--disable-backgrounding-occluded-windows` and
  `--disable-renderer-backgrounding` so ordinary tests are not flaky. Those are
  precisely the behaviour being measured, so both modes remove them.
- **`Emulation.setFocusEmulationEnabled`, which is the one that actually bit.**
  Playwright sends it, enabled, to every main frame it attaches to, and the
  renderer then simulates a focused and active document forever: `document.hidden`
  stays false however the tab is occluded and `requestAnimationFrame` never
  stops. The 2026-09-03 run reported `hidden=false` and 1800 frames on every
  30 second sample of a "backgrounded" tab, because the tab was never
  backgrounded.

`connectOverCDP` with `noDefaults` is the only documented way off it, and it
applies only to pages in the browser's own default context, which a
Playwright-launched browser does not have. So `--chrome` starts a real browser
process (Google Chrome if it is installed, Playwright's own Chromium build
otherwise) with a throwaway profile under `bench/out/chrome-profile`, attaches
over CDP, opens both tabs in the context the browser already had, and quits that
process with `Browser.close` at the end. The throwaway profile is what makes it
a separate process: an already running browser is never touched.

The mode then **proves** the tab went dark before spending six and a half
minutes on the assumption. It reads `document.hidden` back after activating the
second tab, retries once through `Target.activateTarget`, and aborts with a
message rather than measuring a foreground tab. Measured on an M-series Mac:
`hidden` true, `visibilityState` hidden, and zero rAF callbacks in five seconds,
against 187 in the same five seconds without `noDefaults`.

The Playwright-launched mode is still the default and still runs; it says
loudly, in the log and in its own summary, that it measured nothing.

**The profile is deleted at the start of every `--chrome` run, and has to be.**
A kept one makes the second run of the day a different experiment: Chrome
restores the previous session's tabs, so the page the harness picks up is one of
those rather than the fresh `about:blank` the mode is written against, and the
client never mints. Measured: a fresh profile seated in fifteen seconds, and the
next two runs on the kept profile timed out waiting for a player id.

## Running locally

```bash
npm install
cp .env.example .env.local     # REDIS_URL and SESSION_SECRET
npm run dev
```

**Neither `next dev` nor `next start` can serve the WebSocket upgrade.**
`experimental_upgradeWebSocket` needs the Vercel runtime, so `/api/ws` closes
before the handshake and the room never plays locally: the page renders, the
balancer and the session mint work, the frame loop runs, `window.__bench` is
published, and the connection sits in the reconnect ladder until the stall
banner appears. That is expected, not a bug in this app. It means a local smoke
run exercises the page, the harness plumbing and the two HTTP routes, and
nothing downstream of the socket.

To exercise real multiplayer without deploying, run the library's own
`examples/node-server/server.ts`, which puts the identical relay, ticker and
admission logic behind a plain `ws` server on a long-lived host.

Gates:

```bash
npx tsc --noEmit
SESSION_SECRET=dummy npm run build
node bench/run.mjs --help
```

## File map

```
app/
  page.tsx                  the whole client: canvas, keys, bot, window.__bench
  layout.tsx, globals.css   chrome, one stylesheet
  api/session/route.ts      mints pid + handle + HMAC token, rate limited
  api/room/route.ts         createBalancerRoute, for the capacity re-assign path
  api/ticker/route.ts       createTickerRoute, maxDuration 300
  api/ws/route.ts           createRelayRoute, maxDuration 300
game/
  pong.ts                   the RoomConnection wiring and the measurement hook
  bench.ts                  the record shapes window.__bench exposes
lib/
  rooms.ts                  namespace, base, capacity, the 300s arithmetic
  secret.ts                 fail-closed SESSION_SECRET
  tickerUrl.ts              the Deployment Protection bypass, and why
  upgradeWebSocket.ts       the one platform seam
  wire.ts                   the JSON input decoder, and the Buffer fragmentation trap
  mintLimit.ts              in-process per-IP mint limit
sim/
  pong.ts                   the room, with the constant-velocity marker
bench/
  run.mjs                   N clients, M minutes, JSON plus a markdown summary
  hidden-tab.mjs            one client backgrounded, then brought back
  analyse.mjs               the library's own smoothness analysis, ported
  page.mjs                  what both harnesses need from a page, once
vendor/
  tickroom-0.2.0.tgz        the dependency itself
```

## What was changed from the library's example, and why

`sim/pong.ts` is `examples/pong/sim.ts` with four changes, all of them because
this is a measurement rig rather than a game. Each is documented at its site in
the file.

1. **`SEATS` is 20, not 2.** A populated room is the thing being measured:
   `bytesDelivered` is `bytesPublished * players`, the per-socket subscriber
   fan-out is what a managed Redis plan bills, and a two-seat table can show
   neither. It also lets every bench client sit in one room instead of being
   scattered across instances by the balancer. Sides alternate by arrival order,
   and a goal is scored by whoever on that side was nearest the ball.
2. **A win no longer parks the room.** The example latches `winner` and returns
   early from every subsequent tick, which is right for a game and fatal for an
   unattended twelve minute run: the ball stops and the room reads as a wall of
   zero-motion frames. Here a win is announced, held for three seconds, and then
   the scores reset and play resumes. The `win` event still fires once per
   match.
3. **The marker.** See above.
4. **The runtime is a factory taking an instance id**, which rides every
   snapshot as `inst`. A ticker handoff is otherwise invisible from a browser:
   the tick count continues, `serverTime` continues, the roster is unchanged,
   and a successor that restored its predecessor's checkpoint correctly looks
   exactly like a predecessor that never left. That is the claim being measured,
   so the client has to be able to see the seam in order to report that it saw
   nothing at the seam. The library's own loopback harness does the same thing.

   **The id is generated per INVOCATION, in `app/api/ticker/route.ts`'s `GET`,
   and it was module scope until it lied.** A ticker spawns its own successor,
   and Fluid compute lands that successor in the same warm container as the
   incumbent far more often than not: the module was already evaluated, so the
   successor re-used the incumbent's id and published the identical `inst`. A
   handoff across a warm container was then indistinguishable from no handoff at
   all. The 2026-09-03 run saw one of the two handoffs the platform log shows,
   because the 03:59:54 successor carried the same `71558b37` the 03:55:27
   incumbent had. `createTickerRoute` only validates its options and returns a
   closure, so the route is built inside the request too, and `buildId` stays the
   same string as `inst` so a client-side handoff still lines up with the stats
   flush the successor wrote.

`game/pong.ts` is `examples/pong/client.ts` wired exactly as the library
README's step 3 shows, plus a bot mode, the `window.__bench` hook, a room
chosen by query parameter, and a `WebSocketImpl` that counts.

That last one is `BenchSocket`, and it exists because two numbers a bench needs
are on the wrong side of the library's API and correctly so. **Outgoing round
trip probes**: the ping is on the connection's own 2000ms `setInterval`, a
`setInterval` is exactly what a browser throttles once a tab is backgrounded,
and `rttMs` cannot show it because a sample taken across a frozen render loop is
discarded before it reaches the window. So a socket that stayed open with a ping
count that stopped climbing is the hidden-tab failure, and nothing else reports
it. **The socket's close code**: the library turns a close into a status change
and a reconnect, and the code is gone by then, so a run that reconnected once
could say that it happened and nothing about why. `WebSocketImpl` is the
documented seam and the connection builds every socket through it, the warm
swap's replacement included. One wiring detail differs from the README on purpose:
the socket URL is built with `socketUrl` rather than by setting `path`, because
the default builder appends its own `?token=...` to whatever `path` holds and a
`path` carrying the display-name query would produce `/api/ws?n=x?token=...`
with no readable token at all.

`bench/analyse.mjs` is the library's `analyse()` copied rather than imported:
the library's tests are not published in its package, and a bench that could
only run from inside the library's checkout would not be measuring a deployment.
Its thresholds are the originals on purpose, so the numbers stay comparable.

## License

MIT. See `LICENSE`.
