import http from 'node:http';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function cleanHeaders(headers) {
  const connectionTokens = String(headers.connection ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase());
  const excluded = new Set([...HOP_HEADERS, ...connectionTokens]);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!excluded.has(key) && value !== undefined) result[key] = value;
  }
  return result;
}

function jsonError(response, status, code, requestId) {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify({ error: code, request_id: requestId });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestId,
  });
  response.end(body);
}

function proxyAttempt(incoming, endpoint, settings, requestId, agent) {
  const origin = new URL(endpoint.url);
  const headers = cleanHeaders(incoming.headers);
  for (const key of Object.keys(headers)) {
    if (key === 'forwarded' || key.startsWith('x-forwarded-')) delete headers[key];
  }
  headers.host = origin.host;
  headers['x-request-id'] = requestId;
  headers['x-forwarded-for'] = incoming.socket.remoteAddress ?? 'unknown';
  headers['x-forwarded-proto'] = 'http';

  const bodyExpected = Number(incoming.headers['content-length'] ?? 0) > 0
    || incoming.headers['transfer-encoding'] !== undefined;

  return new Promise((resolve, reject) => {
    endpoint.activeRequests += 1;
    let released = false;
    let upstreamResponse = null;
    const release = () => {
      if (released) return;
      released = true;
      endpoint.activeRequests -= 1;
    };
    const upstream = http.request({
      hostname: origin.hostname,
      port: origin.port || 80,
      method: incoming.method,
      path: incoming.url,
      headers,
      agent,
    });
    upstream.setTimeout(settings.requestTimeoutMs, () => {
      const error = new Error('upstream timeout');
      error.code = 'UPSTREAM_TIMEOUT';
      upstream.destroy(error);
    });
    upstream.once('response', (response) => {
      upstreamResponse = response;
      response.once('close', release);
      resolve(response);
    });
    upstream.once('error', (error) => {
      if (upstreamResponse) {
        upstreamResponse.destroy(error);
        return;
      }
      incoming.unpipe(upstream);
      incoming.resume();
      release();
      reject(error);
    });
    incoming.once('aborted', () => upstream.destroy(new Error('client aborted')));
    if (bodyExpected) incoming.pipe(upstream);
    else upstream.end();
  });
}

export async function forward(incoming, outgoing, pool, settings, metrics, requestId, agent) {
  const bodyExpected = Number(incoming.headers['content-length'] ?? 0) > 0
    || incoming.headers['transfer-encoding'] !== undefined;
  const safeMethod = incoming.method === 'GET' || incoming.method === 'HEAD';
  const canRetry = safeMethod && !bodyExpected;
  const maxAttempts = canRetry ? settings.maxRetryAttempts : 1;
  const tried = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (outgoing.destroyed) return;
    const endpoint = pool.select(tried);
    if (!endpoint) {
      jsonError(outgoing, 503, 'no_healthy_upstream', requestId);
      return;
    }
    tried.add(endpoint.id);

    let response;
    try {
      response = await proxyAttempt(incoming, endpoint, settings, requestId, agent);
    } catch (error) {
      pool.reportFailure(endpoint);
      metrics.recordAttempt(pool.id, endpoint.id, 'network_error');
      if (attempt + 1 < maxAttempts && pool.available().some((item) => !tried.has(item.id))) continue;
      const timeout = error.code === 'UPSTREAM_TIMEOUT';
      jsonError(outgoing, timeout ? 504 : 502, timeout ? 'upstream_timeout' : 'upstream_error', requestId);
      return;
    }

    const failed = response.statusCode >= 500;
    if (failed) pool.reportFailure(endpoint);
    else pool.reportSuccess(endpoint);

    const retry = canRetry && RETRYABLE_STATUS.has(response.statusCode)
      && attempt + 1 < maxAttempts
      && pool.available().some((item) => !tried.has(item.id));
    if (retry) {
      metrics.recordAttempt(pool.id, endpoint.id, 'retried_response');
      response.resume();
      continue;
    }

    metrics.recordAttempt(pool.id, endpoint.id, failed ? 'upstream_5xx' : 'success');
    const headers = cleanHeaders(response.headers);
    headers['x-request-id'] = requestId;
    headers['x-edgeflow-upstream'] = endpoint.id;
    outgoing.writeHead(response.statusCode, headers);
    response.once('error', () => outgoing.destroy());
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) response.destroy();
    });
    response.pipe(outgoing);
    return;
  }
}
