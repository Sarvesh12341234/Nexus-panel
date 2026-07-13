const state = {
  user: null,
  permissions: {},
  needsSetup: false,
  servers: [],
  users: [],
  optimizer: null,
  plugins: [],
  softwareCatalog: [],
  templates: [],
  templateGameFilter: '',
  settings: null,
  loginEvents: [],
  health: null,
  adaptiveInsights: [],
  repairBrain: null,
  metricHistory: {},
  activeView: 'dashboard',
  activeServerId: null,
  refreshTimer: null,
  consoleFastTimer: null,
  statusRefreshAt: 0,
  consolePollAt: {},
  consoleMetricsAt: {},
  presenceAt: 0,
  serverStatusSignature: '',
  playitTerminalTimer: null,
  pluginSearchSignature: '',
  viewScroll: {},
};

const elements = {
  accountBox: document.querySelector('#accountBox'),
  themeSelect: document.querySelector('#themeSelect'),
  authView: document.querySelector('#authView'),
  dashboardView: document.querySelector('#dashboardView'),
  loginForm: document.querySelector('#loginForm'),
  setupNotice: document.querySelector('#setupNotice'),
  serverForm: document.querySelector('#serverForm'),
  softwareSelect: document.querySelector('#softwareSelect'),
  softwareVersionSelect: document.querySelector('#softwareVersionSelect'),
  ownerAssignLabel: document.querySelector('#ownerAssignLabel'),
  ownerUserSelect: document.querySelector('#ownerUserSelect'),
  serverGrid: document.querySelector('#serverGrid'),
  serverRowsGrid: document.querySelector('#serverRowsGrid'),
  templateGrid: document.querySelector('#templateGrid'),
  templateGameSelect: document.querySelector('#templateGameSelect'),
  nexuImportInput: document.querySelector('#nexuImportInput'),
  serverList: document.querySelector('#serverList'),
  activeServerSelect: document.querySelector('#activeServerSelect'),
  softwareGrid: document.querySelector('#softwareGrid'),
  propertyForm: document.querySelector('#propertyForm'),
  whitelistForm: document.querySelector('#whitelistForm'),
  whitelistList: document.querySelector('#whitelistList'),
  pluginForm: document.querySelector('#pluginForm'),
  pluginServerSelect: document.querySelector('#pluginServerSelect'),
  pluginAccessNote: document.querySelector('#pluginAccessNote'),
  pluginList: document.querySelector('#pluginList'),
  modrinthForm: document.querySelector('#modrinthForm'),
  modrinthGrid: document.querySelector('#modrinthGrid'),
  adminPanel: document.querySelector('#adminPanel'),
  adminForm: document.querySelector('#adminForm'),
  userList: document.querySelector('#userList'),
  toast: document.querySelector('#toast'),
  accessOutput: document.querySelector('#accessOutput'),
  serverCount: document.querySelector('#serverCount'),
  onlineCount: document.querySelector('#onlineCount'),
  softwareCount: document.querySelector('#softwareCount'),
  accessLabel: document.querySelector('#accessLabel'),
  optimizerSummary: document.querySelector('#optimizerSummary'),
  tweakGrid: document.querySelector('#tweakGrid'),
  techniqueGrid: document.querySelector('#techniqueGrid'),
  optimizerPlan: document.querySelector('#optimizerPlan'),
  healthPanel: document.querySelector('#healthPanel'),
  auditPanel: document.querySelector('#auditPanel'),
  fixedPanel: document.querySelector('#fixedPanel'),
  consoleBox: document.querySelector('#consoleBox'),
  consoleMetrics: document.querySelector('#consoleMetrics'),
  presencePanel: document.querySelector('#presencePanel'),
  commandForm: document.querySelector('#commandForm'),
  serverConfigForm: document.querySelector('#serverConfigForm'),
  adminServerAssign: document.querySelector('#adminServerAssign'),
  fileList: document.querySelector('#fileList'),
  filePathLabel: document.querySelector('#filePathLabel'),
  fileEditor: document.querySelector('#fileEditor'),
  fileUploadInput: document.querySelector('#fileUploadInput'),
  uploadPanel: document.querySelector('#uploadPanel'),
  uploadLabel: document.querySelector('#uploadLabel'),
  uploadProgress: document.querySelector('#uploadProgress'),
  uploadSessionList: document.querySelector('#uploadSessionList'),
  settingsPanel: document.querySelector('#settingsPanel'),
  networkPanel: document.querySelector('#networkPanel'),
  terminalPanel: document.querySelector('#terminalPanel'),
  terminalNav: document.querySelector('#terminalNav'),
  backupPanel: document.querySelector('#backupPanel'),
  viewEyebrow: document.querySelector('#viewEyebrow'),
  viewTitle: document.querySelector('#viewTitle'),
};

let filePath = '';
let fileClipboard = { mode: '', paths: [], serverId: null };
let currentUpload = { path: '', size: 0, paused: false, canceled: false };
let consoleStickToBottom = true;
let consoleRenderToken = 0;
let terminalSession = { id: '', cursor: 0, timer: 0 };
const versionCache = new Map();
const publicBackupLinks = new Map();
const UI_PREFERENCES_KEY = 'nexusUiPreferences';
const uiHistory = [];
const uiRedo = [];
let uiPreferences = loadUiPreferences();
let alphaDraft = structuredClone(uiPreferences);
const layoutEditor = {
  active: false,
  mode: 'boxes',
  precision: true,
  snap: 1,
  dragging: null,
  pointerId: null,
  selectedKey: '',
  selectedType: '',
  selection: [],
  undo: [],
  redo: [],
  controlSnapshot: null,
};
let lastCreateSoftwareKey = '';
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const UPLOAD_PARALLELISM = 3;
const timeZones = [...new Set([
  ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC']),
  'UTC',
  'Asia/Kolkata',
  'Asia/Calcutta',
])].sort();
const CAPABILITIES = Object.freeze({
  SERVER_START: 'server.start',
  SERVER_STOP: 'server.stop',
  SERVER_RESTART: 'server.restart',
  SERVER_KILL: 'server.kill',
  CONSOLE_VIEW: 'console.view',
  CONSOLE_COMMAND: 'console.command',
  SERVER_MANAGE: 'server.manage',
  SOFTWARE_MANAGE: 'software.manage',
  PROPERTIES_MANAGE: 'properties.manage',
  WHITELIST_MANAGE: 'whitelist.manage',
  PLUGINS_MANAGE: 'plugins.manage',
  FILES_MANAGE: 'files.manage',
  BACKUPS_MANAGE: 'backups.manage',
  OPTIMIZER_MANAGE: 'optimizer.manage',
  NETWORK_MANAGE: 'network.manage',
  ADMINS_MANAGE: 'admins.manage',
  SECURITY_VIEW: 'security.view',
  SETTINGS_MANAGE: 'settings.manage',
  TIMEZONE_MANAGE: 'timezone.manage',
});
const ADMIN_PERMISSION_PRESETS = {
  0: [],
  5: [CAPABILITIES.SERVER_START, CAPABILITIES.SERVER_STOP, CAPABILITIES.SERVER_RESTART],
  20: [CAPABILITIES.SERVER_START, CAPABILITIES.SERVER_STOP, CAPABILITIES.SERVER_RESTART, CAPABILITIES.CONSOLE_VIEW],
  40: [CAPABILITIES.SERVER_START, CAPABILITIES.SERVER_STOP, CAPABILITIES.SERVER_RESTART, CAPABILITIES.CONSOLE_VIEW, CAPABILITIES.CONSOLE_COMMAND],
  60: [
    CAPABILITIES.SERVER_START, CAPABILITIES.SERVER_STOP, CAPABILITIES.SERVER_RESTART, CAPABILITIES.SERVER_KILL,
    CAPABILITIES.CONSOLE_VIEW, CAPABILITIES.CONSOLE_COMMAND, CAPABILITIES.SERVER_MANAGE,
    CAPABILITIES.SOFTWARE_MANAGE, CAPABILITIES.PROPERTIES_MANAGE, CAPABILITIES.WHITELIST_MANAGE,
    CAPABILITIES.OPTIMIZER_MANAGE, CAPABILITIES.NETWORK_MANAGE,
  ],
  80: Object.values(CAPABILITIES).filter((key) => ![CAPABILITIES.ADMINS_MANAGE, CAPABILITIES.SECURITY_VIEW, CAPABILITIES.SETTINGS_MANAGE].includes(key)),
  100: Object.values(CAPABILITIES),
};
const ADMIN_PERMISSION_LABELS = {
  [CAPABILITIES.SERVER_START]: 'Start',
  [CAPABILITIES.SERVER_STOP]: 'Stop',
  [CAPABILITIES.SERVER_RESTART]: 'Restart',
  [CAPABILITIES.SERVER_KILL]: 'Force kill',
  [CAPABILITIES.CONSOLE_VIEW]: 'Console view',
  [CAPABILITIES.CONSOLE_COMMAND]: 'Console commands',
  [CAPABILITIES.SERVER_MANAGE]: 'Servers',
  [CAPABILITIES.SOFTWARE_MANAGE]: 'Software',
  [CAPABILITIES.PROPERTIES_MANAGE]: 'Properties',
  [CAPABILITIES.WHITELIST_MANAGE]: 'Whitelist',
  [CAPABILITIES.PLUGINS_MANAGE]: 'Plugins',
  [CAPABILITIES.FILES_MANAGE]: 'Files',
  [CAPABILITIES.BACKUPS_MANAGE]: 'Backups',
  [CAPABILITIES.OPTIMIZER_MANAGE]: 'Optimizer',
  [CAPABILITIES.NETWORK_MANAGE]: 'Network',
  [CAPABILITIES.ADMINS_MANAGE]: 'Admins',
  [CAPABILITIES.SECURITY_VIEW]: 'Security',
  [CAPABILITIES.SETTINGS_MANAGE]: 'Settings',
  [CAPABILITIES.TIMEZONE_MANAGE]: 'Timezone',
};
const themes = [
  { key: 'nexus', name: 'Plain · Nexus Mint', mode: 'plain' },
  { key: 'ember', name: 'Plain · Ember Arena', mode: 'plain' },
  { key: 'ocean', name: 'Plain · Ocean Neon', mode: 'plain' },
  { key: 'violet', name: 'Plain · Violet Pulse', mode: 'plain' },
  { key: 'gold', name: 'Plain · Gold Rush', mode: 'plain' },
  { key: 'cyber', name: 'Plain · Cyber Grid', mode: 'plain' },
  { key: 'crimson', name: 'Plain · Crimson Night', mode: 'plain' },
  { key: 'forest', name: 'Plain · Emerald Forest', mode: 'plain' },
  { key: 'ice', name: 'Plain · Ice Prism', mode: 'plain' },
  { key: 'candy', name: 'Plain · Candy Pop', mode: 'plain' },
  { key: 'volt', name: 'Plain - Neon Volt', mode: 'plain' },
  { key: 'aurora', name: 'Plain - Aurora Glass', mode: 'plain' },
  { key: 'lava', name: 'Plain - Lava Core', mode: 'plain' },
  { key: 'berry', name: 'Plain - Berry Blast', mode: 'plain' },
  { key: 'matrix', name: 'Plain - Matrix Lime', mode: 'plain' },
  { key: 'forge-ui', name: 'Plain - Forge Geometry', mode: 'plain' },
  { key: 'blackhole-pic', name: 'blackhole', mode: 'picture' },
  { key: 'whitehole-pic', name: 'whitehole', mode: 'picture' },
  { key: 'moon-pic', name: 'moon', mode: 'picture' },
  { key: 'earth-pic', name: 'earth', mode: 'picture' },
  { key: 'nether-pic', name: 'nether', mode: 'picture' },
  { key: 'end-pic', name: 'end', mode: 'picture' },
  { key: 'minecraft-pic', name: 'minecraft', mode: 'picture' },
  { key: 'saturn-pic', name: 'saturn', mode: 'picture' },
  { key: 'starfall-pic', name: 'starfall', mode: 'picture' },
  { key: 'cyberpunk-pic', name: 'cyberpunk', mode: 'picture' },
];

const viewTitles = {
  dashboard: ['Dashboard', 'Servers'],
  servers: ['Servers', 'Specific Servers'],
  console: ['Server', 'Console'],
  files: ['Server', 'File Manager'],
  templates: ['Templates', 'One-click Setup'],
  software: ['Server', 'Software Installer'],
  properties: ['Server', 'Server Properties'],
  whitelist: ['Server', 'Whitelist'],
  plugins: ['Server', 'Plugins and Packs'],
  backups: ['Safety', 'Backups'],
  optimizer: ['Host', 'Optimizer'],
  network: ['Host', 'Network'],
  admins: ['Owner', 'Admin Access'],
  security: ['Security', 'Health and Login Audit'],
  fixed: ['Fixed', 'Repair History'],
  settings: ['Panel', 'Settings'],
  terminal: ['Owner', 'VPS Terminal'],
};
const viewAccess = {
  dashboard: { keys: [], level: 'VIEW_ONLY' },
  servers: { keys: [CAPABILITIES.SERVER_START, CAPABILITIES.SERVER_STOP, CAPABILITIES.SERVER_RESTART, CAPABILITIES.SERVER_KILL, CAPABILITIES.SERVER_MANAGE], level: 'POWER_SERVERS' },
  console: { keys: [CAPABILITIES.CONSOLE_VIEW, CAPABILITIES.CONSOLE_COMMAND], level: 'VIEW_CONSOLE' },
  files: { keys: [CAPABILITIES.FILES_MANAGE], level: 'MANAGE_FILES' },
  templates: { keys: [CAPABILITIES.SERVER_MANAGE], level: 'MANAGE_SERVERS' },
  software: { keys: [CAPABILITIES.SOFTWARE_MANAGE], level: 'MANAGE_SERVERS' },
  properties: { keys: [CAPABILITIES.PROPERTIES_MANAGE], level: 'MANAGE_SERVERS' },
  whitelist: { keys: [CAPABILITIES.WHITELIST_MANAGE], level: 'MANAGE_SERVERS' },
  plugins: { keys: [CAPABILITIES.PLUGINS_MANAGE], level: 'MANAGE_FILES' },
  backups: { keys: [CAPABILITIES.BACKUPS_MANAGE], level: 'MANAGE_FILES' },
  optimizer: { keys: [CAPABILITIES.OPTIMIZER_MANAGE], level: 'MANAGE_SERVERS' },
  network: { keys: [CAPABILITIES.NETWORK_MANAGE], level: 'MANAGE_SERVERS' },
  admins: { keys: [CAPABILITIES.ADMINS_MANAGE], level: 'MANAGE_ADMINS' },
  security: { keys: [CAPABILITIES.SECURITY_VIEW], level: 'MANAGE_ADMINS' },
  fixed: { keys: [CAPABILITIES.SECURITY_VIEW], level: 'MANAGE_ADMINS' },
  settings: { keys: [CAPABILITIES.SETTINGS_MANAGE, CAPABILITIES.TIMEZONE_MANAGE], level: 'MANAGE_ADMINS' },
  terminal: { keys: [CAPABILITIES.SETTINGS_MANAGE], level: 'MANAGE_ADMINS' },
};
const defaultNavOrder = Object.keys(viewTitles);

function loadUiPreferences() {
  const defaults = {
    navOrder: [],
    actionPriority: ['start-server', 'stop-server', 'restart-server', 'open-console', 'file-upload', 'manual-backup', 'fix-server', 'kill-server', 'delete-server'],
    buttonLayout: {},
    buttonWidths: {},
    buttonPositions: {},
    componentLayout: {},
    componentWidths: {},
    componentPositions: {},
    compact: false,
    reducedMotion: false,
    liveRefresh: true,
    buttonShape: 'soft',
    buttonSize: 'medium',
    sidebarWidth: 270,
    fontScale: 100,
    accentHue: 155,
    surfaceOpacity: 86,
    contentWidth: 1600,
    rowGap: 12,
    borderWidth: 1,
    shadowStrength: 35,
    navFontSize: 14,
    buttonGap: 8,
    cardRadius: 8,
    inputRadius: 7,
    sidebarOpacity: 98,
    backdropBlur: 18,
    lineHeight: 150,
    consoleFontSize: 13,
    animationSpeed: 100,
    toolbarScale: 100,
    stickyTopbar: true,
    showQuickStats: true,
    showEyebrows: true,
    uppercaseButtons: false,
    highContrast: false,
    focusBoost: true,
    denseForms: false,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) || '{}');
    return {
      ...defaults,
      ...saved,
      navOrder: Array.isArray(saved.navOrder) ? saved.navOrder : [],
      actionPriority: Array.isArray(saved.actionPriority) ? saved.actionPriority : defaults.actionPriority,
      buttonLayout: saved.buttonLayout && typeof saved.buttonLayout === 'object' ? saved.buttonLayout : {},
      buttonWidths: saved.buttonWidths && typeof saved.buttonWidths === 'object' ? saved.buttonWidths : {},
      buttonPositions: saved.buttonPositions && typeof saved.buttonPositions === 'object' ? saved.buttonPositions : {},
      componentLayout: saved.componentLayout && typeof saved.componentLayout === 'object' ? saved.componentLayout : {},
      componentWidths: saved.componentWidths && typeof saved.componentWidths === 'object' ? saved.componentWidths : {},
      componentPositions: saved.componentPositions && typeof saved.componentPositions === 'object' ? saved.componentPositions : {},
    };
  } catch {
    return defaults;
  }
}

function applyUiPreferences(preferences = uiPreferences) {
  document.body.dataset.density = preferences.compact ? 'compact' : 'comfortable';
  document.body.dataset.reducedMotion = preferences.reducedMotion ? 'true' : 'false';
  document.body.dataset.buttonShape = preferences.buttonShape;
  document.body.dataset.buttonSize = preferences.buttonSize;
  document.body.dataset.highContrast = preferences.highContrast ? 'true' : 'false';
  document.body.dataset.uppercaseButtons = preferences.uppercaseButtons ? 'true' : 'false';
  document.body.dataset.denseForms = preferences.denseForms ? 'true' : 'false';
  document.body.dataset.hideQuickStats = preferences.showQuickStats ? 'false' : 'true';
  document.body.dataset.hideEyebrows = preferences.showEyebrows ? 'false' : 'true';
  document.body.dataset.stickyTopbar = preferences.stickyTopbar ? 'true' : 'false';
  document.body.dataset.focusBoost = preferences.focusBoost ? 'true' : 'false';
  document.documentElement.style.setProperty('--alpha-sidebar-width', `${Number(preferences.sidebarWidth)}px`);
  document.documentElement.style.setProperty('--alpha-font-scale', `${Number(preferences.fontScale) / 100}`);
  document.documentElement.style.setProperty('--alpha-accent-hue', Number(preferences.accentHue));
  document.documentElement.style.setProperty('--alpha-surface-opacity', `${Number(preferences.surfaceOpacity)}%`);
  document.documentElement.style.setProperty('--alpha-content-width', `${Number(preferences.contentWidth)}px`);
  document.documentElement.style.setProperty('--alpha-row-gap', `${Number(preferences.rowGap)}px`);
  document.documentElement.style.setProperty('--alpha-border-width', `${Number(preferences.borderWidth)}px`);
  document.documentElement.style.setProperty('--alpha-shadow-strength', Number(preferences.shadowStrength) / 100);
  document.documentElement.style.setProperty('--alpha-nav-font-size', `${Number(preferences.navFontSize)}px`);
  document.documentElement.style.setProperty('--alpha-button-gap', `${Number(preferences.buttonGap)}px`);
  document.documentElement.style.setProperty('--alpha-card-radius', `${Number(preferences.cardRadius)}px`);
  document.documentElement.style.setProperty('--alpha-input-radius', `${Number(preferences.inputRadius)}px`);
  document.documentElement.style.setProperty('--alpha-sidebar-opacity', `${Number(preferences.sidebarOpacity)}%`);
  document.documentElement.style.setProperty('--alpha-backdrop-blur', `${Number(preferences.backdropBlur)}px`);
  document.documentElement.style.setProperty('--alpha-line-height', Number(preferences.lineHeight) / 100);
  document.documentElement.style.setProperty('--alpha-console-font-size', `${Number(preferences.consoleFontSize)}px`);
  document.documentElement.style.setProperty('--alpha-animation-speed', `${Number(preferences.animationSpeed)}ms`);
  document.documentElement.style.setProperty('--alpha-toolbar-scale', Number(preferences.toolbarScale) / 100);
  const nav = document.querySelector('.nav-list');
  if (!nav) return;
  const buttons = new Map([...nav.querySelectorAll('[data-view]')].map((button) => [button.dataset.view, button]));
  const order = [...preferences.navOrder, ...defaultNavOrder].filter((key, index, list) => buttons.has(key) && list.indexOf(key) === index);
  for (const key of order) nav.appendChild(buttons.get(key));
  const priority = new Map((preferences.actionPriority || []).map((action, index) => [action, index]));
  document.querySelectorAll('.server-actions [data-action], .file-toolbar [data-action], .row-actions [data-action]').forEach((button) => {
    button.style.order = String(priority.has(button.dataset.action) ? priority.get(button.dataset.action) : priority.size + 100);
  });
  applyButtonLayout(preferences);
  applyComponentLayout(preferences);
  restoreLayoutSelection();
}

function reapplyDynamicLayout() {
  const preferences = layoutEditor.active ? alphaDraft : uiPreferences;
  const customized = layoutEditor.active
    || Object.keys(preferences.buttonLayout || {}).length
    || Object.keys(preferences.buttonPositions || {}).length
    || Object.keys(preferences.componentLayout || {}).length
    || Object.keys(preferences.componentPositions || {}).length;
  if (!customized) return;
  applyButtonLayout(preferences);
  applyComponentLayout(preferences);
  restoreLayoutSelection();
}

function layoutRegionElements() {
  const parents = new Set();
  for (const button of document.querySelectorAll('button, .button-link')) {
    if (
      button.closest('.alpha-lab')
      || button.closest('#layoutEditorBar')
      || button.closest('#powerPalette')
      || button.closest('[hidden]')
    ) continue;
    if (button.parentElement) parents.add(button.parentElement);
  }
  return [...parents];
}

function stableClassName(element) {
  return [...element.classList]
    .filter((name) => !name.startsWith('is-') && !name.startsWith('has-'))
    .slice(0, 2)
    .join('.');
}

function regionBaseName(region) {
  if (region.classList.contains('nav-list')) return 'navigation';
  if (region.id) return `${state.activeView}:id:${region.id}`;
  const identity = `${region.tagName.toLowerCase()}.${stableClassName(region) || 'plain'}`;
  const peers = layoutRegionElements().filter((item) => (
    !item.id
    && `${item.tagName.toLowerCase()}.${stableClassName(item) || 'plain'}` === identity
  ));
  return `${state.activeView}:${identity}:${Math.max(0, peers.indexOf(region))}`;
}

function buttonBaseKey(button) {
  if (button.dataset.view) return `view:${button.dataset.view}`;
  if (button.dataset.action) {
    const qualifier = button.dataset.softwareKey
      || button.dataset.templateKey
      || button.dataset.filePath
      || button.dataset.serverId
      || '';
    return `action:${button.dataset.action}:${qualifier}`;
  }
  if (button.id) return `id:${button.id}`;
  return `label:${String(button.textContent || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function prepareLayoutRegions() {
  for (const region of layoutRegionElements()) {
    const regionKey = regionBaseName(region);
    region.dataset.uiRegion = regionKey;
    const seen = new Map();
    for (const button of region.querySelectorAll(':scope > button, :scope > .button-link')) {
      const base = buttonBaseKey(button);
      const occurrence = seen.get(base) || 0;
      seen.set(base, occurrence + 1);
      button.dataset.uiButtonKey = `${base}#${occurrence}`;
    }
  }
}

function reorderInExistingSlots(parent, currentElements, desiredElements) {
  if (currentElements.length < 2 || desiredElements.length !== currentElements.length) return;
  const markers = currentElements.map((element) => {
    const marker = document.createComment('nexus-layout-slot');
    parent.insertBefore(marker, element);
    return marker;
  });
  desiredElements.forEach((element, index) => parent.insertBefore(element, markers[index]));
  markers.forEach((marker) => marker.remove());
}

function applyButtonLayout(preferences = uiPreferences) {
  prepareLayoutRegions();
  for (const region of layoutRegionElements()) {
    const savedOrder = preferences.buttonLayout?.[region.dataset.uiRegion];
    const buttons = [...region.querySelectorAll(':scope > button, :scope > .button-link')];
    const byKey = new Map(buttons.map((button) => [button.dataset.uiButtonKey, button]));
    if (Array.isArray(savedOrder)) {
      const desired = [
        ...savedOrder.map((key) => byKey.get(key)).filter(Boolean),
        ...buttons.filter((button) => !savedOrder.includes(button.dataset.uiButtonKey)),
      ];
      reorderInExistingSlots(region, buttons, desired);
    }
    for (const button of buttons) {
      const fullKey = `${region.dataset.uiRegion}/${button.dataset.uiButtonKey}`;
      const width = preferences.buttonWidths?.[fullKey] || 'auto';
      button.dataset.uiWidth = width;
      if (preferences.buttonLayout?.[region.dataset.uiRegion]) button.style.order = '';
      button.draggable = layoutEditor.active;
      applyStoredPosition(button, preferences.buttonPositions?.[fullKey]);
    }
  }
}

function captureButtonLayout() {
  prepareLayoutRegions();
  const buttonLayout = { ...(alphaDraft.buttonLayout || {}) };
  for (const region of layoutRegionElements()) {
    buttonLayout[region.dataset.uiRegion] = [...region.querySelectorAll(':scope > button, :scope > .button-link')]
      .map((button) => button.dataset.uiButtonKey);
  }
  alphaDraft = { ...alphaDraft, buttonLayout };
}

const COMPONENT_SELECTOR = [
  '.surface',
  '.tool-surface',
  'form',
  'article',
  '[class*="-card"]',
  'form > label',
  'form > input',
  'form > select',
  'form > textarea',
  '.section-head',
  '.settings-group',
  '.upload-panel',
  '.public-help-grid',
  '.nexu-details',
  '.server-card',
  '.server-row-card',
  '.software-card',
  '.template-card',
  '.plugin-row',
  '.user-row',
  '.file-row',
  '.upload-session-row',
  '.backup-settings',
  '.console-metrics',
  '.server-actions',
  '.file-toolbar',
  '.console-box',
  '.command-row',
  '.field-grid',
  '.option-grid',
  '.plugin-list',
  '.server-grid',
  '.server-rows-list',
  '.software-grid',
  '.template-grid',
  '.modrinth-grid',
  '.optimizer-summary',
  '.audit-row',
  '.stat-row',
  '.status-row',
  '.quick-stats > article',
  '.promise-strip > article',
  '.settings-form > label',
  '.settings-form > .settings-group',
  '.server-config-form > label',
  '.admin-form > input',
  '.admin-form > select',
  '.admin-form > label',
].join(',');

