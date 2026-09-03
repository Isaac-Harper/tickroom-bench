# tickroom-bench

A single [tickroom](https://github.com/Isaac-Harper/tickroom) room on a real
Vercel deployment, instrumented so a robot can measure what a browser actually
renders.

**This exists because, until the runs written up under Results below, every
platform claim tickroom made was measured on loopback.** The library's own smoothness harness runs a `ws` server in the
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

Three harnesses, all driving real Chromium through Playwright. A real browser
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

**A third script, `bench/paddle.mjs`, measures something neither of the other
two can see.**

```bash
node bench/paddle.mjs --url https://tickroom-bench.vercel.app [--room pong~6] [--moves 8] [--hold 350]
```

It holds a direction key down, releases it, waits, and repeats that several
times, counting every reconcile whose error is not zero and every direction
flip in the DRAWN paddle after a release. A healthy deployment prints zero for
both, and the script exits 1 on any nonzero reconcile or any post-release
flip. It exists because `run.mjs` and `hidden-tab.mjs` both measure the
marker, and the marker is server-driven: constant velocity, untouched by any
key, so it can never show a disagreement in the input timeline. Steady motion
hides a one-tick error completely; only a change in the input reveals it, as a
correction landing at exactly the moment the input changes. A player's own
paddle is the entity actually driven by a key, predicted locally and
reconciled against every snapshot, so this script measures that entity
directly instead of standing in for it with the marker.

## Results

Measured on **2026-09-03 (UTC)** against `https://tickroom-bench.vercel.app`:
Vercel project `tickroom-bench` in a personal org on the **Hobby** plan, Next.js
App Router, **Fluid compute**, Node 24, `maxDuration = 300` and
`maxDurationS: 300` on both long-lived routes, namespace `bench`, base id
`pong`. Redis is a shared **Upstash** database over TLS (`rediss://`), about 80
to 87ms round trip from the laptop. The library is `tickroom` 0.2.0 from
`vendor/`. Clients are headless Chromium driven by Playwright at 60fps with
`?bot=1`, except run C, which is a real windowed browser process. Every number
below comes out of a file in `bench/out/`, named under its run.

### Run A: three clients, twelve minutes, room `pong` (03:56 to 04:08)

`bench/out/2026-09-03T03-56-43-162Z.json`

| client | frames | backward | zero-motion | blank | peak u/s | mean u/s | max snapshot gap | max serverTime gap | reconnects | swaps ok/att/failed | re-anchors (max ticks) | stalls | terminals | rtt min/median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bot0 | 43,271 | **0** | 23 | **0** | 578 | 100.03 | 433ms | 8 ticks | 1 | **2/2/0** | 3 (3) | 0 | 0 | 78/82ms |
| bot1 | 43,255 | **0** | 0 | **0** | 115 | 100 | 184ms | 3 ticks | 0 | **2/2/0** | 1 (3) | 0 | 0 | 78/83ms |
| bot2 | 43,229 | **0** | 14 | **0** | 1395 | 100 | 433ms | 5 ticks | 0 | **2/2/0** | 1 (3) | 0 | 0 | 78/84ms |

The room itself, over 709 of 720 stats flushes: `starves` 43, `lateInputs` 23,
`refusedInputs` 0, `hostErrors` 0, `publishSkipped` 0, `publishFails` 0,
`renewFails` 0, 14,367 publishes, tick rate 19.84 to 21.55Hz, 6.2MB published
and 19.1MB delivered, **peak 8 Redis connections**.

Two ticker handoffs happened. The Vercel log shows successor invocations at
03:59:54 and 04:04:21, both `ticker.restore` from the checkpoint, and **only the
second was visible to the clients** as an instance-id change, because Fluid
compute ran the first standby in the same warm container as the incumbent and
the app's instance id was still at module scope. That is the bug the file map's
note on `app/api/ticker/route.ts` describes, and it was fixed to per invocation
before run B. The visible handoff cost an arrival gap of **66ms** on a 50ms grid
with a server grid gap of **50ms**, so no tick went missing. Two things this run
could not answer and run B could: bot0's single reconnect at 43s has no recorded
close code, and the two 433ms gaps could not be placed in time, because the page
recorded neither closes nor gap timestamps yet.

### Run B: three clients, ten minutes, room `pong` (04:32 to 04:42)

`bench/out/2026-09-03T04-32-28-532Z.json`, with per-invocation ticker ids,
socket close codes and gap timestamps all recorded.

| client | frames | backward | zero-motion | blank | peak u/s | mean u/s | max snapshot gap | max serverTime gap | reconnects | swaps ok/att/failed | re-anchors (max) | stalls | terminals | rtt min/median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bot0 | 36,068 | **0** | 9 | **0** | 190 | 100 | 367ms | 7 ticks | **0** | **2/2/0** | 0 (0) | 0 | 0 | 78/85ms |
| bot1 | 36,039 | **0** | 6 | **0** | 604 | 100 | 400ms | 4 ticks | **0** | **2/2/0** | 1 (3) | 0 | 0 | 81/85ms |
| bot2 | 36,010 | **0** | 6 | **0** | 138 | 100 | 283ms | 5 ticks | **0** | **2/2/0** | 1 (2) | 0 | 0 | 79/85ms |

Both ticker handoffs were seen by all three clients: at 270s (`ab3ee73b` to
`86959e25`) an arrival gap of 49.8 to 49.9ms, and at 538s (`86959e25` to
`65f07b5e`) one of 49.2 to 66.6ms, with a server grid gap of exactly **50ms**
both times. A planned handoff on a real platform therefore costs **no server
tick** and at most one extra frame of arrival jitter. Every client attempted two
relay warm swaps and completed both, none failed, and each retired socket closed
**1005 clean** about three seconds after adoption, at 288s and 573s.

Snapshot arrival gaps over 250ms, with their timestamps: bot0 one (367ms at
495s, nothing in the client's own events within 2s); bot1 two (250ms at 111s,
and 400ms at 570s, which is 0.7s **before** its second swap began, so on the old
relay just as it announced expiry); bot2 two (283ms at 143s and 265ms at 600s,
nothing near either).

The room: `starves` 33, `lateInputs` 26, `refusedInputs` 0, `hostErrors` 0,
`publishFails` 0, `renewFails` 0, 11,972 publishes, tick rate 19.96 to 21.01Hz,
5.1MB published and 15.2MB delivered, peak players 3, **peak 8 Redis
connections**. The deployment's own logs over the whole session carried only 200
and 101 responses: no 5xx, no function timeout, and no warn or error line.

### Run C: one genuinely hidden tab, 6.5 minutes, room `pong~2` (04:32 to 04:40)

`bench/out/hidden-2026-09-03T04-32-26-458Z.json`, `--chrome` mode: Chrome for
Testing 151 driven over CDP with Playwright's focus emulation disabled.

| | measured |
| --- | --- |
| tab state | `document.hidden` true, `visibilityState` hidden, **1 frame rendered** in 6.5 minutes |
| client pings | 15 per 30s for the first minute (the 2s cadence), then **about one a minute** from the second minute onward; 46 in total |
| socket | open the whole time, **0 reconnects**, still in the roster on return |
| crossed while hidden | 1 relay warm swap, attempted and succeeded (old socket closed 1005), and 1 ticker handoff |
| terminals | none |
| recovery on show | first rendered frame at **1.05s**, drawn in the roster again at 1.05s |
| tick re-anchors | 200, max delta 43 ticks |
| liveness | at one ping a minute the **90s** default held; the old 45s default would have reaped this socket |

Chromium throttled the ping interval far earlier than the five minutes the
library's docs assumed. The re-anchors are not a fault: `frame()` never runs
while the tab is dark, so every snapshot re-anchors the counter, and a host's
`onTickReanchor` fires about every 2s for as long as the tab stays hidden.

### Cold start and join latency

First snapshot after the page's first rendered frame:

| | measured | file |
| --- | --- | --- |
| the room's ticker had to be spawned cold by the relay | **1016ms** | `bench/out/2026-09-03T03-55-24-909Z.json` |
| joining a room already running | **351, 533, 351ms** | `bench/out/2026-09-03T03-56-43-162Z.json` |
| joining a room already running, a later two-client smoke | **617, 534ms** | `bench/out/2026-09-03T04-29-08-082Z.json` |

Each figure is a mint, an upgrade and a first snapshot at about 80ms round trip.

### What the runs do not prove

**The 250 to 433ms band is the platform's pub/sub tail, and it is unattributed.**
On this path (a Vercel function, to Upstash over TLS, to another Vercel
function, to a browser 80ms away) arrival gaps of 150 to 250ms land about once a
minute per client and gaps of 250 to 433ms about once per five client-minutes,
with nothing in the library's own events near most of them. The interpolator
absorbs the first band outright; the second shows as 6 to 23 motionless frames
and then a catch-up peaking at 600 to 1400 u/s on a 100 u/s marker, which is a
visible hitch of about a third of a second a few times an hour per client.
Across all 73 client-minutes: zero backward steps, zero blank frames, mean speed
exactly 100. The library's loopback harness never sees a gap above 149ms, so the
band belongs to the network path rather than to tickroom's scheduling. A host's
lever is the interpolation delay floor, trading roughly 200ms of remote-entity
latency for absorbing the second band; the measurements worth making next are a
same-region Redis and an in-function latency probe.

Three more caveats worth carrying with every number above:

- **Chrome for Testing, not Google Chrome.** `--chrome` prefers a real installed
  Google Chrome and falls back to Playwright's own Chromium build, and this
  machine has no Google Chrome, so run C is Chromium's official build running as
  a real windowed process. Safari and mobile are untested entirely.
- **The clients are a laptop about 80ms away**, on residential wifi, not another
  machine in the deployment's region. Every client-side gap carries that round
  trip in it.
- **The Upstash database's region is unknown**, and it is a shared database
  rather than one provisioned for this bench. Nothing here separates a slow
  region from a slow provider.

### The input timeline off-by-one, 2026-09-03

Playing the deployment by hand surfaced it before any script did: press a
direction key and the paddle on screen ran slightly behind for a moment,
crept back to where it should have been, and then lurched again about 200ms
after the key came up. `bench/paddle.mjs` turned that into a deterministic
reproduction. Against the unpatched deployment, 4 moves produced 8 reconciles
with a nonzero error, every one of them exactly one tick of travel (4.5
units, at 90 units per second and a 20Hz tick), positive by 110 to 125ms
after each press and negative by 200 to 230ms after each release. Each
release also carried exactly one direction flip in the drawn paddle. Max
correction offset was 3.6 to 3.7 units, the client's lead over the snapshot
held at 3 to 4 ticks throughout, and window shortfalls stayed at zero, so the
error was not a starved input queue or a lead problem: it was the input's
effect landing on the wrong tick.

The cause lived in the library, not on this page. The ticker consumed the
input stamped for tick n just before the step that produced tick n+1, so an
input's effect first appeared one snapshot later than the client's own
prediction, and later than the shipped pong example, assumes. The fix, in
tickroom 0.2.0's ticker: the step that produces tick T now consumes the
inputs stamped T, documented on `RoomRuntime.currentTick` and pinned by two
ticker tests that change the input mid-run. After vendoring the fixed
tarball and redeploying, the same check on the same deployment ran 8 moves,
203 reconciles, 0 with a nonzero error, 0 direction flips, a max offset of
0.00, and a lead of 3 to 4 ticks: PASS.

Runs A and B above were measured with the off-by-one still present. Their
marker numbers are unaffected, because the marker is server-driven and never
touched by a key. Their `lateInputs` and `starves` counters are not: both
were taken with one more tick of arrival slack than the fixed library
allows, so a run repeated today would not reproduce them exactly.

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
