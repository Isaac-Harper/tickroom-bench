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

Five harnesses, all driving a real browser: three through Playwright, one over
raw CDP because Playwright's own attachment prevents the thing being measured,
and one over WebDriver into Safari. A real browser rather than a headless Node
client because `frame()` is driven by `requestAnimationFrame`, and rAF is what a
browser throttles, what a hidden tab stops entirely, and what a busy tab delays.
The frame loop **is** the measurement surface.

```bash
# the main run: three clients in one room for twelve minutes
node bench/run.mjs --url https://tickroom-bench.vercel.app \
  --clients 3 --minutes 12 --redis "$REDIS_URL"

# the hidden-tab run: one client backgrounded for 6.5 minutes, then brought back
node bench/hidden-tab.mjs --url https://tickroom-bench.vercel.app --minutes 6.5 --chrome
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

**A fourth script, `bench/discard.mjs`, kills the client's renderer instead of
hiding it.**

```bash
node bench/discard.mjs --url https://tickroom-bench.vercel.app [--room pong~8] [--roster-seconds 90]
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
took to leave the room. It defaults to room `pong~8` rather than `pong` on
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
node bench/hidden-safari.mjs --url https://tickroom-bench.vercel.app --minutes 6.5 [--room pong~9]
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

## Results

Measured on **2026-09-03 (UTC)** against `https://tickroom-bench.vercel.app`:
Vercel project `tickroom-bench` in a personal team on the **Pro** plan, Next.js
App Router, **Fluid compute**, Node 24, `maxDuration = 300` and
`maxDurationS: 300` on both long-lived routes, which is a configuration and the
platform default rather than this team's cap (run D below is the same room at
the Pro cap of 800), namespace `bench`, base id `pong`. Redis is a shared **Upstash** database over TLS (`rediss://`), in
`iad1` with the functions and about 80 to 87ms round trip from the laptop. The
library is `tickroom` 0.2.0 from `vendor/`. Clients are headless Chromium
driven by Playwright at 60fps with `?bot=1`, except run C, which is a real
windowed browser process. Every number in runs A to C comes out of a file in
`bench/out/`, named under its run; the later runs name their own date, machine
and file, because runs D and the sweep were driven from the fw13 server's
Playwright container rather than from the laptop.

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

### Run D: three clients, 27 minutes at the Pro cap, room `pong` (2026-09-05, 04:15 to 04:42)

`pro-27min.log` on fw13, `--lead 150`. The first run at `maxDuration = 800`, so
the ticker's lifetime is **700s** and the relay's **790s**: the periods the
library's own README quotes, rather than the 270 and 290 runs A to C measured.

| | measured |
| --- | --- |
| ticker handoffs | both seen by all three clients: at 700s (`15dbf32d` to `b67b3366`) an arrival gap of **50.0 to 50.1ms**, at 1397s (`b67b3366` to `777108b9`) **66.7 to 83.4ms**, server grid gap exactly **50ms** both times |
| relay warm swaps | **2/2/0** per client, and the retired sockets closed **1005 clean** at 788s and 1574s |
| reconnects, stalls, terminals | **0**, **0**, **0** |
| mean rendered marker speed | exactly **100** on all three |

**And the client-side numbers are the worst this bench has produced, which is
the container and not the platform.** This run rendered in three headless
Chromiums inside a Docker container on the 16-core server while a second
three-client run shared the box, and it shows: zero-motion frames 35 to 61 per
client, worst arrival gaps of 650 to 933ms (most of them in the first 75
seconds, at 833, 650 and 450ms), peaks up to 3290 u/s, RTT medians of 91 to
117ms against 80ms minimums, and **one backward step on one client in 97,000
frames**, which is the first backward step in any run here. That is a renderer
starved of CPU, and it is exactly what the marker is for: every one of those
numbers is a client-side deviation, and none of them touches the server-side
facts in the table above. A handoff cost, a swap outcome and a reconnect count
do not depend on the browser drawing on time. Measure smoothness on a quiet
machine; measure a handoff wherever it is convenient.

