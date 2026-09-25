# tickroom-bench

A single [tickroom](https://github.com/Isaac-Harper/tickroom) room on a real
Vercel deployment, instrumented so a robot can measure what a browser actually
renders.

**This exists because, until the runs written up in [RESULTS.md](RESULTS.md), every
platform claim tickroom made was measured on loopback.** The library's own smoothness harness runs a `ws` server in the
test process, a Redis on 127.0.0.1, and a simulated one-way delay standing in
for a network. That measures the mechanism, which is the right thing for a test
suite to do, and it says nothing about the platform: no cold function start, no
real round trip, no Chromium, no `requestAnimationFrame` being throttled, no
serverless duration cap arriving on somebody else's schedule. This app plus
`bench/` runs the identical analysis where all of that is true.

It is a measurement rig, not a product. The room is public, there are no
accounts, and nothing is saved.

## Results at a glance

Measured on Vercel Pro (Fluid compute, Node 24) with Upstash Redis in the same
region, on tickroom 0.3.x, from headless Chromium clients plus real Chrome and
Safari. Every run, table and caveat is in [RESULTS.md](RESULTS.md).

| | result |
| --- | --- |
| planned ticker handoff | **no server tick lost**; an arrival gap of 49 to 83ms on a 50ms grid |
| relay warm swap | every attempt succeeded, and each retired socket closed 1005 clean |
| reconnects, stalls, terminals | **0** in runs B and D (one unexplained reconnect in run A, before close codes were recorded) |
| rendered motion | zero blank frames and mean marker speed exactly 100 u/s everywhere; one backward step in 97,000 frames, on a CPU-starved container |
| cold start | first snapshot at **1016ms** when the ticker spawns cold, 350 to 620ms joining a running room |
| hidden tab | the socket survives 6.5 hidden minutes in Chrome and Safari and is back in the roster in about **1s** |
| discarded tab | revives as a fresh session in 0.8s, and the dead seat is dropped at once rather than waiting out liveness |
| the tail | 250 to 433ms arrival gaps about once per five client-minutes, attributed to the WebSocket path, **not Redis** (in-function p99 about 2ms) |
| input headroom | 150ms is the knee: 6.5x fewer starves than 100ms, and the library's default |

Not yet measured: a live run on tickroom 1.0.0, and mobile.

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

## The duration-cap arithmetic, which is the whole reason for the numbers below

The personal Vercel team is on the **Pro** plan, where **800 seconds is the hard
cap** on a function's `maxDuration`. The first runs here were configured at
**300** instead, which is the platform's own default and also the Hobby cap, and
that is what runs A to C below are measured at; the deployment runs at 800 now.
Both long-lived routes export the literal, and both pass the same number to the
library as `maxDurationS`. Everything else follows by subtraction:

| | derived as | at 800, today | at 300, runs A to C |
| --- | --- | --- | --- |
| ticker `maxRunMs` | `min(700s, maxDuration - TICKER_EXIT_MARGIN_MS 30s)` | **700s** | **270s** |
| relay `lifetimeMs` | `maxDuration - RELAY_EXIT_MARGIN_MS 10s` | **790s** | **290s** |
| relay announces `relay-expiring` | `lifetimeMs - RELAY_EXPIRY_LEAD_MS 5s` | **785s** | **285s** |

So the room hands off between ticker invocations every 700 seconds, and every
socket warm-swaps onto a fresh relay every 790 seconds; at 300 those periods
were 270 and 290. Those two events are the only things a real deployment does
that loopback never will, which is why **a run has to be long enough to cross
them or it measures nothing interesting**: about five minutes at 300, about
fourteen at 800. Twelve minutes crossed roughly two of each at 300, and 27
minutes crosses two of each at 800.

The 700s ceiling on the ticker is the library's own `MAX_TICKER_MS` rather than
the platform's, so raising `maxDuration` past 730 buys relay lifetime and not
ticker lifetime. That asymmetry is deliberate in the library: the platform cap
only ever **lowers** the tick loop's lifetime.

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

**This project is no longer deployed.** Its Vercel project was removed on
2026-09-08 and the page moved into `tickroom-demo` under the route `/bench`; see
the note at the top of Results. What follows is how it was deployed, kept
because the app in this repo is still the source the demo's copy was taken from.

Vercel, Node runtime, no `vercel.json`. From this directory:

```bash
vercel --scope <your-team>        # first run: link, project name tickroom-bench
vercel env add REDIS_URL production            # a real TCP rediss:// URL
vercel env add SESSION_SECRET production       # any high-entropy string
vercel --prod --scope <your-team>
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

`tickroom` installs from the registry: `npm install tickroom@1.0.0`. It is
pinned exactly (`"tickroom": "1.0.0"`, no `^`) rather than left to float,
because **1.0.0 is the release this rig now measures**, and every number under
Results is a number about one stated version of the library. A caret would let
the next `npm install` change the thing being measured with no diff in this
repo to review, which for a bench is not a convenience but a silently invalid
result. To pick up a later library version on purpose: bump the pin in
`package.json`, run `npm install`, and work through `CHANGELOG.md` for what
changed. Runs A to G were measured on 0.3.x; see "The 1.0.0 migration" below
for what moved and what the harness reads instead.

## Running the harness

Five harnesses, all driving a real browser: three through Playwright, one over
raw CDP because Playwright's own attachment prevents the thing being measured,
and one over WebDriver into Safari. A real browser rather than a headless Node
client because `frame()` is driven by `requestAnimationFrame`, and rAF is what a
browser throttles, what a hidden tab stops entirely, and what a busy tab delays.
The frame loop **is** the measurement surface.

```bash
# the main run: three clients in one room for twelve minutes
node bench/run.mjs --url https://tickroom-demo.vercel.app \
  --clients 3 --minutes 12 --redis "$REDIS_URL"

# the hidden-tab run: one client backgrounded for 6.5 minutes, then brought back
node bench/hidden-tab.mjs --url https://tickroom-demo.vercel.app --minutes 6.5 --chrome
```

Both write a timestamped JSON to `bench/out/` and print a markdown summary to
stdout. `node bench/run.mjs --help` lists every flag.

**`--lead <ms>`** overrides the connection's input lead on every client via
`?lead=` (the bench page validates it: a finite number 0 to 1000, else the
override is dropped and the library's own default applies), and is reported
back in `window.__bench.stats().inputLeadMs` and in the run's markdown header.
It exists to sweep the default headroom (100, 150, 200) against a real
deployment without rebuilding the library each time.

**Per client**, `run.mjs` reports frames, backward steps, blank frames,
zero-motion frames, peak and mean rendered speed, the largest snapshot arrival
gap and the largest gap on the server's own grid in ticks, the socket's own
arrival cadence (max, median and p99 gap, taken in the `message` handler rather
than inferred from frames), reconnects, relay swaps (completed, attempted and
failed), tick re-anchors with their largest delta, stalls, terminals, and the
round trip. It also lists every ticker handoff the client saw and every resume
step across an epoch boundary, which are the two events the whole exercise is
about, and marks every arrival gap over 250ms `socket` or `render` according to
whether the socket saw it too. See "Attributing the bus tail" for how to read
that pair.

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
node bench/paddle.mjs --url https://tickroom-demo.vercel.app [--room bench~6] [--moves 8] [--hold 350]
```

It holds a direction key down, releases it, waits, and repeats that several
times, counting every reconcile past the first (which only snaps onto the
spawn pose) whose error is above 0.25 units, below which is quantisation
noise from the snapshot's y rounded to a tenth, plus every direction flip in
the DRAWN paddle after a release. A healthy deployment prints zero for both.
**Since 1.0.0 the `error` on a `reconcile` event lands one frame after the rest
of that event**, because the connection reconciles the prediction after
`onSnapshot` returns and `onSnapshot` is where the event is written; the page
parks the record and fills the field from `conn.ownStats.lastError` on the next
frame or the next snapshot, whichever comes first. Nothing in the grading
changes: the field is late by roughly 16ms, or absent on the single event that
can still be pending when the harness drains, and an absent one fails the
comparison rather than reading as a zero error nobody measured. It exists because `run.mjs` and `hidden-tab.mjs` both measure the
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

**A fourth script, `bench/discard.mjs`, kills the client's renderer instead of
hiding it.**

```bash
node bench/discard.mjs --url https://tickroom-demo.vercel.app [--room bench~8] [--roster-seconds 90]
```

A hidden tab still has a renderer: its socket is up, snapshots keep arriving,
and `hidden-tab.mjs` measures a client that only stopped drawing. A **discarded**
tab has nothing. Chrome kills the renderer outright under memory pressure, the
tab stays in the strip as a title, and the socket, the connection, the tick
counter and the player's seat go with it, with no close the page itself
performed. On return the tab is **reloaded**, so the room sees a new client mint
a new player id while the old one is still in the roster until the server
notices. The script records four milestones from the moment the tab is brought
back (first rendered frame, a minted id, an open socket, being drawn in the
roster again), the reconnect count on the new connection, which must be 0
because a reload is not a reconnect, and how long the discarded client's seat
took to leave the room. It defaults to room `bench~8` rather than `bench` on
purpose: a discard leaves a dead player behind for as long as the reap takes,
which would show up in anything else measuring the same room.

**The discard mechanism, and the two things that stop it.** There is no CDP
command for discarding a tab, so the harness drives Chrome's own page: it opens
a second tab, presses the **Enable internal debugging pages** button on
`chrome://chrome-urls` (Chrome gates `chrome://discards` behind that switch now,
per profile, and the profile is thrown away every run), then clicks
**[Urgent Discard]** on the client's row of `chrome://discards`. Urgent is the
memory-pressure path rather than the proactive one Chrome runs on its own
schedule. The row's own lifecycle state, `discarded (urgent)` with a timestamp,
is the confirmation, and it has to be, because the obvious check is destructive:
attaching to a discarded tab is enough to make Chrome reload it.
**A tab with a debugger session attached is not discardable at all**, which
rules Playwright out of this script entirely: `connectOverCDP` attaches to every
page in the browser's default context and holds it, and with that session open
the click lands, the page reports success and `Discard Count` stays 0. So
`discard.mjs` speaks raw CDP over Node's own `WebSocket` and attaches to the
client tab only for the instant of each read. Two differences between builds are worth
knowing, and both are handled rather than assumed. Chrome 152 destroys the page
target along with the renderer and makes a new one for the same tab, where
Chrome for Testing 151 kept the id, so everything after the discard asks the
browser which target is showing the client URL rather than remembering one. And
Chrome for Testing 151 reloads the tab as soon as it is activated, where Chrome
152 accepts the activation and leaves the tab dead until it is really shown,
which never happens if that window is not the frontmost thing on the machine; so
after a five second grace period the harness sends the reload itself, reports
which of the two brought the tab back, and keeps the evidence either way
(`document.wasDiscarded` is still true after a reload, where a fresh navigation
to the same URL would clear it). The script exits 3, naming what it tried, if
the discard cannot be triggered.

**A fifth, `bench/hidden-safari.mjs`, is the hidden-tab measurement on real
Safari.**

```bash
node bench/hidden-safari.mjs --url https://tickroom-demo.vercel.app --minutes 6.5 [--room bench~9]
```

Every number `hidden-tab.mjs` produces is about Chromium's throttling policy:
when rAF stops, how hard timers are clamped, how often a hidden tab is still
allowed to send. Safari's policy is different software, and the library's
liveness defaults are sized against whichever browser is stingiest, so this run
is the other half of that claim. **Playwright's WebKit is not Safari**, so this
one drives the actual Safari.app through `safaridriver` over the raw WebDriver
protocol, `fetch` against `http://127.0.0.1:<port>`, with no new dependency. It
starts its own `safaridriver` (or adopts one already listening on `--port`),
opens the client, waits for the mint with the same readiness rule the Playwright
harnesses use out of `bench/page.mjs`, samples every 30s exactly as the Chrome
run does, closes the front tab at the end, and watches the recovery for 20s at
1s. It prints the same table plus the browser's own `navigator.userAgent`.

**The one-tab-visibility caveat, which is the whole trick.** WebDriver has a
current window handle, `execute/sync` runs there, and it is not the same thing
as the tab the browser is showing: `POST /window/new` opens a tab in front in
Safari and, per the specification, does not move the current handle. So the
harness keeps its handle on the client while Safari shows the new empty tab, and
the client is genuinely backgrounded while still answering scripts. **Switching
to it with `POST /window` would raise it** and end the state being measured, so
nothing does that until the recovery phase. That is verified on the spot rather
than assumed: if `document.hidden` does not read true from the client's context,
the run falls back to switching to it for each sample and switching back, says
so in the log and in its own summary, and the numbers then carry a moment of
visibility every 30 seconds. A run where the tab never reads hidden measured
nothing and exits 3. Safari needs **Allow remote automation** on (Safari
Settings, Developer) and, on macOS 26, that is a setting the running Safari
reads at launch: turn it on, then quit and reopen Safari. `sudo safaridriver
--enable` is the other half on a machine that has never run a WebDriver session,
and it asks for an administrator password.

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
node bench/paddle.mjs --help
```

## File map

```
app/
  page.tsx                  the whole client: canvas, keys, bot, window.__bench
  layout.tsx, globals.css   chrome, one stylesheet
  api/session/route.ts      mints pid + handle + HMAC token, rate limited
  api/room/route.ts         createBalancerRoute, for the capacity re-assign path
  api/ticker/route.ts       createTickerRoute, maxDuration 800
  api/ws/route.ts           createRelayRoute, maxDuration 800
  api/probe/route.ts        the in-function Redis latency probe, gated by key
game/
  pong.ts                   the RoomConnection wiring and the measurement hook
  bench.ts                  the record shapes window.__bench exposes
lib/
  rooms.ts                  namespace, base, capacity, the duration-cap arithmetic,
                            the session token lifetime the relay verifies against
  secret.ts                 fail-closed SESSION_SECRET
  tickerUrl.ts              the Deployment Protection bypass, and why
  upgradeWebSocket.ts       the one platform seam
  wire.ts                   the JSON input decoder, which throws so onBadInput counts
  mintLimit.ts              in-process per-IP mint limit
sim/
  pong.ts                   the room, with the constant-velocity marker
bench/
  run.mjs                   N clients, M minutes, JSON plus a markdown summary
  hidden-tab.mjs            one client backgrounded, then brought back
  hidden-safari.mjs         the same, in real Safari over WebDriver
  discard.mjs               one client's renderer killed, then the tab brought back
  paddle.mjs                one client, a held key: reconciliation and motion regularity
  probe.mjs                 calls /api/probe and prints both latency series
  analyse.mjs               the library's own smoothness analysis, ported
  page.mjs                  what every harness needs from a page, once
  chrome.mjs                starting, attaching to and quitting a real browser process
```

## What was changed from the library's example, and why

`sim/pong.ts` is `examples/pong/sim.ts` with four changes, all of them because
this is a measurement rig rather than a game. Each is documented at its site in
the file. It used to carry a fifth thing that was not a change at all, a `depth`
map fed by `onBufferHealth` and published per paddle as `inputLead`, copied from
the 0.3.x example; the library carries that on its own control frames at 1.0.0
and the example dropped it too, so this file dropped it in step.

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
chosen by query parameter, and a `WebSocketImpl` that counts. At 1.0.0 that
wiring is one object: `predict: { step, maxSpeed, ownPose, wire: 'json' }` on
the connection, `conn.frame(now, input)` once a frame, and `frame().own` as the
pose to draw, where it used to be a `PredictedEntity` held beside the connection
with the order of its three calls kept by hand. `wire: 'json'` rather than the
new binary default because the bench's input is `{ dir }` and not a
`DefaultInput`, and because `'json'` is byte for byte the 0.3.x frame, so the
stamped-input contract every number here reports is the one it has always
been.

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
