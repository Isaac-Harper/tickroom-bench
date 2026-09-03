import { requireSecret } from 'tickroom/server';

/**
 * The HMAC key behind both session tokens (what the relay trusts for a whole
 * socket's life) and spawn tokens (what stops an anonymous GET buying a
 * multi-minute authoritative tick loop).
 *
 * `requireSecret` is tickroom's own fail-closed resolver: it THROWS when
 * `SESSION_SECRET` is unset and `NODE_ENV` is production, and returns a
 * clearly-marked insecure fallback otherwise. A missing secret degrading
 * silently would mean every token in the deployment is forgeable with a value
 * printed in the library's source, which is worse than refusing to start.
 *
 * Practical consequence, and it is deliberate rather than an oversight:
 * `next build` runs with `NODE_ENV=production` and route modules are evaluated
 * during the build, so a build with no `SESSION_SECRET` in the environment
 * fails here. That is the guard working. Set any value for a local build
 * (`SESSION_SECRET=dummy npm run build`) and a real one in the deployment.
 */
export const SESSION_SECRET: string = requireSecret('SESSION_SECRET');
