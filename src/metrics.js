const escapeLabel = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');

export class Metrics {
  constructor() {
    this.requests = new Map();
    this.attempts = new Map();
    this.startedAt = Date.now();
  }

  recordRequest(route, status) {
    const code = Number.isInteger(status) ? status : 500;
    const key = `${route}|${code}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
  }

  recordAttempt(route, upstream, result) {
    const key = `${route}|${upstream}|${result}`;
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
  }

  render(pools) {
    const lines = [
      '# HELP edgeflow_uptime_seconds Seconds since gateway startup.',
      '# TYPE edgeflow_uptime_seconds gauge',
      `edgeflow_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      '# HELP edgeflow_requests_total HTTP requests by route and response code.',
      '# TYPE edgeflow_requests_total counter',
    ];
    for (const [key, count] of this.requests) {
      const [route, status] = key.split('|');
      lines.push(`edgeflow_requests_total{route="${escapeLabel(route)}",status="${status}"} ${count}`);
    }
    lines.push('# HELP edgeflow_upstream_attempts_total Proxy attempts by outcome.');
    lines.push('# TYPE edgeflow_upstream_attempts_total counter');
    for (const [key, count] of this.attempts) {
      const [route, upstream, result] = key.split('|');
      lines.push(`edgeflow_upstream_attempts_total{route="${escapeLabel(route)}",upstream="${escapeLabel(upstream)}",result="${result}"} ${count}`);
    }
    lines.push('# HELP edgeflow_upstream_available Upstream is healthy and not ejected.');
    lines.push('# TYPE edgeflow_upstream_available gauge');
    lines.push('# HELP edgeflow_upstream_active_requests In-flight proxy requests.');
    lines.push('# TYPE edgeflow_upstream_active_requests gauge');
    for (const pool of pools) {
      const available = new Set(pool.available().map((item) => item.id));
      for (const item of pool.upstreams) {
        const labels = `route="${escapeLabel(pool.id)}",upstream="${escapeLabel(item.id)}"`;
        lines.push(`edgeflow_upstream_available{${labels}} ${available.has(item.id) ? 1 : 0}`);
        lines.push(`edgeflow_upstream_active_requests{${labels}} ${item.activeRequests}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
