'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOOL_TEMPLATES = [
  ['health.snapshot', 'GET', '/api/health', 'read-only', 'Inspect panel/database/host health.'],
  ['host.metrics', 'GET', '/api/system/metrics', 'read-only', 'Inspect host CPU, memory, disk and pressure metrics.'],
  ['server.metrics', 'GET', '/api/servers/:id/metrics', 'read-only', 'Inspect live server resource metrics.'],
  ['server.live', 'GET', '/api/live', 'read-only', 'Inspect live server/runtime state.'],
  ['server.info', 'GET', '/api/servers/:id', 'read-only', 'Inspect server configuration and runtime metadata.'],
  ['server.console', 'GET', '/api/servers/:id/console', 'read-only', 'Read recent server console output.'],
  ['server.files.list', 'GET', '/api/servers/:id/files', 'read-only', 'List files inside the server root.'],
  ['server.file.read', 'GET', '/api/servers/:id/files/:path', 'read-only', 'Read a server file after path validation.'],
  ['server.plugins', 'GET', '/api/servers/:id/plugins', 'read-only', 'Inspect installed plugins/mods.'],
  ['server.backups', 'GET', '/api/servers/:id/backups', 'read-only', 'Inspect available backups.'],
  ['server.start', 'POST', '/api/servers/:id/start', 'medium', 'Start a stopped server.'],
  ['server.stop', 'POST', '/api/servers/:id/stop', 'medium', 'Stop a running server.'],
  ['server.restart', 'POST', '/api/servers/:id/restart', 'high', 'Restart a server after stability gates.'],
  ['server.command', 'POST', '/api/servers/:id/command', 'medium', 'Send a server console command.'],
  ['server.create', 'POST', '/api/servers', 'high', 'Create a new isolated server definition.'],
  ['server.delete', 'DELETE', '/api/servers/:id', 'critical', 'Delete a server; backup/owner approval required.'],
  ['file.write', 'PUT', '/api/servers/:id/files/:path', 'high', 'Write a validated server file with backup-first policy.'],
  ['file.delete', 'DELETE', '/api/servers/:id/files/:path', 'critical', 'Delete a validated server file; never use for arbitrary paths.'],
  ['permissions.audit', 'GET', '/api/permissions/audit', 'read-only', 'Audit ownership, modes, ACLs and traversal.'],
  ['permissions.repair', 'POST', '/api/permissions/repair', 'high', 'Repair only validated permission/ownership defects.'],
  ['nexusmark.status', 'GET', '/api/nexus-mark/status', 'read-only', 'Inspect Nexus-Mark capabilities and selected isolation tier.'],
  ['nexusmark.diagnostics', 'POST', '/api/nexus-mark/diagnostics', 'read-only', 'Collect native sandbox diagnostics without mutation.'],
  ['nexusmark.profile', 'GET', '/api/servers/:id/nexus-mark', 'read-only', 'Inspect the effective server isolation profile.'],
  ['intelligence.snapshot', 'GET', '/api/intelligence', 'read-only', 'Read learned health, incidents, predictions and baselines.'],
  ['intelligence.recommend', 'GET', '/api/intelligence/recommendations', 'read-only', 'Get evidence-backed recommendations.'],
  ['intelligence.incident', 'POST', '/api/intelligence/incident', 'medium', 'Record an incident/evidence event for continuous learning.'],
  ['intelligence.resolve', 'POST', '/api/intelligence/incident/:id/resolve', 'medium', 'Mark a confirmed incident resolved.'],
  ['ai.status', 'GET', '/api/advanced-ai/status', 'read-only', 'Inspect AI engine/model/tool registry state.'],
  ['ai.assess', 'POST', '/api/advanced-ai/assess', 'read-only', 'Run deterministic forensic assessment.'],
  ['ai.reason', 'POST', '/api/advanced-ai/reason', 'read-only', 'Generate an evidence-bound repair plan.'],
  ['ai.learn', 'POST', '/api/advanced-ai/learn', 'medium', 'Record owner feedback and repair outcome.'],
  ['repair.status', 'GET', '/api/repair/agent/status', 'read-only', 'Inspect repair agent state.'],
  ['repair.tools', 'GET', '/api/repair/agent/tools', 'read-only', 'Discover typed repair tools.'],
  ['repair.tool.execute', 'POST', '/api/repair/agent/tools/execute', 'high', 'Execute a registered typed tool after authorization.'],
  ['repair.command.queue', 'POST', '/api/repair/agent/commands', 'high', 'Queue a host command for explicit approval.'],
  ['repair.command.approve', 'POST', '/api/repair/agent/commands/:id/approve', 'critical', 'Owner-approved host command execution.'],
  ['repair.episode.feedback', 'POST', '/api/repair/agent/episodes/:id/feedback', 'medium', 'Train repair weights from owner feedback.'],
  ['optimizer.status', 'GET', '/api/optimizer/status', 'read-only', 'Inspect optimizer state.'],
  ['optimizer.plan', 'GET', '/api/optimizer/plan', 'read-only', 'Generate bounded optimization recommendations.'],
  ['optimizer.apply', 'POST', '/api/optimizer/apply', 'high', 'Apply bounded optimizer changes.'],
  ['network.metrics', 'GET', '/api/network/metrics', 'read-only', 'Inspect network health.'],
  ['network.download', 'GET', '/api/network/download-test', 'read-only', 'Run a bounded download test.'],
  ['network.upload', 'POST', '/api/network/upload-test', 'medium', 'Run a bounded upload test.'],
  ['host-agent.status', 'GET', '/api/host-agent/status', 'read-only', 'Inspect host agent capability/status.'],
  ['security.render', 'GET', '/api/security/render', 'read-only', 'Inspect security policy rendering.'],
  ['database.health', 'GET', '/api/database/health', 'read-only', 'Inspect database integrity/health.'],
  ['database.backup', 'POST', '/api/database/backup', 'medium', 'Create a database backup.'],
  ['templates.list', 'GET', '/api/templates', 'read-only', 'Discover available server templates.'],
  ['software.catalog', 'GET', '/api/software', 'read-only', 'Inspect software/runtime catalog.'],
  ['platform.detect', 'GET', '/api/platform', 'read-only', 'Inspect cross-platform capabilities.'],
  ['performance.snapshot', 'GET', '/api/performance', 'read-only', 'Inspect route latency, request pressure and recent server-side errors.'],
  ['terminal.run', 'POST', '/api/terminal/run', 'critical', 'Run an owner-authenticated terminal command; never automatic.'],
  ['terminal.session', 'POST', '/api/terminal/session', 'high', 'Create an interactive terminal session after authorization.'],
  ['terminal.output', 'GET', '/api/terminal/session/:sessionId/output', 'read-only', 'Read bounded interactive terminal output.'],
  ['terminal.input', 'POST', '/api/terminal/session/:sessionId/input', 'critical', 'Send input to an interactive terminal; never automatic.'],
  ['server.timeline', 'GET', '/api/servers/:id/timeline', 'read-only', 'Read the server incident/event timeline.'],
  ['fixed.logs', 'GET', '/api/fixed/logs', 'read-only', 'Inspect verified repair history.'],
  ['world.converter.status', 'GET', '/api/world-converter/status', 'read-only', 'Inspect world converter capability.'],
  ['settings.nexusmark.doctor', 'POST', '/api/settings/nexusmark/doctor', 'high', 'Run Nexus-Mark configuration diagnostics; no automatic arbitrary changes.'],
];