function componentElements() {
  return [...document.querySelectorAll(COMPONENT_SELECTOR)].filter((component) => (
    (!component.closest('.alpha-lab') || component.classList.contains('alpha-lab'))
    && !component.closest('#layoutEditorBar')
    && !component.closest('#powerPalette')
    && !component.closest('[hidden]')
    && component !== document.querySelector('.panel-shell')
    && component !== document.querySelector('.workspace')
    && component !== document.querySelector('.sidebar')
  ));
}

function componentZoneElements() {
  return [...new Set(componentElements().map((component) => component.parentElement).filter(Boolean))];
}

function componentZoneKey(zone) {
  if (zone.id) return `${state.activeView}:id:${zone.id}`;
  if (zone.classList.contains('quick-stats')) return 'global:quick-stats';
  const identity = `${zone.tagName.toLowerCase()}.${stableClassName(zone) || 'plain'}`;
  const peers = componentZoneElements().filter((item) => (
    !item.id
    && `${item.tagName.toLowerCase()}.${stableClassName(item) || 'plain'}` === identity
  ));
  return `${state.activeView}:${identity}:${Math.max(0, peers.indexOf(zone))}`;
}

function componentBaseKey(component) {
  if (component.id) return `id:${component.id}`;
  if (component.dataset.layoutKey) return `layout:${component.dataset.layoutKey}`;
  for (const key of ['serverId', 'softwareKey', 'templateKey', 'pluginId', 'userId', 'requestId', 'uploadPath']) {
    if (component.dataset[key]) return `${key}:${component.dataset[key]}`;
  }
  const field = component.matches('input, select, label')
    ? (component.name || component.querySelector?.('input,select,textarea')?.name || '')
    : '';
  if (field) return `field:${field}`;
  const label = component.getAttribute('aria-label')
    || component.querySelector?.('.property-name,h1,h2,h3')?.textContent
    || '';
  const cleanLabel = String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const className = stableClassName(component) || component.tagName.toLowerCase();
  return `${className}:${cleanLabel}`;
}

function prepareComponentLayout() {
  for (const zone of componentZoneElements()) {
    zone.dataset.uiComponentZone = componentZoneKey(zone);
    const seen = new Map();
    const directComponents = componentElements().filter((component) => component.parentElement === zone);
    for (const component of directComponents) {
      const base = componentBaseKey(component);
      const occurrence = seen.get(base) || 0;
      seen.set(base, occurrence + 1);
      component.dataset.uiComponentKey = `${base}#${occurrence}`;
    }
  }
}

function applyComponentLayout(preferences = uiPreferences) {
  prepareComponentLayout();
  for (const zone of componentZoneElements()) {
    const zoneKey = zone.dataset.uiComponentZone;
    const components = componentElements().filter((component) => component.parentElement === zone);
    const byKey = new Map(components.map((component) => [component.dataset.uiComponentKey, component]));
    const savedOrder = preferences.componentLayout?.[zoneKey];
    if (Array.isArray(savedOrder)) {
      const desired = [
        ...savedOrder.map((key) => byKey.get(key)).filter(Boolean),
        ...components.filter((component) => !savedOrder.includes(component.dataset.uiComponentKey)),
      ];
      reorderInExistingSlots(zone, components, desired);
    }
    for (const component of components) {
      const fullKey = `${zoneKey}/${component.dataset.uiComponentKey}`;
      component.dataset.uiComponentWidth = preferences.componentWidths?.[fullKey] || 'auto';
      applyStoredPosition(component, preferences.componentPositions?.[fullKey]);
    }
  }
}

function captureComponentLayout() {
  prepareComponentLayout();
  const componentLayout = { ...(alphaDraft.componentLayout || {}) };
  for (const zone of componentZoneElements()) {
    componentLayout[zone.dataset.uiComponentZone] = componentElements()
      .filter((component) => component.parentElement === zone)
      .map((component) => component.dataset.uiComponentKey);
  }
  alphaDraft = { ...alphaDraft, componentLayout };
}

function positionBreakpoint() {
  return window.innerWidth <= 760 ? 'mobile' : 'desktop';
}

function cleanPosition(position) {
  return {
    x: Number.isFinite(Number(position?.x)) ? Math.round(Number(position.x)) : 0,
    y: Number.isFinite(Number(position?.y)) ? Math.round(Number(position.y)) : 0,
    z: Number.isFinite(Number(position?.z)) ? Math.max(0, Math.min(50, Math.round(Number(position.z)))) : 0,
  };
}

function applyStoredPosition(element, positions) {
  const position = cleanPosition(positions?.[positionBreakpoint()]);
  element.style.setProperty('--ui-position-x', `${position.x}px`);
  element.style.setProperty('--ui-position-y', `${position.y}px`);
  element.style.setProperty('--ui-position-z', String(position.z));
  element.dataset.uiPositioned = position.x || position.y || position.z ? 'true' : 'false';
}

function selectedPosition() {
  if (!layoutEditor.selectedKey || !layoutEditor.selectedType) return cleanPosition();
  const positions = layoutEditor.selectedType === 'component'
    ? alphaDraft.componentPositions
    : alphaDraft.buttonPositions;
  return cleanPosition(positions?.[layoutEditor.selectedKey]?.[positionBreakpoint()]);
}

function selectedLayoutItem() {
  if (!layoutEditor.selectedKey || !layoutEditor.selectedType) return null;
  return layoutItemByKey(layoutEditor.selectedType, layoutEditor.selectedKey);
}

function layoutItemByKey(type, key) {
  if (type === 'component') {
    return [...document.querySelectorAll('[data-ui-component-key]')].find((component) => {
      const zone = component.parentElement?.closest('[data-ui-component-zone]');
      return zone && `${zone.dataset.uiComponentZone}/${component.dataset.uiComponentKey}` === key;
    }) || null;
  }
  return [...document.querySelectorAll('[data-ui-region] [data-ui-button-key]')].find((button) => (
    `${button.closest('[data-ui-region]').dataset.uiRegion}/${button.dataset.uiButtonKey}` === key
  )) || null;
}

function layoutZoneFor(type, item) {
  if (!item) return null;
  return type === 'component'
    ? item.parentElement?.closest('[data-ui-component-zone]')
    : item.closest('[data-ui-region]');
}

function selectedLayoutZone(item = selectedLayoutItem()) {
  return layoutZoneFor(layoutEditor.selectedType, item);
}

function layoutItemKey(type, item, zone = layoutZoneFor(type, item)) {
  if (!item || !zone) return '';
  return type === 'component'
    ? `${zone.dataset.uiComponentZone}/${item.dataset.uiComponentKey}`
    : `${zone.dataset.uiRegion}/${item.dataset.uiButtonKey}`;
}

function restoreLayoutSelection() {
  if (!layoutEditor.active) return;
  document.querySelectorAll('.is-layout-selected').forEach((item) => item.classList.remove('is-layout-selected'));
  for (const entry of layoutEditor.selection) {
    layoutItemByKey(entry.type, entry.key)?.classList.add('is-layout-selected');
  }
}

function selectLayoutItem(type, key, { additive = false } = {}) {
  const exists = layoutEditor.selection.some((entry) => entry.type === type && entry.key === key);
  if (additive) {
    layoutEditor.selection = exists
      ? layoutEditor.selection.filter((entry) => entry.type !== type || entry.key !== key)
      : [...layoutEditor.selection, { type, key }];
  } else if (!exists || layoutEditor.selection.length <= 1) {
    layoutEditor.selection = [{ type, key }];
  }
  const primary = layoutEditor.selection.find((entry) => entry.type === type && entry.key === key)
    || layoutEditor.selection.at(-1);
  layoutEditor.selectedType = primary?.type || '';
  layoutEditor.selectedKey = primary?.key || '';
  restoreLayoutSelection();
  renderLayoutEditorBar();
  return exists && additive ? null : layoutItemByKey(type, key);
}

function selectedLayoutEntries({ sameZone = false } = {}) {
  const entries = layoutEditor.selection.map((entry) => {
    const item = layoutItemByKey(entry.type, entry.key);
    return item ? { ...entry, item, zone: layoutZoneFor(entry.type, item) } : null;
  }).filter((entry) => entry?.zone);
  if (!sameZone || entries.length < 2) return entries;
  const primary = entries.find((entry) => (
    entry.type === layoutEditor.selectedType && entry.key === layoutEditor.selectedKey
  )) || entries.at(-1);
  return entries.filter((entry) => entry.type === primary.type && entry.zone === primary.zone);
}

function layoutPositionFor(entry) {
  const store = entry.type === 'component' ? alphaDraft.componentPositions : alphaDraft.buttonPositions;
  return cleanPosition(store?.[entry.key]?.[positionBreakpoint()]);
}

function constrainPosition(item, zone, desired, current = selectedPosition()) {
  if (!item || !zone) return cleanPosition(desired);
  const rect = item.getBoundingClientRect();
  const zoneRect = zone.getBoundingClientRect();
  const origin = {
    left: rect.left - current.x,
    right: rect.right - current.x,
    top: rect.top - current.y,
    bottom: rect.bottom - current.y,
  };
  let minX = Math.ceil(zoneRect.left - origin.left);
  let maxX = Math.floor(zoneRect.right - origin.right);
  let minY = Math.ceil(zoneRect.top - origin.top);
  let maxY = Math.floor(zoneRect.bottom - origin.bottom);
  if (minX > maxX) minX = maxX = 0;
  if (minY > maxY) minY = maxY = 0;
  return {
    x: Math.max(minX, Math.min(maxX, Math.round(Number(desired.x) || 0))),
    y: Math.max(minY, Math.min(maxY, Math.round(Number(desired.y) || 0))),
    z: Math.max(0, Math.min(50, Math.round(Number(desired.z) || 0))),
  };
}

function updateSelectedPosition(nextPosition, { constrain = true } = {}) {
  const item = selectedLayoutItem();
  const zone = selectedLayoutZone(item);
  if (!item || !zone) return null;
  return updateLayoutItemPosition({
    type: layoutEditor.selectedType,
    key: layoutEditor.selectedKey,
    item,
    zone,
  }, nextPosition, { constrain });
}

function updateLayoutItemPosition(entry, nextPosition, { constrain = true } = {}) {
  const { type, key, item, zone } = entry;
  if (!item || !zone) return null;
  const current = layoutPositionFor(entry);
  const next = constrain ? constrainPosition(item, zone, nextPosition, current) : cleanPosition(nextPosition);
  const storeKey = type === 'component' ? 'componentPositions' : 'buttonPositions';
  const store = alphaDraft[storeKey] || {};
  alphaDraft = {
    ...alphaDraft,
    [storeKey]: {
      ...store,
      [key]: {
        ...(store[key] || {}),
        [positionBreakpoint()]: next,
      },
    },
  };
  applyStoredPosition(item, alphaDraft[storeKey][key]);
  if (key === layoutEditor.selectedKey && type === layoutEditor.selectedType) updatePrecisionControls(next);
  return next;
}

function updatePrecisionControls(position = selectedPosition()) {
  const bar = document.querySelector('#layoutEditorBar');
  if (!bar) return;
  const x = bar.querySelector('[data-layout-coordinate="x"]');
  const y = bar.querySelector('[data-layout-coordinate="y"]');
  if (x) x.value = position.x;
  if (y) y.value = position.y;
  const count = bar.querySelector('[data-layout-selection-count]');
  if (count) count.textContent = `${layoutEditor.selection.length} selected`;
}

function alignSelectedItems(alignment) {
  const entries = selectedLayoutEntries({ sameZone: true });
  if (!entries.length) return 0;
  if (entries.length === 1) {
    const [{ item, zone }] = entries;
    const current = selectedPosition();
    const rect = item.getBoundingClientRect();
    const zoneRect = zone.getBoundingClientRect();
    const origin = {
      left: rect.left - current.x,
      top: rect.top - current.y,
      width: rect.width,
      height: rect.height,
    };
    const next = { ...current };
    if (alignment === 'left') next.x = Math.round(zoneRect.left - origin.left);
    if (alignment === 'center') next.x = Math.round(zoneRect.left + (zoneRect.width - origin.width) / 2 - origin.left);
    if (alignment === 'right') next.x = Math.round(zoneRect.right - (origin.left + origin.width));
    if (alignment === 'top') next.y = Math.round(zoneRect.top - origin.top);
    if (alignment === 'middle') next.y = Math.round(zoneRect.top + (zoneRect.height - origin.height) / 2 - origin.top);
    if (alignment === 'bottom') next.y = Math.round(zoneRect.bottom - (origin.top + origin.height));
    updateSelectedPosition(next);
    return 1;
  }

  const measured = entries.map((entry) => ({
    ...entry,
    position: layoutPositionFor(entry),
    rect: entry.item.getBoundingClientRect(),
  }));
  const bounds = {
    left: Math.min(...measured.map((entry) => entry.rect.left)),
    right: Math.max(...measured.map((entry) => entry.rect.right)),
    top: Math.min(...measured.map((entry) => entry.rect.top)),
    bottom: Math.max(...measured.map((entry) => entry.rect.bottom)),
  };
  if (alignment === 'distribute-horizontal' && measured.length >= 3) {
    const ordered = [...measured].sort((a, b) => a.rect.left - b.rect.left);
    const width = ordered.reduce((sum, entry) => sum + entry.rect.width, 0);
    const gap = (bounds.right - bounds.left - width) / (ordered.length - 1);
    let cursor = bounds.left;
    for (const entry of ordered) {
      updateLayoutItemPosition(entry, { ...entry.position, x: entry.position.x + cursor - entry.rect.left });
      cursor += entry.rect.width + gap;
    }
    return measured.length;
  }
  if (alignment === 'distribute-vertical' && measured.length >= 3) {
    const ordered = [...measured].sort((a, b) => a.rect.top - b.rect.top);
    const height = ordered.reduce((sum, entry) => sum + entry.rect.height, 0);
    const gap = (bounds.bottom - bounds.top - height) / (ordered.length - 1);
    let cursor = bounds.top;
    for (const entry of ordered) {
      updateLayoutItemPosition(entry, { ...entry.position, y: entry.position.y + cursor - entry.rect.top });
      cursor += entry.rect.height + gap;
    }
    return measured.length;
  }
  for (const entry of measured) {
    const next = { ...entry.position };
    if (alignment === 'left') next.x += bounds.left - entry.rect.left;
    if (alignment === 'center') next.x += ((bounds.left + bounds.right) / 2) - (entry.rect.left + entry.rect.width / 2);
    if (alignment === 'right') next.x += bounds.right - entry.rect.right;
    if (alignment === 'top') next.y += bounds.top - entry.rect.top;
    if (alignment === 'middle') next.y += ((bounds.top + bounds.bottom) / 2) - (entry.rect.top + entry.rect.height / 2);
    if (alignment === 'bottom') next.y += bounds.bottom - entry.rect.bottom;
    updateLayoutItemPosition(entry, next);
  }
  return measured.length;
}

function rememberLayoutMutation(before) {
  if (!before || JSON.stringify(before) === JSON.stringify(alphaDraft)) return false;
  layoutEditor.undo.push(before);
  if (layoutEditor.undo.length > 100) layoutEditor.undo.shift();
  layoutEditor.redo.length = 0;
  renderLayoutEditorBar();
  restoreLayoutSelection();
  return true;
}

function restoreLayoutDraft(next) {
  alphaDraft = structuredClone(next);
  applyUiPreferences(alphaDraft);
  restoreLayoutSelection();
  renderLayoutEditorBar();
}

function undoLayoutMutation() {
  if (!layoutEditor.undo.length) return false;
  layoutEditor.redo.push(structuredClone(alphaDraft));
  restoreLayoutDraft(layoutEditor.undo.pop());
  return true;
}

function redoLayoutMutation() {
  if (!layoutEditor.redo.length) return false;
  layoutEditor.undo.push(structuredClone(alphaDraft));
  restoreLayoutDraft(layoutEditor.redo.pop());
  return true;
}

function decodeBase64Utf8(value) {
  const compact = value.replace(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('Layout code is not valid Base64.');
  }
  const binary = atob(compact.padEnd(Math.ceil(compact.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseLayoutPayload(value) {
  const payload = JSON.parse(value);
  if (![1, 2].includes(payload.version) || !payload.preferences || typeof payload.preferences !== 'object' || Array.isArray(payload.preferences)) {
    throw new Error('Unsupported layout code.');
  }
  return payload.preferences;
}

function encodeLayoutCode(preferences = uiPreferences) {
  const payload = JSON.stringify({ version: 2, preferences });
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `NXUI2.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

function decodeLayoutCode(code) {
  let normalized = String(code || '').trim();
  normalized = normalized.replace(/^["'`]|["'`]$/g, '');
  if (normalized.startsWith('{')) return parseLayoutPayload(normalized);
  const compactInput = normalized.replace(/\s+/g, '');
  if (/^(?:NXUI[12][.:])?[A-Za-z0-9_+/-]{20,}={0,2}$/i.test(compactInput)) {
    normalized = compactInput.replace(/^NXUI[12][.:]/i, '');
  } else {
    const prefixed = normalized.match(/NXUI[12][.:]\s*([A-Za-z0-9_+/-]{20,}={0,2})/i);
    if (prefixed) {
      normalized = prefixed[1];
    } else {
      const candidates = [...normalized.matchAll(/[A-Za-z0-9_+/-]{20,}={0,2}/g)];
      if (candidates.length) normalized = candidates.at(-1)[0];
    }
  }
  try {
    return parseLayoutPayload(decodeBase64Utf8(normalized));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Layout code contains invalid data.');
    throw error;
  }
}

function renderLayoutEditorBar() {
  document.querySelector('#layoutEditorBar')?.remove();
  if (!layoutEditor.active) return;
  const bar = document.createElement('aside');
  bar.id = 'layoutEditorBar';
  bar.className = 'layout-editor-bar';
  bar.setAttribute('aria-label', 'UI layout editor');
  const position = selectedPosition();
  bar.innerHTML = `
    <strong>UI Editor</strong>
    <span>${layoutEditor.precision ? 'Free move: drag precisely. Shift-click or Ctrl-click to select multiple items.' : 'Flow move: drag to swap item order.'} <b data-layout-selection-count>${layoutEditor.selection.length} selected</b></span>
    <button type="button" data-layout-command="mode-boxes" class="${layoutEditor.mode === 'boxes' ? '' : 'secondary'}" title="Move cards and panels">Boxes</button>
    <button type="button" data-layout-command="mode-buttons" class="${layoutEditor.mode === 'buttons' ? '' : 'secondary'}" title="Move command buttons">Buttons</button>
    <button type="button" data-layout-command="move-free" class="${layoutEditor.precision ? '' : 'secondary'}" title="Place items at exact coordinates">Free</button>
    <button type="button" data-layout-command="move-flow" class="${layoutEditor.precision ? 'secondary' : ''}" title="Reorder items in responsive flow">Flow</button>
    <label class="precision-coordinate" title="Horizontal offset">X <input type="number" step="1" value="${position.x}" data-layout-coordinate="x"></label>
    <label class="precision-coordinate" title="Vertical offset">Y <input type="number" step="1" value="${position.y}" data-layout-coordinate="y"></label>
    <label class="precision-snap" title="Mouse movement snap">Snap
      <select data-layout-snap>
        ${[1, 2, 4, 8, 16].map((value) => `<option value="${value}" ${layoutEditor.snap === value ? 'selected' : ''}>${value}px</option>`).join('')}
      </select>
    </label>
    <label class="precision-snap" title="Align inside the current UI container">Align
      <select data-layout-align>
        <option value="">Choose</option>
        <option value="left">Left</option>
        <option value="center">Center</option>
        <option value="right">Right</option>
        <option value="top">Top</option>
        <option value="middle">Middle</option>
        <option value="bottom">Bottom</option>
        <option value="distribute-horizontal">Distribute H</option>
        <option value="distribute-vertical">Distribute V</option>
      </select>
    </label>
    <button type="button" data-layout-command="front" title="Bring selected item above nearby items">Front</button>
    <button type="button" data-layout-command="reset-position" class="secondary" title="Reset selected item coordinates">Reset Pos</button>
    <button type="button" data-layout-command="width" title="Cycle selected box or button width">Width</button>
    <button type="button" data-layout-command="undo" title="Undo one editor action" ${layoutEditor.undo.length ? '' : 'disabled'}>Undo</button>
    <button type="button" data-layout-command="redo" title="Redo one editor action" ${layoutEditor.redo.length ? '' : 'disabled'}>Redo</button>
    <button type="button" data-layout-command="copy" title="Copy permanent UI code">Copy UI Code</button>
    <button type="button" data-layout-command="cancel" class="secondary">Cancel</button>
    <button type="button" data-layout-command="save">Save</button>
  `;
  document.body.appendChild(bar);
}

function setLayoutEditor(active) {
  layoutEditor.active = Boolean(active);
  layoutEditor.dragging = null;
  layoutEditor.pointerId = null;
  layoutEditor.selectedKey = '';
  layoutEditor.selectedType = '';
  layoutEditor.selection = [];
  layoutEditor.controlSnapshot = null;
  if (layoutEditor.active) {
    layoutEditor.undo = [];
    layoutEditor.redo = [];
  }
  document.body.dataset.uiEditing = layoutEditor.active ? 'true' : 'false';
  document.body.dataset.uiEditMode = layoutEditor.mode;
  document.body.dataset.uiMoveMode = layoutEditor.precision ? 'free' : 'flow';
  document.documentElement.style.setProperty('--ui-editor-grid', `${Math.max(8, layoutEditor.snap)}px`);
  applyUiPreferences(layoutEditor.active ? alphaDraft : uiPreferences);
  renderLayoutEditorBar();
  if (layoutEditor.active) showToast('UI Editor active. Drag highlighted boxes or switch to Buttons mode.');
}

function closePowerPalette() {
  document.querySelector('#powerPalette')?.remove();
}

function openPowerPalette() {
  closePowerPalette();
  const palette = document.createElement('div');
  palette.id = 'powerPalette';
  palette.className = 'power-palette-backdrop';
  palette.innerHTML = `
    <section class="power-palette" role="dialog" aria-modal="true" aria-label="Panel command palette">
      <input type="search" placeholder="Search views, servers, or actions" aria-label="Search panel commands" autofocus>
      <div class="power-palette-results"></div>
    </section>
  `;
  document.body.appendChild(palette);
  const input = palette.querySelector('input');
  const results = palette.querySelector('.power-palette-results');
  const render = () => {
    const query = input.value.trim().toLowerCase();
    const commands = [
      ...Object.entries(viewTitles)
        .filter(([key]) => canView(key))
        .map(([key, labels]) => ({ key: `view:${key}`, label: `Open ${labels[1]}`, type: 'View' })),
      ...state.servers.map((server) => ({ key: `server:${server.id}`, label: `Switch to ${server.name}`, type: server.status })),
      { key: 'utility:privacy', label: 'Toggle privacy shield', type: 'Utility' },
      { key: 'utility:snapshot', label: 'Copy live panel snapshot', type: 'Utility' },
    ].filter((item) => !query || `${item.label} ${item.type}`.toLowerCase().includes(query));
    results.innerHTML = commands.slice(0, 30).map((item, index) => `
      <button type="button" data-power-command="${escapeHtml(item.key)}" class="${index === 0 ? 'is-selected' : ''}">
        <span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.type)}</small>
      </button>
    `).join('') || '<p class="empty-state">No matching command.</p>';
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    const buttons = [...results.querySelectorAll('button')];
    let index = buttons.findIndex((button) => button.classList.contains('is-selected'));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[index]?.classList.remove('is-selected');
      index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.classList.add('is-selected');
      buttons[index]?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      buttons[Math.max(0, index)]?.click();
    }
  });
  render();
  input.focus();
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('#powerPalette') ? closePowerPalette() : openPowerPalette();
    return;
  }
  if (event.key === 'Escape') closePowerPalette();
  if (event.altKey && event.key.toLowerCase() === 's' && state.servers.length) {
    event.preventDefault();
    const index = state.servers.findIndex((server) => server.id === state.activeServerId);
    state.activeServerId = state.servers[(index + 1) % state.servers.length].id;
    renderServerSwitcher();
    renderActiveView();
  }
});

document.addEventListener('click', async (event) => {
  if (event.target.id === 'powerPalette') return closePowerPalette();
  const key = event.target.closest('[data-power-command]')?.dataset.powerCommand;
  if (!key) return;
  closePowerPalette();
  if (key.startsWith('view:')) return setView(key.slice(5));
  if (key.startsWith('server:')) {
    state.activeServerId = Number(key.slice(7));
    renderServerSwitcher();
    return renderActiveView();
  }
  if (key === 'utility:privacy') {
    document.body.dataset.privacyShield = document.body.dataset.privacyShield === 'true' ? 'false' : 'true';
    return showToast(document.body.dataset.privacyShield === 'true' ? 'Privacy shield enabled.' : 'Privacy shield disabled.');
  }
  if (key === 'utility:snapshot') {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      activeView: state.activeView,
      servers: state.servers.map(({ id, name, status, type, port }) => ({ id, name, status, type, port })),
      health: state.health?.score ?? null,
    };
    await copyText(JSON.stringify(snapshot, null, 2));
    showToast('Live panel snapshot copied.');
  }
});

function commitUiPreferences(next) {
  uiHistory.push(structuredClone(uiPreferences));
  if (uiHistory.length > 30) uiHistory.shift();
  uiRedo.length = 0;
  uiPreferences = { ...uiPreferences, ...next };
  alphaDraft = structuredClone(uiPreferences);
  localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(uiPreferences));
  applyUiPreferences();
  if (state.activeView === 'settings') renderSettings();
}

