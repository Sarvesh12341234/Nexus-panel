'use strict';

const contract = require('../ai/needle2/repair-tools.json');

const REPAIR_TOOL_DIAGNOSTICS = Object.freeze({
  repair_server_properties: ['properties-path', 'properties-syntax', 'properties-value', 'properties-encoding'],
  repair_missing_executable: ['jar-corrupt'],
  install_bundled_java_runtime: ['java-missing', 'bad-java-version'],
  rebuild_support_configs: ['support-config-missing'],
  repair_bedrock_pack_references: ['bedrock-missing-pack-reference'],
  quarantine_identified_plugin: ['plugin-exception', 'plugin-archive-corrupt', 'plugin-dependency', 'duplicate-plugin', 'plugin-api-version', 'loader-mismatch', 'mod-resolution', 'mixin', 'datapack'],
  cleanup_stale_transfers: ['archive-incomplete'],
  quarantine_incompatible_bedrock_pack: ['bedrock-pack-version'],
});

// These are panel diagnostic IDs, mapped to the corresponding documented
// issue IDs. Execution still independently checks the active diagnostic,
// server state, edition, and tool-specific conditions.
const DIAGNOSTIC_ISSUES = Object.freeze({
  'java-missing': 'java-missing',
  'bad-java-version': 'java-too-old',
  'properties-path': 'server-properties-unreadable',
  'properties-syntax': 'server-properties-recovery',
  'properties-value': 'server-properties-recovery',
  'properties-encoding': 'server-properties-recovery',
  'support-config-missing': 'support-config-json-missing',
  'bedrock-missing-pack-reference': 'bedrock-missing-pack-reference',
  'archive-incomplete': 'archive-incomplete',
  'plugin-exception': 'minecraft-plugin-isolate-safely',
  'bedrock-pack-version': 'bedrock-pack-engine-version',
});

function panelRepairCandidates(diagnostics, missingExecutable = false) {
  const candidates = [];
  const seen = new Set();
  for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
    const issueId = DIAGNOSTIC_ISSUES[diagnostic?.id];
    const tool = issueId && contract.issueMap[issueId];
    const evidence = typeof diagnostic?.summary === 'string' ? diagnostic.summary.trim() : '';
    if (!tool || !evidence || evidence.length > 350 || seen.has(issueId)) continue;
    seen.add(issueId);
    candidates.push({ diagnosticId: diagnostic.id, issueId, tool, evidence });
  }
  if (missingExecutable && !seen.has('server-not-installed')) {
    candidates.push({ diagnosticId: 'missing-executable', issueId: 'server-not-installed',
      tool: contract.issueMap['server-not-installed'], evidence: 'Install server software before starting.' });
  }
  return candidates;
}

function repairCandidatePrompt(candidate) {
  return `Confirmed offline repair. issueId: ${candidate.issueId}; tool: ${candidate.tool}; evidence: ${candidate.evidence}`;
}

module.exports = { DIAGNOSTIC_ISSUES, REPAIR_TOOL_DIAGNOSTICS, panelRepairCandidates, repairCandidatePrompt };