### Run E: one genuinely hidden tab in a real Google Chrome, 6.5 minutes, room `pong~5` (2026-09-05)

`bench/out/hidden-2026-09-05T05-03-22-854Z.json`, `--chrome` mode picking up
**Google Chrome 152.0.7977.83** from `/Applications` rather than falling back to
Playwright's Chromium build, which is the caveat run C carried.

| | measured |
| --- | --- |
| tab state | genuinely hidden, **1 frame rendered** in 6.5 minutes |
| client pings | 15 per 30s through the first minute, then **about one a minute**; **47** in total |
| socket | open the whole time, **0 reconnects**, no closes, no terminals, still in the roster on return |
| crossed while hidden | none: at 800s the relay lifetime is 790s and the ticker's is 700s, both longer than the run |
| recovery on show | first rendered frame and drawn in the roster at **1.019s** |
| tick re-anchors | **201**, max delta 44 |

The same result as Chrome for Testing 151 gave, on the browser a player actually
runs. The throttle arrives at the same place (the second minute, not the fifth),
the 90s liveness default holds it with room, and the re-anchors are `frame()`
not running rather than a fault. Safari is run G below; what is left after both
of them is mobile, and a Safari read that does not switch to the tab to take its
samples.

### Run F: a discarded tab, room `pong~8` (2026-09-05)

`bench/out/discard-2026-09-05T05-00-05-297Z.json`, real Chrome 152, driven by
`bench/discard.mjs` over raw CDP. An **urgent** discard from `chrome://discards`
after pressing the enable button on `chrome://chrome-urls`; the row read
`discarded (urgent)` with a timestamp and `document.wasDiscarded` was true on
return, which is the confirmation that matters.

| | measured |
| --- | --- |
| revived by | **`Page.reload`** at 6.4s. Chrome 152 accepted the activation and left the tab dead, because the machine was locked and the window was never really shown |
| first rendered frame | **0.27s** after that reload |
| a new player id minted | **0.37s** |
| socket open | **0.69s** |
| drawn in the roster again | **0.79s** |
| reconnects on the new connection | **0**, because a reload is not a reconnect |
| the discarded client's seat | **already gone** in the first roster the reloaded page drew |

**That last row is the finding.** The expectation going in was that the dead
seat would sit in the room until the relay's 90s liveness deadline reaped it.
It does not: the discard kills the renderer, the socket dies with it, and the
relay drops the player at once, so the deadline never enters. A discarded tab is
a reload, a reload is a fresh session, and nothing in the library needs to
survive one. Chrome 152 also destroys the page target and makes a new one for
the same tab, where Chrome for Testing 151 kept the id; both behaviours are
handled in the harness rather than assumed, and the header of `discard.mjs`
says how.

### Run G: a hidden tab in real Safari, 6.5 minutes, room `pong~9` (2026-09-05)

`bench/out/hidden-safari-2026-09-05T05-55-52-314Z.json`, the actual Safari.app
(**Version/26.6.2**, `AppleWebKit/605.1.15`) driven by `bench/hidden-safari.mjs`
over `safaridriver`, which ran once the user had enabled **Allow remote
automation** and run `sudo safaridriver --enable`. Playwright's WebKit is not
Safari, so this is the only run on this page that says anything about Safari's
own policy.

**Read the caveat first, because it is about how the tab was watched rather than
about what it did.** The harness prefers to leave its WebDriver handle on the
backgrounded client and script it from there, and it verifies that on the spot;
here `execute/sync` would not report the client's state while the empty front
tab was showing, so it fell back to its documented `switch-and-return` mode:
switch to the client for each 30s sample, read, switch back. That makes the tab
briefly visible **13 times**, so this is a tab hidden **thirty seconds at a
time**, not one hidden for 6.5 minutes straight. The 151 frames below are those
switch moments and nothing else.

| | measured |
| --- | --- |
| tab state | `document.hidden` **true on every sample**, 13 of 13 |
| frames rendered | **151** in 6.5 minutes, all of them at the switch moments |
| client pings while hidden | **93**, about **one every four seconds** |
| socket | open the whole time, **0 reconnects**, no closes, no terminals, still in the roster on return |
| crossed while hidden | none: no relay swap and no ticker handoff, at a 790s relay lifetime and a 700s ticker |
| recovery on show | first drawn frame and back in the roster at **1.007s** |
| tick re-anchors | **203**, max delta 55 |