function riskOf(method, endpoint) {
  if (method === 'GET') return 'read-only';
  if (/delete/i.test(endpoint)) return 'critical';
  if (/approve|command|write|permissions|optimizer\/apply/i.test(endpoint)) return 'high';
  return 'medium';
}

function sourceRouteInventory() {
  const source = path.join(__dirname, 'index.js');
  let text = '';
  try { text = fs.readFileSync(source, 'utf8'); } catch { return []; }
  const seen = new Set();
  const routes = [];
  const pattern = /app\.(get|post|put|patch|delete)\(['"]([^'"]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const method = match[1].toUpperCase();
    const endpoint = match[2];
    if (!endpoint.startsWith('/api/')) continue;
    const key = `${method} ${endpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index);
    const context = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const permission = context.match(/requirePermission\(([^)]*)\)/)?.[1] || (context.includes('requireAuth') ? 'AUTHENTICATED' : 'PUBLIC');
    routes.push({ id: `route.${routes.length + 1}`, method, endpoint, risk: riskOf(method, endpoint), permission, source: 'live-route-inventory' });
  }
  return routes;
}

function search(query, limit = 12) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return registry().templates.slice(0, limit);
  const terms = needle.split(/\s+/).filter(Boolean);
  return registry().templates.map((tool) => {
    const haystack = `${tool.id} ${tool.method} ${tool.endpoint} ${tool.description} ${tool.risk}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? (haystack.startsWith(term) ? 3 : 1) : 0), 0);
    return { ...tool, relevance: score };
  }).filter((tool) => tool.relevance > 0).sort((a, b) => b.relevance - a.relevance).slice(0, Math.max(1, Math.min(50, Number(limit) || 12)));
}

function registry() {
  const templates = TOOL_TEMPLATES.map(([id, method, endpoint, risk, description]) => ({ id, method, endpoint, risk, description, typed: true }));
  const routes = sourceRouteInventory();
  const known = new Set(templates.map((item) => `${item.method} ${item.endpoint}`));
  for (const route of routes) {
    if (!known.has(`${route.method} ${route.endpoint}`)) templates.push({
      ...route,
      typed: false,
      description: 'Discovered panel API route. AI may inspect it, but cannot invoke an untyped mutating route automatically.',
    });
  }
  return {
    version: 1,
    generatedAt: Date.now(),
    templates,
    counts: {
      total: templates.length,
      typed: templates.filter((item) => item.typed).length,
      discovered: routes.length,
      readOnly: templates.filter((item) => item.risk === 'read-only').length,
      mutating: templates.filter((item) => item.risk !== 'read-only').length,
    },
    policy: {
      allowReadOnlyAuto: true,
      allowTypedMutationWithOwnerGate: true,
      allowUntypedMutationAuto: false,
      allowArbitraryShellAuto: false,
      requireEvidenceBeforeMutation: true,
      requirePostRepairVerification: true,
    },
  };
}

function compactForPrompt(limit = 12000) {
  const data = registry();
  const text = data.templates.map((tool) => `${tool.id}|${tool.method}|${tool.endpoint}|risk=${tool.risk}|typed=${tool.typed}|${tool.description}`).join('\n');
  return text.slice(0, limit);
}

module.exports = { registry, compactForPrompt, search, TOOL_TEMPLATES };
