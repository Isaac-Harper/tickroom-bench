import { createBalancerRoute } from 'tickroom/adapters/vercel';

import { BASE, MAX_PLAYERS, NAMESPACE, isValidBase } from '@/lib/rooms';

export const runtime = 'nodejs';

/**
 * `/api/room?base=pong[&not=pong,pong~1]` answers which room INSTANCE a joiner
 * should connect to: the lowest-index one with spare capacity, so joiners pack
 * toward instance 0 and higher instances stay empty (and drain their tickers)
 * until they are needed.
 *
 * IT IS HERE FOR THE RE-ASSIGN RECIPE RATHER THAN FOR EVERYDAY TRAFFIC, and the
 * distinction matters to how a run is read. A bench run wants every client in
 * ONE room, because a populated room is the thing being measured, so the page
 * asks for the room named in its own `?room=` and this route only comes into it
 * when a client is bounced for capacity. That is the path the README documents
 * (`onTerminal('capacity')` then `start({ remint: true })`), and without an
 * endpoint to call it is prose rather than something a run can exercise.
 *
 * PASS EVERY ROOM YOU WERE REFUSED FROM, not just the last one. This route
 * reads a stats key with a 5s TTL while the ticker enforces capacity
 * authoritatively, so the two disagree for up to a window: with one id a client
 * ping-pongs between two rooms and burns its whole bounded re-assign budget,
 * and the player is told the game is full while seats are free. `game/pong.ts`
 * keeps the list and sends all of it.
 */
export const GET = createBalancerRoute({
  isValidBase,
  fallbackBase: BASE,
  // The same number the relay admits on and the simulation seats. Three copies
  // of a capacity is three chances for two of them to disagree, which reaches a
  // player as a room the balancer keeps handing out and the relay keeps
  // refusing; `MAX_PLAYERS` is the one definition.
  maxPlayers: MAX_PLAYERS,
  // Shared Redis. See the comment on NAMESPACE in lib/rooms.ts.
  namespace: NAMESPACE,
});
