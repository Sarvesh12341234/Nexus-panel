'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Lightweight, deterministic "Nexus Intelligence" layer.
 * It intentionally does not execute model-generated commands. It converts
 * telemetry into a health score, correlated incidents, predictions and
 * explainable recommendations. The heavier local model can consume this
 * compact state when enabled.
 */
class IntelligenceCore {
  constructor(root, options = {}) {
    this.root = root;
    this.file = path.join(root, 'data', 'intelligence-state.json');
    this.alpha = Number(options.alpha || 0.18);
    this.maxSamples = Number(options.maxSamples || 240);
    this.state = this._load();
  }

  _load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value && typeof value === 'object') return value;
    } catch {}
    return { version: 1, metrics: {}, incidents: [], actions: [], updatedAt: 0 };
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o750 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  _metricKey(scope, name) { return `${scope}:${name}`; }

  observe(scope, metrics = {}, metadata = {}) {
    const anomalies = [];
    for (const [name, raw] of Object.entries(metrics)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const key = this._metricKey(scope, name);
      const previous = this.state.metrics[key] || { samples: 0, mean: value, variance: 0, min: value, max: value };
      const delta = value - previous.mean;
      const mean = previous.samples ? previous.mean + this.alpha * delta : value;
      const variance = previous.samples
        ? Math.max(0, (1 - this.alpha) * (previous.variance + this.alpha * delta * delta))
        : 0;
      const sigma = Math.sqrt(variance);
      const z = sigma > 0 ? Math.abs(value - mean) / sigma : 0;
      this.state.metrics[key] = {
        samples: previous.samples + 1,
        mean,
        variance,
        min: Math.min(previous.min, value),
        max: Math.max(previous.max, value),
        last: value,
        updatedAt: Date.now(),
      };
      if (previous.samples >= 8 && z >= 3) {
        anomalies.push({ scope, metric: name, value, baseline: Number(mean.toFixed(2)), z: Number(z.toFixed(2)) });
      }
    }

    if (anomalies.length) {
      this.recordIncident({
        type: 'telemetry-anomaly',
        scope,
        severity: anomalies.some((a) => a.z >= 5) ? 'high' : 'medium',
        evidence: anomalies,
        metadata,
      });
    }
    this.state.updatedAt = Date.now();
    this._trim();
    this._save();
    return { anomalies, health: this.health(scope) };
  }

  recordIncident(incident) {
    const payload = {
      id: crypto.randomUUID(),
      at: Date.now(),
      type: String(incident.type || 'unknown').slice(0, 80),
      scope: String(incident.scope || 'system').slice(0, 120),
      severity: ['low', 'medium', 'high', 'critical'].includes(incident.severity) ? incident.severity : 'low',
      evidence: Array.isArray(incident.evidence) ? incident.evidence.slice(0, 20) : [],
      metadata: incident.metadata && typeof incident.metadata === 'object' ? incident.metadata : {},
      resolved: false,
    };
    const recent = this.state.incidents.find((item) => item.scope === payload.scope && item.type === payload.type && !item.resolved && Date.now() - item.at < 5 * 60 * 1000);
    if (recent) {
      recent.count = Number(recent.count || 1) + 1;
      recent.lastAt = payload.at;
      recent.evidence = payload.evidence;
      recent.severity = payload.severity;
      return recent;
    }
    this.state.incidents.unshift(payload);
    this._trim();
    this._save();
    return payload;
  }

  resolveIncident(id) {
    const incident = this.state.incidents.find((item) => item.id === id);
    if (!incident) return false;
    incident.resolved = true;
    incident.resolvedAt = Date.now();
    this._save();
    return true;
  }

  health(scope = null) {
    const incidents = this.state.incidents.filter((item) => !item.resolved && (!scope || item.scope === scope) && Date.now() - item.at < 15 * 60 * 1000);
    let score = 100;
    for (const incident of incidents) score -= ({ low: 5, medium: 12, high: 25, critical: 45 }[incident.severity] || 5);
    const recentAnomalies = incidents.filter((item) => item.type === 'telemetry-anomaly').length;
    score -= Math.min(15, recentAnomalies * 3);
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  predict(scope = null) {
    const now = Date.now();
    const open = this.state.incidents.filter((item) => !item.resolved && (!scope || item.scope === scope) && now - item.at < 30 * 60 * 1000);
    const predictions = [];
    const metrics = Object.entries(this.state.metrics).filter(([key]) => !scope || key.startsWith(`${scope}:`));
    for (const [key, model] of metrics) {
      if (model.samples < 10) continue;
      const spread = Math.sqrt(Math.max(model.variance, 0));
      if (!spread) continue;
      const trend = Number(model.last) - Number(model.mean);
      if (trend > spread * 2.2) predictions.push({ type: 'rising-metric', metric: key, confidence: Math.min(0.98, 0.55 + Math.abs(trend / spread) / 10), message: `${key} is trending above its learned baseline.` });
    }
    if (open.some((item) => item.type === 'native-startup' || item.type === 'telemetry-anomaly')) {
      predictions.push({ type: 'stability-risk', confidence: 0.82, message: 'Recent instability makes another restart likely; collect evidence before applying configuration repairs.' });
    }
    return predictions.slice(0, 12);
  }

  recommend(context = {}) {
    const scope = context.scope || 'system';
    const health = this.health(scope);
    const predictions = this.predict(scope);
    const recommendations = [];
    if (health < 60) recommendations.push({ priority: 'high', action: 'diagnose-first', reason: 'Health is degraded; gather evidence before mutation.' });
    if (predictions.some((p) => p.type === 'rising-metric')) recommendations.push({ priority: 'medium', action: 'inspect-resources', reason: 'A metric is deviating from its learned baseline.' });
    if (context.permissionError) recommendations.push({ priority: 'high', action: 'permission-audit', reason: 'Permission errors should be verified against owner, mode and path traversal before repair.' });
    if (context.nativeStartupFailure) recommendations.push({ priority: 'critical', action: 'native-forensics', reason: 'Native isolation failed before the application produced useful output.' });
    if (!recommendations.length) recommendations.push({ priority: 'low', action: 'observe', reason: 'No high-confidence repair is justified by current evidence.' });
    return { health, predictions, recommendations };
  }

  snapshot(scope = null) {
    const incidents = this.state.incidents.filter((item) => !scope || item.scope === scope).slice(0, 25);
    const metrics = Object.fromEntries(Object.entries(this.state.metrics).filter(([key]) => !scope || key.startsWith(`${scope}:`)).slice(0, 120));
    return { version: this.state.version, scope, health: this.health(scope), predictions: this.predict(scope), incidents, metrics, updatedAt: this.state.updatedAt };
  }

  _trim() {
    this.state.incidents = this.state.incidents.slice(0, this.maxSamples);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.state.incidents = this.state.incidents.filter((item) => item.at > cutoff || !item.resolved);
  }
}

module.exports = { IntelligenceCore };
