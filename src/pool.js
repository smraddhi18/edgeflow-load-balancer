export class UpstreamPool {
  constructor(route, settings) {
    this.id = route.id;
    this.prefix = route.prefix;
    this.settings = settings;
    this.upstreams = route.upstreams.map((upstream) => ({
      ...upstream,
      healthy: false,
      consecutiveFailures: 0,
      ejectedUntil: 0,
      currentWeight: 0,
      activeRequests: 0,
      probing: false,
    }));
  }

  available(now = Date.now()) {
    return this.upstreams.filter((item) => item.healthy && item.ejectedUntil <= now);
  }

  select(excluded = new Set()) {
    const candidates = this.available().filter((item) => !excluded.has(item.id));
    if (candidates.length === 0) return null;

    // Smooth weighted round robin, scoped to healthy and non-ejected endpoints.
    let best = null;
    let totalWeight = 0;
    for (const item of candidates) {
      item.currentWeight += item.weight;
      totalWeight += item.weight;
      if (!best || item.currentWeight > best.currentWeight) best = item;
    }
    best.currentWeight -= totalWeight;
    return best;
  }

  reportSuccess(item) {
    item.consecutiveFailures = 0;
  }

  reportFailure(item) {
    item.consecutiveFailures += 1;
    if (item.consecutiveFailures >= this.settings.ejectAfterFailures) {
      item.ejectedUntil = Date.now() + this.settings.ejectForMs;
      item.consecutiveFailures = 0;
    }
  }
}
