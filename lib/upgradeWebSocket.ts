import { experimental_upgradeWebSocket } from '@vercel/functions';

/**
 * THE SINGLE PLACE THIS APP NAMES THE HOSTING PLATFORM, and it is not a cast.
 *
 * tickroom's Vercel adapter takes `upgradeWebSocket` by injection rather than
 * importing `@vercel/functions` itself, so the identical relay logic runs
 * behind a plain `ws` server on a VM. This file is the seam that injection
 * creates, and it is its own module so that swapping the platform is one import
 * to change rather than a search.
 *
 * The library declares the real signature (`(handler, options?) =>
 * Promise<Response>`), so the export satisfies it structurally with nothing
 * asserted here. The socket type still differs and still needs no cast: the
 * platform hands over a `ws` `WebSocket` while the library's parameter is
 * `any`, the structural minimum a relay actually calls, and `any` is what lets
 * the two declarations meet without either package knowing about the other.
 */
export const upgradeWebSocket = experimental_upgradeWebSocket;
