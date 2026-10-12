import http from 'node:http';

function checkEndpoint(item, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get(`${item.url}/healthz`, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => request.destroy(new Error('health check timeout')));
    request.once('error', () => resolve(false));
  });
}

export function startHealthChecks(pools, settings) {
  let stopped = false;
  const probe = async (item) => {
    if (stopped || item.probing) return;
    item.probing = true;
    try {
      item.healthy = await checkEndpoint(item, settings.healthTimeoutMs);
    } finally {
      item.probing = false;
    }
  };

  const tick = () => {
    for (const pool of pools) {
      for (const item of pool.upstreams) void probe(item);
    }
  };
  tick();
  const timer = setInterval(tick, settings.healthIntervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
