/**
 * Where the relay reaches the ticker, resolved by the adapter against the
 * incoming request's own origin. A relative path is right here: both routes
 * live in this one deployment.
 *
 * THE BYPASS PARAMETER IS LOAD BEARING WHENEVER DEPLOYMENT PROTECTION IS ON,
 * AND THE FAILURE IT FIXES IS SILENT.
 *
 * Vercel Deployment Protection guards EVERY request to a deployment, including
 * one function calling another on the same deployment. The relay's spawn fetch
 * is exactly that: an unauthenticated server-to-server request, which
 * Protection answers with a redirect to the SSO login rather than running the
 * route.
 *
 * The result is not an error anyone sees. The spawn is fire-and-forget with a
 * catch (correctly: a failed spawn must never take down a socket), so a socket
 * opens, joins, and then sits in perfect silence because no ticker was ever
 * started. Nothing in the logs says so, because from the relay's point of view
 * the fetch resolved, and `/api/ticker` simply never appears in the invocation
 * log at all. That absence is the only symptom, and on a bench it would read as
 * a deployment that cannot hold a room rather than as a configuration setting.
 *
 * A PUBLIC PRODUCTION DEPLOYMENT NEEDS NONE OF THIS, which is the intended way
 * to run the bench: Protection is off, this resolves to the bare `/api/ticker`
 * the README's quickstart uses, and the parameter is never sent. Setting
 * `VERCEL_AUTOMATION_BYPASS_SECRET` is the escape hatch for measuring a
 * PROTECTED deployment (a preview URL, or a project whose Protection was left
 * on), and it is harmless when Protection is off because the parameter is then
 * simply ignored. Carrying it as a query parameter rather than a header is what
 * makes it survive the adapter's `new URL(tickerUrl, requestUrl)` plus its
 * `searchParams.set` calls, so the room id and spawn token are appended
 * alongside it.
 */
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export const TICKER_URL = BYPASS
  ? `/api/ticker?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`
  : '/api/ticker';
