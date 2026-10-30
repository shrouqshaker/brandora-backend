// Inspect the actual build used by the PostgreSQL HTTP verifiers. No reports or
// archived sources are inputs; npm test's pretest builds dist before discovery.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RequestMethod } = require('@nestjs/common');
const {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
} = require('@nestjs/common/constants');
const root = path.resolve(__dirname, '..');
const publicPaths = new Set([
  '/auth/register',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/forgot-password',
  '/auth/reset-password',
]);

function controllerRoutes() {
  const { AUTH_SCOPE } = require('../dist/auth/auth-policy');
  const routes = [];
  for (const file of fs.readdirSync(path.join(root, 'dist'), {
    recursive: true,
  })) {
    if (!file.endsWith('.controller.js')) continue;
    const exports = require(path.join(root, 'dist', file));
    for (const controller of Object.values(exports)) {
      if (!controller?.prototype) continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        if (
          name === 'constructor' ||
          typeof handler !== 'function' ||
          !Reflect.hasMetadata(METHOD_METADATA, handler)
        )
          continue;
        const prefixes = [
          Reflect.getMetadata(PATH_METADATA, controller),
        ].flat();
        const suffixes = [Reflect.getMetadata(PATH_METADATA, handler)].flat();
        for (const prefix of prefixes)
          for (const suffix of suffixes) {
            routes.push({
              verb: RequestMethod[
                Reflect.getMetadata(METHOD_METADATA, handler)
              ],
              route:
                '/' +
                [prefix, suffix]
                  .filter(Boolean)
                  .join('/')
                  .replace(/^\/+|\/+$/g, ''),
              scope:
                Reflect.getMetadata(AUTH_SCOPE, handler) ??
                Reflect.getMetadata(AUTH_SCOPE, controller),
              guards: [
                ...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []),
                ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
              ],
            });
          }
      }
    }
  }
  return routes.sort(
    (a, b) => a.route.localeCompare(b.route) || a.verb.localeCompare(b.verb),
  );
}

function verifyRoutePolicy({ verb, route, scope, guards }) {
  const { AuthRateGuard } = require('../dist/auth/auth-rate.guard');
  let expected;
  if (verb === 'GET' && route === '/.well-known/assetlinks.json')
    expected = 'public';
  else if (verb === 'POST' && publicPaths.has(route)) expected = 'public';
  else if (
    (route === '/auth/me' && verb === 'GET') ||
    (route === '/auth/logout-all' && verb === 'POST') ||
    (route === '/businesses' && ['GET', 'POST'].includes(verb))
  )
    expected = 'identity';
  else if (route.includes(':importId')) expected = 'import';
  else if (route.includes(':businessId')) expected = 'params';
  else if (route.startsWith('/catalog-items'))
    expected = ['POST', 'PATCH'].includes(verb) ? 'body' : 'query';
  assert.ok(expected, `No reviewed policy for ${verb} ${route}`);
  assert.equal(scope, expected, `${verb} ${route}`);
  if (expected === 'public' && publicPaths.has(route))
    assert.ok(
      guards.includes(AuthRateGuard),
      `Missing rate guard: ${verb} ${route}`,
    );
}

function verifyControllerInventory(routes = controllerRoutes()) {
  for (const route of routes) verifyRoutePolicy(route);
  assert.equal(
    new Set(routes.map((r) => `${r.verb} ${r.route}`)).size,
    routes.length,
    'Duplicate routes',
  );
  assert.equal(
    routes.length,
    49,
    'Review the policy and endpoint inventory when adding routes',
  );
  const publicCount = routes.filter((r) => r.scope === 'public').length;
  assert.equal(publicCount, 7);
  return {
    routes: routes.length,
    protected: routes.length - publicCount,
    public: publicCount,
    mismatches: 0,
  };
}

module.exports = {
  controllerRoutes,
  verifyRoutePolicy,
  verifyControllerInventory,
};
if (require.main === module) {
  console.log(
    'PASS: compiled controller policy inventory',
    verifyControllerInventory(),
  );
}
