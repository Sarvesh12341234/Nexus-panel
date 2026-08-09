'use strict';

const MAX_ROUTES = 256;
const MAX_SAMPLES = 32;

class PerformanceMonitor {
  constructor() {
    this.routes = new Map();
    this.startedAt = Date.now();
    this.inFlight = 0;
    this.total = 0;
    this.errors = 0;
  }

  middleware() {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      this.inFlight += 1;
      this.total += 1;
      res.setHeader('X-Nexus-Request-Id', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      res.once('finish', () => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (res.statusCode >= 500) this.errors += 1;
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const key = `${req.method} ${req.route?.path || req.path}`;
        const item = this.routes.get(key) || { count: 0, errors: 0, samples: [] };
        item.count += 1;
        if (res.statusCode >= 500) item.errors += 1;
        item.samples.push(Number(ms.toFixed(2)));
        if (item.samples.length > MAX_SAMPLES) item.samples.shift();
        this.routes.set(key, item);
        if (this.routes.size > MAX_ROUTES) this.routes.delete(this.routes.keys().next().value);
      });
      next();
    };
  }

  snapshot() {
    const routes = [...this.routes.entries()].map(([route, item]) => {
      const samples = [...item.samples].sort((a, b) => a - b);
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] : 0;
      return { route, count: item.count, errors: item.errors, avgMs: Number(avg.toFixed(2)), p95Ms: Number(p95.toFixed(2)) };
    }).sort((a, b) => b.p95Ms - a.p95Ms);
    return {
      uptimeMs: Date.now() - this.startedAt,
      requests: this.total,
      errors: this.errors,
      inFlight: this.inFlight,
      slowest: routes.slice(0, 10),
    };
  }
}

module.exports = { PerformanceMonitor };