function alphaOption(value, current, label = value) {
  return `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function showToast(message) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

ensureFileControls();

function initThemes() {
  if (!elements.themeSelect) return;
  const plain = themes.filter((theme) => theme.mode === 'plain');
  const picture = themes.filter((theme) => theme.mode === 'picture');
  elements.themeSelect.innerHTML = `
    <optgroup label="Plain themes">${plain.map((theme) => `<option value="${theme.key}">${theme.name}</option>`).join('')}</optgroup>
    <optgroup label="Picture themes">${picture.map((theme) => `<option value="${theme.key}">${theme.name}</option>`).join('')}</optgroup>
  `;
  const saved = localStorage.getItem('nexusTheme') || 'nexus';
  applyTheme(saved);
  elements.themeSelect.value = saved;
}

function applyTheme(key) {
  const theme = themes.find((item) => item.key === key) || themes[0];
  document.body.dataset.theme = theme.key;
  document.body.dataset.themeMode = theme.mode;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'include', // Important: include cookies in requests
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(data.error || raw.slice(0, 500) || 'Request failed.');
  return data;
}

function formData(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) data[checkbox.name] = checkbox.checked;
  return data;
}

function can(capability, legacyLevel = 0) {
  if (!state.user) return false;
  if (state.user.role === 'owner') return true;
  if (Array.isArray(state.user.permissionKeys)) {
    const keys = Array.isArray(capability) ? capability : [capability];
    return keys.filter(Boolean).some((key) => state.user.permissionKeys.includes(key));
  }
  return state.user.accessLevel >= legacyLevel;
}

function canView(view) {
  if (!state.user || !Object.hasOwn(viewAccess, view)) return false;
  if (view === 'templates' && state.settings?.edition !== 'host') return false;
  if (view === 'terminal') return state.user.role === 'owner';
  const access = viewAccess[view];
  if (!access.keys.length) return true;
  return can(access.keys, Number(state.permissions[access.level] || 0));
}

function firstAllowedView() {
  return defaultNavOrder.find((view) => canView(view)) || 'dashboard';
}

function activeServer() {
  return state.servers.find((server) => server.id === state.activeServerId) || state.servers[0] || null;
}

function fillServerConfigForm(server, force = false) {
  if (!elements.serverConfigForm || !server) return;
  const form = elements.serverConfigForm;
  const isEditing = form.contains(document.activeElement) || form.dataset.dirty === '1';
  if (!force && isEditing) return;
  form.name.value = server.name;
  form.maxMemoryMb.value = server.maxMemoryMb;
  form.maxMemoryMb.disabled = state.user?.role !== 'owner';
  form.maxMemoryMb.title = state.user?.role === 'owner' ? 'Owner can change RAM allocation.' : 'Only the owner can change RAM allocation.';
  form.cpuCores.value = server.cpuCores || 1;
  form.cpuCores.disabled = state.user?.role !== 'owner';
  form.cpuCores.title = state.user?.role === 'owner' ? 'Owner can change CPU allocation.' : 'Only the owner can change CPU allocation.';
  form.port.value = server.port;
  form.startupDelaySec.value = server.startupDelaySec || 0;
  form.autoRestart.checked = Boolean(server.autoRestart);
  form.autoStart.checked = Boolean(server.autoStart);
  form.crashBackup.checked = Boolean(server.crashBackup);
  form.wakeOnJoin.checked = Boolean(server.wakeOnJoin);
  const ownerLabel = form.querySelector('#serverOwnerConfigLabel');
  const ownerSelect = form.querySelector('select[name="ownerUserId"]');
  if (ownerLabel && ownerSelect) {
    const isOwner = state.user?.role === 'owner';
    ownerLabel.hidden = !isOwner;
    ownerSelect.disabled = !isOwner;
      ownerSelect.innerHTML = '<option value="">Owner / unassigned</option>' + (state.users || [])
      .filter((user) => user.role !== 'owner')
      .map((user) => `<option value="${user.id}" ${Number(server.ownerUserId || 0) === Number(user.id) ? 'selected' : ''}>${escapeHtml(user.name)} - ${escapeHtml(user.email)}</option>`)
      .join('');
  }
  form.dataset.serverId = String(server.id);
  form.dataset.dirty = '0';
}

function ensureFileControls() {
  if (!elements.fileUploadInput) {
    const input = document.createElement('input');
    input.id = 'fileUploadInput';
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    elements.fileList?.before(input);
    elements.fileUploadInput = input;
  }
  if (!elements.uploadPanel) {
    const panel = document.createElement('div');
    panel.id = 'uploadPanel';
    panel.className = 'upload-panel';
    panel.hidden = true;
    panel.innerHTML = '<span id="uploadLabel">Ready</span><div class="install-track"><span id="uploadProgress" style="width:0%"></span></div><small>Uploads are chunked. If the page refreshes, reselect the same file and it resumes from the saved partial upload.</small><div class="upload-actions"><button class="secondary" type="button" data-action="upload-pause">Pause Current</button><button class="danger" type="button" data-action="upload-cancel-current">Cancel Current</button></div><div class="upload-session-list" id="uploadSessionList"></div>';
    elements.fileList?.before(panel);
    elements.uploadPanel = panel;
    elements.uploadLabel = panel.querySelector('#uploadLabel');
    elements.uploadProgress = panel.querySelector('#uploadProgress');
    elements.uploadSessionList = panel.querySelector('#uploadSessionList');
  }
  if (elements.adminServerAssign) {
    elements.adminServerAssign.innerHTML = '<option value="">No server assignment</option>' + state.servers
      .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
      .join('');
  }
}

async function renderUploadSessions() {
  ensureFileControls();
  const server = activeServer();
  if (!server || !elements.uploadSessionList) return;
  const data = await api(`/api/servers/${server.id}/files/uploads`).catch(() => ({ uploads: [] }));
  const uploads = data.uploads || [];
  elements.uploadPanel.hidden = !uploads.length && !currentUpload.path;
  const existing = new Map([...elements.uploadSessionList.querySelectorAll('[data-upload-path]')]
    .filter((element) => element.classList.contains('upload-session-row'))
    .map((element) => [element.dataset.uploadPath, element]));
  const sameSessions = existing.size === uploads.length
    && uploads.every((upload) => existing.has(upload.path));
  if (sameSessions) {
    for (const upload of uploads) {
      const row = existing.get(upload.path);
      const uploadedMb = Math.round((upload.uploadedBytes || 0) / 1024 / 1024);
      const totalMb = Math.round((upload.size || 0) / 1024 / 1024);
      const detail = row.querySelector('[data-live-upload-detail]');
      const fill = row.querySelector('[data-live-upload-track]');
      if (detail) detail.textContent = `${upload.status} · ${upload.progress}% · ${uploadedMb} / ${totalMb} MB`;
      if (fill) fill.style.width = `${upload.progress}%`;
    }
    return;
  }
  elements.uploadSessionList.innerHTML = uploads.map((upload) => `
    <div class="upload-session-row" data-upload-path="${escapeHtml(upload.path)}">
      <div>
        <strong>${escapeHtml(upload.name)}</strong>
        <div class="muted" data-live-upload-detail>${escapeHtml(upload.status)} · ${upload.progress}% · ${Math.round((upload.uploadedBytes || 0) / 1024 / 1024)} / ${Math.round((upload.size || 0) / 1024 / 1024)} MB</div>
        <div class="install-track"><span data-live-upload-track style="width:${upload.progress}%"></span></div>
      </div>
      <button class="danger" type="button" data-action="upload-cancel" data-upload-path="${escapeHtml(upload.path)}">Cancel</button>
    </div>
  `).join('');
  reapplyDynamicLayout();
}

function selectedFilePaths() {
  return [...document.querySelectorAll('.file-pick:checked')].map((input) => input.value);
}

function selectedFileEntries() {
  return [...document.querySelectorAll('.file-pick:checked')].map((input) => ({
    path: input.value,
    type: input.dataset.fileType || 'file',
  }));
}

function startFastDownload(url) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

function enableDeveloperModeGuard() {
  const redirect = () => {
    window.location.replace('https://www.google.com/');
  };
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (event.key === 'F12' || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key)) || (event.ctrlKey && key === 'u')) {
      event.preventDefault();
      redirect();
    }
  });
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
  let lastWidth = window.outerWidth - window.innerWidth;
  let lastHeight = window.outerHeight - window.innerHeight;
  window.setInterval(() => {
    const widthGap = window.outerWidth - window.innerWidth;
    const heightGap = window.outerHeight - window.innerHeight;
    if ((widthGap > 170 && widthGap > lastWidth + 80) || (heightGap > 170 && heightGap > lastHeight + 80)) redirect();
    lastWidth = widthGap;
    lastHeight = heightGap;
  }, 3000);
}

function childPath(name) {
  return [filePath, name].filter(Boolean).join('/');
}

async function digestHex(blob) {
  if (!window.crypto?.subtle) return '';
  const bytes = blob instanceof Blob ? await blob.arrayBuffer() : blob;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function uploadChunk(server, chunk, destinationPath, offset, totalSize, fileSha256, chunkSha256, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const params = new URLSearchParams({
      path: destinationPath,
      offset: String(offset),
      size: String(totalSize),
      fileSha256,
      chunkSha256,
    });
    xhr.open('POST', `/api/servers/${server.id}/files/upload-chunk?${params}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (_error) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed with ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check network connection.'));
    xhr.send(chunk);
  });
}

async function uploadFile(server, file, destinationPath, onProgress) {
  onProgress(0, 'hashing');
  const fileSha256 = file.size <= 512 * 1024 * 1024 ? await digestHex(file) : '';
  const status = await api(`/api/servers/${server.id}/files/upload-status?path=${encodeURIComponent(destinationPath)}&size=${file.size}&sha256=${fileSha256}`);
  if (status.complete) {
    onProgress(100, 'already uploaded');
    return;
  }
  const chunks = [];
  for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_SIZE) {
    chunks.push({ offset, end: Math.min(offset + UPLOAD_CHUNK_SIZE, file.size), uploaded: false, loaded: 0 });
  }
  const uploadedRanges = Array.isArray(status.uploadedChunks) ? status.uploadedChunks : [];
  for (const chunk of chunks) {
    const exact = uploadedRanges.some((range) => Number(range.start) <= chunk.offset && Number(range.end) >= chunk.end);
    if (exact) {
      chunk.uploaded = true;
      chunk.loaded = chunk.end - chunk.offset;
    }
  }
  const updateProgress = (phase = 'uploading') => {
    const loaded = chunks.reduce((sum, chunk) => sum + (chunk.uploaded ? chunk.end - chunk.offset : chunk.loaded), 0);
    onProgress(Math.min(100, Math.round((loaded / file.size) * 100)), phase);
  };
  if (chunks.some((chunk) => chunk.uploaded)) updateProgress('resuming');

  let cursor = 0;
  async function worker() {
    if (currentUpload.canceled) throw new Error('Upload canceled.');
    if (currentUpload.paused) {
      await api(`/api/servers/${server.id}/files/upload-pause`, {
        method: 'POST',
        body: JSON.stringify({ path: destinationPath, size: file.size }),
      });
      throw new Error('Upload paused. Reselect the same file to resume.');
    }
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      const meta = chunks[index];
      if (meta.uploaded) continue;
      const blob = file.slice(meta.offset, meta.end);
      const chunkSha256 = await digestHex(blob);
      let result;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          result = await uploadChunk(server, blob, destinationPath, meta.offset, file.size, fileSha256, chunkSha256, (loaded) => {
            meta.loaded = loaded;
            updateProgress(attempt > 1 ? `retry ${attempt}` : 'uploading');
          });
          break;
        } catch (error) {
          meta.loaded = 0;
          updateProgress(`retrying ${attempt}`);
          if (attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
        }
      }
      meta.uploaded = true;
      meta.loaded = meta.end - meta.offset;
      if (result?.complete && result.sha256 && result.sha256 !== fileSha256) throw new Error('Final checksum mismatch after upload.');
      updateProgress(result?.complete ? 'verifying' : 'uploading');
      await renderUploadSessions();
    }
  }

  await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLELISM, chunks.length) }, () => worker()));
  updateProgress('verifying');
  const complete = await api(`/api/servers/${server.id}/files/upload-complete`, {
    method: 'POST',
    body: JSON.stringify({ path: destinationPath, size: file.size, sha256: fileSha256 }),
  });
  if (fileSha256 && complete.sha256 && complete.sha256 !== fileSha256) throw new Error('Final checksum mismatch after upload.');
  updateProgress('complete');
}

async function uploadFiles(files) {
  ensureFileControls();
  const server = activeServer();
  if (!server) return showToast('Create a server first.');
  const queue = [...files].filter((file) => file && file.name);
  if (!queue.length) return;
  elements.uploadPanel.hidden = false;
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    const destination = childPath(file.name);
    currentUpload = { path: destination, size: file.size, paused: false, canceled: false };
    elements.uploadLabel.textContent = `Uploading ${file.name} (${index + 1}/${queue.length})`;
    elements.uploadProgress.style.width = '0%';
    await uploadFile(server, file, destination, (progress, phase = 'uploading') => {
      elements.uploadProgress.style.width = `${progress}%`;
      const label = phase === 'hashing' ? 'Hashing'
        : phase === 'resuming' ? 'Resuming'
          : phase === 'verifying' ? 'Verifying'
            : 'Uploading';
      elements.uploadLabel.textContent = `${label} ${file.name} ${progress}% (${index + 1}/${queue.length})`;
    });
  }
  elements.uploadLabel.textContent = `Uploaded ${queue.length} file(s).`;
  elements.uploadProgress.style.width = '100%';
  showToast('Upload complete.');
  await renderFiles();
  await renderUploadSessions();
  setTimeout(() => {
    if (!elements.uploadSessionList.innerHTML.trim()) elements.uploadPanel.hidden = true;
    elements.uploadProgress.style.width = '0%';
  }, 2600);
}

function renderAccount() {
  if (!state.user) {
    elements.accountBox.textContent = 'Logged out';
    return;
  }
  elements.accountBox.innerHTML = `<span>${escapeHtml(state.user.name)} (${accessName(state.user.accessLevel)})</span><button class="secondary" type="button" data-action="logout">Logout</button>`;
}

function renderAuth() {
  elements.authView.hidden = Boolean(state.user);
  elements.dashboardView.hidden = !state.user;
}

function renderStats() {
  elements.serverCount.textContent = state.servers.length;
  elements.onlineCount.textContent = state.servers.filter((server) => server.status === 'online').length;
  elements.softwareCount.textContent = state.servers.filter((server) => server.installStatus === 'installed').length;
  elements.accessLabel.textContent = state.user ? accessName(state.user.accessLevel) : 'View';
  const maxMemory = state.settings?.maxAllocatableMemoryMb;
  if (maxMemory) {
    const createRam = elements.serverForm?.maxMemoryMb;
    const configRam = elements.serverConfigForm?.maxMemoryMb;
    if (createRam) createRam.max = String(maxMemory);
    if (configRam) configRam.max = String(maxMemory);
  }
  const maxCores = Math.max(1, Number(state.settings?.maxCpuCores || navigator.hardwareConcurrency || 1));
  if (elements.serverForm?.cpuCores) elements.serverForm.cpuCores.max = String(maxCores);
  if (elements.ownerAssignLabel && elements.ownerUserSelect) {
    const owner = state.user?.role === 'owner';
    elements.ownerAssignLabel.hidden = !owner;
    elements.ownerUserSelect.innerHTML = '<option value="">Owner / unassigned</option>' + (state.users || [])
      .filter((user) => user.role !== 'owner')
      .map((user) => `<option value="${user.id}">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</option>`)
      .join('');
  }
}

function renderView() {
  document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
    button.hidden = !canView(button.dataset.view);
  });
  if (!canView(state.activeView)) state.activeView = firstAllowedView();
  document.querySelectorAll('.view-section').forEach((section) => {
    section.hidden = section.id !== `view-${state.activeView}`;
  });
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === state.activeView);
  });
  const [eyebrow, title] = viewTitles[state.activeView] || viewTitles.dashboard;
  elements.viewEyebrow.textContent = eyebrow;
  elements.viewTitle.textContent = title;
}

function renderServerSwitcher() {
  const options = state.servers.map((server) => `<option value="${server.id}" ${server.id === state.activeServerId ? 'selected' : ''}>${escapeHtml(server.name)}</option>`).join('');
  elements.activeServerSelect.innerHTML = options || '<option value="">No servers</option>';
  elements.serverList.innerHTML = state.servers.map((server) => `
    <button class="server-list-item ${server.id === state.activeServerId ? 'is-active' : ''}" type="button" data-action="activate-server" data-server-id="${server.id}" data-live-server-id="${server.id}">
      <span>${escapeHtml(server.name)}</span>
      <small data-live-summary="sidebar">${escapeHtml(server.softwareName)} · ${escapeHtml(server.status)}</small>
    </button>
  `).join('') || '<p class="empty-state">No server yet. Create one.</p>';
}

function renderServerRows() {
  if (!elements.serverRowsGrid) return;
  if (!state.servers.length) {
    elements.serverRowsGrid.innerHTML = '<p class="empty-state">No servers yet. Create one from Dashboard or Templates.</p>';
    return;
  }
  const canOpenConsole = can(CAPABILITIES.CONSOLE_VIEW, state.permissions.VIEW_CONSOLE);
  const canOpenFiles = can(CAPABILITIES.FILES_MANAGE, state.permissions.MANAGE_FILES);
  const canManageServers = can(CAPABILITIES.SERVER_MANAGE, state.permissions.MANAGE_SERVERS);
  elements.serverRowsGrid.innerHTML = state.servers.map((server) => `
    <article class="server-row-card ${server.id === state.activeServerId ? 'is-selected' : ''}" data-server-id="${server.id}" data-live-server-id="${server.id}">
      <div>
        <strong>${escapeHtml(server.name)}</strong>
        <span class="muted" data-live-summary="row">${escapeHtml(server.softwareName)} · ${escapeHtml(server.type)} · ${escapeHtml(server.status)}</span>
      </div>
      <code>${escapeHtml(server.serverPath || '')}</code>
      <div class="row-actions">
        <button type="button" data-action="open-files" ${canOpenFiles ? '' : 'hidden'}>Open</button>
        <button class="secondary" type="button" data-action="open-console" ${canOpenConsole ? '' : 'hidden'}>Console</button>
        <button class="danger" type="button" data-action="delete-server" ${canManageServers ? '' : 'hidden'} ${server.status === 'online' ? 'disabled' : ''}>Delete</button>
      </div>
    </article>
  `).join('');
}

function renderServers() {
  elements.serverForm.hidden = !can(CAPABILITIES.SERVER_MANAGE, state.permissions.MANAGE_SERVERS);
  if (!state.servers.length) {
    elements.serverGrid.innerHTML = '<p class="empty-state">No servers yet. Create one above, then install software from the Software tab.</p>';
    return;
  }

  const canStart = can(CAPABILITIES.SERVER_START, state.permissions.POWER_SERVERS);
  const canStop = can(CAPABILITIES.SERVER_STOP, state.permissions.POWER_SERVERS);
  const canRestart = can(CAPABILITIES.SERVER_RESTART, state.permissions.POWER_SERVERS);
  const canOpenConsole = can(CAPABILITIES.CONSOLE_VIEW, state.permissions.VIEW_CONSOLE);
  const canOpenFiles = can(CAPABILITIES.FILES_MANAGE, state.permissions.MANAGE_FILES);
  const canManageServers = can(CAPABILITIES.SERVER_MANAGE, state.permissions.MANAGE_SERVERS);
  elements.serverGrid.innerHTML = state.servers.map((server) => {
    const isOnline = server.status === 'online';
    const installed = server.installStatus === 'installed';
    return `
      <article class="server-card ${server.id === state.activeServerId ? 'is-selected' : ''}" data-server-id="${server.id}" data-live-server-id="${server.id}">
        <div class="status-row">
          <h3>${escapeHtml(server.name)}</h3>
          <span class="badge ${isOnline ? 'is-on' : ''}" data-live-status>${escapeHtml(server.status)}</span>
        </div>
        <div class="stat-row"><span class="muted">Software</span><strong>${escapeHtml(server.softwareName)}</strong></div>
        <div class="install-track"><span data-live-install-track style="width:${server.installProgress}%"></span></div>
        <div class="stat-row"><span class="muted" data-live-install-message data-live-message-format="status">${escapeHtml(server.installStatus)}</span><strong data-live-install-progress>${server.installProgress}%</strong></div>
        <div class="stat-row"><span class="muted">Address</span><strong>${server.host}:${server.port}</strong></div>
        <div class="stat-row"><span class="muted">Path</span><code>${escapeHtml(server.serverPath || 'pending')}</code></div>
        <div class="server-actions">
          <button type="button" data-action="open-files" ${canOpenFiles ? '' : 'hidden'}>Open</button>
          <button class="secondary" type="button" data-action="open-console" ${canOpenConsole ? '' : 'hidden'}>Console</button>
          <button class="secondary" type="button" data-action="start-server" ${canStart ? '' : 'hidden'} ${isOnline || !installed ? 'disabled' : ''}>Start</button>
          <button class="secondary" type="button" data-action="stop-server" ${canStop ? '' : 'hidden'} ${isOnline ? '' : 'disabled'}>Stop</button>
          <button class="secondary" type="button" data-action="restart-server" ${canRestart ? '' : 'hidden'} ${isOnline ? '' : 'disabled'}>Restart</button>
          <button class="danger" type="button" data-action="delete-server" ${canManageServers ? '' : 'hidden'} ${isOnline ? 'disabled' : ''}>Delete</button>
        </div>
      </article>
    `;
  }).join('');
}

function templateGameGroup(template) {
  const family = template.nexu?.game?.family || '';
  const game = template.game || 'Other';
  if (family === 'minecraft' || game.toLowerCase().includes('minecraft')) return 'Minecraft';
  return game;
}

function renderTemplates() {
  if (!elements.templateGrid) return;
  const allTemplates = state.templates || [];
  const games = [...new Set(allTemplates.map(templateGameGroup))].sort((a, b) => a.localeCompare(b));
  const defaultGame = state.settings?.edition === 'host' && games.includes('Minecraft') ? 'Minecraft' : 'All';
  if (!state.templateGameFilter || (state.templateGameFilter !== 'All' && !games.includes(state.templateGameFilter))) {
    state.templateGameFilter = defaultGame;
  }
  if (elements.templateGameSelect) {
    const options = state.settings?.edition === 'host' ? games : ['All', ...games];
    elements.templateGameSelect.innerHTML = options.map((game) => `<option value="${escapeHtml(game)}" ${game === state.templateGameFilter ? 'selected' : ''}>${escapeHtml(game)}</option>`).join('');
  }
  const templates = state.templateGameFilter === 'All'
    ? allTemplates
    : allTemplates.filter((template) => templateGameGroup(template) === state.templateGameFilter);
  const maxCpuCores = Math.max(1, Number(state.settings?.maxCpuCores || 1));
  elements.templateGrid.innerHTML = templates.map((template) => `
    <article class="template-card">
      <div class="status-row">
        <div>
          <p class="eyebrow">${escapeHtml(template.game)}</p>
          <h3>${escapeHtml(template.name)}</h3>
        </div>
        <span class="badge ${template.edition === 'custom' ? '' : 'is-on'}">${escapeHtml(template.edition)}</span>
      </div>
      <p>${escapeHtml(template.description)}</p>
      <div class="nexu-orb">
        <span>RAM ${escapeHtml(template.memoryMb)} MB</span>
        <span>CPU ${escapeHtml(template.cpuCores || 1)} core(s)</span>
        <span>Disk ${escapeHtml(template.diskMb || 0)} MB</span>
      </div>
      <div class="template-tags">${(template.features || []).slice(0, 5).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      <details class="nexu-details">
        <summary>Template JSON structure</summary>
        <pre>${escapeHtml(JSON.stringify(template.nexu || {}, null, 2))}</pre>
      </details>
      <p class="muted">Requirements: ${(template.requirements || []).map((item) => escapeHtml(item.name || item.key || item)).join(', ') || 'none'} · Start args: ${(template.startArgs || []).map(escapeHtml).join(' ') || 'native'}</p>
      <div class="field-grid mini">
        <label>Name <input data-template-name="${escapeHtml(template.key)}" value="${escapeHtml(template.name)}"></label>
        <label>RAM MB <input data-template-ram="${escapeHtml(template.key)}" type="number" min="256" max="${state.settings?.maxAllocatableMemoryMb || 65536}" step="256" value="${template.memoryMb}"></label>
        <label>CPU cores <input data-template-cpu="${escapeHtml(template.key)}" type="number" min="1" max="${maxCpuCores}" step="1" value="${template.cpuCores || 1}"></label>
        <label>Port <input data-template-port="${escapeHtml(template.key)}" type="number" min="1" max="65535" value="${template.port}"></label>
      </div>
      <button type="button" data-action="create-template-server" data-template-key="${escapeHtml(template.key)}">${template.edition === 'custom' ? 'Create Template Server' : 'Create + Auto Setup'}</button>
    </article>
  `).join('') || '<p class="empty-state">No templates available.</p>';
}

function renderSoftware() {
  const server = activeServer();
  if (!server) {
    elements.softwareGrid.innerHTML = '<p class="empty-state">Create a server before installing software.</p>';
    return;
  }

  if (!state.softwareCatalog || state.softwareCatalog.length === 0) {
    elements.softwareGrid.innerHTML = '<p class="empty-state">No software available.</p>';
    return;
  }

  elements.softwareGrid.innerHTML = `
    <article class="software-card software-update-card" data-layout-key="software-updates">
      <div class="status-row">
        <strong>Software Versions</strong>
        <span class="pill">Live</span>
      </div>
      <p>Checks Paper, Purpur, Java, Bedrock, and PocketMine sources for new versions.</p>
      <button type="button" data-action="check-software-updates">Check Updates</button>
    </article>
  ` + (server.templateKey && server.type === 'custom' ? `
    <article class="software-card is-selected" data-layout-key="template-runtime" data-live-server-id="${server.id}">
      <div class="status-row">
        <strong>${escapeHtml(server.softwareName || 'Nexu Template')}</strong>
        <span class="pill is-on">nexu</span>
      </div>
      <p>Installs from the template's own runtime commands, including SteamCMD app IDs where provided.</p>
      <div class="stat-row"><span class="muted">Executable</span><code>${escapeHtml(server.executablePath || 'resolved after install')}</code></div>
      <div class="install-track"><span data-live-install-track style="width:${server.installProgress || 0}%"></span></div>
      <div class="stat-row"><span class="muted" data-live-install-message data-live-message-format="message">${escapeHtml(server.installMessage || server.installStatus || 'Ready')}</span><strong data-live-install-progress>${server.installProgress || 0}%</strong></div>
      <button type="button" data-action="install-software" data-software-key="${escapeHtml(server.softwareKey || '')}">${server.installStatus === 'installed' ? 'Reinstall Template' : 'Install Template'}</button>
    </article>
  ` : '') + state.softwareCatalog.map((software) => {
    const compatible = software.edition === server.type;
    const selected = software.key === server.softwareKey;
    return `
      <article class="software-card ${selected ? 'is-selected' : ''}" data-software-key="${escapeHtml(software.key)}" ${selected ? `data-live-server-id="${server.id}"` : ''}>
        <div class="status-row">
          <strong>${escapeHtml(software.name)}</strong>
          <span class="pill ${compatible ? 'is-on' : ''}">${compatible ? software.edition : 'blocked'}</span>
        </div>
        <p>${escapeHtml(software.notes)}</p>
        <div class="stat-row"><span class="muted">Executable</span><code>${escapeHtml(selected ? server.executablePath : software.expectedPath)}</code></div>
        <label>Version <select data-software-version="${software.key}" ${compatible ? '' : 'disabled'}><option value="latest">Latest</option></select></label>
        <div class="install-track"><span data-live-install-track style="width:${selected ? server.installProgress : 0}%"></span></div>
        <div class="stat-row"><span class="muted" data-live-install-message data-live-message-format="software">${selected ? `${escapeHtml(server.installMessage)} (${escapeHtml(server.softwareVersion || 'latest')})` : 'Not selected'}</span><strong data-live-install-progress>${selected ? `${server.installProgress}%` : ''}</strong></div>
        <button type="button" data-action="install-software" data-software-key="${software.key}" ${compatible ? '' : 'disabled'}>${selected && server.installStatus === 'installed' ? 'Reinstall' : 'Install'}</button>
      </article>
    `;
  }).join('');
  hydrateSoftwareVersionSelects();
}

