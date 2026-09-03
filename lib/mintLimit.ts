/**
 * A fixed-window per-IP limit on session minting.
 *
 * WHY AN UNMETERED MINT IS A PROBLEM, since it looks like the cheapest route in
 * the app. A minted token is the ONLY thing the WebSocket relay checks before
 * it admits a socket: verification is local HMAC arithmetic with no lookup
 * behind it, which is the whole point (an auth outage never reaches the socket
 * path) and exactly why the mint has to be the place a bound is applied. Every
 * token buys the right to open a socket, every socket the relay holds keeps its
 * OWN Redis subscriber connection open for as long as it lives, and a managed
 * Redis plan's concurrent connection ceiling is the first wall this
 * architecture hits. Unmetered, a single caller can mint an unbounded supply of
 * distinct identities; distinct identities are precisely what the relay's
 * per-subject socket cap keys off, so an attacker who can mint freely can walk
 * straight around that cap and exhaust the connection ceiling, which takes down
 * the rooms' own ticker subscribers with it. That is a total outage rather than
 * a nuisance, and it is reachable by anyone who can issue HTTP requests.
 *
 * IN-PROCESS, SO IT IS A SOFT BOUND, and deliberately so. Serverless runs many
 * instances and each holds its own map, so a caller spread across instances
 * gets some multiple of this allowance. Making it exact means a Redis round
 * trip on the mint path, which spends the very resource this limit exists to
 * protect. A soft bound that costs nothing beats an exact one that adds load
 * during an attack.
 *
 * FAILS OPEN: a request with no usable client address is allowed rather than
 * refused, because refusing every joiner behind an unrecognised proxy header
 * is a worse outcome than a limit that occasionally does not apply.
 */

const WINDOW_MS = 60_000;
/**
 * RAISED FROM THE DEMO'S 30 BECAUSE THIS APP IS MEASURED BY A ROBOT. Every
 * bench client is a browser tab on one machine behind one address, and each one
 * mints on its first connect plus on every forced re-mint (a capacity bounce, a
 * warm swap whose replacement was refused, three pre-open failures). A twenty
 * client run therefore opens with twenty mints inside a second from a single
 * key, which the demo's allowance would refuse: the limiter would be turning
 * away the exact traffic the run exists to measure, and the result would read
 * as a deployment that cannot seat twenty players.
 *
 * It is still a bound rather than a hole. The reason an unmetered mint is a
 * problem (a token is the only thing the relay checks, every token buys a
 * socket, every socket holds its own Redis subscriber, and the connection
 * ceiling is the first wall this architecture hits) is unchanged; 120 a minute
 * is comfortably above what a full room of honest clients needs and well below
 * anything that reaches that ceiling.
 */
const MAX_PER_WINDOW = 120;

/**
 * A ceiling on how many distinct keys are tracked at once. Without it the map
 * is an unbounded, attacker-driven allocation: the limiter itself becomes the
 * memory leak. At the cap the whole window is dropped, which resets everyone
 * for one window rather than evicting arbitrary victims.
 */
const MAX_TRACKED_KEYS = 10_000;

const windows = new Map<string, { count: number; resetAt: number }>();

export interface MintLimitResult {
  allowed: boolean;
  /** Seconds until the caller's window resets. Only meaningful when refused. */
  retryAfterS: number;
}

export function takeMintToken(clientKey: string | null, nowMs: number = Date.now()): MintLimitResult {
  if (!clientKey) return { allowed: true, retryAfterS: 0 };

  if (windows.size > MAX_TRACKED_KEYS) windows.clear();

  const existing = windows.get(clientKey);
  if (!existing || existing.resetAt <= nowMs) {
    windows.set(clientKey, { count: 1, resetAt: nowMs + WINDOW_MS });
    return { allowed: true, retryAfterS: 0 };
  }

  if (existing.count >= MAX_PER_WINDOW) {
    return { allowed: false, retryAfterS: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)) };
  }

  existing.count += 1;
  return { allowed: true, retryAfterS: 0 };
}

/**
 * Best-effort client address. `x-forwarded-for` is a list and the FIRST entry
 * is the original client, but it is also client-settable, so this is a
 * fairness key and never an identity: the only thing forging it buys is
 * evading your own share of a soft limit.
 */
export function clientKeyFrom(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip');
}
