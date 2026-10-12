import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { loadConfig } from './config.js';
import { startHealthChecks } from './health.js';
import { TokenBucketLimiter } from './limiter.js';
import { log } from './log.js';
import { Metrics } from './metrics.js';
import { UpstreamPool } from './pool.js';
import { forward } from './proxy.js';

const settings = loadConfig(process.env.CONFIG_PATH ?? './config/local.json');
const pools = settings.routes.map((route) => new UpstreamPool(route, settings))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const limiter = new TokenBucketLimiter(settings.rateLimit);
const metrics = new Metrics();
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const stopHealthChecks = startHealthChecks(pools, settings);

function reply(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function matchesPrefix(pathname, prefix) {
  return prefix === '/' || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const server = http.createServer((request, response) => {
  const started = Date.now();
  const requestId = randomUUID();
  let routeId = 'local';
  let loggedPath = '/';
  response.once('finish', () => {
    metrics.recordRequest(routeId, response.statusCode);
    log('info', 'request_finished', {
      request_id: requestId,
      method: request.method,
      path: loggedPath,
      route: routeId,
      status: response.statusCode,
      duration_ms: Date.now() - started,
    });
  });

  let pathname;
  try {
    pathname = new URL(request.url, 'http://edgeflow.local').pathname;
    loggedPath = pathname;
  } catch {
    reply(response, 400, { error: 'invalid_url', request_id: requestId });
    return;
  }

  if (pathname === '/livez') {
    reply(response, 200, { status: 'alive' });
    return;
  }
  if (pathname === '/readyz') {
    const ready = pools.every((pool) => pool.available().length > 0);
    reply(response, ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' });
    return;
  }
  if (pathname === '/metrics') {
    const body = metrics.render(pools);
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }

  const pool = pools.find((candidate) => matchesPrefix(pathname, candidate.prefix));
  if (!pool) {
    reply(response, 404, { error: 'route_not_found', request_id: requestId });
    return;
  }
  routeId = pool.id;
  const clientIp = request.socket.remoteAddress ?? 'unknown';
  if (!limiter.allow(clientIp)) {
    reply(response, 429, { error: 'rate_limited', request_id: requestId }, { 'retry-after': '1' });
    return;
  }
  void forward(request, response, pool, settings, metrics, requestId, agent).catch((error) => {
    log('error', 'proxy_failure', { request_id: requestId, message: error.message });
    if (!response.headersSent && !response.destroyed) {
      reply(response, 502, { error: 'proxy_failure', request_id: requestId });
    } else {
      response.destroy();
    }
  });
});

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(settings.listenPort, '0.0.0.0', () => {
  log('info', 'gateway_started', { port: settings.listenPort, routes: pools.map((pool) => pool.id) });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });
  stopHealthChecks();
  server.close(() => {
    agent.destroy();
    log('info', 'shutdown_complete');
  });
  const deadline = setTimeout(() => {
    log('error', 'shutdown_deadline_exceeded');
    process.exitCode = 1;
    server.closeAllConnections();
    agent.destroy();
  }, 10_000);
  deadline.unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