async function renderActiveView() {
  if (!state.user) return;
  if (state.activeView === 'dashboard') renderServers();
  if (state.activeView === 'servers') renderServerRows();
  if (state.activeView === 'templates') renderTemplates();
  if (state.activeView === 'software') renderSoftware();
  if (state.activeView === 'properties') await renderProperties();
  if (state.activeView === 'whitelist') await renderWhitelist();
  if (state.activeView === 'plugins') renderPlugins();
  if (state.activeView === 'console') await renderConsole();
  if (state.activeView === 'files') {
    await renderFiles();
    await renderUploadSessions();
  }
  if (state.activeView === 'backups') renderBackups();
  if (state.activeView === 'optimizer') await renderOptimizer();
  if (state.activeView === 'network') await renderNetwork();
  if (state.activeView === 'admins') renderAdmins();
  if (state.activeView === 'security') await renderSecurity();
  if (state.activeView === 'fixed') await renderFixed();
  if (state.activeView === 'settings') renderSettings();
  if (state.activeView === 'terminal') renderTerminal();
  applyUiPreferences(alphaDraft);
}

function animateCommandButton(button) {
  if (!button) return;
  button.classList.remove('is-commanding');
  void button.offsetWidth;
  button.classList.add('is-commanding');
  button.addEventListener('animationend', () => button.classList.remove('is-commanding'), { once: true });
}

function renderPlugins() {
  const canManagePlugins = can(CAPABILITIES.PLUGINS_MANAGE, state.permissions.MANAGE_FILES);
  if (elements.pluginForm) elements.pluginForm.hidden = true;
  elements.pluginAccessNote.hidden = canManagePlugins;
  if (elements.pluginServerSelect) elements.pluginServerSelect.innerHTML = state.servers.map((server) => `<option value="${server.id}">${escapeHtml(server.name)} (${escapeHtml(server.softwareName)})</option>`).join('') || '<option value="">Create a server first</option>';
  const server = activeServer();

  if (!canManagePlugins) {
    elements.pluginList.innerHTML = '<p class="empty-state">Plugin manager is locked until file access level 80.</p>';
    return;
  }

  if (!server) {
    elements.pluginList.innerHTML = '<p class="empty-state">Create a server to install plugins.</p>';
    return;
  }

  if (server.softwareKey === 'bedrock-vanilla') {
    elements.modrinthGrid.innerHTML = '<p class="empty-state">Bedrock Dedicated Server does not support server plugins. Use File Manager to add resource packs or behavior packs, or switch software to PocketMine for plugins.</p>';
  } else if (server.softwareKey === 'pocketmine') {
    elements.modrinthForm.querySelector('input[name="query"]').placeholder = 'Search Poggit: PurePerms, ScoreHud, Worlds';
    elements.modrinthForm.querySelector('[name="projectType"]').disabled = true;
    elements.modrinthForm.querySelector('[name="loader"]').disabled = true;
    loadPluginMarketplace({ featured: true }).catch(() => {});
  } else {
    elements.modrinthForm.querySelector('input[name="query"]').placeholder = 'Search Modrinth: Geyser, LuckPerms, ViaVersion';
    elements.modrinthForm.querySelector('[name="projectType"]').disabled = false;
    elements.modrinthForm.querySelector('[name="loader"]').disabled = false;
    loadPluginMarketplace({ featured: true }).catch(() => {});
  }

  const plugins = state.plugins.filter((plugin) => plugin.serverId === server.id);
  if (!plugins.length) {
    elements.pluginList.innerHTML = '<p class="empty-state">No plugins installed for this server yet. Search Modrinth above.</p>';
    return;
  }

  elements.pluginList.innerHTML = plugins.map((plugin) => {
    return `
      <div class="plugin-row" data-plugin-id="${plugin.id}">
        <div><strong>${escapeHtml(plugin.name)}</strong><div class="muted">${escapeHtml(plugin.kind)} | ${escapeHtml(plugin.relativePath)}</div></div>
        <div class="user-actions"><button class="secondary" type="button" data-action="toggle-plugin">${plugin.enabled ? 'Disable' : 'Enable'}</button><button class="danger" type="button" data-action="delete-plugin">Delete</button></div>
      </div>
    `;
  }).join('');
}

async function renderConsole() {
  const server = activeServer();
  const renderToken = ++consoleRenderToken;
  if (!server) {
    elements.consoleBox.innerHTML = '<div>[NexusPanel] Create a server to use console.</div>';
    if (elements.consoleMetrics) elements.consoleMetrics.innerHTML = '';
    return;
  }
  const serverId = server.id;
  const now = Date.now();
  if (now - Number(state.consolePollAt[serverId] || 0) < 250) return;
  state.consolePollAt[serverId] = now;
  const needsMetrics = now - Number(state.consoleMetricsAt[serverId] || 0) >= 1500;
  if (needsMetrics) state.consoleMetricsAt[serverId] = now;
  const [data, metricsBundle] = await Promise.all([
    api(`/api/servers/${server.id}/console`).catch((error) => ({ lines: [], error: error.message })),
    needsMetrics
      ? Promise.all([
        api('/api/system/metrics').catch(() => null),
        api(`/api/servers/${server.id}/metrics`).catch(() => null),
      ])
      : Promise.resolve(null),
  ]);
  if (renderToken !== consoleRenderToken || state.activeServerId !== serverId) return;
  fillServerConfigForm(server);
  elements.serverConfigForm.hidden = !can(CAPABILITIES.SERVER_MANAGE, state.permissions.MANAGE_SERVERS);
  elements.commandForm.hidden = !can(CAPABILITIES.CONSOLE_COMMAND, state.permissions.SEND_COMMANDS);
  if (data.status && server.status !== data.status) {
    server.status = data.status;
    renderStats();
    updateLiveServerDom();
  }
  syncConsoleActionButtons(server, data.status || server.status);
  const lines = data.lines.length
    ? data.lines
    : data.error
      ? [`[NexusPanel] Console unavailable: ${data.error}`]
      : server.installStatus !== 'installed'
        ? [`[NexusPanel] ${server.name} is ${data.status || server.status}.`, '[NexusPanel] Install server software before starting.']
        : [`[NexusPanel] ${server.name} is ${data.status || server.status}.`, '[NexusPanel] No panel logs have been recorded yet. Press Start to begin.'];
  const consoleSignature = `${lines.length}:${lines.at(-1) || ''}`;
  if (elements.consoleBox.dataset.rendered !== consoleSignature) {
    const consoleHtml = lines.map((line) => `<div>${escapeHtml(formatConsoleLine(line))}</div>`).join('');
    elements.consoleBox.innerHTML = consoleHtml;
    elements.consoleBox.dataset.rendered = consoleSignature;
  }
  if (consoleStickToBottom) elements.consoleBox.scrollTop = elements.consoleBox.scrollHeight;
  if (metricsBundle) renderConsoleMetrics(server, metricsBundle[0], metricsBundle[1]);
  renderPresence(server).catch(() => {});
}

async function loadPluginMarketplace({ featured = false } = {}) {
  const server = activeServer();
  if (!server || !elements.modrinthGrid) return;
  if (server.softwareKey === 'bedrock-vanilla') {
    elements.modrinthGrid.innerHTML = '<p class="empty-state">Bedrock Dedicated Server packs need behavior/resource pack registration. Use File Manager for now; PocketMine plugins are available after switching software.</p>';
    return;
  }
  const payload = formData(elements.modrinthForm);
  const source = server.softwareKey === 'pocketmine' ? 'poggit' : 'modrinth';
  const query = featured ? '' : String(payload.query || '');
  const loader = source === 'modrinth' ? String(payload.loader || '') : '';
  const projectType = source === 'modrinth' ? String(payload.projectType || 'plugin') : '';
  const signature = `${source}:${server.id}:${query}:${loader}:${projectType}`;
  if (featured && state.pluginSearchSignature === signature && elements.modrinthGrid.children.length) return;
  state.pluginSearchSignature = signature;
  elements.modrinthGrid.innerHTML = '<p class="empty-state">Loading marketplace cards...</p>';
  const params = new URLSearchParams({ serverId: server.id, query });
  if (loader) params.set('loader', loader);
  if (projectType) params.set('projectType', projectType);
  const data = await api(`/api/${source}/search?${params}`);
  elements.modrinthGrid.innerHTML = data.hits.map((project) => `
    <article class="modrinth-card">
      <div class="status-row">
        <strong>${escapeHtml(project.title)}</strong>
        <span class="pill">${Number(project.downloads || 0).toLocaleString()} downloads</span>
      </div>
      <p>${escapeHtml(project.description || '')}</p>
      ${project.iconUrl ? `<img class="plugin-icon" src="${escapeHtml(project.iconUrl)}" alt="">` : ''}
      <div class="template-tags">${(project.categories || []).slice(0, 5).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      <div class="install-track" hidden><span style="width:0%"></span></div>
      <button type="button"
        data-action="${source === 'poggit' ? 'install-poggit' : 'install-modrinth'}"
        data-project-id="${escapeHtml(project.projectId || '')}"
        data-project-name="${escapeHtml(project.title)}"
        data-download-url="${escapeHtml(project.downloadUrl || '')}"
        data-file-name="${escapeHtml(project.fileName || '')}">Install</button>
    </article>
  `).join('') || `<p class="empty-state">${escapeHtml(data.message || `No ${source} items found. Try a broader search.`)}</p>`;
}

function appendConsoleImmediate(line) {
  if (!elements.consoleBox || !line) return;
  elements.consoleBox.dataset.rendered = '';
  elements.consoleBox.insertAdjacentHTML('beforeend', `<div>${escapeHtml(formatConsoleLine(line))}</div>`);
  if (consoleStickToBottom) elements.consoleBox.scrollTop = elements.consoleBox.scrollHeight;
}

async function renderPresence(server) {
  if (!elements.presencePanel || !server) return;
  const now = Date.now();
  if (now - Number(state.presenceAt || 0) < 3000) return;
  state.presenceAt = now;
  api('/api/presence', {
    method: 'POST',
    body: JSON.stringify({ serverId: server.id, view: state.activeView, label: server.name }),
  }).catch(() => {});
  const data = await api(`/api/presence?serverId=${encodeURIComponent(server.id)}`).catch(() => ({ users: [] }));
  const users = (data.users || []).filter((user) => !user.self).slice(0, 5);
  elements.presencePanel.innerHTML = users.length
    ? users.map((user) => `<div class="plugin-row"><div><strong>${escapeHtml(user.name || user.email)}</strong><div class="muted">Viewing ${escapeHtml(user.view || 'panel')} now</div></div><span class="badge is-on">Live</span></div>`).join('')
    : '<div class="plugin-row"><div><strong>Live collaborators</strong><div class="muted">No other owner/admin is viewing this server right now.</div></div><span class="badge">Solo</span></div>';
}

function syncConsoleActionButtons(server, status) {
  const surface = elements.consoleBox?.closest('.tool-surface');
  if (!surface) return;
  const isOnline = status === 'online';
  const installed = server.installStatus === 'installed';
  const set = (action, disabled) => {
    const button = surface.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = disabled;
  };
  const show = (action, visible) => {
    const button = surface.querySelector(`[data-action="${action}"]`);
    if (button) button.hidden = !visible;
  };
  show('start-server', can(CAPABILITIES.SERVER_START, state.permissions.POWER_SERVERS));
  show('stop-server', can(CAPABILITIES.SERVER_STOP, state.permissions.POWER_SERVERS));
  show('restart-server', can(CAPABILITIES.SERVER_RESTART, state.permissions.POWER_SERVERS));
  show('kill-server', can(CAPABILITIES.SERVER_KILL, state.permissions.POWER_SERVERS));
  show('fix-server', can(CAPABILITIES.SERVER_MANAGE, state.permissions.MANAGE_SERVERS));
  set('start-server', isOnline || !installed);
  set('stop-server', !isOnline);
  set('restart-server', !isOnline);
  set('kill-server', !isOnline);
}

function renderConsoleMetrics(server, metrics, serverMetrics) {
  if (!elements.consoleMetrics || !metrics) {
    if (elements.consoleMetrics) elements.consoleMetrics.innerHTML = '';
    return;
  }
  const ramPercent = metrics.ramTotalMb ? Math.min(100, Math.round((metrics.ramUsedMb / metrics.ramTotalMb) * 100)) : 0;
  const serverRamPercent = serverMetrics?.maxMemoryMb ? Math.min(100, Math.round((serverMetrics.rssMb / serverMetrics.maxMemoryMb) * 100)) : 0;
  const history = state.metricHistory[server.id] || [];
  history.push({
    cpu: Number(metrics.cpuPercent || 0),
    ram: ramPercent,
    serverCpu: Number(serverMetrics?.cpuPercent || 0),
    serverRam: serverRamPercent,
    players: Number(serverMetrics?.playerCount || 0),
  });
  while (history.length > 36) history.shift();
  state.metricHistory[server.id] = history;

  elements.consoleMetrics.innerHTML = `
    ${metricCard('Host CPU', `${metrics.cpuPercent}%`, metrics.cpuPercent, history, 'cpu')}
    ${metricCard('Host RAM', `${formatBytes(metrics.ramUsedMb * 1024 * 1024)} / ${formatBytes(metrics.ramTotalMb * 1024 * 1024)}`, ramPercent, history, 'ram')}
    ${metricCard('Server RAM', `${serverMetrics ? `${formatBytes(serverMetrics.rssMb * 1024 * 1024)} / ${formatBytes(serverMetrics.maxMemoryMb * 1024 * 1024)}` : 'Offline'}`, serverRamPercent, history, 'serverRam')}
    ${metricCard('Server CPU', `${serverMetrics ? `${serverMetrics.cpuPercent}%` : '0%'}`, serverMetrics?.cpuPercent || 0, history, 'serverCpu')}
    ${metricCard('Players', `${serverMetrics ? serverMetrics.playerCount : 0}`, Math.min(100, (serverMetrics?.playerCount || 0) * 8), history, 'players')}
    ${metricCard('Load', `${metrics.load}`, Math.min(100, Number(metrics.load || 0) * 18), history, 'cpu')}
  `;
}

function metricCard(label, value, percent, history, key) {
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return `
    <article class="metric-card">
      <div class="metric-head"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
      <div class="metric-bar"><i style="width:${safePercent}%"></i></div>
      <div class="metric-spark">${history.map((item) => `<i style="height:${Math.max(8, Math.min(100, Number(item[key]) || 0))}%"></i>`).join('')}</div>
    </article>
  `;
}

