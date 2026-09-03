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
times, counting every reconcile past the first (which only snaps onto the
spawn pose) whose error is above 0.25 units, below which is quantisation
noise from the snapshot's y rounded to a tenth, plus every direction flip in
the DRAWN paddle after a release. A healthy deployment prints zero for both. It exists because `run.mjs` and `hidden-tab.mjs` both measure the
marker, and the marker is server-driven: constant velocity, untouched by any
key, so it can never show a disagreement in the input timeline. Steady motion
hides a one-tick error completely; only a change in the input reveals it, as a
correction landing at exactly the moment the input changes. A player's own
paddle is the entity actually driven by a key, predicted locally and
reconciled against every snapshot, so this script measures that entity
directly instead of standing in for it with the marker.

**It grades two things, and prints a PASS or FAIL line for each.** The first
is reconciliation: zero nonzero reconciles and zero post-release flips, which
is the input timeline agreeing at both ends. The second is motion regularity
while the key is held, and it exists because the first can pass perfectly on
a paddle that visibly stutters. A locally predicted entity advances only when
a tick is stamped, once per 50ms at 20Hz, while the page draws at 60fps, so
drawn raw it holds still for two frames in three and then jumps a whole tick
of travel. Over the middle of each hold (from 120ms after the press to 20ms
before the release) the script counts the share of frames in which the drawn
paddle did not move at all and the largest single-frame step, and passes when
fewer than one frame in ten is still and the largest step is under 3 units.
Smooth reads as near zero still frames and a step near the per-frame travel,
which is 1.5 units at 90 units per second and 60fps; stepping reads as about
two thirds still and a step of a whole tick, 4.5 units. The script exits 1
when either grade fails.

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
were taken with one more tick of arrival slack than the fixed ticker allows
at the same headroom, and the next entry has what that cost and what was done
about it.

### The stepping paddle and the starve rate, 2026-09-03

Two things followed the timeline fix, one seen by a player and one seen only
by the room's counters, and both were measured on this deployment before
anything was changed.

**The paddle stopped rubber banding and started stepping.** With the
reconciliation now exact, the player reported the paddle moving in visible
steps under a held key. The cause was not a defect in the fix but the defect
the fix had been hiding: the locally predicted paddle advances only when a
tick is stamped, once per 50ms at 20Hz, while the page draws at 60fps, so it
held still for two frames in three and then jumped a whole tick of travel.
The extended `paddle.mjs` grade measured it on the deployment before the
change: 48 held frames, 67% with no motion, largest single-frame step 4.50
units, which is exactly one tick at 90 units per second. Remote paddles and
the marker never show this, because the library's interpolator draws them
between snapshots; the owned entity is the one thing on the page with no
interpolator in front of it, and the marker-based harnesses could never have
seen it.

The fix is in two places. The library's `ClientTickView` gained `fraction`,
how far the counter is into the next tick (0 inclusive to 1 exclusive, from
the accumulator the counter already kept; 0 before the first anchor and after
any anchor), pinned by five `clientTick` tests that were mutation-checked.
This page and the library's pong example then keep the prediction one stamped
tick behind as `prevPredictedY` and draw
`prev + (curr - prev) * conn.tick.fraction` plus the `ErrorOffset`, shifting
`prev` by the same delta on every reconcile so a correction is carried once,
by the offset, and not glided a second time by the interpolation. The price
is one tick of visual delay on the owned entity, at most 50ms at 20Hz, on top
of a prediction that has no round trip in it; the return is motion at the
frame rate. After vendoring and redeploying, the same check on the same
deployment ran 8 input changes with zero corrections, a lead of 4 to 5 ticks
over the snapshot, and while held: 95 frames, 0% with no motion, largest
single-frame step 1.60 units against a per-frame travel of 1.5 at 90 units
per second and 60fps. Both grades PASS. The library's suite stood at 1042
tests across 38 files with the five new cases in.