**The one number that differs from Chromium is the throttle, and it differs in
the safe direction.** Chromium drops a hidden tab to about one timer callback a
minute from the second minute; Safari held roughly one every four seconds across
the whole run, so it clamps the client's 2s ping cadence far less. The 90s
liveness default is sized against the stingiest browser, and at Safari's
throttling it is never approached. Recovery is the same as Chrome's to within a
few milliseconds, and the re-anchors are `frame()` not running rather than a
fault, exactly as in runs C and E.

**What is still owed** is a Safari read taken *without* the per-sample switch,
which needs a way to observe a background tab that does not raise it: a
`BroadcastChannel` to a visible helper tab, or the page posting its own state to
the server on the socket it already has. And mobile, which nothing here touches.

### Cold start and join latency

First snapshot after the page's first rendered frame:

| | measured | file |
| --- | --- | --- |
| the room's ticker had to be spawned cold by the relay | **1016ms** | `bench/out/2026-09-03T03-55-24-909Z.json` |
| joining a room already running | **351, 533, 351ms** | `bench/out/2026-09-03T03-56-43-162Z.json` |
| joining a room already running, a later two-client smoke | **617, 534ms** | `bench/out/2026-09-03T04-29-08-082Z.json` |

Each figure is a mint, an upgrade and a first snapshot at about 80ms round trip.

### What the runs do not prove

**The 250 to 433ms band is the platform's socket tail, and it is attributed now**
(this paragraph called it unattributed until the arrivals ring ran; the
entry after the probe has that run)**.**
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
latency for absorbing the second band. Both measurements this paragraph used to
name as owed have since been made, and neither found Redis: the database is in
the same region as the functions, and the in-function probe below reads a p99
of about 2ms. The band is downstream of the relay AND upstream of the browser's
`message` event, confirmed at the socket 5 times out of 5, so it is the
WebSocket path itself; the entry after the probe has the run.

Three more caveats worth carrying with every number above:

- **Chrome for Testing, not Google Chrome**, in run C: `--chrome` prefers a real
  installed Google Chrome and falls back to Playwright's own Chromium build, and
  the machine had no Google Chrome at the time, so run C is Chromium's official
  build running as a real windowed process. Run E above is the same measurement
  on Google Chrome 152 and reads the same. Safari is measured in run G, with the
  per-sample-switch caveat that entry states, and it throttles far less than
  Chromium. **Mobile is still untested.**
- **The clients are a laptop about 80ms away**, on residential wifi, not another
  machine in the deployment's region. Every client-side gap carries that round
  trip in it.
- **The Upstash database is shared** rather than provisioned for this bench.
  Its region is no longer unknown: it is `iad1`, the same region as the
  functions, and the in-function probe below measures that leg at a p99 of
  around 2ms, so a slow region and a slow provider are both ruled out as the
  cause of the band.

### Attributing the bus tail

`/api/probe?seconds=<n>&key=<SESSION_SECRET>` is the in-function latency probe
the paragraph above says is worth building, and it exists to answer the one
question a browser 80ms away cannot: whether the 250 to 433ms band is Redis, or
everything between Redis and the browser. It opens its own two Redis
connections from inside a Vercel function (a publisher plus command client, and
a subscriber on a private `bench:probe:<random>` channel) and, every 100ms for
`seconds` (bounded 5 to 240), times a PING round trip and a PUBLISH-to-SUBSCRIBE
round trip. The relay, the browser and the last 80ms of network are all out of
the path; what is left is exactly the leg from a Vercel function to Redis and
back.

**It is gated by `key`, and has to be.** The route can run for up to `seconds`
of function time on purpose, so an unauthenticated GET buying that for free
would be the same problem the mint limit on `/api/session` exists to prevent,
aimed at a route whose entire cost is time rather than a Redis write. `key`
must equal the deployment's `SESSION_SECRET`; anything else, or nothing, is a
401 before a single Redis connection opens.

