export class TokenBucketLimiter {
  constructor({ requestsPerSecond, burst, maxClients }) {
    this.rate = requestsPerSecond / 1000;
    this.burst = burst;
    this.maxClients = maxClients;
    this.clients = new Map();
  }

  allow(clientId, now = Date.now()) {
    let bucket = this.clients.get(clientId);
    if (!bucket) {
      if (this.clients.size >= this.maxClients) this.evictOldest(now);
      bucket = { tokens: this.burst, updatedAt: now };
    } else {
      bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.updatedAt) * this.rate);
      bucket.updatedAt = now;
      this.clients.delete(clientId);
    }
    this.clients.set(clientId, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  evictOldest(now) {
    for (const [key, bucket] of this.clients) {
      if (now - bucket.updatedAt > 60_000) this.clients.delete(key);
      if (this.clients.size < this.maxClients) return;
    }
    // Bounds memory under high-cardinality client traffic.
    this.clients.delete(this.clients.keys().next().value);
  }
}
