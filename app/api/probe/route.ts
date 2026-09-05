import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { secretMatches } from 'tickroom/server';

import { SESSION_SECRET } from '@/lib/secret';

/**
 * `/api/probe?seconds=60&key=<SESSION_SECRET>`: measures the Redis path from
 * INSIDE a Vercel function rather than from the laptop `bench/run.mjs` drives
 * its browsers from, because the two are not the same measurement.
 *
 * README's "What the runs do not prove" names the gap this exists to close:
 * `run.mjs` sees snapshot arrival gaps of 250 to 433ms a few times an hour per
 * client, with nothing in the library's own events near most of them, and
 * cannot say whether the tail belongs to the function-to-Redis leg, the
 * Redis-to-function leg, the relay, or the browser's own socket. This route
 * removes the browser, the relay and half the network from the path: it runs
 * on the platform, opens its own Redis connections, and times PING and
 * PUBLISH/SUBSCRIBE round trips entirely inside one invocation. A tail that
 * shows up HERE is the Redis path; a tail `run.mjs` sees that this route never
 * reproduces is the relay or the browser's own socket instead.
 *
 * `maxDuration = 300` FOR THE SAME REASON THE TICKER AND RELAY EXPORT IT: this
 * route can run for up to `MAX_SECONDS` seconds on purpose, and 300 is the
 * Hobby plan's hard cap. Unlike those two routes this one has no lease, no
 * checkpoint and nothing to hand off; it simply answers with everything it
 * measured once its budget is spent.
 */
export const runtime = 'nodejs';
export const maxDuration = 300;

/** How often a sample is taken. Matches the granularity `run.mjs` reports gaps at; anything finer would mostly measure this function's own event loop rather than Redis. */
const SAMPLE_INTERVAL_MS = 100;

const MIN_SECONDS = 5;
const MAX_SECONDS = 240;
const DEFAULT_SECONDS = 60;

/** The threshold the over-list is built against. Matches the band `run.mjs`'s snapshot-gap analysis calls interesting; a sample under this is the ordinary 80 to 100ms this deployment's own Redis measures at, not a tail worth listing by itself. */
const OVER_MS = 150;

/**
 * How long a single PUBLISH is allowed to wait for its own SUBSCRIBE to land
 * before that one sample is given up on. Well past anything this route exists
 * to explain (the tail under investigation tops out at 433ms) so a genuine
 * slow round trip is still captured whole, and short enough that one dead
 * subscription cannot quietly eat the whole `seconds` budget one timeout at a
 * time.
 */
const PUBSUB_SAMPLE_TIMEOUT_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Nearest-rank percentile over an already-sorted ascending array. Same definition `bench/analyse.mjs` uses, so a number here reads directly against one from the browser-side harness. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i] ?? null;
}

interface SeriesStats {
  count: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

function summarise(samplesMs: number[]): SeriesStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted.length ? (sorted[sorted.length - 1] ?? null) : null,
  };
}

/** The host this deployment's Redis is measured against, password stripped. `URL` never includes credentials in `.host`, so parsing and discarding `username`/`password` is enough; a `rediss://` URL parses like any other. */
function redisHostFrom(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return 'unknown';
  }
}

/**
 * Resolves once a message matching `nonce` arrives on `channel`, or rejects
 * after `timeoutMs`. Attached and torn down per sample rather than kept as one
 * long-lived handler, so a sample that times out cannot leave a stale listener
 * behind to false-match a later one; the nonce match is a second guard against
 * exactly that, in case a late message from a timed-out sample lands while the
 * next sample's listener is already up.
 */
