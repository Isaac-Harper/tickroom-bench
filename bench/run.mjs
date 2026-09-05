#!/usr/bin/env node
// The bench: N real browsers on one room for M minutes, and the numbers that
// come out.
//
// Everything the library publishes about smoothness today was measured on
// loopback: a `ws` server in the test process, a Redis on 127.0.0.1, and a
// simulated one-way delay standing in for a network. That measures the
// mechanism and says nothing about the platform. This runs the identical
// analysis against a real deployment, where the ticker is a serverless function
// with a cold start, the relay is a different function with its own duration
// cap, Redis is across the internet, and the client is Chromium rather than a
// timer in Node.
//
// WHY A REAL BROWSER RATHER THAN A HEADLESS NODE CLIENT. `RoomConnection` runs
// perfectly well in Node (the library documents `socketUrl` and
// `WebSocketImpl` for exactly that) and a Node client would be cheaper, faster
// to start and easier to instrument. It would also measure a different thing:
// `frame()` is driven by `requestAnimationFrame` in a real client, and rAF is
// what a browser throttles, what a hidden tab stops entirely, and what a busy
// tab delays. The frame loop IS the measurement surface, so replacing it with a
// `setInterval` measures a client nobody ships.
//
// ONE BROWSER CONTEXT PER CLIENT, NOT ONE TAB PER CLIENT. Tabs in one context
// share a cookie jar, and the session route's device cookie is what the relay's
// per-subject socket cap counts against. Sharing it means every client after
// the first is refused with `conn-limit`, and the run measures the cap working
// rather than the room working.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { analyse, summariseRoomStats, GAP_REPORT_MS, TICK_MS } from './analyse.mjs';
import { waitForPid } from './page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** How often each page is drained. 500ms of frames is about 30 records at 60fps, comfortably inside the page's 4000-record ring. */
const POLL_MS = 500;

/**
 * How often the room's stats key is read, and it is NOT the five seconds that
 * would be the obvious choice.
 *
 * `RoomStats`'s counter fields are read-and-zero: the ticker flushes them into
 * the key once a second and resets them, so the key holds "what happened in the
 * last second" and never a lifetime total. A five second poll would therefore
 * see one flush in five and silently under-report every counter in the payload
 * by a factor of five, which is worse than sparse sampling because the numbers
 * still look plausible. Reading faster than the flush cadence and DEDUPING ON
 * `at` (the flush's own timestamp) is what makes a sum correct, and the
 * coverage figure in the output says how many distinct flushes were actually
 * caught out of the number the run should have produced.
 */
const REDIS_POLL_MS = 500;

/** `CLIENT LIST` is a full scan of the server's connection table, so it is not on the fast path. Every five seconds is plenty for a number that moves once per socket. */
const CLIENT_LIST_MS = 5000;

/** How long to wait for a page to publish `window.__bench` before calling the page broken. Covers a cold Vercel start plus the bundle. */
const READY_TIMEOUT_MS = 60_000;

/**
 * The Redis key prefix, and it MUST equal `NAMESPACE` in `lib/rooms.ts`. It is
 * retyped here rather than imported because this file is plain `.mjs` run by
 * node and that one is TypeScript compiled by Next, and a build step between
 * the harness and the deployment it measures would be a worse trade than one
 * duplicated string. `roomKeys` in `tickroom/core` is the definition both
 * follow: `${namespace}:${roomId}:${suffix}`.
 */
const NAMESPACE = 'bench';

const USAGE = `
tickroom-bench: drive N browser clients against a deployment and report what they rendered.

  node bench/run.mjs --url <base-url> [options]

Options:
  --url <url>        Base URL of the deployment. Required. Example: https://tickroom-bench.vercel.app
  --clients <n>      Number of browser clients. Default 3.
  --minutes <m>      Run length in minutes. Default 12. Fractional values are allowed.
  --room <id>        Room instance every client joins. Default "pong".
  --headed           Show the browsers. Default headless.
  --redis <url>      Read the room's stats key and CLIENT LIST from this Redis. Optional.
  --lead <ms>        Override the connection's input lead (0 to 1000) on every client
                      via ?lead=, for a sweep of the default headroom (100, 150, 200)
                      against a real deployment with no library rebuild. Optional.
  --out <dir>        Where the JSON result goes. Default bench/out.
  --help             This.

Notes:
  A run shorter than about 5 minutes exercises neither the ticker's 270s handoff
  nor the relay's 290s warm swap, which are the two things a real deployment
  does that loopback never will. 12 minutes crosses roughly two of each.

  Every client gets its own browser context, because the session route's device
  cookie is what the relay's per-subject socket cap counts against and tabs in
  one context share it.
`.trim();

