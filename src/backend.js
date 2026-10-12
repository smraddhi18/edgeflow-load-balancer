import http from 'node:http';

import { log } from './log.js';

const instance = process.env.INSTANCE_ID ?? 'backend-local';
const port = Number(process.env.PORT ?? 9000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-instance-id': instance,
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://backend.local');
  if (url.pathname === '/healthz') {
    send(response, 200, { status: 'healthy', instance });
    return;
  }

  // One replica fails this demo path so safe-method failover is visible.
  if (url.pathname === '/unstable' && instance === 'backend-c') {
    send(response, 503, { error: 'simulated_failure', instance });
    return;
  }

  let bodyBytes = 0;
  let tooLarge = false;
  request.on('data', (chunk) => {
    if (tooLarge) return;
    bodyBytes += chunk.length;
    if (bodyBytes > 1_048_576) {
      tooLarge = true;
      send(response, 413, { error: 'body_too_large', instance });
    }
  });
  request.once('end', () => {
    if (response.writableEnded) return;
    send(response, 200, {
      instance,
      method: request.method,
      path: url.pathname,
      request_id: request.headers['x-request-id'] ?? null,
      body_bytes: bodyBytes,
    });
  });
  request.once('error', (error) => {
    log('error', 'backend_request_error', { instance, message: error.message });
  });
});

server.listen(port, '0.0.0.0', () => log('info', 'backend_started', { instance, port }));
process.on('SIGTERM', () => server.close(() => log('info', 'backend_stopped', { instance })));
process.on('SIGINT', () => server.close(() => log('info', 'backend_stopped', { instance })));