async function renderProperties() {
  const server = activeServer();
  if (!server) {
    elements.propertyForm.innerHTML = '<p class="empty-state">Create a server to edit properties.</p>';
    return;
  }
  const data = await api(`/api/servers/${server.id}/properties`);
  elements.propertyForm.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">Properties</p><h2>${escapeHtml(server.name)}</h2></div><button type="submit">Save properties</button></div>
    <div class="property-grid">
      ${data.schema.map((item) => propertyControl(item, data.values[item.key])).join('')}
    </div>
  `;
}

function propertyControl(item, value = '') {
  if (item.type === 'boolean') {
    const checked = String(value) === 'true' ? 'checked' : '';
    return `<label class="property-card property-toggle"><span class="property-name">${escapeHtml(item.label)}</span><span class="switch"><input name="${escapeHtml(item.key)}" type="checkbox" ${checked}><span></span></span></label>`;
  }
  if (item.type === 'select') {
    return `<label class="property-card"><span class="property-name">${escapeHtml(item.label)}</span><select name="${escapeHtml(item.key)}">${item.options.map((option) => `<option value="${escapeHtml(option)}" ${String(value) === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  return `<label class="property-card"><span class="property-name">${escapeHtml(item.label)}</span><input name="${escapeHtml(item.key)}" type="${item.type === 'number' ? 'number' : item.type === 'password' ? 'password' : 'text'}" value="${escapeHtml(value)}"></label>`;
}

async function renderWhitelist() {
  const server = activeServer();
  if (!server) {
    elements.whitelistList.innerHTML = '<p class="empty-state">Create a server to manage whitelist.</p>';
    return;
  }
  const data = await api(`/api/servers/${server.id}/whitelist?ts=${Date.now()}`);
  const clearButton = data.players.length ? '<button class="danger" type="button" data-action="clear-whitelist">Remove All</button>' : '';
  elements.whitelistList.innerHTML = data.players.map((player) => `
    <div class="plugin-row">
      <div><strong>${escapeHtml(player.name || 'Unknown')}</strong><div class="muted">${escapeHtml(player.uuid || player.xuid || 'Bedrock allowlist')}</div></div>
      <button class="danger" type="button" data-action="delete-whitelist" data-player-name="${escapeHtml(player.name || '')}">Remove</button>
    </div>
  `).join('') + clearButton || '<p class="empty-state">No whitelisted players yet.</p>';
}

async function renderFiles() {
  const server = activeServer();
  if (!server) {
    elements.fileList.innerHTML = '<p class="empty-state">Create a server to browse files.</p>';
    return;
  }
  const data = await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(filePath)}`).catch((error) => {
    showToast(error.message);
    return null;
  });
  if (!data) return;
  elements.filePathLabel.textContent = `/${data.path || ''}`;
  if (data.type === 'file') {
    elements.fileList.innerHTML = '';
    elements.fileEditor.hidden = false;
    elements.fileEditor.path.value = data.path;
    elements.fileEditor.content.value = data.content;
    return;
  }
  elements.fileEditor.hidden = true;
  elements.fileList.innerHTML = data.entries.map((entry) => `
    <div class="file-row">
      <label class="file-check"><input type="checkbox" class="file-pick" value="${escapeHtml(entry.path)}" data-file-type="${escapeHtml(entry.type)}"><span></span></label>
      <button class="file-open" type="button" data-action="file-open" data-file-path="${escapeHtml(entry.path)}">
        <span class="file-icon">${entry.type === 'directory' ? '📁' : '📄'}</span>
        <span class="file-main"><strong>${escapeHtml(entry.name)}</strong><small>${entry.type === 'directory' ? 'Folder' : formatBytes(entry.size)}</small></span>
      </button>
      <div class="file-meta"><code>${escapeHtml(entry.path)}</code><time>${entry.modifiedAt ? escapeHtml(formatPanelDate(entry.modifiedAt)) : ''}</time></div>
    </div>
  `).join('') || '<p class="empty-state">Folder is empty. Create a file or paste config here.</p>';
}

function renderSettings() {
  if (!elements.settingsPanel) return;
  const settings = state.settings || {};
  const update = settings.updateStatus || {};
  const isHost = settings.edition === 'host';
  const canManageSettings = can(CAPABILITIES.SETTINGS_MANAGE, state.permissions.MANAGE_ADMINS);
  const selectedZone = settings.timeZone || 'UTC';
  const zoneOptions = timeZones.map((zone) => `<option value="${escapeHtml(zone)}" ${zone === selectedZone ? 'selected' : ''}>${escapeHtml(zone)}</option>`).join('');
  const visibleNavOrder = [...document.querySelectorAll('.nav-list [data-view]')].map((button) => ({
    key: button.dataset.view,
    label: button.textContent.trim(),
  }));

  elements.settingsPanel.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">Settings</p><h2>${canManageSettings ? 'Panel engine' : 'Account preferences'}</h2></div>${canManageSettings ? '<button type="button" data-action="run-panel-update">Update from GitHub</button>' : ''}</div>
    <form class="settings-form" id="settingsForm">
      ${canManageSettings ? `
      <label class="switch"><input name="terminalEnabled" type="checkbox" ${settings.terminalEnabled ? 'checked' : ''}><span></span>Owner terminal row</label>
      <label class="switch"><input name="nexusMarkEnabled" type="checkbox" ${settings.nexusMarkEnabled ? 'checked' : ''}><span></span>Nexus-Mark controls</label>
      <label class="switch"><input name="repairWebEnabled" type="checkbox" ${settings.repairWebEnabled ? 'checked' : ''}><span></span>Repair agent web research</label>
      <label class="switch"><input name="repairAgentTerminalEnabled" type="checkbox" ${settings.repairAgentTerminalEnabled ? 'checked' : ''}><span></span>Terminal diagnostics</label>
      <label>Panel version <input readonly value="${escapeHtml(settings.version || '2.0.0')}"></label>
      <label>Update source <input readonly value="${escapeHtml(settings.updateRepo || '')}"></label>
      <label>Update tag <input name="updateTargetTag" value="${escapeHtml(settings.updateTag || '')}" placeholder="normal-v2.0.0"></label>
      <label>Public panel URL <input name="publicBaseUrl" type="url" value="${escapeHtml(settings.publicBaseUrl || '')}" placeholder="https://panel.example.com"></label>
      <label>Max allocatable RAM <input readonly value="${settings.maxAllocatableMemoryMb || 0} MB"></label>
      <label>Max CPU cores <input readonly value="${settings.maxCpuCores || 1}"></label>
      <label>Edition <input readonly value="${escapeHtml(settings.edition || 'normal')} (${escapeHtml(settings.updateTag || '')})"></label>
      ${isHost ? `<label class="switch"><input name="hostMaintenanceMode" type="checkbox" ${settings.hostMaintenanceMode ? 'checked' : ''}><span></span>Host maintenance mode</label>
      <label>Servers per hosted account <input name="hostServerQuota" type="number" min="1" max="500" value="${Number(settings.hostServerQuota || 10)}"></label>` : `
      <div class="settings-group tunnel-settings">
        <strong>Normal public tunnel setup</strong>
        <label>ngrok auth token <input name="ngrokAuthToken" type="password" placeholder="${settings.ngrokConfigured ? `Saved (${escapeHtml(settings.ngrokAuthtokenPreview || 'configured')})` : 'Paste ngrok token'}"></label>
        <label>Tunnel packet type <select id="normalTunnelProtocol"><option value="auto">Auto from server type</option><option value="tcp">TCP (Java)</option><option value="udp">UDP (Bedrock)</option></select></label>
        <label class="switch"><input name="playitEnabled" type="checkbox" ${settings.playitEnabled ? 'checked' : ''}><span></span>Enable playit.gg helper</label>
        <div class="row-actions">
          <button class="secondary" type="button" data-action="show-normal-tunnel-plan">Status</button>
          <button class="secondary" type="button" data-action="install-ngrok-agent">Install ngrok</button>
          <button class="secondary" type="button" data-action="start-ngrok-tunnel">Start ngrok</button>
          <button class="danger" type="button" data-action="stop-ngrok-tunnel">Stop ngrok</button>
          <button class="secondary" type="button" data-action="install-playit-agent">Install Playit</button>
          <button class="secondary" type="button" data-action="run-playit-terminal">Run Playit terminal</button>
          <button class="secondary" type="button" data-action="start-playit-agent">Start Playit</button>
          <button class="danger" type="button" data-action="stop-playit-agent">Stop Playit</button>
          <a id="playitSetupLink" class="button-like secondary" href="${escapeHtml(settings.playitSetupUrl || 'https://playit.gg/account/agents')}" target="_blank" rel="noreferrer">Playit setup</a>
        </div>
        <div class="tunnel-output" id="normalTunnelOutput">Select a server, choose TCP or UDP, then click Show tunnel status.</div>
      </div>`}` : ''}
      <div class="settings-group">
        <div class="setting-inline">
          <label>Timezone <select name="timeZone" id="userTimezoneSelect">${zoneOptions}</select></label>
          <button type="button" class="secondary" data-action="save-timezone">Save Timezone</button>
          <span id="timezoneStatus"></span>
        </div>
      </div>
      ${canManageSettings ? '<button class="save-wide" type="submit">Save Panel Settings</button>' : ''}
    </form>
    ${canManageSettings ? `
    <div class="upload-panel">
      <span id="panelUpdateMessage">${escapeHtml(update.message || 'Updater idle')}</span>
      <div class="install-track"><span id="panelUpdateProgress" style="width:${Number(update.progress || 0)}%"></span></div>
      <small id="panelUpdateDetail">${update.running ? `Update is running: ${Number(update.progress || 0)}%` : `Last exit: ${update.exitCode ?? 'none'}`}</small>
    </div>
    ${isHost && state.user?.role === 'owner' ? `<div class="server-actions"><button class="secondary" type="button" data-action="show-host-token">Show Host API Token</button><button class="danger" type="button" data-action="regen-host-token">Regenerate Host Token</button><code>${escapeHtml(settings.hostApiTokenPreview || '')}</code></div>` : ''}
    <div class="public-help-grid">
      <article><strong>Nexus-Mark</strong><span>Original lightweight control profile: safe paths, RAM caps, CPU plan metadata, and future cgroup/systemd slicing on Linux.</span></article>
      <article><strong>Template Imports</strong><span>JSON game blueprints. Custom game servers stay isolated per server.</span></article>
      <article><strong>Updater</strong><span>Pulls panel code while protecting server data and the external backup store.</span></article>
    </div>
    ${isHost ? `<details class="nexu-details">
      <summary>Example Template JSON</summary>
      <pre>${escapeHtml(JSON.stringify(settings.nexuExample || {}, null, 2))}</pre>
    </details>` : ''}` : ''}
    <details class="nexu-details alpha-lab">
      <summary>Alpha UI studio</summary>
      <p class="help-text">Boxes and Buttons choose what to edit. Free mode gives bounded X/Y placement, 1px arrow-key nudging, snap control, and independent desktop/mobile coordinates; Flow mode reorders the responsive layout.</p>
      <form id="alphaUiForm">
        <div class="alpha-control-grid">
          <label>Button shape <select data-alpha-key="buttonShape">${[
            ['soft','Soft'],['angular','Angular'],['pill','Pill'],['tech','Tech cut'],['square','Square'],['bevel','Bevel'],['notch','Notch'],['hex','Hex'],['slant','Slant'],['tab','Tab'],['leaf','Leaf'],['bracket','Bracket'],['arc','Arc'],['shield','Shield'],['ticket','Ticket'],['step','Step'],['edge','Diamond edge'],['outline','Outline'],['compact','Compact'],['glass','Glass'],
          ].map(([value,label]) => alphaOption(value, alphaDraft.buttonShape, label)).join('')}</select></label>
          <label>Button size <select data-alpha-key="buttonSize">${alphaOption('small', alphaDraft.buttonSize, 'Small')}${alphaOption('medium', alphaDraft.buttonSize, 'Medium')}${alphaOption('large', alphaDraft.buttonSize, 'Large')}</select></label>
          <label>Sidebar width <input data-alpha-key="sidebarWidth" type="range" min="220" max="380" value="${alphaDraft.sidebarWidth}"></label>
          <label>Font scale <input data-alpha-key="fontScale" type="range" min="85" max="120" value="${alphaDraft.fontScale}"></label>
          <label>Accent hue <input data-alpha-key="accentHue" type="range" min="0" max="360" value="${alphaDraft.accentHue}"></label>
          <label>Surface opacity <input data-alpha-key="surfaceOpacity" type="range" min="55" max="100" value="${alphaDraft.surfaceOpacity}"></label>
          <label>Content width <input data-alpha-key="contentWidth" type="range" min="1100" max="2200" step="50" value="${alphaDraft.contentWidth}"></label>
          <label>Row gap <input data-alpha-key="rowGap" type="range" min="4" max="24" value="${alphaDraft.rowGap}"></label>
          <label>Border width <input data-alpha-key="borderWidth" type="range" min="0" max="3" value="${alphaDraft.borderWidth}"></label>
          <label>Shadow strength <input data-alpha-key="shadowStrength" type="range" min="0" max="100" value="${alphaDraft.shadowStrength}"></label>
          <label>Navigation text <input data-alpha-key="navFontSize" type="range" min="11" max="20" value="${alphaDraft.navFontSize}"></label>
          <label>Button spacing <input data-alpha-key="buttonGap" type="range" min="2" max="20" value="${alphaDraft.buttonGap}"></label>
          <label>Card corners <input data-alpha-key="cardRadius" type="range" min="0" max="24" value="${alphaDraft.cardRadius}"></label>
          <label>Input corners <input data-alpha-key="inputRadius" type="range" min="0" max="20" value="${alphaDraft.inputRadius}"></label>
          <label>Sidebar opacity <input data-alpha-key="sidebarOpacity" type="range" min="55" max="100" value="${alphaDraft.sidebarOpacity}"></label>
          <label>Backdrop blur <input data-alpha-key="backdropBlur" type="range" min="0" max="30" value="${alphaDraft.backdropBlur}"></label>
          <label>Line height <input data-alpha-key="lineHeight" type="range" min="110" max="190" value="${alphaDraft.lineHeight}"></label>
          <label>Console text <input data-alpha-key="consoleFontSize" type="range" min="10" max="20" value="${alphaDraft.consoleFontSize}"></label>
          <label>Animation speed <input data-alpha-key="animationSpeed" type="range" min="0" max="400" step="20" value="${alphaDraft.animationSpeed}"></label>
          <label>Toolbar scale <input data-alpha-key="toolbarScale" type="range" min="80" max="125" value="${alphaDraft.toolbarScale}"></label>
          ${[
            ['compact', 'Compact density'],
            ['reducedMotion', 'Reduced motion'],
            ['liveRefresh', 'Live refresh'],
            ['stickyTopbar', 'Sticky top bar'],
            ['showQuickStats', 'Show quick stats'],
            ['showEyebrows', 'Show section labels'],
            ['uppercaseButtons', 'Uppercase commands'],
            ['highContrast', 'High contrast'],
            ['focusBoost', 'Strong keyboard focus'],
            ['denseForms', 'Dense forms'],
          ].map(([key, label]) => `<label class="switch"><input type="checkbox" data-alpha-key="${key}" ${alphaDraft[key] ? 'checked' : ''}><span></span>${label}</label>`).join('')}
        </div>
        <div class="backup-settings">
          <button type="submit">Save Alpha layout</button>
          <button type="button" data-action="alpha-open-editor">Open full layout editor</button>
          <button class="secondary" type="button" data-action="alpha-cancel">Cancel preview</button>
          <button class="secondary" type="button" data-action="alpha-undo" ${uiHistory.length ? '' : 'disabled'}>Undo saved</button>
          <button class="secondary" type="button" data-action="alpha-redo" ${uiRedo.length ? '' : 'disabled'}>Redo saved</button>
          <button class="secondary" type="button" data-action="alpha-export">Export layout code</button>
          <button class="secondary" type="button" data-action="alpha-import">Import layout code</button>
          <button class="danger" type="button" data-action="alpha-reset">Reset draft</button>
        </div>
      </form>
      <h3>Navigation order</h3>
      <div class="plugin-list">
        ${visibleNavOrder.map((item, index) => `<div class="plugin-row"><strong>${escapeHtml(item.label)}</strong><div class="row-actions"><button class="secondary" type="button" data-action="alpha-nav-move" data-nav-key="${escapeHtml(item.key)}" data-direction="-1" ${index === 0 ? 'disabled' : ''}>Move up</button><button class="secondary" type="button" data-action="alpha-nav-move" data-nav-key="${escapeHtml(item.key)}" data-direction="1" ${index === visibleNavOrder.length - 1 ? 'disabled' : ''}>Move down</button></div></div>`).join('')}
      </div>
      <h3>Section command order</h3>
      <div class="plugin-list">
        ${(alphaDraft.actionPriority || []).map((key, index, list) => `<div class="plugin-row"><strong>${escapeHtml(key.replaceAll('-', ' '))}</strong><div class="row-actions"><button class="secondary" type="button" data-action="alpha-action-move" data-command-key="${escapeHtml(key)}" data-direction="-1" ${index === 0 ? 'disabled' : ''}>Move up</button><button class="secondary" type="button" data-action="alpha-action-move" data-command-key="${escapeHtml(key)}" data-direction="1" ${index === list.length - 1 ? 'disabled' : ''}>Move down</button></div></div>`).join('')}
      </div>
    </details>
  `;

}

function updateSettingsLiveStatus() {
  if (state.activeView !== 'settings') return;
  const update = state.settings?.updateStatus || {};
  const message = document.getElementById('panelUpdateMessage');
  const progress = document.getElementById('panelUpdateProgress');
  const detail = document.getElementById('panelUpdateDetail');
  if (message) message.textContent = update.message || 'Updater idle';
  if (progress) progress.style.width = `${Number(update.progress || 0)}%`;
  if (detail) detail.textContent = update.running
    ? `Update is running: ${Number(update.progress || 0)}%`
    : `Last exit: ${update.exitCode ?? 'none'}`;
}

function tunnelStatusText(plan) {
  return [
    `Server: ${plan.server ? `${plan.server.name} (${plan.server.type}:${plan.server.port})` : 'No server selected'}`,
    `ngrok: ${plan.ngrok?.running ? 'running' : 'stopped'} | ${plan.ngrok?.installed ? 'installed' : 'not installed'} | ${plan.ngrok?.protocol || 'auto'}`,
    `ngrok binary: ${plan.ngrok?.binary || 'not found in service PATH'}`,
    `ngrok address: ${plan.ngrok?.remoteHost || plan.ngrok?.publicUrl || 'not assigned yet'}`,
    `ngrok command: ${plan.ngrok?.command || ''}`,
    `ngrok note: ${plan.ngrok?.note || ''}`,
    `Playit: ${plan.playit?.running ? 'running' : 'stopped'} | ${plan.playit?.installed ? 'installed' : 'not installed'}`,
    `Playit binary: ${plan.playit?.binary || 'not found in service PATH'}`,
    `Playit setup: ${plan.playit?.setupUrl || 'not reported yet'}`,
    `Playit note: ${plan.playit?.note || ''}`,
  ].join('\n');
}

function linkifyTunnelOutput(message) {
  const escaped = escapeHtml(message);
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const clean = url.replace(/[),.;]+$/, '');
    const suffix = url.slice(clean.length);
    return `<a href="${clean}" target="_blank" rel="noreferrer">${clean}</a>${suffix}`;
  });
}

function setTunnelOutput(message, mode = 'info') {
  const output = document.querySelector('#normalTunnelOutput');
  if (!output) return;
  output.dataset.mode = mode;
  output.innerHTML = linkifyTunnelOutput(message);
}

async function fetchTunnelPlan() {
  const server = activeServer();
  const protocol = document.querySelector('#normalTunnelProtocol')?.value || 'auto';
  return api(`/api/tunnels/normal-plan${server ? `?serverId=${encodeURIComponent(server.id)}&protocol=${encodeURIComponent(protocol)}` : ''}`);
}

async function refreshTunnelOutput(prefix = '') {
  const plan = await fetchTunnelPlan();
  const playitLink = document.querySelector('#playitSetupLink');
  if (playitLink && plan.playit?.setupUrl) {
    playitLink.href = plan.playit.setupUrl;
    playitLink.textContent = /claim|setup|agent/i.test(plan.playit.setupUrl) ? 'Open Playit setup' : 'Playit dashboard';
  }
  setTunnelOutput(`${prefix ? `${prefix}\n\n` : ''}${tunnelStatusText(plan)}`);
  return plan;
}

function stopPlayitTerminalPolling() {
  if (state.playitTerminalTimer) clearInterval(state.playitTerminalTimer);
  state.playitTerminalTimer = null;
}

async function refreshPlayitTerminalOutput() {
  const data = await api('/api/tunnels/playit/claim-terminal/status');
  const terminal = data.terminal || {};
  const output = terminal.output || terminal.message || 'Playit terminal has not produced output yet.';
  setTunnelOutput(output);
  const playitLink = document.querySelector('#playitSetupLink');
  if (playitLink && terminal.setupUrl) {
    playitLink.href = terminal.setupUrl;
    playitLink.textContent = 'Open Playit claim';
  }
  if (!terminal.running) stopPlayitTerminalPolling();
  return terminal;
}

function startPlayitTerminalPolling() {
  stopPlayitTerminalPolling();
  state.playitTerminalTimer = setInterval(() => {
    refreshPlayitTerminalOutput().catch((error) => {
      stopPlayitTerminalPolling();
      setTunnelOutput(error.message, 'error');
    });
  }, 2000);
}


function renderTerminal() {
  if (!elements.terminalPanel) return;
  if (!state.settings?.terminalEnabled || state.user?.role !== 'owner') {
    elements.terminalPanel.innerHTML = state.user?.role === 'owner'
      ? '<div class="section-head"><div><p class="eyebrow">Owner Terminal</p><h2>Persistent VPS shell</h2></div><button type="button" data-action="terminal-enable">Enable Terminal</button></div><p class="empty-state">Terminal is owner-only and currently disabled. Enable it here or in Settings.</p>'
      : '<p class="empty-state">No permission. Terminal is owner-only.</p>';
    return;
  }
  elements.terminalPanel.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">Owner Terminal</p><h2>Persistent VPS shell</h2></div><button class="danger" type="button" data-action="terminal-close">Stop Terminal</button></div>
    <form class="terminal-form" id="terminalUnlockForm" ${terminalSession.id ? 'hidden' : ''}>
      <label>Owner password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Unlock Terminal</button>
    </form>
    <pre class="terminal-output" id="terminalOutput">${terminalSession.id ? 'Connected. Waiting for shell output...' : 'Terminal locked. Owner password required.'}</pre>
    <form class="terminal-form" id="terminalInputForm" ${terminalSession.id ? '' : 'hidden'}>
      <label>Repair learning target <select name="serverId">
        <option value="">Do not associate</option>
        ${state.servers.map((server) => `<option value="${server.id}" ${server.id === state.activeServerId ? 'selected' : ''}>${escapeHtml(server.name)}</option>`).join('')}
      </select></label>
      <label>Input <input name="input" placeholder="systemctl status nexuspanel --no-pager" autocomplete="off"></label>
      <button type="submit">Send</button>
    </form>
  `;
  if (terminalSession.id) startTerminalPolling();
}

function appendTerminalOutput(text) {
  const output = document.querySelector('#terminalOutput');
  if (!output || !text) return;
  output.textContent = `${output.textContent}${text}`.slice(-160000);
  output.scrollTop = output.scrollHeight;
}

function startTerminalPolling() {
  if (!terminalSession.id || terminalSession.timer) return;
  terminalSession.timer = window.setInterval(async () => {
    if (!terminalSession.id || state.activeView !== 'terminal') return;
    try {
      const data = await api(`/api/terminal/session/${encodeURIComponent(terminalSession.id)}/output?cursor=${terminalSession.cursor}`);
      terminalSession.cursor = data.cursor;
      appendTerminalOutput(data.output || '');
      if (!data.active) {
        window.clearInterval(terminalSession.timer);
        terminalSession = { id: '', cursor: 0, timer: 0 };
      }
    } catch (error) {
      appendTerminalOutput(`\n[NexusPanel] ${error.message}\n`);
      window.clearInterval(terminalSession.timer);
      terminalSession = { id: '', cursor: 0, timer: 0 };
    }
    }, 250);
}

async function closeTerminalSession() {
  if (!terminalSession.id) return;
  const id = terminalSession.id;
  if (terminalSession.timer) window.clearInterval(terminalSession.timer);
  terminalSession = { id: '', cursor: 0, timer: 0 };
  await api(`/api/terminal/session/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  renderTerminal();
}

function renderBackups() {
  const server = activeServer();
  if (!server) {
    elements.backupPanel.innerHTML = '<p class="empty-state">Create a server to manage backups.</p>';
    return;
  }
  const backupMinutes = Number(server.backupIntervalMinutes || (server.backupIntervalHours || 24) * 60);
  const backupUnit = backupMinutes % 60 === 0 ? 'hours' : 'minutes';
  const backupValue = backupUnit === 'hours' ? Math.max(1, Math.round(backupMinutes / 60)) : Math.max(1, backupMinutes);

  api(`/api/servers/${server.id}/backups`).then((data) => {
    const requests = data.shareRequests || [];
    const shared = data.sharedBackups || [];

    function formatBackupDisplayName(filename) {
      if (!filename) return 'Unknown';
      const name = filename.replace(/\.zip$/, '');
      const parts = name.split('--');
      if (parts.length === 2) {
        const [datePart, timePart] = parts;
        const dateSegments = datePart.split('-');
        const timeSegments = timePart.split('-');
        const day = dateSegments[dateSegments.length - 3] || '';
        const month = dateSegments[dateSegments.length - 2] || '';
        const year = dateSegments[dateSegments.length - 1] || '';
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthName = monthNames[parseInt(month) - 1] || month;
        const hour = timeSegments[0] || '';
        const minute = timeSegments[1] || '';
        const ampm = timeSegments[2] || '';
        return `${monthName} ${parseInt(day)}, ${year} | ${parseInt(hour)}:${minute} ${ampm}`;
      }
      return name;
    }

    function formatBackupDate(timestamp) {
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return 'Invalid Date';
      const timezone = state.settings?.timeZone || 'UTC';
      try {
        return date.toLocaleString('en-US', {
          timeZone: timezone,
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }).replace(',', ' |');
      } catch {
        return date.toLocaleString();
      }
    }

    elements.backupPanel.innerHTML = `
      <div class="section-head"><div><p class="eyebrow">Backups</p><h2>${escapeHtml(server.name)}</h2></div><button type="button" data-action="manual-backup">Manual backup</button></div>
      <form class="backup-settings" id="backupSettingsForm">
        <label class="switch"><input name="scheduledBackups" type="checkbox" ${server.scheduledBackups ? 'checked' : ''}><span></span>Auto backup</label>
        <label>Every <input name="backupIntervalValue" type="number" min="1" max="5256000" value="${backupValue}"></label>
        <label>Unit <select name="backupIntervalUnit"><option value="hours" ${backupUnit === 'hours' ? 'selected' : ''}>Hours</option><option value="minutes" ${backupUnit === 'minutes' ? 'selected' : ''}>Minutes</option></select></label>
        <label>Keep latest <input name="backupRetention" type="number" min="1" max="50" value="${server.backupRetention || 4}"></label>
        <button type="submit">Save backup settings</button>
      </form>
      <p class="muted">Stored outside the panel install by default: <code>/var/lib/nexuspanel/backups/${server.id}/</code> on Linux. Server-folder <code>backups/</code>, <code>archives/</code>, and top-level ZIPs are skipped to prevent recursive giant backups.</p>
      ${data.canManageShare ? `<div class="backup-settings">
        <button class="secondary" type="button" data-action="backup-code-show">${data.shareCode ? 'Refresh Backup Code' : 'Create Backup Code'}</button>
        ${data.shareCode ? `<code>${escapeHtml(data.shareCode.code)}</code><span class="muted">expires ${escapeHtml(formatBackupDate(data.shareCode.expires_at))}</span><button class="danger" type="button" data-action="backup-code-hide">Hide Code</button>` : '<span class="muted">Create a 6-digit code so another server can request access.</span>'}
      </div>` : ''}
      ${data.canManageShare ? `<div class="backup-settings">
        <button class="secondary" type="button" data-action="public-backup-link">Create public links</button>
        <button class="danger" type="button" data-action="revoke-public-backup-link">Revoke public links</button>
        <span class="muted">Links are revocable, expire within 24 hours, and work between NexusPanel installations.</span>
      </div>
      <div class="plugin-list">${(publicBackupLinks.get(server.id)?.archives || []).map((backup) => `
        <div class="plugin-row"><div><strong>${escapeHtml(backup.name)}</strong><div class="muted">Public until ${escapeHtml(formatBackupDate(publicBackupLinks.get(server.id).expiresAt))}</div></div><div class="row-actions"><button class="secondary" type="button" data-action="copy-public-backup-link" data-public-url="${escapeHtml(backup.url)}">Copy link</button></div></div>
      `).join('')}</div>` : ''}
      <form class="backup-settings" id="backupCodeForm">
        <label>Add code <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456"></label>
        <button type="submit">Request shared backup</button>
      </form>
      <div class="quick-stats">
        <article><span>Filename timezone</span><strong>${escapeHtml(data.schedule?.fileNameTimeZone || 'UTC')}</strong></article>
        <article><span>Next automatic backup</span><strong>${data.schedule?.nextBackupAt ? escapeHtml(formatBackupDate(data.schedule.nextBackupAt)) : 'Disabled'}</strong></article>
        <article><span>Scheduler accuracy</span><strong>within ${Number(data.schedule?.schedulerResolutionSeconds || 30)} sec</strong></article>
      </div>
      <form class="backup-settings" id="publicBackupImportForm">
        <label>NexusPanel transfer URL <input name="url" type="url" placeholder="https://panel.example/api/public/backups/..." required></label>
        <button type="submit">Import backup</button>
      </form>
      ${data.canManageShare ? `<div class="plugin-list">
        ${requests.map((request) => `<div class="plugin-row"><div><strong>${escapeHtml(request.target_name || 'Server')}</strong><div class="muted">${escapeHtml(request.requester_email || '')} | ${escapeHtml(request.status)}${request.expires_at ? ` | until ${escapeHtml(formatBackupDate(request.expires_at))}` : ''}</div></div><div class="row-actions">${request.status === 'pending' ? '<input type="number" min="1" max="24" value="1" data-share-hours>' : ''}<button class="secondary" type="button" data-action="backup-request-approve" data-request-id="${request.id}" ${request.status === 'pending' ? '' : 'disabled'}>Accept</button><button class="danger" type="button" data-action="backup-request-remove" data-request-id="${request.id}">Remove</button></div></div>`).join('') || '<p class="empty-state">No backup access requests.</p>'}
      </div>` : ''}

      <!-- BACKUP LIST WITH 12-HOUR FORMAT -->
      <div class="plugin-list">
        ${data.backups.map((backup) => {
          const displayName = formatBackupDisplayName(backup.name);
          const formattedDate = formatBackupDate(backup.createdAt);
          return `
            <div class="plugin-row">
              <div>
                <strong>${escapeHtml(displayName)}</strong>
                <div class="muted">${Math.round(backup.size / 1024)} KB | ${escapeHtml(formattedDate)}</div>
              </div>
              <div class="row-actions">
                <button class="secondary" type="button" data-action="restore-backup" data-backup-path="${escapeHtml(backup.path)}">Restore</button>
                <a class="button-link" href="/api/servers/${server.id}/backups/download?name=${encodeURIComponent(backup.name)}">Download</a>
                <button class="danger" type="button" data-action="delete-backup" data-backup-path="${escapeHtml(backup.path)}">Delete</button>
              </div>
            </div>
          `;
        }).join('') || '<p class="empty-state">No backups yet.</p>'}
      </div>

      <h3>Shared backups</h3>
      <div class="plugin-list">${shared.map((group) => `
        <div class="plugin-row"><div><strong>${escapeHtml(group.sourceName)}</strong><div class="muted">Access until ${escapeHtml(formatBackupDate(group.expiresAt))}</div></div></div>
        ${(group.backups || []).map((backup) => {
          const displayName = formatBackupDisplayName(backup.name);
          const formattedDate = formatBackupDate(backup.createdAt);
          return `
            <div class="plugin-row">
              <div><strong>${escapeHtml(displayName)}</strong><div class="muted">${Math.round(backup.size / 1024)} KB | shared-backup | ${escapeHtml(formattedDate)}</div></div>
              <div class="row-actions">
                <button class="secondary" type="button" data-action="restore-backup" data-backup-path="${escapeHtml(backup.path)}" data-source-server-id="${group.sourceServerId}">Restore here</button>
              </div>
            </div>
          `;
        }).join('')}
      `).join('') || '<p class="empty-state">No shared backups approved for this server.</p>'}</div>
    `;
  }).catch((error) => showToast(error.message));
}

async function renderOptimizer() {
  if (!can(CAPABILITIES.OPTIMIZER_MANAGE, state.permissions.MANAGE_SERVERS)) return;

  try {
    const optimizer = state.optimizer || await api('/api/optimizer/status').catch(() => ({}));
    const commands = await api('/api/optimizer/plan').catch(() => ({ commands: [] }));
    const cards = [
      ['Platform', optimizer.platform || 'System', 'Host profile detected by NexusPanel'],
      ['Applied', optimizer.applied ? 'Yes' : 'No', optimizer.message || 'No optimizer changes applied yet'],
      ['CPU Cores', state.settings?.maxCpuCores || navigator.hardwareConcurrency || 1, 'Used for server allocation limits'],
      ['RAM Ceiling', `${state.settings?.maxAllocatableMemoryMb || 0} MB`, 'Max allocatable memory after host reserve'],
      ['Data Engine', state.settings?.dataEngine?.connected ? 'SQLite + Redis' : 'SQLite', state.settings?.dataEngine?.connected ? `${state.settings.dataEngine.hits} cache hit(s), ${state.settings.dataEngine.localKeys} warm key(s)` : 'Redis cache is optional and will auto-enable when available'],
      ['Plan Items', commands.commands?.length || 0, 'Safe host tuning commands available'],
      ['Mode', 'No background agent', 'Runs only when you click Optimize'],
    ];
    elements.optimizerSummary.innerHTML = `
      <article class="optimizer-action optimizer-hero">
        <span>Host Optimizer</span>
        <strong>${escapeHtml(optimizer.platform || 'System')}</strong>
        <p>${escapeHtml(optimizer.message || 'Review and apply safe VPS tuning from one place.')}</p>
        <button type="button" data-action="apply-optimizer">Optimize VPS</button>
      </article>
      ${cards.map(([label, value, detail]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join('')}
      <article class="optimizer-plan">
        <span>Command Preview</span>
        ${(commands.commands || []).slice(0, 8).map((item) => `<code>${escapeHtml(item.command || item)}</code>`).join('') || '<small>No host commands required on this OS.</small>'}
      </article>
    `;
  } catch (error) {
    elements.optimizerSummary.innerHTML = '<p class="empty-state">Error loading optimizer data.</p>';
    console.error('Optimizer error:', error);
  }
}

async function renderNetwork(speed = null) {
  if (!elements.networkPanel) return;
  const data = await api('/api/network/metrics').catch(() => ({ network: { inboundBytes: 0, outboundBytes: 0, interfaces: [] } }));
  const network = data.network || {};
  elements.networkPanel.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">Network</p><h2>VPS traffic monitor</h2></div><div class="row-actions"><button class="secondary" type="button" data-action="show-nginx-config">Nginx Config</button><button type="button" data-action="network-speed-test">Check Network Speed</button></div></div>
    <div class="quick-stats">
      <article><span>Inbound Used</span><strong>${formatBytes(network.inboundBytes || 0)}</strong></article>
      <article><span>Outbound Used</span><strong>${formatBytes(network.outboundBytes || 0)}</strong></article>
      <article><span>Download Speed</span><strong>${speed ? `${formatBytes(speed.downloadBytesPerSec)}/s` : 'Click check'}</strong></article>
      <article><span>Upload Speed</span><strong>${speed ? `${formatBytes(speed.uploadBytesPerSec)}/s` : 'Click check'}</strong></article>
    </div>
    <div class="public-help-grid">
      <article><strong>Fast Downloads</strong><span>Range downloads stay resumable; optional Nginx X-Accel can offload huge files.</span></article>
      <article><strong>Speed Test</strong><span>Measures your browser to this panel, so VPS/LAN speed is visible directly.</span></article>
    </div>
    <div class="plugin-list">
      ${(network.interfaces || []).map((item) => `<div class="plugin-row"><strong>${escapeHtml(item.name)}</strong><div class="row-actions"><span>${formatBytes(item.rxBytes)} in</span><span>${formatBytes(item.txBytes)} out</span></div></div>`).join('') || '<p class="empty-state">No network counters available on this OS.</p>'}
    </div>
  `;
}

function renderAdmins() {
  elements.adminPanel.hidden = !can(CAPABILITIES.ADMINS_MANAGE, state.permissions.MANAGE_ADMINS);
  if (!can(CAPABILITIES.ADMINS_MANAGE, state.permissions.MANAGE_ADMINS)) return;

  if (!state.users || state.users.length === 0) {
    elements.userList.innerHTML = '<p class="empty-state">No admin users yet.</p>';
    return;
  }

  elements.userList.innerHTML = '<p class="muted access-help">Each checked permission is independent. Existing legacy accounts keep their numeric access until exact permissions are saved.</p>' + state.users.map((user) => {
    const selected = user.role === 'owner'
      ? Object.values(CAPABILITIES)
      : (Array.isArray(user.permissionKeys) ? user.permissionKeys : (ADMIN_PERMISSION_PRESETS[user.accessLevel] || []));
    const permissionEditor = Object.entries(ADMIN_PERMISSION_LABELS).map(([key, label]) => `
      <label><input type="checkbox" data-user-permission value="${escapeHtml(key)}" ${selected.includes(key) ? 'checked' : ''} ${user.role === 'owner' ? 'disabled' : ''}> ${escapeHtml(label)}</label>
    `).join('');
    return `
    <div class="user-row" data-user-id="${user.id}">
      <div><strong>${escapeHtml(user.name)}</strong><div class="muted">${escapeHtml(user.email)} | ${user.role} | ${Array.isArray(user.permissionKeys) ? `${user.permissionKeys.length} exact permissions` : accessName(user.accessLevel)} | ${user.expiresAt ? `expires ${escapeHtml(formatPanelDate(user.expiresAt))}` : 'permanent'}</div></div>
      <details class="user-permission-editor"><summary>Edit exact permissions</summary><div class="permission-grid">${permissionEditor}</div></details>
      <div class="user-actions"><input type="number" data-user-access-level min="0" max="100" step="5" value="${user.accessLevel}" ${user.role === 'owner' ? 'disabled' : ''}><button class="secondary" type="button" data-action="update-user" ${user.role === 'owner' ? 'disabled' : ''}>Save</button><button class="danger" type="button" data-action="delete-user" ${user.role === 'owner' ? 'disabled' : ''}>Delete</button></div>
    </div>
  `;
  }).join('');
}

async function renderFixed() {
  if (!elements.fixedPanel) return;
  if (!can(CAPABILITIES.SECURITY_VIEW, state.permissions.MANAGE_ADMINS)) {
    elements.fixedPanel.innerHTML = '<p class="empty-state">Fixed history needs security access.</p>';
    return;
  }
  const data = await api('/api/fixed/logs').catch((error) => ({
    error: error.message,
    logs: [],
    retentionDays: 2,
    consoleLogPolicy: {},
  }));
  const agentData = await api('/api/repair/agent/status').catch(() => ({ agent: state.repairBrain?.agent || {} }));
  const agent = agentData.agent || {};
  const terminal = agent.terminal || {};
  const policy = data.consoleLogPolicy || {};
  elements.fixedPanel.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">Fixed</p><h2>Repair and action history</h2></div><button class="secondary" type="button" data-action="refresh-fixed">Refresh</button></div>
    <div class="quick-stats">
      <article><span>Retention</span><strong>${Number(data.retentionDays || 2)} days</strong></article>
      <article><span>Console memory cap</span><strong>${Number(policy.memoryLinesPerServer || 600)} lines</strong></article>
      <article><span>Disk log rotation</span><strong>${formatBytes(Number(policy.diskRotateBytes || 4 * 1024 * 1024))}</strong></article>
      <article><span>Lag risk</span><strong>${escapeHtml(policy.lagRisk || 'low')}</strong></article>
      <article><span>Owner shell queue</span><strong>${terminal.fullAccessEnabled ? 'Unlocked' : 'Locked'}</strong></article>
      <article><span>Live diagnostics</span><strong>${terminal.liveEnabled ? 'On' : 'Off'}</strong></article>
      <article><span>Pending commands</span><strong>${Number(terminal.pendingFullAccessCommands || 0)}</strong></article>
    </div>
    ${state.user?.role === 'owner' ? `<div class="backup-settings">
      <button class="${terminal.fullAccessEnabled ? 'danger' : 'secondary'}" type="button" data-action="${terminal.fullAccessEnabled ? 'agent-full-access-lock' : 'agent-full-access-unlock'}">${terminal.fullAccessEnabled ? 'Lock owner shell' : 'Unlock owner shell'}</button>
      <button class="secondary" type="button" data-action="${terminal.liveEnabled ? 'agent-live-disable' : 'agent-live-enable'}">${terminal.liveEnabled ? 'Disable live diagnostics' : 'Enable live diagnostics'}</button>
      <button class="secondary" type="button" data-action="agent-queue-command">Queue Command</button>
    </div>` : ''}
    <h3>Owner shell queue</h3>
    <div class="plugin-list">
      ${(terminal.commandQueue || []).map((item) => `
        <div class="plugin-row">
          <div>
            <strong>${escapeHtml(item.commandPreview || 'command')}</strong>
            <div class="muted">${escapeHtml(item.serverName || 'Panel')} Â· ${escapeHtml(item.purpose || '')} Â· ${escapeHtml(item.risk || 'high')} Â· ${escapeHtml(item.status || '')}${item.exitCode == null ? '' : ` Â· exit ${item.exitCode}`}</div>
            ${item.outputPreview ? `<div class="muted">${escapeHtml(item.outputPreview).slice(-420)}</div>` : ''}
          </div>
          <div class="row-actions">${item.status === 'pending' && state.user?.role === 'owner' ? `<button class="danger" type="button" data-action="agent-command-approve" data-command-id="${item.id}">Approve & Run</button>` : ''}</div>
        </div>
      `).join('') || '<p class="empty-state">No full access commands queued.</p>'}
    </div>
    <h3>Last 24 hours</h3>
    <div class="plugin-list">
      ${(data.logs || []).map((item) => `
        <div class="plugin-row">
          <div>
            <strong>${escapeHtml(item.title || 'Fixed event')}</strong>
            <div class="muted">${escapeHtml(item.serverName || 'Panel')} · ${escapeHtml(item.category || 'panel')} · ${escapeHtml(item.source || 'system')} · ${escapeHtml(formatPanelDate(item.createdAt))}</div>
            ${item.detail ? `<div class="muted">${escapeHtml(item.detail).replaceAll('\n', '<br>')}</div>` : ''}
          </div>
          <span class="badge is-on">fixed</span>
        </div>
      `).join('') || `<p class="empty-state">${escapeHtml(data.error || 'No fixed events recorded in the last 24 hours.')}</p>`}
    </div>
  `;
}

async function renderSecurity(forceHealth = false) {
  if (!can(CAPABILITIES.SECURITY_VIEW, state.permissions.MANAGE_ADMINS)) {
    if (elements.auditPanel) elements.auditPanel.innerHTML = '<p class="empty-state">Security audit needs owner/admin access.</p>';
    return;
  }

  const [audit, health] = await Promise.all([
    api('/api/audit/logins').catch(() => ({ events: state.loginEvents || [] })),
    api(`/api/health${forceHealth ? '?force=1' : ''}`).catch(() => ({ health: state.health })),
  ]);
  state.loginEvents = audit.events || [];
  state.health = health.health || null;

  if (elements.healthPanel) {
    const checks = state.health?.checks || [];
    elements.healthPanel.innerHTML = `
      <div class="section-head">
        <div><p class="eyebrow">Security</p><h2>${escapeHtml(state.health?.summary || 'No check yet')}</h2></div>
        <div class="row-actions">
          <button class="secondary" type="button" data-action="database-snapshot">Snapshot DB</button>
          <button class="secondary" type="button" data-action="ddos-scan">DDoS scan</button>
          <button type="button" data-action="run-health-check">Run check now</button>
        </div>
      </div>
      <p class="muted">Last checked: ${escapeHtml(state.health?.checkedAtText ? formatPanelDate(state.health.checkedAtText) : 'never')}</p>
      <div class="health-grid">
        ${checks.map((check) => `<article class="${check.ok ? 'is-ok' : 'is-bad'}"><strong>${escapeHtml(check.name)}</strong><span>${escapeHtml(check.message)}</span></article>`).join('') || '<p class="empty-state">Run a health check to verify panel folders, database, software, and Java.</p>'}
      </div>
      <div class="plugin-list" id="ddosPanel"></div>
    `;
  }

  if (elements.auditPanel) {
    elements.auditPanel.innerHTML = `
      <div class="section-head"><div><p class="eyebrow">Audit</p><h2>Recent logins</h2></div></div>
      <div class="audit-list">
        ${state.loginEvents.map((event) => `
          <article class="audit-row">
            <div><strong>${escapeHtml(event.email)}</strong><span>${escapeHtml(event.browser)} - ${escapeHtml(event.device)}</span></div>
            <code>${escapeHtml(event.ip || 'unknown IP')}</code>
            <time>${escapeHtml(formatPanelDate(event.createdAt))}</time>
          </article>
        `).join('') || '<p class="empty-state">No login events recorded yet.</p>'}
      </div>
    `;
  }
}
function renderSoftwareChoices() {
  const type = elements.serverForm.type.value;
  const compatible = state.softwareCatalog.filter((software) => software.edition === type);
  const selected = elements.softwareSelect.value;
  const markup = compatible.map((software) => `<option value="${software.key}" ${software.key === selected ? 'selected' : ''}>${escapeHtml(software.name)}</option>`).join('');
  if (elements.softwareSelect.innerHTML !== markup) elements.softwareSelect.innerHTML = markup;
  hydrateCreateVersionSelect();
}

async function hydrateCreateVersionSelect() {
  const key = elements.softwareSelect.value;
  if (!key || key === lastCreateSoftwareKey) return;
  lastCreateSoftwareKey = key;
  const versions = await getSoftwareVersions(key);
  elements.softwareVersionSelect.innerHTML = versions.slice(0, 80).map((version) => `<option value="${escapeHtml(version)}">${escapeHtml(version)}</option>`).join('');
}

async function getSoftwareVersions(key, force = false) {
  if (!force && versionCache.has(key)) return versionCache.get(key);
  const versions = await api(`/api/software/${encodeURIComponent(key)}/versions`).then((data) => data.versions).catch(() => ['latest']);
  versionCache.set(key, versions);
  return versions;
}

async function hydrateSoftwareVersionSelects() {
  const selects = [...document.querySelectorAll('[data-software-version]')];
  await Promise.all(selects.map(async (select) => {
    const key = select.dataset.softwareVersion;
    const selected = select.value;
    const versions = await getSoftwareVersions(key);
    select.innerHTML = versions.slice(0, 80).map((version) => `<option value="${escapeHtml(version)}">${escapeHtml(version)}</option>`).join('');
    select.value = versions.includes(selected) ? selected : (versions[0] || 'latest');
  }));
}

function updateLiveServerDom() {
  const servers = new Map(state.servers.map((server) => [String(server.id), server]));
  document.querySelectorAll('[data-live-server-id]').forEach((root) => {
    const server = servers.get(String(root.dataset.liveServerId));
    if (!server) return;
    const online = server.status === 'online';
    const installed = server.installStatus === 'installed';
    const status = root.querySelector('[data-live-status]');
    if (status) {
      status.textContent = server.status;
      status.classList.toggle('is-on', online);
    }
    root.querySelectorAll('[data-live-summary="sidebar"]').forEach((element) => {
      element.textContent = `${server.softwareName} · ${server.status}`;
    });
    root.querySelectorAll('[data-live-summary="row"]').forEach((element) => {
      element.textContent = `${server.softwareName} · ${server.type} · ${server.status}`;
    });
    root.querySelectorAll('[data-live-install-track]').forEach((element) => {
      element.style.width = `${Number(server.installProgress || 0)}%`;
    });
    root.querySelectorAll('[data-live-install-progress]').forEach((element) => {
      element.textContent = `${Number(server.installProgress || 0)}%`;
    });
    root.querySelectorAll('[data-live-install-message]').forEach((element) => {
      if (element.dataset.liveMessageFormat === 'software') {
        element.textContent = `${server.installMessage || server.installStatus} (${server.softwareVersion || 'latest'})`;
      } else if (element.dataset.liveMessageFormat === 'message') {
        element.textContent = server.installMessage || server.installStatus || 'Ready';
      } else {
        element.textContent = server.installStatus;
      }
    });
    const start = root.querySelector('[data-action="start-server"]');
    const stop = root.querySelector('[data-action="stop-server"]');
    const restart = root.querySelector('[data-action="restart-server"]');
    const remove = root.querySelector('[data-action="delete-server"]');
    if (start) start.disabled = online || !installed;
    if (stop) stop.disabled = !online;
    if (restart) restart.disabled = !online;
    if (remove) remove.disabled = online;
  });
}

async function refresh({ keepView = true } = {}) {
  try {
    const overview = await api('/api/overview');
    state.needsSetup = overview.needsSetup;
    state.permissions = overview.permissions;
    state.user = overview.user;
    state.servers = overview.servers || [];
    state.users = overview.users || [];
    state.optimizer = overview.optimizer;
    state.plugins = overview.plugins || [];
    state.softwareCatalog = overview.softwareCatalog || [];
    state.templates = overview.templates || [];
    state.settings = overview.settings || null;
    state.loginEvents = overview.loginEvents || [];
    state.health = overview.health || null;
    state.adaptiveInsights = overview.adaptiveInsights || [];
    state.repairBrain = overview.repairBrain || null;

    if (state.activeServerId && !state.servers.some((server) => server.id === state.activeServerId)) {
      state.activeServerId = null;
    }
    if (!state.activeServerId && state.servers.length) {
      state.activeServerId = state.servers[0].id;
    }

    renderAuth();
    if (!state.user) {
      return;
    }

    renderAuth();
    renderAccount();
    renderView();
    renderStats();
    renderServerSwitcher();
    if (state.activeView === 'dashboard') renderSoftwareChoices();
    await renderActiveView();

    if (!keepView) setView('dashboard');
  } catch (error) {
    showToast('Failed to load data: ' + error.message);
    console.error('Refresh error:', error);
  }
}

async function refreshServerStatusOnly() {
  const live = await api('/api/live');
  const liveServers = live.servers || [];
  const currentIds = state.servers.map((server) => Number(server.id)).sort((a, b) => a - b).join(',');
  const liveIds = liveServers.map((server) => Number(server.id)).sort((a, b) => a - b).join(',');
  if (currentIds !== liveIds) {
    await refresh();
    return;
  }
  const previous = new Map(state.servers.map((server) => [server.id, server]));
  const installFinished = liveServers.some((server) => (
    previous.get(server.id)?.installStatus === 'installing'
    && server.installStatus !== 'installing'
  ));
  const signature = JSON.stringify(liveServers.map((server) => [
    server.id, server.status, server.installStatus, server.installProgress, server.installMessage,
  ]));
  const changed = signature !== state.serverStatusSignature;
  state.serverStatusSignature = signature;
  const updates = new Map(liveServers.map((server) => [server.id, server]));
  state.servers = state.servers
    .filter((server) => updates.has(server.id))
    .map((server) => ({ ...server, ...updates.get(server.id) }));
  if (state.settings) state.settings = { ...state.settings, updateStatus: live.updateStatus || state.settings.updateStatus };
  if (state.activeServerId && !state.servers.some((server) => server.id === state.activeServerId)) {
    state.activeServerId = state.servers[0]?.id || null;
  }
  if (!state.activeServerId && state.servers.length) state.activeServerId = state.servers[0].id;
  if (installFinished) {
    await refresh();
    return;
  }
  if (changed) {
    renderStats();
    updateLiveServerDom();
  }
  updateSettingsLiveStatus();
}

function setView(view) {
  if (!canView(view)) {
    showToast('That section is not included in this account access role.');
    return;
  }
  saveActiveViewScroll();
  state.activeView = view;
  if (view === 'console') {
    consoleStickToBottom = true;
  }
  renderView();
  renderActiveView().catch((error) => showToast(error.message));
  window.requestAnimationFrame(() => {
    restoreActiveViewScroll();
  });
}

function workspaceScroller() {
  return document.querySelector('.workspace') || document.scrollingElement || document.documentElement;
}

function saveActiveViewScroll() {
  const scroller = workspaceScroller();
  state.viewScroll[state.activeView] = {
    windowTop: window.scrollY || document.documentElement.scrollTop || 0,
    workspaceTop: scroller?.scrollTop || 0,
  };
}

function restoreActiveViewScroll() {
  const saved = state.viewScroll[state.activeView] || { windowTop: 0, workspaceTop: 0 };
  window.scrollTo({ top: saved.windowTop || 0, left: 0, behavior: 'auto' });
  const scroller = workspaceScroller();
  if (scroller) scroller.scrollTo?.({ top: saved.workspaceTop || 0, left: 0, behavior: 'auto' });
}

function accessName(level) {
  if (level >= 100) return 'Owner';
  if (level >= 80) return 'Files';
  if (level >= 60) return 'Servers';
  if (level >= 40) return 'Console';
  if (level >= 20) return 'Logs';
  if (level >= 5) return 'Power';
  return 'View';
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {}
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function parsePanelTimestamp(timestamp) {
  if (typeof timestamp === 'number') return new Date(timestamp);
  let value = String(timestamp || '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    value = `${value.replace(' ', 'T')}Z`;
  }
  return new Date(value);
}

function formatPanelDate(timestamp, options = {}) {
  const date = parsePanelTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  return date.toLocaleString('en-US', {
    timeZone: state.settings?.timeZone || 'UTC',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: options.seconds === false ? undefined : '2-digit',
    hour12: true,
  });
}

function formatConsoleLine(line) {
  return String(line).replace(/^\[([0-9]{4}-\d{2}-\d{2}T[^\]]+Z)\]\s*/, (_match, timestamp) => (
    `[${formatPanelDate(timestamp)}] `
  ));
}

function formatBackupDate(timestamp) {
  return formatPanelDate(timestamp, { seconds: false });
}

function formatBackupDisplayName(filename) {
  if (!filename) return 'Unknown';

  const name = filename.replace(/\.zip$/, '');

  const parts = name.split('--');
  if (parts.length === 2) {
    const [datePart, timePart] = parts;
    const dateSegments = datePart.split('-');
    const timeSegments = timePart.split('-');

    const day = dateSegments[dateSegments.length - 3] || '';
    const month = dateSegments[dateSegments.length - 2] || '';
    const year = dateSegments[dateSegments.length - 1] || '';

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = monthNames[parseInt(month) - 1] || month;

    const hour = timeSegments[0] || '';
    const minute = timeSegments[1] || '';
    const ampm = timeSegments[2] || '';

    return `${monthName} ${parseInt(day)}, ${year} | ${parseInt(hour)}:${minute} ${ampm}`;
  }

  return name;
}

function startRefreshLoop() {
  window.clearInterval(state.refreshTimer);
  window.clearInterval(state.consoleFastTimer);
  state.consoleFastTimer = window.setInterval(() => {
    if (!state.user || !uiPreferences.liveRefresh || state.activeView !== 'console') return;
    renderConsole().catch(() => {});
  }, 650);
  state.refreshTimer = window.setInterval(() => {
    if (!state.user || !uiPreferences.liveRefresh) return;
    const liveBusy = state.servers.some((server) => server.installStatus === 'installing') || state.settings?.updateStatus?.running;
    const dueStatus = Date.now() - state.statusRefreshAt > (liveBusy || state.activeView === 'console' ? 1200 : 2500);
    if (dueStatus || liveBusy) {
      state.statusRefreshAt = Date.now();
      refreshServerStatusOnly().catch(() => {});
    }
    if (state.activeView === 'files') renderUploadSessions().catch(() => {});
  }, 900);
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify(formData(elements.loginForm)) });
    showToast('Logged in.');
    await refresh({ keepView: false });
    startRefreshLoop();
  } catch (error) {
    showToast(error.message);
  }
});

elements.serverForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = formData(elements.serverForm);
  payload.port = Number(payload.port);
  payload.maxMemoryMb = Number(payload.maxMemoryMb);
  payload.cpuCores = Number(payload.cpuCores || 1);
  try {
    const result = await api('/api/servers', { method: 'POST', body: JSON.stringify(payload) });
    state.activeServerId = result.server.id;
    elements.serverForm.reset();
    elements.serverForm.autoRestart.checked = true;
    elements.serverForm.crashBackup.checked = true;
    elements.serverForm.port.value = '19132';
    elements.serverForm.maxMemoryMb.value = '1024';
    elements.serverForm.cpuCores.value = '1';
    showToast('Server created. Install software from the Software tab.');
    await refresh();
    setView('software');
  } catch (error) {
    showToast(error.message);
  }
});

elements.serverForm.type.addEventListener('change', () => {
  elements.serverForm.port.value = elements.serverForm.type.value === 'java' ? '25565' : '19132';
  renderSoftwareChoices();
});

elements.softwareSelect.addEventListener('change', () => {
  hydrateCreateVersionSelect();
});

if (elements.templateGameSelect) {
  elements.templateGameSelect.addEventListener('change', () => {
    state.templateGameFilter = elements.templateGameSelect.value;
    renderTemplates();
  });
}

elements.activeServerSelect.addEventListener('change', () => {
  state.activeServerId = Number(elements.activeServerSelect.value);
  filePath = '';
  consoleRenderToken += 1;
  consoleStickToBottom = true;
  if (elements.serverConfigForm) elements.serverConfigForm.dataset.dirty = '0';
  if (elements.consoleBox && state.activeView === 'console') {
    elements.consoleBox.innerHTML = '<div>[NexusPanel] Switching server console...</div>';
  }
  renderServerSwitcher();
  renderActiveView().catch((error) => showToast(error.message));
});

if (elements.pluginForm) {
  elements.pluginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
  });
}

elements.fileUploadInput.addEventListener('change', async () => {
  try {
    await uploadFiles(elements.fileUploadInput.files);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.fileUploadInput.value = '';
  }
});

if (elements.nexuImportInput) {
  elements.nexuImportInput.addEventListener('change', async () => {
    const file = elements.nexuImportInput.files?.[0];
    elements.nexuImportInput.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const result = await api('/api/templates/import', { method: 'POST', body: JSON.stringify(payload) });
      showToast(`Imported template: ${result.template.name}`);
      await refresh();
      setView('templates');
    } catch (error) {
      showToast(`Template import failed: ${error.message}`);
    }
  });
}

elements.fileList.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.fileList.classList.add('is-dropping');
});

elements.fileList.addEventListener('dragleave', () => {
  elements.fileList.classList.remove('is-dropping');
});

elements.fileList.addEventListener('drop', async (event) => {
  event.preventDefault();
  elements.fileList.classList.remove('is-dropping');
  try {
    await uploadFiles(event.dataTransfer.files);
  } catch (error) {
    showToast(error.message);
  }
});

elements.modrinthForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const server = activeServer();
  if (!server) return showToast('Create a server first.');
  try {
    await loadPluginMarketplace();
  } catch (error) {
    showToast(error.message);
  }
});

elements.commandForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const server = activeServer();
  if (!server) return showToast('Create a server first.');
  const payload = formData(elements.commandForm);
  try {
    const command = String(payload.command || '').trim().replace(/^\//, '');
    if (command) appendConsoleImmediate(`[${new Date().toISOString()}] > ${command}`);
    const result = await api(`/api/servers/${server.id}/command`, { method: 'POST', body: JSON.stringify(payload) });
    elements.commandForm.reset();
    if (result.line) state.consolePollAt[server.id] = 0;
    await renderConsole();
  } catch (error) {
    showToast(error.message);
  }
});

elements.consoleBox.addEventListener('scroll', () => {
  consoleStickToBottom = elements.consoleBox.scrollTop + elements.consoleBox.clientHeight >= elements.consoleBox.scrollHeight - 24;
});

if (elements.themeSelect) {
  elements.themeSelect.addEventListener('change', () => {
    applyTheme(elements.themeSelect.value);
    localStorage.setItem('nexusTheme', elements.themeSelect.value);
  });
}

if (elements.serverConfigForm) {
  elements.serverConfigForm.addEventListener('input', () => {
    elements.serverConfigForm.dataset.dirty = '1';
  });

  elements.serverConfigForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const server = activeServer();
    if (!server) return;
    const payload = {
      ...server,
      ...formData(elements.serverConfigForm),
      port: Number(elements.serverConfigForm.port.value),
      cpuCores: Number(elements.serverConfigForm.cpuCores.value),
      startupDelaySec: Number(elements.serverConfigForm.startupDelaySec.value),
      type: server.type,
      softwareKey: server.softwareKey,
      softwareVersion: server.softwareVersion,
    };
    if (state.user?.role === 'owner') {
      payload.maxMemoryMb = Number(elements.serverConfigForm.maxMemoryMb.value);
      payload.cpuCores = Number(elements.serverConfigForm.cpuCores.value);
    }
    try {
      await api(`/api/servers/${server.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('Server settings saved. Restart to apply RAM and CPU changes.');
      elements.serverConfigForm.dataset.dirty = '0';
      await refresh();
      fillServerConfigForm(activeServer(), true);
      await renderConsole();
    } catch (error) {
      showToast(error.message);
    }
  });
}

elements.fileEditor.addEventListener('submit', async (event) => {
  event.preventDefault();
  const server = activeServer();
  if (!server) return;
  const payload = formData(elements.fileEditor);
  try {
    await api(`/api/servers/${server.id}/files`, { method: 'PUT', body: JSON.stringify(payload) });
    showToast('File saved.');
    await renderFiles();
  } catch (error) {
    showToast(error.message);
  }
});

elements.propertyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const server = activeServer();
  if (!server) return;
  const values = formData(elements.propertyForm);
  for (const checkbox of elements.propertyForm.querySelectorAll('input[type="checkbox"]')) {
    values[checkbox.name] = checkbox.checked ? 'true' : 'false';
  }
  try {
    await api(`/api/servers/${server.id}/properties`, { method: 'PUT', body: JSON.stringify({ values }) });
    showToast('Properties saved. Restart may be required.');
    await renderProperties();
  } catch (error) {
    showToast(error.message);
  }
});

