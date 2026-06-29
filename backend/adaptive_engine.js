class AdaptiveEngine {
  constructor(alpha = 0.22) {
    this.alpha = alpha;
    this.models = new Map();
  }

  observe(section, metrics) {
    const previous = this.models.get(section) || {};
    const next = {};
    const anomalies = [];

    for (const [name, rawValue] of Object.entries(metrics || {})) {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) continue;
      const model = previous[name] || { samples: 0, mean: value, variance: 0 };
      const delta = value - model.mean;
      const mean = model.samples ? model.mean + this.alpha * delta : value;
      const variance = model.samples
        ? (1 - this.alpha) * (model.variance + this.alpha * delta * delta)
        : 0;
      const deviation = Math.sqrt(Math.max(variance, 0));
      const score = deviation > 0 ? Math.abs(value - mean) / deviation : 0;
      next[name] = { samples: model.samples + 1, mean, variance };
      if (model.samples >= 5 && score >= 2.8) {
        anomalies.push({
          metric: name,
          value,
          baseline: Number(mean.toFixed(2)),
          confidence: Number(Math.min(0.99, 0.55 + score / 10).toFixed(2)),
          direction: value > mean ? 'high' : 'low',
        });
      }
    }

    this.models.set(section, next);
    const health = Math.max(0, Math.round(100 - anomalies.reduce((sum, item) => sum + item.confidence * 22, 0)));
    return {
      section,
      health,
      learnedSamples: Math.max(0, ...Object.values(next).map((model) => model.samples)),
      anomalies,
      mode: 'adaptive-baseline',
    };
  }
}

module.exports = { AdaptiveEngine };
