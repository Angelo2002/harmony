// Focused check for login throttling.
//
// The login route carries two independent budgets: one keyed on the client
// address, one keyed on the submitted account. This builds a small Fastify app
// around the real route and limiter, with a service whose login always fails,
// and proves that rotating the address (what an attacker does when
// HARMONY_TRUST_PROXY is on behind a proxy that forwards the header) does not
// reset the account's budget, while a different account keeps its own.
//
// Run with: npm run smoke:auth --workspace @harmony/server
import Fastify from 'fastify';
import { HttpError, registerErrorHandler } from '../src/http/errors.ts';
import { registerAuthRoutes } from '../src/routes/auth.ts';

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

/** A service whose login always fails, so only the limiter can produce a 429. */
const service = {
  async login() {
    throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
  },
  async register() {
    throw new HttpError(500, 'internal_error', 'not exercised by this check');
  },
  sessionForUser() {
    return null;
  },
  signInWithDiscord() {
    throw new HttpError(500, 'internal_error', 'not exercised by this check');
  },
  logout() {},
  resolveToken() {
    return null;
  },
};

async function makeApp() {
  // trustProxy mirrors a deployment behind a reverse proxy: the request IP is
  // read from X-Forwarded-For, which this check rotates between attempts.
  const app = Fastify({ trustProxy: true, logger: false });
  registerErrorHandler(app);
  registerAuthRoutes(app, { service, config: { cookieName: 'harmony_session', cookieSecure: false } });
  await app.ready();
  return app;
}

function attempt(app, username, forwardedFor) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: 'definitely-wrong' },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
}

// 1. A rotating address must not reset one account's budget. Each of the first
//    ten attempts arrives from a different address, so the address budget alone
//    cannot stop the eleventh; only the account budget can.
{
  const app = await makeApp();
  const statuses = [];
  for (let i = 0; i < 10; i += 1) {
    statuses.push((await attempt(app, 'victim', `203.0.113.${i + 1}`)).statusCode);
  }
  check('ten rotated-address attempts for one account are 401', statuses.every((s) => s === 401), statuses.join(','));

  const eleventh = await attempt(app, 'victim', '203.0.113.250');
  check(
    'the eleventh attempt for the same account is 429 despite a new address',
    eleventh.statusCode === 429 && eleventh.json()?.error?.code === 'rate_limited',
    `status ${eleventh.statusCode}`,
  );
  await app.close();
}

// 2. The budget is per account, not global: a different account from a fresh
//    address still gets its own attempts while another account is exhausted.
{
  const app = await makeApp();
  for (let i = 0; i < 10; i += 1) await attempt(app, 'victim', `203.0.113.${i + 1}`);
  check(
    'the exhausted account is 429',
    (await attempt(app, 'victim', '203.0.113.251')).statusCode === 429,
  );
  const other = await attempt(app, 'bystander', '198.51.100.7');
  check('a different account from a fresh address is still 401', other.statusCode === 401, `status ${other.statusCode}`);
  await app.close();
}

// 3. The address budget still stands on its own: many accounts from one address
//    are stopped even though each account is new.
{
  const app = await makeApp();
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    statuses.push((await attempt(app, `spray${i}`, '192.0.2.9')).statusCode);
  }
  check('the first ten accounts from one address are 401', statuses.slice(0, 10).every((s) => s === 401), statuses.join(','));
  check('the eleventh account from one address is 429', statuses[10] === 429, statuses.join(','));
  await app.close();
}

console.log(failures === 0 ? '\nAll auth-throttle checks passed.' : `\n${failures} auth-throttle check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
