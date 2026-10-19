// Guards that apply only to the route they are declared on.
//
// bfast-function mounts every `onGuard` with `app.use(route.path, onGuard)`. Express `use` ignores
// the HTTP method and matches the path as a prefix, so a guard written for `PUT /vendor/profile`
// also runs on `GET /vendor/profile`, and a guard on `GET /vendor/products` also runs on
// `PUT /vendor/products/:id` and `POST /vendor/products/:id/stock-adjustments`. The strictest guard
// on a path wins for every method and every sub-path, which locks people out of routes whose own
// guard lets them in.
//
// `routeGuard(method, guards)` returns the guards in the same shape (one function, or an array in
// the same order), each made to run only when the request is for that route: the same method (GET
// also covers HEAD) and the exact path. Any other request passes through to the guard of the route
// it is actually for.
//
// It fails closed: when the request carries no method, or the guard is not mounted under a path
// prefix (e.g. called directly by a spec, or mounted per route with app[method](path, ...)), the
// guard runs.

const normalise = method => String(method || '').trim().toUpperCase();

function forRoute(methods, guard) {
  const scoped = (req, res, next) => {
    const requestMethod = normalise(req?.method);
    if (requestMethod && !methods.has(requestMethod)) return next();
    // Under app.use(path, guard) Express strips the mount path: `baseUrl` is the mount and `path`
    // what is left ('/' for the route itself). A longer remainder is a sub-path with its own route.
    if (req?.baseUrl && typeof req.path === 'string' && req.path !== '/' && req.path !== '') return next();
    return guard(req, res, next);
  };
  scoped.routeMethods = [...methods];
  scoped.guard = guard;
  return scoped;
}

export function routeGuard(method, guards) {
  const methods = new Set([method].flat().map(normalise).filter(Boolean));
  if (!methods.size) throw new Error('routeGuard: a method is required');
  if (methods.has('GET')) methods.add('HEAD');
  const list = [guards].flat();
  if (!list.length || list.some(g => typeof g !== 'function')) throw new Error('routeGuard: guards must be functions');
  const scoped = list.map(g => forRoute(methods, g));
  return Array.isArray(guards) ? scoped : scoped[0];
}