**The starve rate went up, because the off-by-one had been a free tick of
slack.** The old consume timing applied an input one tick after the one it
named, which meant every input had one more tick to arrive than the client's
lead was sized for. Taking that away made the lead honest and the buffer one
tick shallower at the same headroom. Measured with three clients for three
minutes at about 80ms round trip, the fixed library at the old 100ms default
headroom reported `starves` 31 in 3593 ticks, about ten a minute for the
room, against about three a minute before the fix (33 in 11972 ticks over
run B's ten minutes), with `lateInputs` 16 and one tick re-anchor per client.
Two responses were tried, each measured on its own three-minute run.

1. **Tightening the feedback loop's deadband from two ticks to one, so a
   buffer running one tick deep gets lifted: worse, and reverted.** Re-anchors
   per client per three minutes went from 1 to 4, 6 and 8, `starves` went from
   31 to 44, and `lateInputs` from 16 to 13. Every correction clears the
   client's stamped window, and with the band at one tick the loop hunted
   between depths of one and three instead of settling. The deadband equals
   the target by decision now, and the measurement is recorded in the
   library beside the loop and in its architecture document.
2. **Raising the default headroom, `DEFAULT_INPUT_LEAD_MS`, from 100 to
   150: kept.** One more tick of jitter headroom at 20Hz gives back the slack
   the off-by-one had been giving for free, at the same total latency the old
   timing had, with the input now landing on the tick it names. On that build
   the same three-minute run reported `starves` 8 in 3610 ticks and
   `lateInputs` 2, `refusedInputs` 0, `hostErrors` 0, tick rate 19.96 to
   20.98 Hz over 179 of 180 flushes; tick re-anchors 0, 1 and 1 per client
   (largest delta 3), zero reconnects, zero backward, zero-motion and blank
   frames, and a median round trip of 83 to 83.5ms. That is about three a
   minute, the rate the unfixed library had, with the reconciliation exact.

### The predicted entity's render seams, 2026-09-03

The hand-rolled prediction on this page, and the one in the library's own
pong example, is gone. Both now build a `PredictedEntity` off four options,
`conn`, `step`, `maxSpeed` and `initial`, and nothing else, and call
`advance` once a frame and `reconcile` once a snapshot; the four coupled
rules a consumer used to hand-write, stamp, predict, replay into an offset,
draw between tick states, live in the library now.

An adversarial review of the first version found three render seams, all in
the half that draws the owned entity between its stamped ticks rather than in
the reconciliation, which was already exact. A forward re-anchor, the
`inputLead` loop's own answer to a starving buffer, teleported the draw: the
counter jumped several ticks in one frame and a render that followed the
counter followed it there, with no glide and nothing counting it. A backward
re-anchor of one tick, the ordinary epoch anchor on a link under 50ms, walked
the draw backward by a whole tick of travel. And a run of corrections each
inside the snap distance but together past it was trimmed at the clamp in
silence, so an offset could be capped with no record that it had happened.

The fix redesigns the render half around a playhead that slews through the
prediction's own pose history instead of following the tick counter
directly: it moves at up to ten percent over real time, never runs backward,
and only jumps when the target is more than four ticks away, which is
counted as a snap. The snap gate moved too, onto the offset an absorb would
actually produce rather than the size of one correction, which is what makes
the silent trim above impossible now. A `NaN` or any other non-finite pose is
refused and counted rather than absorbed, and the timestep is read off
`conn.tick.tickMs` instead of a duplicated option a host could get wrong
against it.

`bench/paddle.mjs` against the deployed rewrite: 8 moves, 0 corrections above
0.25 units (the snapshot rounds y to a tenth, so the bot's analog input shows
rounding noise below that, which the check now ignores), 0 direction flips,
0% of held frames motionless, largest single-frame step 1.59 units, lead 4
to 11 ticks over the snapshot. The library's own suite: 1085 tests across 39
files on a quiet machine; nine wall-clock cases fail under heavy load and
pass alone, documented in the library itself rather than here.

Also folded into this deployment: the relay's inbound flood guard defaults
moved from capacity 40, refill 25 per second, to capacity 100, refill 70 per
second, so a stamped client at 30 or 60Hz, one packet per tick, is no longer
at risk of its own well-behaved traffic being rate-dropped. Every run above
was at this room's 20Hz, well under either default, so none of the numbers
above are affected.

A second and third review round followed the first, on the harder edges of
the same redesign: what the playhead does when a re-anchor undoes ticks it
had already predicted, and what a stalled render loop rather than a stalled
network does to the connection underneath it.

**A backward re-anchor past the one-tick slack made the prediction
double-step, on ticks the server was still holding.** The rewind landed one
tick short of the mark the server had actually reached, so on a -2 or -3 the
entity treated ticks the server had not dropped as gone, reconciling them a
second time when the real stamps arrived instead of trusting the records
already in flight for them. The prediction now rewinds to the stored pose at
the new mark rather than short of it, and the records beyond that mark are
re-stamped as the counter climbs back rather than replayed against a stale
count. The playhead pays the ticks the rewind cost the way a forward jump is
paid, by speculating ahead of the newest stored pose on whatever input the
current frame carries and slewing at nine tenths of real time until the
target catches it up, bounded at four ticks deep. Measured in the library's
own harness: after a -2 the playhead held at exactly 0.900x for 80 frames
and then dropped to real time, after a -3 for 110 frames; before this fix,
holding the playhead to the history's end instead of drawing the speculation
produced a near-pause of 0.08x to 0.11x for 8 to 11 frames, on the one
entity the player steers, on every tolerance correction.

**A 100 to 300ms main-thread hitch, a garbage-collection pause or one heavy
frame, made the connection re-anchor as though the network had drifted, and
undo it about two seconds later.** The re-anchor decision compared the raw
tick counter against the incoming snapshot, and the counter only advances
inside `frame()`; a hitch that skipped frames left it sitting where the last
frame had put it while a snapshot landing inside the hitch read it as 2 to 5
ticks behind, so the tolerance path re-anchored forward to close the gap and
then, once the resume frame stamped the stall's own ticks on top of that,
re-anchored backward by the same amount two seconds later to undo it, with
every consumer's prediction eating both as real corrections. The connection
now projects the counter by the wall time elapsed since the last frame
before comparing it against a snapshot, so a stall is not drift: a 250ms
hitch and a 120ms hitch each produce zero re-anchors on the library's test
tree, and a genuine three-tick drift still fires exactly as before.

**A NaN or infinite frame delta used to poison the playhead for good,**
because `Math.max(0, NaN)` is `NaN` and every comparison against it downstream
reads false forever after. A non-finite `dt` is now no time at all: the
playhead and the glide hold still for that one frame, the stamps are
whatever the counter already shows, and the next finite frame picks back up
clean instead of carrying the poison forward.

**Two `PredictedEntity` instances on one connection were overwriting each
other's inputs,** because the ticker keeps exactly one playout buffer per
player: whichever entity's frame ran last on a given tick won the buffer and
the other drove blind against a record it never wrote. Construction now
throws, naming the rule, the moment a second entity is built on the same
connection. A player who steers more than one thing on the page carries all
of it in a single input record instead of splitting it across entities.

**A reconnect used to keep the old room's prediction and glide the entity
out of its stale pose into the new room's truth.** An epoch edge, `tick.anchored`
going false and back to true, now drops the entity's records, poses, mark
and playhead outright and unconfirms it, so the new room's first reconcile
is a counted snap onto its own truth rather than a roughly 450ms glide from
a room the entity is no longer in, or a replay of stale records against a
tick count that has already restarted.

The deployed check on the final build: `bench/paddle.mjs`, 8 moves, a lead of
4 to 5 ticks over the snapshot, 0 reconciles above 0.25 units, 0 direction
flips, 0% of held frames motionless, largest single-frame step 1.59 units,
both grades PASS. The library's own suite: 1101 tests across 39 files, green
on a quiet machine.

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
  paddle.mjs                one client, a held key: reconciliation and motion regularity
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
