import { randomUUID } from 'node:crypto';
import { normalizeRoomId } from 'tickroom/core';
import { makeToken } from 'tickroom/server';

import { clientKeyFrom, takeMintToken } from '@/lib/mintLimit';
import { BASE, isValidBase } from '@/lib/rooms';
import { SESSION_SECRET } from '@/lib/secret';

export const runtime = 'nodejs';

/*
 * THE TOKEN LIFETIME IS LEFT AT THE LIBRARY'S DEFAULT, AND THAT IS A DECISION
 * RATHER THAN AN OMISSION, because the relay lifetime chain is the thing it has
 * to outlive and this app is the one most likely to be bitten by getting it
 * wrong. The warm swap at a relay's 290 second cap REUSES the session already
 * on hand, so a token that expires part way along the chain has every
 * replacement after it refused (401 before the upgrade, 4001 after it), the
 * swap discarded, and each cap quietly back to costing a cold reconnect.
 * Nothing on the server says so, because from the relay's side a refused socket
 * is an ordinary refused socket; the only symptom is `conn.stats().swapsFailed`
 * climbing in step with `swapsAttempted`, which is exactly why the harness
 * reports both.
 *
 * AND NOTE WHICH SIDE THE NUMBER ACTUALLY LIVES ON: `maxAgeS` is read by
 * `verifyToken`, not by `makeToken`, and `createRelayRoute` verifies with
 * `{ secret }` alone. So a `maxAgeS` passed here would change nothing at all
 * while reading like a policy, which is worse than not writing it: the
 * effective lifetime is `verifyToken`'s own default of 12 hours either way.
 * That covers a run of any length this rig is meant for, roughly 150 relay caps
 * deep, and it is still an expiry rather than a forever-token.
 */

/**
 * The DEVICE cookie exists so the relay's per-subject socket cap means
 * something. That cap counts sockets per token `sub`, and if `sub` were derived
 * from the pid (which is freshly random on every single mint) then every socket
 * would belong to a different subject and the cap would count to one forever
 * while enforcing nothing. Keying it to a value that survives across mints in
 * one browser is what makes it a real bound.
 *
 * It is deliberately NOT signed and carries no security claim. It is a FAIRNESS
 * key, not an identity: clearing or forging it buys nothing except evading your
 * own connection cap, and the room capacity gate and the mint rate limit both
 * still apply.
 *
 * THE HARNESS RELIES ON EACH TAB GETTING ITS OWN, which is why each bench page
 * is opened in its own browser CONTEXT rather than as another tab in one. Tabs
 * in one context share a cookie jar, so they would share a subject, and the
 * per-subject cap would refuse every client after the first: a run that
 * measured the cap working rather than the room working.
 */
const DEVICE_COOKIE = 'tickroom_bench_device';
const DEVICE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;
const DEVICE_ID_PATTERN = /^[0-9a-f-]{8,64}$/;

function readDeviceId(req: Request): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== DEVICE_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    // Validated, not merely read. It becomes part of a Redis key name
    // (`bench:conns:d.<id>` inside `checkAdmission`), and Redis keys have no
    // escaping, so a cookie carrying ':' or '*' would let a client name a key
    // it has no business naming.
    return DEVICE_ID_PATTERN.test(value) ? value : null;
  }
  return null;
}

/**
 * Mints a session: a fresh player id, a numeric handle, and the HMAC token the
 * relay verifies for the whole life of the socket that follows.
 *
 * The `?room=` the caller passes is re-validated regardless of where it came
 * from. It arrives from a browser, so trusting even the balancer's own answer
 * to have come back unmodified would put an unchecked string into a Redis key
 * name.
 */
export async function POST(req: Request): Promise<Response> {
  const limit = takeMintToken(clientKeyFrom(req.headers));
  if (!limit.allowed) {
    return new Response(JSON.stringify({ error: 'too many session requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(limit.retryAfterS) },
    });
  }

  const url = new URL(req.url);
  const room = normalizeRoomId(url.searchParams.get('room') ?? BASE, {
    isValidBase,
    fallback: BASE,
  });

  const pid = randomUUID();
  const existingDevice = readDeviceId(req);
  const deviceId = existingDevice ?? randomUUID();

  // A cosmetic short id for the UI. Nothing authorises on it: the token binds
  // pid AND handle together, so `verifyToken` refuses a token replayed against
  // a different pid even if the handles happen to collide.
  const handle = Math.floor(Math.random() * 65536);

  const token = makeToken({ pid, handle, sub: `d.${deviceId}` }, { secret: SESSION_SECRET });

  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  if (!existingDevice) {
    // `Secure` only over https. A browser silently discards a Secure cookie on
    // a plain-http origin, so hardcoding it would mean every local request
    // mints a brand new device id and the socket cap goes back to enforcing
    // nothing, exactly the failure this cookie exists to prevent.
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    headers.append(
      'set-cookie',
      `${DEVICE_COOKIE}=${deviceId}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`
    );
  }

  return new Response(JSON.stringify({ token, playerId: pid, handle, room }), { status: 200, headers });
}
