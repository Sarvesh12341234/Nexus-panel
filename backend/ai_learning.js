'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class AILearningStore {
  constructor(root, options = {}) {
    this.file = path.join(root, 'data', 'ai-learning.json');
    this.maxEpisodes = Number(options.maxEpisodes || 500);
    this.state = this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value && typeof value === 'object') return value;
    } catch {}
    return { version: 1, episodes: [], skills: {}, toolStats: {}, updatedAt: 0 };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o750 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  fingerprint(input) {
    const text = JSON.stringify({
      diagnosis: input?.diagnosis || '',
      category: input?.category || '',
      tools: input?.tools || [],
      platform: input?.platform || '',
      software: input?.software || '',
    });
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
  }

  learn(input = {}) {
    const reward = Math.max(-1, Math.min(1, Number(input.reward || 0)));
    const category = String(input.category || 'unknown').slice(0, 80);
    const tool = String(input.tool || 'none').slice(0, 120);
    const fingerprint = this.fingerprint(input);
    const episode = {
      id: crypto.randomUUID(),
      at: Date.now(),
      fingerprint,
      reward,
      category,
      tool,
      diagnosis: String(input.diagnosis || '').slice(0, 500),
      outcome: String(input.outcome || '').slice(0, 500),
      platform: String(input.platform || '').slice(0, 40),
      verified: input.verified === true,
    };
    this.state.episodes.unshift(episode);
    const skill = this.state.skills[category] || { attempts: 0, reward: 0, confidence: 0.5 };
    skill.attempts += 1;
    skill.reward = Number((skill.reward * 0.85 + reward * 0.15).toFixed(4));
    skill.confidence = Number(Math.min(0.99, Math.max(0.05, 0.5 + skill.reward * 0.45)).toFixed(4));
    skill.updatedAt = Date.now();
    this.state.skills[category] = skill;
    const stat = this.state.toolStats[tool] || { attempts: 0, successes: 0, reward: 0 };
    stat.attempts += 1;
    if (reward > 0) stat.successes += 1;
    stat.reward = Number((stat.reward * 0.85 + reward * 0.15).toFixed(4));
    stat.successRate = Number((stat.successes / Math.max(1, stat.attempts)).toFixed(4));
    this.state.toolStats[tool] = stat;
    this.state.updatedAt = Date.now();
    this.trim();
    this.save();
    return episode;
  }

  trim() {
    this.state.episodes = this.state.episodes.slice(0, this.maxEpisodes);
  }

  rank(category, tools = []) {
    const skill = this.state.skills[String(category || 'unknown')];
    const base = skill?.confidence || 0.5;
    return tools.map((tool) => {
      const stat = this.state.toolStats[tool.id || tool] || {};
      return {
        ...tool,
        learnedConfidence: Number(Math.max(0.05, Math.min(0.99, base * 0.65 + Number(stat.successRate || 0.5) * 0.35)).toFixed(3)),
        attempts: stat.attempts || 0,
      };
    }).sort((a, b) => b.learnedConfidence - a.learnedConfidence);
  }

  summary() {
    return {
      version: this.state.version,
      episodes: this.state.episodes.length,
      skills: Object.keys(this.state.skills).length,
      tools: Object.keys(this.state.toolStats).length,
      updatedAt: this.state.updatedAt,
      topSkills: Object.entries(this.state.skills).sort((a, b) => b[1].confidence - a[1].confidence).slice(0, 12).map(([name, value]) => ({ name, ...value })),
    };
  }
}

module.exports = { AILearningStore };