```bash
node bench/probe.mjs --url https://tickroom-bench.vercel.app --key "$SESSION_SECRET" --seconds 60
```

It prints count, p50, p90, p99 and max for both series, the region the function
ran in, the Redis host, and every sample over 150ms with its offset from the
start, and saves the same JSON under `bench/out/`. **Read it next to a
`run.mjs` client's own gap numbers, not instead of them:** a tail that shows up
in the probe's own `p99`, `max` or `over150` is the Redis path, measured with
the browser and the relay both removed. A tail `run.mjs` sees on the same
deployment that the probe never reproduces belongs to the relay or to the
client's own socket instead, not to Redis.

**Measured on 2026-09-05, from `iad1` to `helped-teal-156650.upstash.io`:**

| run | samples each | PING | PUBLISH to SUBSCRIBE |
| --- | --- | --- | --- |
| 60s (`bench/out/probe-2026-09-05T04-13-08-767Z.json`) | 601 | p50 **1.26ms**, p90 1.84, p99 2.35, max 22.27 | p50 **1.28ms**, p90 1.52, p99 2.10, max 22.02 |
| 240s (`bench/out/probe-2026-09-05T04-14-50-624Z.json`) | 2406 | p50 **1.46ms**, p90 2.04, p99 2.38, max 14.14 | p50 **1.66ms**, p90 1.90, p99 2.32, max 19.63 |

