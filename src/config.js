import { readFileSync } from 'node:fs';

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} must use lowercase letters, digits, underscores or hyphens`);
  }
  return value;
}

export function loadConfig(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  positiveInteger(data.listenPort, 'listenPort');
  if (data.listenPort > 65535) throw new Error('listenPort must be at most 65535');

  for (const field of [
    'healthIntervalMs', 'healthTimeoutMs', 'requestTimeoutMs',
    'ejectAfterFailures', 'ejectForMs', 'maxRetryAttempts',
  ]) {
    positiveInteger(data[field], field);
  }
  if (data.maxRetryAttempts > 3) throw new Error('maxRetryAttempts must be at most 3');

  const rate = data.rateLimit;
  if (!rate || typeof rate !== 'object') throw new Error('rateLimit is required');
  for (const field of ['requestsPerSecond', 'burst', 'maxClients']) {
    positiveInteger(rate[field], `rateLimit.${field}`);
  }

  if (!Array.isArray(data.routes) || data.routes.length === 0) {
    throw new Error('at least one route is required');
  }
  const routeIds = new Set();
  const prefixes = new Set();
  for (const route of data.routes) {
    identifier(route.id, 'route id');
    if (routeIds.has(route.id)) throw new Error(`duplicate route id: ${route.id}`);
    routeIds.add(route.id);
    if (typeof route.prefix !== 'string' || !route.prefix.startsWith('/')) {
      throw new Error(`route ${route.id} needs an absolute path prefix`);
    }
    if (prefixes.has(route.prefix)) throw new Error(`duplicate route prefix: ${route.prefix}`);
    prefixes.add(route.prefix);
    if (!Array.isArray(route.upstreams) || route.upstreams.length === 0) {
      throw new Error(`route ${route.id} needs upstreams`);
    }
    const upstreamIds = new Set();
    for (const upstream of route.upstreams) {
      identifier(upstream.id, 'upstream id');
      if (upstreamIds.has(upstream.id)) throw new Error(`duplicate upstream id: ${upstream.id}`);
      upstreamIds.add(upstream.id);
      positiveInteger(upstream.weight, `weight for ${upstream.id}`);
      if (upstream.weight > 100) throw new Error('upstream weight must be at most 100');
      const url = new URL(upstream.url);
      if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`upstream ${upstream.id} must be a plain HTTP origin`);
      }
      upstream.url = url.origin;
    }
  }
  return data;
}
