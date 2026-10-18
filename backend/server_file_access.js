const LIVE_PLUGIN_CONFIG_EXTENSIONS = new Set([
  'cfg',
  'conf',
  'ini',
  'json',
  'json5',
  'properties',
  'toml',
  'yaml',
  'yml',
]);

function isLivePluginConfigPath(relative = '') {
  const cleaned = String(relative || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(Boolean);
  const extension = parts.at(-1)?.split('.').at(-1)?.toLowerCase() || '';
  return parts[0]?.toLowerCase() === 'plugins'
    && parts.length >= 3
    && !parts.some((part) => part === '.' || part === '..')
    && LIVE_PLUGIN_CONFIG_EXTENSIONS.has(extension);
}

module.exports = { isLivePluginConfigPath };
