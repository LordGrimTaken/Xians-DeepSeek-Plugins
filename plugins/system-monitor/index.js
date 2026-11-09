/** Host half of the system-monitor bundle: one authenticated JSON route. */
import { sampleSystem } from './metrics.js';

export const name = 'system-monitor';
export const inject = ['webServer', 'connection'];

const ROUTE = '/system-monitor';

/**
 * GET /system-monitor: CPU delta since the previous poll, memory, uptime.
 * Browser authentication and host-origin trust are required (same check as other native capabilities).
 */
function respond(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET, HEAD');
    res.end();
    return;
  }
  const body = JSON.stringify(sampleSystem());
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: (req, res) => respond(ctx, req, res) }),
    `system-monitor: GET ${ROUTE}`,
  );
}