function waitForMessage(sub: Redis, channel: string, nonce: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onMessage = (ch: string, message: string): void => {
      if (ch !== channel || message !== nonce) return;
      cleanup();
      resolve(performance.now());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no subscribe delivery within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      sub.removeListener('message', onMessage);
    };
    sub.on('message', onMessage);
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // GATED BEFORE ANYTHING ELSE COSTS FUNCTION TIME. This route can burn up to
  // `MAX_SECONDS` seconds of a Vercel invocation by design, which an
  // unauthenticated GET must never be able to trigger for free: same reasoning
  // as the mint limit on `/api/session`, applied to a route whose whole cost
  // is time rather than a Redis write.
  const key = url.searchParams.get('key');
  if (!secretMatches(key, SESSION_SECRET)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const secondsRaw = Number(url.searchParams.get('seconds') ?? String(DEFAULT_SECONDS));
  const seconds = Number.isFinite(secondsRaw)
    ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(secondsRaw)))
    : DEFAULT_SECONDS;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return jsonResponse({ error: 'REDIS_URL is not set' }, 500);

  // A PRIVATE CHANNEL PER INVOCATION. Nothing else in this deployment
  // publishes or subscribes on `bench:probe:*`, so a stray message here can
  // only be this same route's own previous sample, never room traffic and
  // never another concurrent probe call.
  const channel = `bench:probe:${randomUUID().slice(0, 12)}`;

  let pub: Redis | null = null;
  let sub: Redis | null = null;
  try {
    // TWO DEDICATED CONNECTIONS, NEITHER THE SHARED SINGLETON `getRedis`
    // FROM `tickroom/server` HANDS BACK. That client is memoized at module
    // scope on purpose, meant to outlive any one request; this route closes
    // whatever it opens at the end of every call, and quitting the shared
    // client out from under a warm container would leave the next request
    // (a mint, a relay, a ticker tick sharing this instance) reaching for a
    // connection that is no longer there.
    //
    // `lazyConnect: true` PLUS AN EXPLICIT `.connect()` is what turns a
    // connection failure into a promise this route can catch, rather than a
    // background retry loop it would have to give up on by hand: ioredis's
    // `connect()` resolves on `'ready'` and rejects on the connector's own
    // first error or on the stream closing before it got there.
    pub = new Redis(redisUrl, { maxRetriesPerRequest: 2, commandTimeout: 5000, lazyConnect: true });
    // NO `commandTimeout` ON THE SUBSCRIBER, same reasoning as
    // `createSubscriber` in the library's own `server/redis.ts`: after a
    // reconnect ioredis re-issues the subscribe with no `.catch` on the
    // returned promise, and a `commandTimeout` firing on that command is an
    // unhandled rejection, which is a process exit rather than a failed probe.
    // `maxRetriesPerRequest: null` is that function's documented pair.
    sub = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    // Logged rather than silent: a connection that drops mid-run should leave
    // a trace in the function log even though the loop below survives it (see
    // the per-sample try/catch), and a listener is required here or ioredis
    // logs an "unhandled error event" of its own with less context.
    pub.on('error', (err) => console.error('[probe] publisher connection error', err));
    sub.on('error', (err) => console.error('[probe] subscriber connection error', err));
    await Promise.all([pub.connect(), sub.connect()]);
    await sub.subscribe(channel);
  } catch (err) {
    await Promise.allSettled([pub?.quit(), sub?.quit()]);
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, 500);
  }

  const startedAtMs = Date.now();
  const startedAtPerf = performance.now();
  const endAt = startedAtMs + seconds * 1000;

  const pingSamples: { atMs: number; ms: number }[] = [];
  const pubsubSamples: { atMs: number; ms: number }[] = [];
  let tick = 0;

  while (Date.now() < endAt) {
    const tickStartPerf = performance.now();
    const atMs = Math.round(tickStartPerf - startedAtPerf);
    tick += 1;
    const nonce = `${tick}:${randomUUID().slice(0, 8)}`;

    // BOTH MEASUREMENTS RUN CONCURRENTLY, not one after the other: PING and
    // PUBLISH are independent commands on `pub`'s one connection, and waiting
    // for them in series would double-count the network leg they share
    // instead of measuring each round trip on its own.
    //
    // THE LISTENER IS ATTACHED BEFORE `publish` IS AWAITED, synchronously
    // inside `waitForMessage`, so the subscribe side can never miss a message
    // that beat the listener into place.
    const waitMsg = waitForMessage(sub, channel, nonce, PUBSUB_SAMPLE_TIMEOUT_MS);

    const pingStartPerf = performance.now();
    const pingResult = pub
      .ping()
      .then(() => performance.now() - pingStartPerf)
      .catch((err: unknown) => {
        console.error('[probe] ping sample failed', err);
        return null;
      });

    const pubsubStartPerf = performance.now();
    const pubsubResult = pub
      .publish(channel, nonce)
      .then(() => waitMsg)
      .then((receivedAtPerf) => receivedAtPerf - pubsubStartPerf)
      .catch((err: unknown) => {
        console.error('[probe] pubsub sample failed', err);
        return null;
      });

    const [pingMs, pubsubMs] = await Promise.all([pingResult, pubsubResult]);
    if (pingMs !== null) pingSamples.push({ atMs, ms: Math.round(pingMs * 100) / 100 });
    if (pubsubMs !== null) pubsubSamples.push({ atMs, ms: Math.round(pubsubMs * 100) / 100 });

    const elapsed = performance.now() - tickStartPerf;
    const waitMs = SAMPLE_INTERVAL_MS - elapsed;
    if (waitMs > 0) await sleep(waitMs);
  }

  try {
    await sub.unsubscribe(channel);
  } catch {
    // Best-effort only: the connections are quit unconditionally right below,
    // which drops the subscription along with everything else.
  }
  await Promise.allSettled([pub.quit(), sub.quit()]);

  const over150 = [
    ...pingSamples
      .filter((s) => s.ms > OVER_MS)
      .map((s) => ({ series: 'ping' as const, atMs: s.atMs, ms: s.ms })),
    ...pubsubSamples
      .filter((s) => s.ms > OVER_MS)
      .map((s) => ({ series: 'pubsub' as const, atMs: s.atMs, ms: s.ms })),
  ].sort((a, b) => a.atMs - b.atMs);

  return jsonResponse(
    {
      seconds,
      region: process.env.VERCEL_REGION ?? null,
      redisHost: redisHostFrom(redisUrl),
      channel,
      ping: summarise(pingSamples.map((s) => s.ms)),
      pubsub: summarise(pubsubSamples.map((s) => s.ms)),
      over150,
    },
    200
  );
}