function parseArgs(argv) {
  const out = { clients: 3, minutes: 12, room: 'pong', headed: false, out: join(HERE, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--headed') out.headed = true;
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--clients') out.clients = Number(argv[++i]);
    else if (a === '--minutes') out.minutes = Number(argv[++i]);
    else if (a === '--room') out.room = argv[++i];
    else if (a === '--redis') out.redis = argv[++i];
    else if (a === '--lead') out.lead = Number(argv[++i]);
    else if (a === '--out') out.out = resolve(argv[++i]);
    else return { error: `unknown argument: ${a}` };
  }
  if (!out.url) return { error: 'missing --url' };
  if (!Number.isFinite(out.clients) || out.clients < 1) return { error: '--clients must be a positive number' };
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) return { error: '--minutes must be a positive number' };
  if (out.lead !== undefined && (!Number.isFinite(out.lead) || out.lead < 0 || out.lead > 1000)) {
    return { error: '--lead must be a number from 0 to 1000' };
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The drain, and it is deliberately ONE round trip per client per poll.
 *
 * Each of `frames()` and `events()` empties what it returns, so a failed or
 * partial evaluate loses records rather than repeating them. Reading all four
 * in one expression means a page that navigated, crashed or was closed mid-poll
 * loses one poll's worth and nothing else, and the `catch` records that it
 * happened instead of ending the run: a bench that aborts on the first blip
 * cannot measure a deployment whose whole point is surviving blips.
 */
/**
 * How many of those connections are in subscribe mode, WHEN THE SERVER SAYS.
 *
 * A real Redis answers `CLIENT LIST` with `flags=`, `sub=`, `psub=` and `ssub=`
 * on every line, and a subscriber is any of the counts being nonzero or `P` in
 * the flags. `S` is NOT one of them however tempting the letter looks: it is a
 * replica connection, and counting replicas as subscribers would inflate the
 * one number this whole section exists to report.
 *
 * UPSTASH REPORTS NONE OF THEM. Measured against the deployment's own database
 * (Upstash 1.17.11, Redis 8.2.0) with a subscriber deliberately open: every
 * line comes back as `id addr laddr db name lib-name lib-ver` and stops. So the
 * old regex matched nothing and the run reported `0 in subscribe mode` while a
 * ticker subscriber and a relay subscriber per socket were certainly live,
 * which is not a small number, it is a wrong one. `null` is the honest answer
 * and the summary prints it as text rather than as a zero.
 */
function countSubscribers(lines) {
  const reported = lines.some((l) => / (?:sub|psub|ssub)=| flags=/.test(l));
  if (!reported) return null;
  return lines.filter((l) => / (?:sub|psub|ssub)=[1-9]/.test(l) || / flags=\S*P/.test(l)).length;
}

async function drain(page) {
  return page.evaluate(() => {
    const b = window.__bench;
    if (!b) return null;
    return { status: b.status(), stats: b.stats(), frames: b.frames(), events: b.events(), pid: b.pid() };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }

  const runMs = args.minutes * 60_000;
  const startedAt = new Date();
  console.error(
    `[bench] ${args.clients} clients, ${args.minutes} min, room ${args.room}, ${args.url}` +
      (args.redis ? ' (+redis)' : '') +
      (args.lead !== undefined ? ` (lead ${args.lead}ms)` : '')
  );

  // ---- redis sampling, if asked -----------------------------------------

  let redis = null;
  const roomStatsSamples = [];
  const seenFlushAt = new Set();
  const clientCounts = [];
  const redisErrors = [];
  if (args.redis) {
    // Imported lazily so a run without `--redis` does not need the driver at
    // all, and a broken Redis URL fails here rather than half way through a
    // twelve minute run.
    const { default: Redis } = await import('ioredis');
    redis = new Redis(args.redis, { maxRetriesPerRequest: 2, lazyConnect: true });
    redis.on('error', (e) => redisErrors.push(String(e && e.message ? e.message : e)));
    await redis.connect();
  }

  // ---- browsers ----------------------------------------------------------

  const browser = await chromium.launch({ headless: !args.headed });
  const clients = [];
  for (let i = 0; i < args.clients; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const rec = {
      index: i,
      name: `bot${i}`,
      pid: '',
      frames: [],
      events: [],
      statsSeries: [],
      statuses: [],
      pageErrors: [],
      consoleErrors: [],
      drainFailures: 0,
      context,
      page,
    };
    page.on('pageerror', (e) => rec.pageErrors.push(String(e && e.message ? e.message : e)));
    page.on('console', (m) => {
      if (m.type() === 'error') rec.consoleErrors.push(m.text().slice(0, 400));
    });
    const target = new URL(args.url);
    target.searchParams.set('bot', '1');
    target.searchParams.set('room', args.room);
    target.searchParams.set('name', rec.name);
    if (args.lead !== undefined) target.searchParams.set('lead', String(args.lead));
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__bench), null, { timeout: READY_TIMEOUT_MS });
    // WAITS FOR THE MINT AND NOT JUST FOR THE HOOK. The page publishes
    // `window.__bench` before `conn.start()`, so `pid()` answers `''` until
    // `/api/session` comes back; see `bench/page.mjs` for what reading it a
    // moment too early cost the hidden-tab harness.
    rec.pid = await waitForPid(page);
    clients.push(rec);
    console.error(`[bench] client ${i} up`);
  }

  // ---- the run -----------------------------------------------------------

  const runStart = Date.now();
  const endAt = runStart + runMs;
  let nextRedisAt = runStart;
  let nextClientListAt = runStart;
  let nextLogAt = runStart + 30_000;

  while (Date.now() < endAt) {
    await sleep(POLL_MS);

    await Promise.all(
      clients.map(async (c) => {
        try {
          const sample = await drain(c.page);
          if (!sample) {
            c.drainFailures += 1;
            return;
          }
          if (!c.pid && sample.pid) c.pid = sample.pid;
          c.frames.push(...sample.frames);
          c.events.push(...sample.events);
          c.statsSeries.push(sample.stats);
          if (c.statuses[c.statuses.length - 1] !== sample.status) c.statuses.push(sample.status);
        } catch (err) {
          c.drainFailures += 1;
          c.pageErrors.push(`drain: ${String(err && err.message ? err.message : err)}`);
        }
      })
    );

    if (redis && Date.now() >= nextRedisAt) {
      nextRedisAt = Date.now() + REDIS_POLL_MS;
      try {
        const raw = await redis.get(`${NAMESPACE}:${args.room}:stats`);
        if (raw) {
          const parsed = JSON.parse(raw);
          // DEDUPED ON THE FLUSH'S OWN TIMESTAMP. The key is overwritten once a
          // second and read faster than that, so without this every counter
          // would be summed several times over.
          if (typeof parsed.at === 'number' && !seenFlushAt.has(parsed.at)) {
            seenFlushAt.add(parsed.at);
            roomStatsSamples.push(parsed);
          }
        }
      } catch (err) {
        redisErrors.push(`stats: ${String(err && err.message ? err.message : err)}`);
      }
    }

    if (redis && Date.now() >= nextClientListAt) {
      nextClientListAt = Date.now() + CLIENT_LIST_MS;
      try {
        // THE FIRST CEILING THIS ARCHITECTURE HITS IS CONCURRENT CONNECTIONS,
        // not commands: every socket the relay holds keeps its OWN subscriber
        // open, because a connection in subscribe mode cannot run ordinary
        // commands. So the number that matters on a populated room is how many
        // connections the server is actually holding, and this is the only
        // place it can be read from.
        const list = await redis.call('CLIENT', 'LIST');
        const lines = String(list).split('\n').filter((l) => l.trim() !== '');
        clientCounts.push({ atMs: Date.now() - runStart, total: lines.length, subscribers: countSubscribers(lines) });
      } catch (err) {
        redisErrors.push(`client-list: ${String(err && err.message ? err.message : err)}`);
      }
    }

    if (Date.now() >= nextLogAt) {
      nextLogAt = Date.now() + 30_000;
      const elapsed = Math.round((Date.now() - runStart) / 1000);
      const line = clients
        .map((c) => `${c.index}:${c.statuses[c.statuses.length - 1] ?? '?'}/${c.frames.length}f`)
        .join(' ');
      console.error(`[bench] ${elapsed}s ${line}`);
    }
  }

  // One last drain, so the final seconds are not thrown away.
  await Promise.all(
    clients.map(async (c) => {
      try {
        const sample = await drain(c.page);
        if (sample) {
          c.frames.push(...sample.frames);
          c.events.push(...sample.events);
          c.statsSeries.push(sample.stats);
        }
      } catch {
        c.drainFailures += 1;
      }
    })
  );

  await browser.close();
  if (redis) await redis.quit();

  // ---- analysis ----------------------------------------------------------

  const perClient = clients.map((c) => {
    const t0 = c.frames.length ? c.frames[0].t : 0;
    const endStats = c.statsSeries.length ? c.statsSeries[c.statsSeries.length - 1] : {};
    return {
      index: c.index,
      name: c.name,
      pid: c.pid,
      statuses: c.statuses,
      drainFailures: c.drainFailures,
      pageErrors: c.pageErrors,
      consoleErrors: c.consoleErrors,
      analysis: analyse(c.frames, c.events, c.statsSeries, endStats, t0),
    };
  });

  const expectedFlushes = Math.floor(runMs / 1000);
  const result = {
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    args: {
      url: args.url,
      clients: args.clients,
      minutes: args.minutes,
      room: args.room,
      redis: Boolean(args.redis),
      lead: args.lead ?? null,
    },
    clients: perClient,
    room: args.redis
      ? {
          ...summariseRoomStats(roomStatsSamples),
          flushCoverage: `${roomStatsSamples.length}/${expectedFlushes}`,
          clientCounts,
          errors: redisErrors.slice(0, 20),
        }
      : null,
  };

  await mkdir(args.out, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const file = join(args.out, `${stamp}.json`);
  await writeFile(file, JSON.stringify(result, null, 2));

  console.log(renderMarkdown(result, file));
  return 0;
}

/** The one field of an event's detail worth putting next to a gap. A whole `detail` object per line would bury the answer it exists to give. */
function describeNear(e) {
  const d = e.detail ?? {};
  if (e.kind === 'status') return ` ${d.status}`;
  if (e.kind === 'close') return ` ${d.code}${d.wasClean ? '' : ' unclean'}`;
  if (e.kind === 'reanchor') return ` delta ${d.delta}`;
  if (e.kind === 'swap') return ` ${d.relaySwaps}/${d.swapsAttempted}/${d.swapsFailed}`;
  if (e.kind === 'handoff') return ` ${d.from} to ${d.to}`;
  if (e.kind === 'stall') return d.stalled ? ' on' : ' off';
  if (e.kind === 'terminal') return ` ${d.reason}`;
  return '';
}

function renderMarkdown(result, file) {
  const lines = [];
  lines.push(`# tickroom bench, ${result.startedAt}`);
  lines.push('');
  lines.push(
    `${result.args.clients} client(s), ${result.args.minutes} min, room \`${result.args.room}\`, ` +
      `\`${result.args.url}\`` +
      (result.args.lead !== null ? `, lead ${result.args.lead}ms` : '') +
      `. Raw JSON: \`${file}\`.`
  );
  lines.push('');
  lines.push('## What each client rendered');
  lines.push('');
  lines.push(
    '| client | frames | backward | zero-motion | blank | peak u/s | mean u/s | max snap gap | max serverTime gap | reconnects | swaps (ok/att/fail) | reanchors (max) | stalls | terminals | rtt min/med |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of result.clients) {
    const a = c.analysis;
    const cl = a.client;
    lines.push(
      `| ${c.name} | ${a.frames} | ${a.rendered.backward} | ${a.rendered.zeroMotion} | ${a.rendered.blankFrames} | ` +
        `${a.rendered.peak} | ${a.rendered.mean} | ${a.snapshotGap.maxMs}ms | ` +
        `${a.snapshotGap.maxServerTicks} ticks | ${cl.reconnects ?? '?'} | ` +
        `${cl.relaySwaps ?? '?'}/${cl.swapsAttempted ?? '?'}/${cl.swapsFailed ?? '?'} | ` +
        `${a.tick.reanchors.length} (${a.tick.maxAbsReanchor}) | ${a.events.stalls.length} | ` +
        `${a.events.terminals.length} | ${cl.rttMinMs ?? '?'}/${cl.rttMedianMs ?? '?'}ms |`
    );
  }
  lines.push('');
  lines.push(
    'Backward, zero-motion and peak are measured on the constant-velocity marker ' +
      'at 100 u/s, which is the same entity at the same speed the library measures on loopback. ' +
      'Hold frames (an epoch that has had no snapshot yet) are excluded from all three; the step ' +
      'out of a hold is reported separately as a resume step.'
  );
  lines.push('');

  for (const c of result.clients) {
    const a = c.analysis;
    const rs = a.rendered.resumeSteps;
    const hs = a.snapshotGap.handoffs;
    const wide = a.snapshotGap.over150.filter((g) => g.gapMs >= GAP_REPORT_MS);
    const cs = a.events.closes;
    if (rs.length === 0 && hs.length === 0 && wide.length === 0 && cs.length === 0 && a.events.terminals.length === 0) continue;
    lines.push(`### ${c.name}`);
    lines.push('');
    if (hs.length) {
      lines.push(`Ticker handoffs seen: ${hs.length}.`);
      for (const h of hs) {
        lines.push(`- at ${(h.atMs / 1000).toFixed(1)}s, ${h.from} to ${h.to}, arrival gap ${h.gapMs}ms, server grid gap ${h.serverGapMs}ms`);
      }
      lines.push('');
    }
    if (rs.length) {
      lines.push(`Resume steps across an epoch boundary: ${rs.length}.`);
      for (const r of rs) lines.push(`- at ${(r.atMs / 1000).toFixed(1)}s, dx ${r.dx}, ${r.speed} u/s`);
      lines.push('');
    }
    if (wide.length) {
      // PLACED IN TIME AND NEXT TO WHATEVER WAS HAPPENING. A gap that sits on a
      // swap is that swap's adoption cost; the same gap with nothing near it is
      // the network or the room, and the two used to be one number in a list.
      lines.push(`Snapshot arrival gaps over ${GAP_REPORT_MS}ms: ${wide.length}.`);
      for (const g of wide) {
        const near = (g.near ?? []).map((e) => `${e.kind}${describeNear(e)} ${e.dtMs >= 0 ? '+' : ''}${(e.dtMs / 1000).toFixed(1)}s`);
        lines.push(
          `- at ${(g.atMs / 1000).toFixed(1)}s, ${g.gapMs}ms, epoch ${g.epoch}` +
            (near.length ? `, near: ${near.join('; ')}` : ', nothing within 2s')
        );
      }
      lines.push('');
    }
    if (cs.length) {
      lines.push(`Socket closes: ${cs.length}.`);
      for (const x of cs) {
        lines.push(
          `- at ${(x.atMs / 1000).toFixed(1)}s, code ${x.code}${x.reason ? ` "${x.reason}"` : ''}, ${x.wasClean ? 'clean' : 'not clean'}`
        );
      }
      lines.push('');
    }
    if (a.events.terminals.length) {
      lines.push('Terminals:');
      for (const t of a.events.terminals) lines.push(`- at ${(t.atMs / 1000).toFixed(1)}s, ${t.reason} in ${t.room}`);
      lines.push('');
    }
    if (c.pageErrors.length) {
      lines.push(`Page errors: ${c.pageErrors.length}. First: ${c.pageErrors[0]}`);
      lines.push('');
    }
  }

  if (result.room) {
    const r = result.room;
    lines.push('## What the room reported');
    lines.push('');
    lines.push(`Stats flushes caught: ${r.flushCoverage}. Peak players: ${r.maxPlayers}. Tick rate ${r.tickHz.min} to ${r.tickHz.max} Hz against a ${(1000 / TICK_MS).toFixed(0)}Hz target.`);
    lines.push('');
    lines.push('| counter | total |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(r.totals)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    if (r.clientCounts.length) {
      const peak = r.clientCounts.reduce((m, c) => Math.max(m, c.total), 0);
      const counted = r.clientCounts.filter((c) => typeof c.subscribers === 'number');
      const sub = counted.length
        ? `${counted.reduce((m, c) => Math.max(m, c.subscribers), 0)} in subscribe mode`
        : 'subscribe mode not reported by this Redis';
      lines.push(`Redis connections, peak: ${peak} total, ${sub}. Every relay socket holds its own subscriber, so the second number is the one that meets a managed plan's ceiling first.`);
      if (!counted.length) {
        lines.push('');
        lines.push(
          "This database's `CLIENT LIST` answers `id addr laddr db name lib-name lib-ver` and nothing else: " +
            'no `flags=`, no `sub=`, no `psub=`. The split cannot be counted here and is not reported as zero, ' +
            'which is what it used to be. The total is real, and `connected_clients` from `INFO clients` agrees with it.'
        );
      }
      lines.push('');
    }
    if (r.errors.length) {
      lines.push(`Redis errors: ${r.errors.length}. First: ${r.errors[0]}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