**No sample over 150ms in either run**, and the region came back `iad1`, the
same region the functions run in, which retires the other measurement this
README said was worth making. So the 250 to 433ms snapshot arrival gaps the
clients see are **not in the Redis path**. What is left is the relay function
(its subscriber's event loop, or the function being paused between snapshots) or
the socket path to the browser.

**The library's own next instrument is `relay.gaps`, and it separates those
two.** The relay measures the inter-arrival gap on its own subscriber
(`busGapMax`, `busGapOver150`) and the time from a bus arrival to the send
returning (`sendLagMax`) per heartbeat window, and logs one line at info only
when `busGapMax` passes 150 or `sendLagMax` passes 50. Read it this way: a
`relay.gaps` line with a `busGapMax` matching a gap a client reported means the
cause is **upstream of the socket** (the ticker, the bus, or the function being
paused), and a client gap with **no** relay line beside it means the **socket
path**. A healthy socket logs nothing, so the absence of a line is half the
reading rather than a missing measurement.

**And the first attribution run read the second way, which is the answer.** Ten
minutes, three clients, room `pong` at `--lead 150` from the fw13 container on
2026-09-05 (05:07 to 05:17 UTC), against the deployment carrying the
instrumentation. The clients reported **eight** arrival gaps over 250ms (550,
267, 267, 283, 267, 383, 300 and 250ms), and the Vercel runtime log carries
**not one `relay.gaps` line** for that window, while other relay lines from the
same deployment are present in it, so info-level capture is proven rather than
assumed. The relay therefore saw no bus gap over 150ms and no send lag over
50ms in any heartbeat window of that run: every one of those gaps is
**downstream of the relay's `send` returning**. Together with the probe above,
that clears the ticker, the bus and the relay function, and leaves the socket
path between the function and the browser (Vercel's WebSocket edge, or the
network) or the client's own event loop. The room's counters for the run:
`starves` 71, `lateInputs` 67 over about 12,000 ticks, tick rate 19.96 to
20.95Hz.

**The caveat was the client, and it is the same caveat run D carries.** That
run rendered inside a Docker container on a loaded box, and every arrival time
this bench quoted was inferred from **frames**, so a container render stall
read as an arrival gap. The Mac runs saw the same 250 to 433ms band at a lower
rate, which is what makes the band real and that run's rate the wrong number to
quote. Removing the caveat needed a client-side arrival time that owes nothing
to the render loop, and that is the instrument below.

**The socket ring: `window.__bench.arrivals()`.** `BenchSocket` in
`game/pong.ts` registers a `message` listener in its own constructor, and the
connection cannot get ahead of it: the library attaches its reader by assigning
`socket.onmessage` after `new WebSocketImpl(url)` has returned, and a property
handler takes its place in the listener order from the moment it is first
assigned, so a listener registered inside the constructor always runs first.
`performance.now()` is the first statement of that handler, so what is recorded
is the arrival rather than the arrival plus a decode. It is a 4000-entry ring
(about three minutes of 20Hz snapshots) drained on the same 500ms poll as the
frames, on the same clock as `BenchFrame.t`, and `stats().arrivalsDropped` says
whether the harness ever fell behind it.

**Only binary frames go in, and that is not a simplification.** The library's
own transport frames share the socket: a `pong` every 2000ms, `relay-expiring`,
the roster seed. A pong landing inside a 400ms snapshot hole would split it
into two 200ms gaps and report a healthy socket, which is the exact wrong
answer to the one question the ring exists to settle. Snapshots are the binary
frames (`binaryType` is `arraybuffer`), which is the same test the library's own
`handleMessage` splits on.

**The new column: `socket gap max/med/p99`.** It sits next to `max snap gap` in
the per-client table and is the same stream measured the other way. Read the
two together:

| what the table shows | what it means |
| --- | --- |
| socket median on the 50ms tick, socket max near the snap gap | the hole is real and is in the socket path or upstream of it |
| socket median on the tick, socket max well under the snap gap | the arrivals kept coming and the render loop is what paused |
| `none` | the page reported no arrivals at all, so nothing here is attributed |

`none` is what a local run prints, because `/api/ws` needs the Vercel runtime
and no socket ever opens, and it is also what a deployment older than the ring
prints. It is deliberately not three zeros: a silent socket and an absent
instrument are the two things that must never read the same.

**And per gap, `socket` or `render`.** Every arrival gap over 250ms already got
its own line with the events around it; each of those lines now ends in a
verdict, and `snapshotGap.over150[].confirmedBySocket` carries the same thing in
the JSON alongside the matched `socketGapMs`:

```
- at 128.4s, 433ms, epoch 0, socket, socket gap 420.1ms, near: swap 3/3/0 +0.4s
- at 401.7s, 267ms, epoch 0, render, socket saw none, nothing within 2s
```

`socket` means the socket's own handler saw the same hole, so the cause is the
socket path or anything upstream of it. `render` means the arrivals kept coming
and only the frames stopped, so the cause is that client's event loop, which is
precisely the container caveat above made measurable instead of asserted. A
socket gap of at least **200ms** within **300ms** of the frame gap is what
confirms one; the bar is below the 250ms report bar on purpose, because the
frame-inferred gap carries up to a frame of quantisation at each end and an
equal bar would turn that rounding into a false `render`. A run with no
arrivals at all reports `unattributed` rather than `render`, for the same
reason `none` is not zero.

**One thing it still cannot separate, and the report does not pretend
otherwise.** A blocked event loop stops the `message` handler too, so a client
that froze its whole main thread gaps in both series and reads as `socket`.
What the ring cleanly rules out is the case that actually threatened run D's
reading: a render loop starved while the socket kept delivering. So `socket`
means "not only the render loop", and the wording in the report says the socket
path **or upstream**, never "the network".

**And the run with the ring in it is the answer.** Ten minutes, three clients,
room `pong~10` at `--lead 150` from the fw13 container on 2026-09-05 (07:44 to
07:54 UTC), against the deployment carrying both `relay.gaps` and the page's
arrivals ring.

| | measured |
| --- | --- |
| socket arrivals per client | about **12,000** |
| socket gap, median | **49.8ms**, on a 50ms grid |
| socket gap, p99 | **69 to 75ms** |
| frame-inferred gaps over 250ms | 5 in all: bot0 one, bot1 one, bot2 three |
| how many the socket confirmed | **5 of 5**, every one within a few ms |
| verdicts | **`socket` x5, `render` x0**, nothing within 2s of any of them |
| `relay.gaps` lines in the window | **zero** |

Per gap: bot0 267ms inferred against **252ms** at the socket; bot1 417 against
**416**; bot2 433/**428**, 700/**709** and 283/**276**. **Read that as the end of
the attribution.** The relay saw no bus gap over 150ms and no send lag over 50ms,
so the holes are downstream of `send` returning; the socket's own handler saw
them, so they are upstream of the browser's `message` event. What sits between
those two points is the WebSocket path from the function through Vercel's edge
to the client, or the network to the container. The ticker, the bus, the relay
function and the render loop are all cleared, and the band is a **platform
property** rather than anything this library or this page schedules. The lever a
host has is the interpolation delay floor, which is what the "what the runs do
not prove" section already said and can now say without a hedge.

The rest of that run: backward steps **0, 0 and 2** (bot2, all across the 700ms
hole), zero-motion frames 2, 9 and 50, `reconnects` 0, no swaps at a 790s relay
lifetime, and the room's own `starves` 87 and `lateInputs` 82 at 19.96 to 21Hz.

**Two things are still owed, and both are narrow.** The same run from a client
on a **quiet machine on a residential link**, because this one is a container on
a loaded box and the Mac runs saw the same band at a lower rate; and a
**whole-process stall detector** in the page, a `setInterval` heartbeat gap ring
beside the arrivals one, because a blocked event loop stops the message handler
too and is the one case a confirmation at the socket cannot distinguish.

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

### The headroom sweep, 2026-09-05

`--lead` exists for this. Three five-minute three-client runs from the fw13
container against the deployment, one headroom each, rooms `pong~3`, `pong~4`
and `pong~6`, between 04:59 and 05:45 UTC. The container's round trip is a
minimum of about 80ms with medians of 87 to 99ms, so this is a jitterier path
than the Mac runs above, which is the point: a headroom is jitter insurance.
Room counters over about 6,000 ticks each.

| headroom | starves | lateInputs | re-anchors per client | zero-motion frames per client | max arrival gap |
| --- | --- | --- | --- | --- | --- |
| 100ms | 345 | 362 | 0, 0, 1 | 0, 37, 14 | 233 to 617ms |
| **150ms** | **53** | **56** | 1, 1, 1 | 3, 10, 1 | 250 to 383ms |
| 200ms | 36 | 31 | 1, 1, 1 | 10, 8, 2 | 267 to 350ms |

**100 to 150 cuts starves and late inputs about 6.5x, and the re-anchor column
says why.** After the consume-on-produced-tick fix the cushion at 100ms is one
tick, and the `inputLead` loop's two-tick deadband never lifts a buffer that
shallow, so the loop sits the whole run out (re-anchors 0) and the starves are
simply paid. 150 to 200 buys another 1.5x for one more tick, 50ms, of input
latency on **every** action. So 150 is the knee and stays the library's
default; a host on a jittery path (mobile, a container, this run) sets
`inputLeadMs: 200`.

**This is a sweep of the headroom, not of the target.** `TARGET_DEPTH_TICKS`
(2), the depth the feedback loop aims the buffer at, was deliberately not swept
beside it: the one-tick-deadband measurement above already showed that the
LOOP rather than the target is what governs a one-tick cushion, and sweeping
the target itself would mean exposing the constant as a host option, which the
library deliberately does not do.

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
  api/ticker/route.ts       createTickerRoute, maxDuration 800
  api/ws/route.ts           createRelayRoute, maxDuration 800
  api/probe/route.ts        the in-function Redis latency probe, gated by key
game/
  pong.ts                   the RoomConnection wiring and the measurement hook
  bench.ts                  the record shapes window.__bench exposes
lib/
  rooms.ts                  namespace, base, capacity, the duration-cap arithmetic
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
  hidden-safari.mjs         the same, in real Safari over WebDriver
  discard.mjs               one client's renderer killed, then the tab brought back
  paddle.mjs                one client, a held key: reconciliation and motion regularity
  probe.mjs                 calls /api/probe and prints both latency series
  analyse.mjs               the library's own smoothness analysis, ported
  page.mjs                  what every harness needs from a page, once
  chrome.mjs                starting, attaching to and quitting a real browser process
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