elements.whitelistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const server = activeServer();
  if (!server) return;
  try {
    await api(`/api/servers/${server.id}/whitelist`, { method: 'POST', body: JSON.stringify(formData(elements.whitelistForm)) });
    elements.whitelistForm.reset();
    showToast('Player whitelisted.');
    await renderWhitelist();
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'settingsForm') return;
  event.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(formData(event.target)) });
    showToast('Settings saved.');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('input', (event) => {
  const control = event.target.closest('[data-alpha-key]');
  if (!control) return;
  const key = control.dataset.alphaKey;
  const value = control.type === 'checkbox'
    ? control.checked
    : control.type === 'range'
      ? Number(control.value)
      : control.value;
  alphaDraft = { ...alphaDraft, [key]: value };
  applyUiPreferences(alphaDraft);
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'alphaUiForm') return;
  event.preventDefault();
  commitUiPreferences(alphaDraft);
  showToast('Alpha layout saved.');
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'terminalUnlockForm') return;
  event.preventDefault();
  const output = document.querySelector('#terminalOutput');
  if (output) output.textContent = 'Opening shell...\n';
  try {
    const result = await api('/api/terminal/session', { method: 'POST', body: JSON.stringify(formData(event.target)) });
    terminalSession = { id: result.session.id, cursor: 0, timer: 0 };
    renderTerminal();
    startTerminalPolling();
  } catch (error) {
    if (output) output.textContent = error.message;
    showToast(error.message);
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'terminalInputForm') return;
  event.preventDefault();
  const input = event.target.input.value;
  if (!terminalSession.id || !input.trim()) return;
  event.target.input.value = '';
  appendTerminalOutput(`\n$ ${input}\n`);
  try {
    const result = await api(`/api/terminal/session/${encodeURIComponent(terminalSession.id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ input, serverId: event.target.serverId.value }),
    });
    if (result.learning) showToast('Repair learner is observing this command and its outcome.');
  } catch (error) {
    appendTerminalOutput(`\n[NexusPanel] ${error.message}\n`);
    showToast(error.message);
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'backupSettingsForm') return;
  event.preventDefault();
  const server = activeServer();
  if (!server) return;
  const payload = formData(event.target);
  payload.backupIntervalValue = Number(payload.backupIntervalValue);
  payload.backupRetention = Number(payload.backupRetention);
  try {
    await api(`/api/servers/${server.id}/backups/settings`, { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Backup settings saved.');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'backupCodeForm') return;
  event.preventDefault();
  const server = activeServer();
  if (!server) return;
  const payload = formData(event.target);
  try {
    await api(`/api/servers/${server.id}/backups/share-request`, { method: 'POST', body: JSON.stringify(payload) });
    showToast('Backup access request sent.');
    event.target.reset();
    renderBackups();
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'publicBackupImportForm') return;
  event.preventDefault();
  const server = activeServer();
  if (!server) return;
  const submitButton = event.target.querySelector('[type="submit"]');
  submitButton.disabled = true;
  showToast('Importing remote backup...');
  try {
    await api(`/api/servers/${server.id}/backups/import-url`, {
      method: 'POST',
      body: JSON.stringify(formData(event.target)),
    });
    event.target.reset();
    showToast('Remote backup imported.');
    renderBackups();
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.addEventListener('dragstart', (event) => {
  if (layoutEditor.active && event.target.closest('[data-ui-button-key], [data-ui-component-key]')) event.preventDefault();
});

document.addEventListener('pointerdown', (event) => {
  if (!layoutEditor.active || event.button !== 0) return;
  const type = layoutEditor.mode === 'boxes' ? 'component' : 'button';
  const item = type === 'component'
    ? event.target.closest('[data-ui-component-key]')
    : event.target.closest('[data-ui-button-key]');
  if (!item || item.closest('#layoutEditorBar')) return;
  const zone = type === 'component'
    ? item.parentElement?.closest('[data-ui-component-zone]')
    : item.closest('[data-ui-region]');
  if (!zone) return;
  const key = layoutItemKey(type, item, zone);
  const selected = selectLayoutItem(type, key, { additive: event.shiftKey || event.ctrlKey || event.metaKey });
  if (!selected) return;
  layoutEditor.dragging = {
    item,
    zone,
    type,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    beforeDraft: structuredClone(alphaDraft),
  };
  layoutEditor.pointerId = event.pointerId;
  layoutEditor.selectedType = type;
  layoutEditor.selectedKey = key;
  layoutEditor.dragging.basePosition = selectedPosition();
  updatePrecisionControls(layoutEditor.dragging.basePosition);
  item.setPointerCapture?.(event.pointerId);
}, true);

document.addEventListener('pointermove', (event) => {
  const drag = layoutEditor.dragging;
  if (!layoutEditor.active || !drag || event.pointerId !== layoutEditor.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
  drag.moved = true;
  drag.item.classList.add('is-layout-dragging');
  if (layoutEditor.precision) {
    const snap = Math.max(1, Number(layoutEditor.snap) || 1);
    const next = {
      x: drag.basePosition.x + Math.round((event.clientX - drag.startX) / snap) * snap,
      y: drag.basePosition.y + Math.round((event.clientY - drag.startY) / snap) * snap,
      z: drag.basePosition.z,
    };
    updateSelectedPosition(next);
    event.preventDefault();
    return;
  }
  const selector = drag.type === 'component' ? '[data-ui-component-key]' : '[data-ui-button-key]';
  let target = document.elementFromPoint(event.clientX, event.clientY);
  while (target && target !== document.body) {
    if (target.matches?.(selector)) {
      const targetZone = drag.type === 'component'
        ? target.parentElement?.closest('[data-ui-component-zone]')
        : target.closest('[data-ui-region]');
      if (targetZone === drag.zone) break;
    }
    target = target.parentElement;
  }
  if (!target || target === document.body || target === drag.item) return;
  const rect = target.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2
    || (Math.abs(event.clientY - (rect.top + rect.height / 2)) < rect.height / 3 && event.clientX < rect.left + rect.width / 2);
  drag.zone.insertBefore(drag.item, before ? target : target.nextSibling);
  event.preventDefault();
}, { passive: false, capture: true });

document.addEventListener('pointerup', (event) => {
  const drag = layoutEditor.dragging;
  if (!drag || event.pointerId !== layoutEditor.pointerId) return;
  drag.item.classList.remove('is-layout-dragging');
  if (drag.moved) {
    if (layoutEditor.precision) {
      const position = selectedPosition();
      showToast(`${drag.type === 'component' ? 'Box' : 'Button'} positioned at X ${position.x}, Y ${position.y}.`);
    } else {
      if (drag.type === 'component') captureComponentLayout();
      else captureButtonLayout();
      showToast(`${drag.type === 'component' ? 'Box' : 'Button'} order updated in the layout draft.`);
    }
    rememberLayoutMutation(drag.beforeDraft);
  }
  restoreLayoutSelection();
  updatePrecisionControls();
  layoutEditor.dragging = null;
  layoutEditor.pointerId = null;
}, true);

document.addEventListener('pointercancel', (event) => {
  const drag = layoutEditor.dragging;
  if (!drag || event.pointerId !== layoutEditor.pointerId) return;
  drag.item.classList.remove('is-layout-dragging');
  restoreLayoutDraft(drag.beforeDraft);
  layoutEditor.dragging = null;
  layoutEditor.pointerId = null;
}, true);

document.addEventListener('click', (event) => {
  if (!layoutEditor.active || event.target.closest('#layoutEditorBar')) return;
  const target = layoutEditor.mode === 'boxes'
    ? event.target.closest('[data-ui-component-key]')
    : event.target.closest('[data-ui-button-key]');
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('click', async (event) => {
  const command = event.target.closest('[data-layout-command]')?.dataset.layoutCommand;
  if (!command) return;
  if (command === 'mode-boxes' || command === 'mode-buttons') {
    layoutEditor.mode = command === 'mode-boxes' ? 'boxes' : 'buttons';
    layoutEditor.selectedKey = '';
    layoutEditor.selectedType = '';
    layoutEditor.selection = [];
    document.body.dataset.uiEditMode = layoutEditor.mode;
    document.querySelectorAll('.is-layout-selected').forEach((item) => item.classList.remove('is-layout-selected'));
    renderLayoutEditorBar();
    showToast(`${layoutEditor.mode === 'boxes' ? 'Box' : 'Button'} placement mode active.`);
    return;
  }
  if (command === 'move-free' || command === 'move-flow') {
    layoutEditor.precision = command === 'move-free';
    document.body.dataset.uiMoveMode = layoutEditor.precision ? 'free' : 'flow';
    renderLayoutEditorBar();
    showToast(layoutEditor.precision ? 'Free move active. Drag or use X/Y and arrow keys.' : 'Flow move active. Drag to reorder items.');
    return;
  }
  if (command === 'reset-position') {
    const before = structuredClone(alphaDraft);
    const position = updateSelectedPosition({ x: 0, y: 0, z: 0 }, { constrain: false });
    if (!position) return showToast('Select a box or button first.');
    rememberLayoutMutation(before);
    showToast('Position reset.');
    return;
  }
  if (command === 'front') {
    const before = structuredClone(alphaDraft);
    const current = selectedPosition();
    const position = updateSelectedPosition({ ...current, z: Math.min(50, current.z + 1) });
    if (!position) return showToast('Select a box or button first.');
    rememberLayoutMutation(before);
    showToast(`Layer ${position.z}.`);
    return;
  }
  if (command === 'save') {
    captureButtonLayout();
    captureComponentLayout();
    commitUiPreferences(alphaDraft);
    setLayoutEditor(false);
    showToast('Custom UI saved. Its layout code does not expire.');
    return;
  }
  if (command === 'cancel') {
    alphaDraft = structuredClone(uiPreferences);
    setLayoutEditor(false);
    return;
  }
  if (command === 'copy') {
    captureButtonLayout();
    captureComponentLayout();
    const code = encodeLayoutCode(alphaDraft);
    await copyText(code);
    showToast('Permanent UI code copied.');
    return;
  }
  if (command === 'undo') {
    if (!undoLayoutMutation()) showToast('Nothing left to undo in this edit session.');
    else showToast('Undid one layout action.');
    return;
  }
  if (command === 'redo') {
    if (!redoLayoutMutation()) showToast('Nothing left to redo in this edit session.');
    else showToast('Redid one layout action.');
    return;
  }
  if (command === 'width') {
    const before = structuredClone(alphaDraft);
    const isComponent = layoutEditor.selectedType === 'component';
    const selected = isComponent
      ? [...document.querySelectorAll('[data-ui-component-key]')].find((component) => {
        const zone = component.parentElement?.closest('[data-ui-component-zone]');
        return zone && `${zone.dataset.uiComponentZone}/${component.dataset.uiComponentKey}` === layoutEditor.selectedKey;
      })
      : [...document.querySelectorAll('[data-ui-region] [data-ui-button-key]')].find((button) => (
        `${button.closest('[data-ui-region]').dataset.uiRegion}/${button.dataset.uiButtonKey}` === layoutEditor.selectedKey
      ));
    if (!selected) return showToast(`Select a ${layoutEditor.mode === 'boxes' ? 'box' : 'button'} first.`);
    const widths = isComponent ? alphaDraft.componentWidths : alphaDraft.buttonWidths;
    const current = widths?.[layoutEditor.selectedKey] || 'auto';
    const next = current === 'auto' ? 'half' : current === 'half' ? 'full' : 'auto';
    if (isComponent) {
      alphaDraft = {
        ...alphaDraft,
        componentWidths: { ...(alphaDraft.componentWidths || {}), [layoutEditor.selectedKey]: next },
      };
      applyComponentLayout(alphaDraft);
    } else {
      alphaDraft = {
        ...alphaDraft,
        buttonWidths: { ...(alphaDraft.buttonWidths || {}), [layoutEditor.selectedKey]: next },
      };
      applyButtonLayout(alphaDraft);
    }
    selected.classList.add('is-layout-selected');
    rememberLayoutMutation(before);
    showToast(`${isComponent ? 'Box' : 'Button'} width: ${next}.`);
  }
});

document.addEventListener('input', (event) => {
  const coordinate = event.target.closest('[data-layout-coordinate]')?.dataset.layoutCoordinate;
  if (!coordinate || !layoutEditor.active) return;
  const current = selectedPosition();
  const next = { ...current, [coordinate]: Number(event.target.value) || 0 };
  if (!updateSelectedPosition(next)) showToast('Select a box or button first.');
});

document.addEventListener('focusin', (event) => {
  if (!layoutEditor.active || !event.target.matches('[data-layout-coordinate]')) return;
  layoutEditor.controlSnapshot = structuredClone(alphaDraft);
});

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-layout-coordinate]')) {
    rememberLayoutMutation(layoutEditor.controlSnapshot);
    layoutEditor.controlSnapshot = null;
  }
  if (event.target.matches('[data-layout-snap]')) {
    layoutEditor.snap = Math.max(1, Number(event.target.value) || 1);
    document.documentElement.style.setProperty('--ui-editor-grid', `${Math.max(8, layoutEditor.snap)}px`);
    showToast(`Mouse snap set to ${layoutEditor.snap}px.`);
  }
  if (event.target.matches('[data-layout-align]') && event.target.value) {
    const before = structuredClone(alphaDraft);
    const count = alignSelectedItems(event.target.value);
    if (!count) showToast('Select a box or button first.');
    else {
      rememberLayoutMutation(before);
      showToast(`${event.target.value.startsWith('distribute') ? 'Distributed' : 'Aligned'} ${count} item${count === 1 ? '' : 's'}.`);
    }
    event.target.value = '';
  }
});

document.addEventListener('keydown', (event) => {
  if (
    !layoutEditor.active
    || !layoutEditor.precision
    || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    || event.target.matches('input, select, textarea')
  ) return;
  if (!selectedLayoutItem()) return;
  event.preventDefault();
  const before = structuredClone(alphaDraft);
  const step = event.shiftKey ? 10 : 1;
  const current = selectedPosition();
  const next = { ...current };
  if (event.key === 'ArrowLeft') next.x -= step;
  if (event.key === 'ArrowRight') next.x += step;
  if (event.key === 'ArrowUp') next.y -= step;
  if (event.key === 'ArrowDown') next.y += step;
  updateSelectedPosition(next);
  rememberLayoutMutation(before);
});

let layoutResizeFrame = 0;
window.addEventListener('resize', () => {
  window.cancelAnimationFrame(layoutResizeFrame);
  layoutResizeFrame = window.requestAnimationFrame(() => {
    const preferences = layoutEditor.active ? alphaDraft : uiPreferences;
    applyButtonLayout(preferences);
    applyComponentLayout(preferences);
    updatePrecisionControls();
  });
});

function applyAdminPermissionPreset(level = elements.adminForm.accessLevel?.value || 5) {
  const selected = new Set(ADMIN_PERMISSION_PRESETS[Number(level)] || []);
  elements.adminForm.querySelectorAll('[name="permissionKey"]').forEach((checkbox) => {
    checkbox.checked = selected.has(checkbox.value);
  });
}

if (elements.adminForm.accessLevel?.tagName === 'SELECT') {
  elements.adminForm.accessLevel.addEventListener('change', () => applyAdminPermissionPreset());
}

function accessLevelForPermissionKeys(keys) {
  const selected = new Set(keys || []);
  if (selected.size === 0) return 0;
  if ([CAPABILITIES.ADMINS_MANAGE, CAPABILITIES.SECURITY_VIEW, CAPABILITIES.SETTINGS_MANAGE].some((key) => selected.has(key))) return 100;
  if ([CAPABILITIES.FILES_MANAGE, CAPABILITIES.BACKUPS_MANAGE, CAPABILITIES.PLUGINS_MANAGE].some((key) => selected.has(key))) return 80;
  if ([CAPABILITIES.SERVER_MANAGE, CAPABILITIES.SOFTWARE_MANAGE, CAPABILITIES.PROPERTIES_MANAGE, CAPABILITIES.WHITELIST_MANAGE, CAPABILITIES.OPTIMIZER_MANAGE, CAPABILITIES.NETWORK_MANAGE].some((key) => selected.has(key))) return 60;
  if (selected.has(CAPABILITIES.CONSOLE_COMMAND)) return 40;
  if (selected.has(CAPABILITIES.CONSOLE_VIEW)) return 20;
  return 5;
}

elements.adminForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = formData(elements.adminForm);
  payload.permissionKeys = [...elements.adminForm.querySelectorAll('[name="permissionKey"]:checked')]
    .map((checkbox) => checkbox.value);
  payload.accessLevel = accessLevelForPermissionKeys(payload.permissionKeys);
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
    elements.adminForm.reset();
    applyAdminPermissionPreset(5);
    showToast('Admin created.');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('click', async (event) => {
  const actionTarget = event.target.closest('[data-action]');
  const viewTarget = event.target.closest('[data-view]');
  const action = actionTarget?.dataset.action;
  const view = viewTarget?.dataset.view;
  if (view) return setView(view);
  if (!action) return;

  try {
    const serverCard = event.target.closest('[data-server-id]');
    if (serverCard) state.activeServerId = Number(serverCard.dataset.serverId);

    if (action === 'save-timezone') {
      const select = document.getElementById('userTimezoneSelect');
      const status = document.getElementById('timezoneStatus');
      if (!select || !select.value) {
        showToast('Please select a timezone');
        return;
      }
      try {
        await api('/api/user/timezone', {
          method: 'POST',
          body: JSON.stringify({ timezone: select.value })
        });
        showToast(`✅ Timezone set to ${select.value}`);
        if (status) {
          status.textContent = `✅ Set to ${select.value}`;
          status.style.color = '#4CAF50';
          setTimeout(() => { status.textContent = ''; }, 5000);
        }
        if (state.settings) state.settings.timeZone = select.value;
      } catch (error) {
        showToast(`❌ Error: ${error.message}`);
        if (status) {
          status.textContent = `❌ ${error.message}`;
          status.style.color = '#f44336';
          setTimeout(() => { status.textContent = ''; }, 5000);
        }
      }
      return;
    }

    if (action === 'logout') {
      await api('/api/logout', { method: 'POST' });
      state.user = null;
      window.clearInterval(state.refreshTimer);
      await refresh();
      return;
    }
    if (action && action.startsWith('admin-perms-')) {
      const boxes = [...elements.adminForm.querySelectorAll('[name="permissionKey"]')];
      const setChecked = (keys) => {
        const selected = new Set(keys);
        boxes.forEach((box) => { box.checked = selected.has(box.value); });
      };
      if (action === 'admin-perms-all') boxes.forEach((box) => { box.checked = true; });
      if (action === 'admin-perms-clear') boxes.forEach((box) => { box.checked = false; });
      if (action === 'admin-perms-power') setChecked([CAPABILITIES.SERVER_START, CAPABILITIES.SERVER_STOP, CAPABILITIES.SERVER_RESTART]);
      if (action === 'admin-perms-ops') setChecked([
        CAPABILITIES.SERVER_START, CAPABILITIES.SERVER_STOP, CAPABILITIES.SERVER_RESTART,
        CAPABILITIES.CONSOLE_VIEW, CAPABILITIES.CONSOLE_COMMAND,
        CAPABILITIES.PROPERTIES_MANAGE, CAPABILITIES.WHITELIST_MANAGE,
      ]);
      return;
    }
    if (action === 'ddos-scan') {
      const server = activeServer();
      const data = await api(`/api/security/ddos${server ? `?serverId=${encodeURIComponent(server.id)}` : ''}`);
      const panel = document.querySelector('#ddosPanel');
      if (panel) {
        panel.innerHTML = `
          <div class="plugin-row">
            <div><strong>DDoS Guard ${Number(data.parameterCount || 0).toLocaleString()} params - ${escapeHtml(data.analysis?.risk || 'normal')}</strong><div class="muted">${escapeHtml(data.analysis?.top?.id || 'normal')} score ${Number(data.analysis?.top?.score || 0).toFixed(2)} - TCP ${Number(data.evidence?.tcp?.total || 0)} - UDP ${Number(data.evidence?.udp?.total || 0)}</div></div>
            <span class="badge ${data.analysis?.active ? 'is-on' : ''}">${data.analysis?.active ? 'Active risk' : 'Watching'}</span>
          </div>
          ${(data.mitigation?.steps || []).slice(0, 5).map((step) => `<div class="plugin-row"><div><strong>${escapeHtml(step)}</strong><div class="muted">${escapeHtml((data.mitigation?.commands || [])[0] || 'No command required')}</div></div></div>`).join('')}
        `;
      }
      showToast('DDoS scan complete.');
      return;
    }
    if (action === 'alpha-nav-move') {
      const current = [...document.querySelectorAll('.nav-list [data-view]')].map((button) => button.dataset.view);
      const index = current.indexOf(actionTarget.dataset.navKey);
      const targetIndex = index + Number(actionTarget.dataset.direction || 0);
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return;
      [current[index], current[targetIndex]] = [current[targetIndex], current[index]];
      alphaDraft = { ...alphaDraft, navOrder: current };
      applyUiPreferences(alphaDraft);
      renderSettings();
      return;
    }
    if (action === 'alpha-action-move') {
      const current = [...(alphaDraft.actionPriority || [])];
      const index = current.indexOf(actionTarget.dataset.commandKey);
      const targetIndex = index + Number(actionTarget.dataset.direction || 0);
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return;
      [current[index], current[targetIndex]] = [current[targetIndex], current[index]];
      alphaDraft = { ...alphaDraft, actionPriority: current };
      applyUiPreferences(alphaDraft);
      renderSettings();
      return;
    }
    if (action === 'alpha-cancel') {
      alphaDraft = structuredClone(uiPreferences);
      applyUiPreferences();
      renderSettings();
      return;
    }
    if (action === 'alpha-open-editor') {
      alphaDraft = structuredClone(uiPreferences);
      setLayoutEditor(true);
      return;
    }
    if (action === 'alpha-undo' && uiHistory.length) {
      uiRedo.push(structuredClone(uiPreferences));
      uiPreferences = uiHistory.pop();
      alphaDraft = structuredClone(uiPreferences);
      localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(uiPreferences));
      applyUiPreferences();
      renderSettings();
      return;
    }
    if (action === 'alpha-redo' && uiRedo.length) {
      uiHistory.push(structuredClone(uiPreferences));
      uiPreferences = uiRedo.pop();
      alphaDraft = structuredClone(uiPreferences);
      localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(uiPreferences));
      applyUiPreferences();
      renderSettings();
      return;
    }
    if (action === 'alpha-reset') {
      const saved = localStorage.getItem(UI_PREFERENCES_KEY);
      localStorage.removeItem(UI_PREFERENCES_KEY);
      alphaDraft = loadUiPreferences();
      if (saved !== null) localStorage.setItem(UI_PREFERENCES_KEY, saved);
      applyUiPreferences(alphaDraft);
      renderSettings();
      return;
    }
    if (action === 'alpha-export') {
      const code = encodeLayoutCode(uiPreferences);
      await copyText(code);
      prompt('Alpha layout code copied:', code);
      return;
    }
    if (action === 'alpha-import') {
      const code = prompt('Paste an Alpha layout code:');
      if (!code) return;
      try {
        alphaDraft = { ...loadUiPreferences(), ...decodeLayoutCode(code) };
        applyUiPreferences(alphaDraft);
        renderSettings();
        showToast('Layout code loaded as a preview. Save to keep it.');
      } catch (error) {
        showToast(`Layout import failed: ${error.message}`);
      }
      return;
    }
    if (action === 'terminal-enable') {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...state.settings, terminalEnabled: true }),
      });
      showToast('Terminal enabled.');
      await refresh();
      return setView('terminal');
    }
    if (action === 'refresh-fixed') {
      await renderFixed();
      showToast('Fixed history refreshed.');
      return;
    }
    if (action === 'agent-full-access-unlock') {
      const password = prompt('Owner password to unlock AI full access for 15 minutes:');
      if (!password) return;
      await api('/api/repair/agent/full-access', {
        method: 'POST',
        body: JSON.stringify({ enabled: true, minutes: 15, password }),
      });
      showToast('AI full access unlocked for 15 minutes.');
      await refresh();
      return renderFixed();
    }
    if (action === 'agent-full-access-lock') {
      await api('/api/repair/agent/full-access', {
        method: 'POST',
        body: JSON.stringify({ enabled: false, minutes: 1, password: prompt('Owner password to lock AI full access:') || '' }),
      });
      showToast('AI full access locked.');
      await refresh();
      return renderFixed();
    }
    if (action === 'agent-live-enable' || action === 'agent-live-disable') {
      const enabled = action === 'agent-live-enable';
      if (enabled && !confirm('Enable live diagnostics? It will scan console/files during adaptive maintenance, run safe offline fixes, and queue high-risk commands for owner approval.')) return;
      await api('/api/repair/agent/live', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      showToast(enabled ? 'Live diagnostics enabled.' : 'Live diagnostics disabled.');
      await refresh();
      return renderFixed();
    }
    if (action === 'agent-queue-command') {
      const command = prompt('Command to queue for owner-approved full access execution:');
      if (!command) return;
      const purpose = prompt('Purpose for this command:', 'owner-requested') || 'owner-requested';
      await api('/api/repair/agent/commands', {
        method: 'POST',
        body: JSON.stringify({ serverId: state.activeServerId || null, command, purpose, risk: 'owner-approved' }),
      });
      showToast('Command queued.');
      await refresh();
      return renderFixed();
    }
    if (action === 'agent-command-approve') {
      const id = actionTarget.dataset.commandId;
      if (!id) return;
      if (!confirm('Approve and run this full access command now?')) return;
      const password = prompt('Owner password to run queued command:');
      if (!password) return;
      const result = await api(`/api/repair/agent/commands/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ password, timeoutMs: 30000 }),
      });
      showToast(result.ok ? 'Full access command completed.' : 'Full access command failed.');
      await refresh();
      return renderFixed();
    }
    if (action === 'manage-server') {
      state.activeServerId = Number(actionTarget.closest('[data-server-id]').dataset.serverId);
      filePath = '';
      consoleRenderToken += 1;
      consoleStickToBottom = true;
      renderServerSwitcher();
      return setView('console');
    }
    if (action === 'activate-server') {
      state.activeServerId = Number(actionTarget.closest('[data-server-id]').dataset.serverId);
      filePath = '';
      consoleRenderToken += 1;
      consoleStickToBottom = true;
      if (elements.serverConfigForm) elements.serverConfigForm.dataset.dirty = '0';
      if (elements.consoleBox && state.activeView === 'console') {
        elements.consoleBox.innerHTML = '<div>[NexusPanel] Switching server console...</div>';
      }
      renderServerSwitcher();
      await renderActiveView();
      return;
    }
    if (action === 'select-server') return setView('software');
    if (action === 'open-console') return setView('console');
    if (action === 'open-files') {
      filePath = '';
      return setView('files');
    }
    if (action === 'create-template-server') {
      const key = actionTarget.dataset.templateKey;
      const name = document.querySelector(`[data-template-name="${CSS.escape(key)}"]`)?.value || '';
      const maxMemoryMb = Number(document.querySelector(`[data-template-ram="${CSS.escape(key)}"]`)?.value || 0);
      const cpuCores = Number(document.querySelector(`[data-template-cpu="${CSS.escape(key)}"]`)?.value || 1);
      const port = Number(document.querySelector(`[data-template-port="${CSS.escape(key)}"]`)?.value || 0);
      actionTarget.disabled = true;
      const result = await api(`/api/templates/${encodeURIComponent(key)}/create`, {
        method: 'POST',
        body: JSON.stringify({ name, maxMemoryMb, cpuCores, port }),
      });
      state.activeServerId = result.server.id;
      showToast(result.server.installStatus === 'template' ? 'Template server created.' : 'Template server created. Install software next.');
      await refresh();
      setView(result.server.installStatus === 'template' ? 'console' : 'software');
      return;
    }
    if (action === 'import-nexu') {
      elements.nexuImportInput?.click();
      return;
    }
    if (action === 'run-panel-update') {
      if (!confirm('Update NexusPanel from GitHub now? Server files, data, software cache, and external backups stay protected.')) return;
      const tag = document.querySelector('#settingsForm [name="updateTargetTag"]')?.value || state.settings?.updateTag || '';
      const result = await api('/api/settings/update', { method: 'POST', body: JSON.stringify({ updateTargetTag: tag }) });
      showToast(result.message || 'Update started.');
      await refreshServerStatusOnly();
      return;
    }
    if (action === 'show-host-token') {
      const data = await api('/api/host/token');
      await navigator.clipboard?.writeText(data.token).catch(() => {});
      prompt('Host API token copied if browser allowed it:', data.token);
      return;
    }
    if (action === 'regen-host-token') {
      if (!confirm('Regenerate host API token? Old automation using the token will stop working.')) return;
      const data = await api('/api/host/token/regenerate', { method: 'POST' });
      await navigator.clipboard?.writeText(data.token).catch(() => {});
      prompt('New host API token copied if browser allowed it:', data.token);
      await refresh();
      return;
    }
    if (action === 'terminal-close') {
      await closeTerminalSession();
      showToast('Terminal session closed.');
      return;
    }
    if (action === 'install-software') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      const versionSelect = document.querySelector(`[data-software-version="${CSS.escape(actionTarget.dataset.softwareKey)}"]`);
      actionTarget.disabled = true;
      const card = actionTarget.closest('.software-card');
      const fill = card?.querySelector('.install-track span');
      const message = card?.querySelector('.stat-row .muted');
      if (fill) fill.style.width = '12%';
      if (message) message.textContent = 'Install queued...';
      try {
        await api(`/api/servers/${server.id}/software/install`, {
          method: 'POST',
          body: JSON.stringify({ softwareKey: actionTarget.dataset.softwareKey, softwareVersion: versionSelect ? versionSelect.value : 'latest' }),
        });
      } catch (error) {
        actionTarget.disabled = false;
        throw error;
      }
      showToast('Software install started.');
      await refresh();
      startRefreshLoop();
      return;
    }
    if (action === 'check-software-updates') {
      showToast('Checking software sources...');
      const data = await api('/api/software/check-updates', { method: 'POST' });
      versionCache.clear();
      for (const [key, versions] of Object.entries(data.versions || {})) {
        versionCache.set(key, versions);
      }
      lastCreateSoftwareKey = '';
      showToast('Software versions refreshed.');
      renderSoftwareChoices();
      renderSoftware();
      reapplyDynamicLayout();
      return;
    }
    if (action === 'start-server' || action === 'stop-server' || action === 'kill-server' || action === 'restart-server') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      animateCommandButton(actionTarget);
      const op = action.replace('-server', '');
      try {
        await api(`/api/servers/${server.id}/${op}`, { method: 'POST' });
      } catch (error) {
        if (error.message.includes('EULA') && confirm('Minecraft Java requires accepting the EULA before starting. Agree and continue?')) {
          await api(`/api/servers/${server.id}/eula`, { method: 'POST' });
          await api(`/api/servers/${server.id}/${op}`, { method: 'POST' });
        } else {
          throw error;
        }
      }
      showToast(`${op} requested.`);
      await refresh();
      if (state.activeView === 'console') await renderConsole();
      return;
    }
    if (action === 'agree-eula') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      await api(`/api/servers/${server.id}/eula`, { method: 'POST' });
      showToast('EULA agreed for this server.');
      await refresh();
      return;
    }
    if (action === 'apply-optimizer') {
      await api('/api/optimizer/apply', { method: 'POST' });
      showToast('Optimizer applied.');
      await refresh();
      return;
    }
    if (action === 'network-speed-test') {
      actionTarget.disabled = true;
      try {
        showToast('Running quick panel speed test...');
        const downloadSize = 512 * 1024;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 3500);
        const downloadStart = performance.now();
        const downloadBuffer = await fetch(`/api/network/download-test?size=${downloadSize}&t=${Date.now()}`, { credentials: 'same-origin', signal: controller.signal }).then((res) => {
          if (!res.ok) throw new Error('Download speed test failed.');
          return res.arrayBuffer();
        });
        const downloadSeconds = Math.max(0.001, (performance.now() - downloadStart) / 1000);
        const uploadBuffer = new Uint8Array(256 * 1024).fill(90);
        const uploadStart = performance.now();
        const uploadResult = await fetch('/api/network/upload-test', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: uploadBuffer,
          signal: controller.signal,
        });
        window.clearTimeout(timeout);
        if (!uploadResult.ok) throw new Error('Upload speed test failed.');
        const uploadSeconds = Math.max(0.001, (performance.now() - uploadStart) / 1000);
        await renderNetwork({
          downloadBytesPerSec: downloadBuffer.byteLength / downloadSeconds,
          uploadBytesPerSec: uploadBuffer.byteLength / uploadSeconds,
        });
        showToast('Network speed updated.');
      } finally {
        actionTarget.disabled = false;
      }
      return;
    }
    if (action === 'show-normal-tunnel-plan') {
      try {
        const plan = await refreshTunnelOutput();
        const copyText = plan.ngrok?.remoteHost || tunnelStatusText(plan);
        await navigator.clipboard?.writeText(copyText).catch(() => {});
        showToast('Tunnel status refreshed.');
      } catch (error) {
        setTunnelOutput(error.message, 'error');
      }
      return;
    }
    if (action === 'install-ngrok-agent' || action === 'start-ngrok-tunnel' || action === 'stop-ngrok-tunnel') {
      const server = activeServer();
      if (!server && action !== 'install-ngrok-agent') return showToast('Create or select a server first.');
      const protocol = document.querySelector('#normalTunnelProtocol')?.value || 'auto';
      const endpoint = action === 'install-ngrok-agent'
        ? '/api/tunnels/ngrok/install'
        : action === 'start-ngrok-tunnel'
          ? '/api/tunnels/ngrok/start'
          : '/api/tunnels/ngrok/stop';
      actionTarget.disabled = true;
      setTunnelOutput(`${actionTarget.textContent.trim()} running...`);
      try {
        const data = await api(endpoint, {
          method: 'POST',
          body: JSON.stringify({ serverId: server?.id || 0, protocol }),
        });
        const remote = data.ngrok?.remoteHost || data.ngrok?.message || 'ngrok status updated.';
        if (data.ngrok?.remoteHost) await navigator.clipboard?.writeText(data.ngrok.remoteHost).catch(() => {});
        await refreshTunnelOutput(remote);
        showToast(action === 'start-ngrok-tunnel' ? `ngrok: ${remote}` : remote);
      } catch (error) {
        setTunnelOutput(error.message, 'error');
      } finally {
        actionTarget.disabled = false;
      }
      return;
    }
    if (action === 'run-playit-terminal') {
      actionTarget.disabled = true;
      setTunnelOutput('Starting Playit foreground terminal...');
      try {
        const data = await api('/api/tunnels/playit/claim-terminal/start', { method: 'POST' });
        const terminal = data.terminal || {};
        setTunnelOutput(terminal.output || terminal.message || 'Playit terminal started.');
        if (terminal.running) startPlayitTerminalPolling();
        showToast('Playit terminal is running. Keep it open until the claim page connects.');
      } catch (error) {
        setTunnelOutput(error.message, 'error');
      } finally {
        actionTarget.disabled = false;
      }
      return;
    }
    if (action === 'install-playit-agent' || action === 'start-playit-agent' || action === 'stop-playit-agent') {
      const endpoint = action === 'install-playit-agent'
        ? '/api/tunnels/playit/install'
        : action === 'start-playit-agent'
          ? '/api/tunnels/playit/start'
          : '/api/tunnels/playit/stop';
      actionTarget.disabled = true;
      setTunnelOutput(`${actionTarget.textContent.trim()} running...`);
      try {
        const data = await api(endpoint, { method: 'POST' });
        if (action === 'stop-playit-agent') stopPlayitTerminalPolling();
        await refreshTunnelOutput(data.playit?.message || 'Playit status updated.');
        showToast(data.playit?.message || 'Playit status updated.');
      } catch (error) {
        setTunnelOutput(error.message, 'error');
      } finally {
        actionTarget.disabled = false;
      }
      return;
    }
    if (action === 'show-nginx-config') {
      const response = await fetch('/api/nginx/accel-config', { credentials: 'same-origin' });
      const text = await response.text();
      if (!response.ok) throw new Error(text || 'Could not load Nginx config.');
      await navigator.clipboard?.writeText(text).catch(() => {});
      prompt('Nginx X-Accel config copied if browser allowed it:', text);
      return;
    }
    if (action === 'repair-preview') {
      const server = activeServer();
      if (!server) return showToast('Select a server first.');
      const result = await api(`/api/servers/${server.id}/repair-preview`, { method: 'POST', body: '{}' });
      const diagnoses = (result.agent?.diagnoses || result.diagnostics || []).slice(0, 6)
        .map((item) => `${String(item.severity || 'info').toUpperCase()} ${Math.round(Number(item.confidence || 0) * 100)}%: ${item.summary}`)
        .join('\n');
      const actions = (result.agent?.actions || []).slice(0, 6).map((item) => `- ${item.description}`).join('\n');
      const optimizations = (result.agent?.optimizations || []).slice(0, 4)
        .map((item) => `- ${item.key}: ${item.current} -> ${item.suggested} (${item.reason})`)
        .join('\n');
      const research = (result.agent?.webResearch?.results || []).slice(0, 5)
        .map((item) => `- ${item.source}: ${item.title}${item.codeSnippets?.length ? ` (${item.codeSnippets.length} redacted code snippet(s))` : ''}\n  ${item.url}`)
        .join('\n');
      const summary = [
        diagnoses || `No known cause matched ${result.knowledge?.diagnosticSignals || 0} signals.`,
        actions ? `\nSafe plan:\n${actions}` : '',
        optimizations ? `\nOptimization plan:\n${optimizations}` : '',
        research ? `\nUntrusted web references (never auto-executed):\n${research}` : '',
      ].join('');
      prompt(`Repair preview ${result.signature} (no changes applied):`, summary);
      return;
    }
    if (action === 'copy-repair-bundle') {
      const bundle = await api('/api/repair/bundle');
      await copyText(JSON.stringify(bundle, null, 2));
      showToast('Redacted repair bundle copied.');
      return;
    }
    if (action === 'database-snapshot') {
      const result = await api('/api/database/snapshot', { method: 'POST', body: '{}' });
      showToast(`Verified database snapshot created: ${result.file}`);
      await refresh();
      return;
    }
    if (action === 'run-health-check') {
      showToast('Running panel health check...');
      await renderSecurity(true);
      showToast('Health check complete.');
      return;
    }
    if (action === 'adaptive-heal') {
      const result = await api('/api/adaptive/heal', { method: 'POST', body: '{}' });
      showToast(result.actions?.length ? `Adaptive heal completed ${result.actions.length} action(s).` : 'Adaptive heal found no safe repairs.');
      await refresh();
      if (state.activeView === 'security') await renderSecurity();
      return;
    }
    if (action === 'agent-feedback') {
      const feedback = actionTarget.dataset.feedback;
      if (!confirm(`Mark this repair-agent episode as ${feedback}? This changes its learned neural weights.`)) return;
      const result = await api(`/api/repair/agent/episodes/${encodeURIComponent(actionTarget.dataset.episodeId)}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ feedback }),
      });
      showToast(`Agent feedback recorded: ${feedback} (${result.learning?.updated || 0} weight updates).`);
      await refresh();
      if (state.activeView === 'security') await renderSecurity();
      return;
    }
    if (action === 'delete-server') {
      const server = activeServer();
      if (!server) return;
      if (!confirm(`Delete server "${server.name}" and all its files? This cannot be undone.`)) return;
      const result = await api(`/api/servers/${server.id}`, { method: 'DELETE' });
      showToast(result.cleanupPending ? 'Server deleted. Locked leftovers will be removed on next boot.' : 'Server deleted.');
      state.activeServerId = null;
      await refresh({ keepView: false });
      return;
    }
    if (action === 'manual-backup') {
      const server = activeServer();
      if (!server) return;
      showToast('Creating backup...');
      await api(`/api/servers/${server.id}/backups`, { method: 'POST' });
      showToast('Backup created.');
      renderBackups();
      return;
    }
    if (action === 'backup-code-show') {
      const server = activeServer();
      if (!server) return;
      const hours = Number(prompt('How many hours should this code stay active? 1-24', '1') || 1);
      await api(`/api/servers/${server.id}/backups/share-code`, {
        method: 'POST',
        body: JSON.stringify({ durationValue: Math.max(1, Math.min(24, hours)), durationUnit: 'hours' }),
      });
      showToast('Backup code ready.');
      renderBackups();
      return;
    }
    if (action === 'backup-code-hide') {
      const server = activeServer();
      if (!server) return;
      await api(`/api/servers/${server.id}/backups/share-code`, { method: 'DELETE' });
      showToast('Backup code hidden.');
      renderBackups();
      return;
    }
    if (action === 'public-backup-link') {
      const server = activeServer();
      if (!server) return;
      const hours = Number(prompt('How many hours should these links stay active? 1-24', '1') || 1);
      const share = await api(`/api/servers/${server.id}/backups/public-link`, {
        method: 'POST',
        body: JSON.stringify({ durationValue: Math.max(1, Math.min(24, hours)), durationUnit: 'hours' }),
      });
      publicBackupLinks.set(server.id, share);
      showToast('Public backup links created.');
      renderBackups();
      return;
    }
    if (action === 'revoke-public-backup-link') {
      const server = activeServer();
      if (!server || !confirm('Revoke every active public backup link for this server?')) return;
      await api(`/api/servers/${server.id}/backups/public-link`, { method: 'DELETE' });
      publicBackupLinks.delete(server.id);
      showToast('Public backup links revoked.');
      renderBackups();
      return;
    }
    if (action === 'copy-public-backup-link') {
      await copyText(actionTarget.dataset.publicUrl || '');
      showToast('Public backup link copied.');
      return;
    }
    if (action === 'backup-request-approve') {
      const server = activeServer();
      if (!server) return;
      const row = actionTarget.closest('.plugin-row');
      const hours = Number(row?.querySelector('[data-share-hours]')?.value || 1);
      await api(`/api/servers/${server.id}/backups/share-requests/${actionTarget.dataset.requestId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ durationValue: Math.max(1, Math.min(24, hours)), durationUnit: 'hours' }),
      });
      showToast('Backup access approved.');
      renderBackups();
      return;
    }
    if (action === 'backup-request-remove') {
      const server = activeServer();
      if (!server) return;
      if (!confirm('Remove this backup access/request?')) return;
      await api(`/api/servers/${server.id}/backups/share-requests/${actionTarget.dataset.requestId}`, { method: 'DELETE' });
      showToast('Backup access removed.');
      renderBackups();
      return;
    }
    if (action === 'delete-backup') {
      const server = activeServer();
      if (!server) return;
      const backupPath = actionTarget.dataset.backupPath;
      if (!backupPath || !confirm(`Delete backup ${backupPath.split('/').pop()}?`)) return;
      await api(`/api/servers/${server.id}/backups?path=${encodeURIComponent(backupPath)}`, { method: 'DELETE' });
      showToast('Backup deleted.');
      renderBackups();
      return;
    }
    if (action === 'restore-backup') {
      const server = activeServer();
      if (!server) return;
      const backupPath = actionTarget.dataset.backupPath;
      const sourceServerId = actionTarget.dataset.sourceServerId || '';
      if (server.status === 'online') return showToast('Stop the server before restoring a backup.');
      if (!backupPath || !confirm(`Restore ${backupPath.split('/').pop()}? This deletes current server files except software/runtime, then unzips the backup.`)) return;
      showToast('Restoring backup...');
      await api(`/api/servers/${server.id}/backups/restore`, {
        method: 'POST',
        body: JSON.stringify({ name: backupPath, sourceServerId }),
      });
      filePath = '';
      showToast('Backup restored.');
      renderBackups();
      if (state.activeView === 'files') await renderFiles();
      return;
    }
    if (action === 'install-modrinth') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      const card = actionTarget.closest('.modrinth-card');
      const bar = card?.querySelector('.install-track');
      const fill = bar?.querySelector('span');
      if (bar) bar.hidden = false;
      if (fill) fill.style.width = '35%';
      await api(`/api/servers/${server.id}/modrinth/install`, {
        method: 'POST',
        body: JSON.stringify({ projectId: actionTarget.dataset.projectId, name: actionTarget.dataset.projectName }),
      });
      if (fill) fill.style.width = '100%';
      showToast('Modrinth plugin installed. Restart server to load it.');
      await refresh();
      return;
    }
    if (action === 'install-poggit') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      const card = actionTarget.closest('.modrinth-card');
      const bar = card?.querySelector('.install-track');
      const fill = bar?.querySelector('span');
      if (bar) bar.hidden = false;
      if (fill) fill.style.width = '35%';
      await api(`/api/servers/${server.id}/poggit/install`, {
        method: 'POST',
        body: JSON.stringify({
          downloadUrl: actionTarget.dataset.downloadUrl,
          fileName: actionTarget.dataset.fileName,
          name: actionTarget.dataset.projectName,
        }),
      });
      if (fill) fill.style.width = '100%';
      showToast('Poggit plugin installed. Restart server to load it.');
      await refresh();
      return;
    }
    if (action === 'delete-whitelist') {
      const server = activeServer();
      if (!server) return;
      if (!confirm(`Remove ${actionTarget.dataset.playerName} from whitelist?`)) return;
      await api(`/api/servers/${server.id}/whitelist/${encodeURIComponent(actionTarget.dataset.playerName)}`, { method: 'DELETE' });
      showToast('Whitelist entry removed.');
      await renderWhitelist();
      return;
    }
    if (action === 'clear-whitelist') {
      const server = activeServer();
      if (!server) return;
      if (!confirm('Remove ALL players from this whitelist?')) return;
      await api(`/api/servers/${server.id}/whitelist`, { method: 'DELETE' });
      showToast('Whitelist cleared.');
      await renderWhitelist();
      return;
    }
    if (action === 'file-open') {
      filePath = actionTarget.dataset.filePath;
      await renderFiles();
      return;
    }
    if (action === 'file-upload') {
      elements.fileUploadInput.click();
      return;
    }
    if (action === 'upload-pause') {
      if (!currentUpload.path) return showToast('No active upload in this tab.');
      currentUpload.paused = true;
      showToast('Pausing after current chunk...');
      return;
    }
    if (action === 'upload-cancel-current') {
      const server = activeServer();
      if (!server || !currentUpload.path) return showToast('No active upload in this tab.');
      currentUpload.canceled = true;
      await api(`/api/servers/${server.id}/files/upload-session?path=${encodeURIComponent(currentUpload.path)}`, { method: 'DELETE' });
      showToast('Upload canceled.');
      await renderUploadSessions();
      return;
    }
    if (action === 'upload-cancel') {
      const server = activeServer();
      if (!server) return;
      await api(`/api/servers/${server.id}/files/upload-session?path=${encodeURIComponent(actionTarget.dataset.uploadPath)}`, { method: 'DELETE' });
      if (currentUpload.path === actionTarget.dataset.uploadPath) currentUpload.canceled = true;
      showToast('Upload removed.');
      await renderUploadSessions();
      return;
    }
    if (action === 'file-select-all') {
      document.querySelectorAll('.file-pick').forEach((input) => { input.checked = true; });
      return;
    }
    if (action === 'file-clear-selection') {
      document.querySelectorAll('.file-pick').forEach((input) => { input.checked = false; });
      return;
    }
    if (action === 'file-copy-selected' || action === 'file-cut-selected') {
      const selected = selectedFilePaths();
      if (!selected.length) return showToast('Select files or folders first.');
      const server = activeServer();
      fileClipboard = { mode: action === 'file-copy-selected' ? 'copy' : 'move', paths: selected, serverId: server?.id || null };
      showToast(`${fileClipboard.mode === 'copy' ? 'Copied' : 'Cut'} ${selected.length} item(s).`);
      return;
    }
    if (action === 'fix-server') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      if (server.status === 'online') return showToast('Stop the server before running Repair & Diagnose.');
      if (!confirm(`Run the repair agent for "${server.name}"? It will inspect VPS pressure, validate the runtime, clean stale transfers, check world storage and disk space, rebuild isolation metadata, and apply only bounded offline Minecraft distance optimizations after saving a recovery copy.`)) return;
      const result = await api(`/api/servers/${server.id}/fix`, { method: 'POST' });
      const learned = result.learned ? ` Learned playbook ${result.learned.signature}.` : '';
      showToast(`${result.summary || result.repair?.message || 'Repair & Diagnose completed.'}${learned}`);
      await refresh();
      return;
    }
    if (action === 'file-paste') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      if (!fileClipboard.paths.length) return showToast('Nothing copied or cut.');
      if (fileClipboard.serverId !== server.id) {
        fileClipboard = { mode: '', paths: [], serverId: null };
        return showToast('Paste canceled: clipboard belongs to another server.');
      }
      await api(`/api/servers/${server.id}/files/${fileClipboard.mode === 'move' ? 'move' : 'copy'}`, {
        method: 'POST',
        body: JSON.stringify({ paths: fileClipboard.paths, destination: filePath }),
      });
      showToast(`${fileClipboard.mode === 'move' ? 'Moved' : 'Copied'} ${fileClipboard.paths.length} item(s).`);
      if (fileClipboard.mode === 'move') fileClipboard = { mode: '', paths: [], serverId: null };
      await renderFiles();
      return;
    }
    if (action === 'file-scroll-top') {
      elements.fileList.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }
    if (action === 'file-scroll-bottom') {
      elements.fileList.scrollTo({ top: elements.fileList.scrollHeight, behavior: 'auto' });
      return;
    }
    if (action === 'file-up') {
      filePath = filePath.split('/').slice(0, -1).join('/');
      await renderFiles();
      return;
    }
    if (action === 'file-new') {
      const name = prompt('New file path inside this folder:');
      if (!name) return;
      const server = activeServer();
      const nextPath = [filePath, name].filter(Boolean).join('/');
      await api(`/api/servers/${server.id}/files`, { method: 'PUT', body: JSON.stringify({ path: nextPath, content: '' }) });
      filePath = nextPath;
      await renderFiles();
      return;
    }
    if (action === 'folder-new') {
      const name = prompt('New folder path inside this folder:');
      if (!name) return;
      const server = activeServer();
      await api(`/api/servers/${server.id}/files/mkdir`, { method: 'POST', body: JSON.stringify({ path: [filePath, name].filter(Boolean).join('/') }) });
      await renderFiles();
      return;
    }
    if (action === 'file-delete') {
      const server = activeServer();
      const target = elements.fileEditor.path.value;
      if (!target || !confirm(`Delete ${target}?`)) return;
      await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(target)}`, { method: 'DELETE' });
      filePath = target.split('/').slice(0, -1).join('/');
      showToast('Deleted.');
      await renderFiles();
      return;
    }
    if (action === 'file-delete-selected') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      const selected = selectedFilePaths();
      if (!selected.length) return showToast('Select files or folders first.');
      if (!confirm(`Delete ${selected.length} selected item(s)?`)) return;
      await Promise.all(selected.map((target) => api(`/api/servers/${server.id}/files?path=${encodeURIComponent(target)}`, { method: 'DELETE' })));
      showToast('Selected items deleted.');
      await renderFiles();
      return;
    }
    if (action === 'file-download-selected') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      const selected = selectedFileEntries();
      const editorPath = !selected.length && elements.fileEditor && !elements.fileEditor.hidden
        ? elements.fileEditor.path.value
        : '';

      if (selected.length === 1 && selected[0].type === 'file') {
        showToast('Fast ranged download starting.');
        startFastDownload(`/api/servers/${server.id}/files/download?path=${encodeURIComponent(selected[0].path)}`);
        return;
      }

      if (!selected.length && editorPath) {
        showToast('Fast ranged download starting.');
        startFastDownload(`/api/servers/${server.id}/files/download?path=${encodeURIComponent(editorPath)}`);
        return;
      }

      if (!selected.length) return showToast('Select one file/folder first.');
      showToast('Packing selected items for download...');
      const result = await api(`/api/servers/${server.id}/files/archive`, {
        method: 'POST',
        body: JSON.stringify({ paths: selected.map((item) => item.path) }),
      });
      showToast('Archive ready. Download starting.');
      startFastDownload(result.downloadUrl);
      await renderFiles();
      return;
    }
    if (action === 'file-archive') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      const selected = selectedFilePaths();
      const paths = selected.length ? selected : [filePath];
      const result = await api(`/api/servers/${server.id}/files/archive`, {
        method: 'POST',
        body: JSON.stringify({ paths }),
      });
      showToast('Archive created. Download starting.');
      window.location.href = result.downloadUrl;
      await renderFiles();
      return;
    }
    if (action === 'file-unzip') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      const selected = selectedFilePaths();
      const zipFiles = selected.filter((item) => item.toLowerCase().endsWith('.zip'));
      if (!zipFiles.length) return showToast('Select one or more .zip files first.');
      showToast(`Unzipping ${zipFiles.length} file(s)...`);
      const payload = { paths: zipFiles, destination: filePath, mode: 'fail' };
      try {
        await api(`/api/servers/${server.id}/files/extract`, { method: 'POST', body: JSON.stringify(payload) });
      } catch (error) {
        if (!/replace/i.test(error.message)) throw error;
        const replace = confirm(`${error.message}\n\nOK = Replace all duplicates\nCancel = Skip existing duplicates`);
        payload.mode = replace ? 'replace' : 'skip';
        await api(`/api/servers/${server.id}/files/extract`, { method: 'POST', body: JSON.stringify(payload) });
      }
      showToast('Unzip complete.');
      await renderFiles();
      return;
    }

    const pluginRow = event.target.closest('[data-plugin-id]');
    if (pluginRow && action === 'toggle-plugin') {
      const plugin = state.plugins.find((item) => String(item.id) === pluginRow.dataset.pluginId);
      await api(`/api/plugins/${pluginRow.dataset.pluginId}`, { method: 'PATCH', body: JSON.stringify({ enabled: !plugin.enabled }) });
      showToast('Plugin state updated.');
      await refresh();
      return;
    }
    if (pluginRow && action === 'delete-plugin') {
      await api(`/api/plugins/${pluginRow.dataset.pluginId}`, { method: 'DELETE' });
      showToast('Plugin removed.');
      await refresh();
      return;
    }

    const row = event.target.closest('[data-user-id]');
    if (row && action === 'update-user') {
      const permissionKeys = [...row.querySelectorAll('[data-user-permission]:checked')].map((input) => input.value);
      await api(`/api/users/${row.dataset.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          accessLevel: Number(row.querySelector('[data-user-access-level]').value),
          permissionKeys,
        }),
      });
      showToast('Admin access updated.');
      await refresh();
      return;
    }
    if (row && action === 'delete-user') {
      await api(`/api/users/${row.dataset.userId}`, { method: 'DELETE' });
      showToast('Admin deleted.');
      await refresh();
    }
  } catch (error) {
    showToast(error.message);
  }
});

initThemes();
applyUiPreferences();
applyAdminPermissionPreset(5);
enableDeveloperModeGuard();

refresh().then(startRefreshLoop).catch((error) => {
  showToast(error.message);
  console.error('Initial load error:', error);
});
