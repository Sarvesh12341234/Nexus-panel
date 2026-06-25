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
  metricHistory: {},
  activeView: 'dashboard',
  activeServerId: null,
  refreshTimer: null,
  statusRefreshAt: 0,
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
  consoleBox: document.querySelector('#consoleBox'),
  consoleMetrics: document.querySelector('#consoleMetrics'),
  commandForm: document.querySelector('#commandForm'),
  serverConfigForm: document.querySelector('#serverConfigForm'),
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
let fileClipboard = { mode: '', paths: [] };
let currentUpload = { path: '', size: 0, paused: false, canceled: false };
let consoleStickToBottom = true;
let consoleRenderToken = 0;
let terminalSession = { id: '', cursor: 0, timer: 0 };
const versionCache = new Map();
let lastCreateSoftwareKey = '';
const UPLOAD_CHUNK_SIZE = 32 * 1024 * 1024;
const UPLOAD_PARALLELISM = 4;
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
  settings: ['Panel', 'Settings'],
  terminal: ['Owner', 'VPS Terminal'],
};

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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function formData(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) data[checkbox.name] = checkbox.checked;
  return data;
}

function can(level) {
  return state.user && state.user.accessLevel >= level;
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
  form.port.value = server.port;
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
}

async function renderUploadSessions() {
  ensureFileControls();
  const server = activeServer();
  if (!server || !elements.uploadSessionList) return;
  const data = await api(`/api/servers/${server.id}/files/uploads`).catch(() => ({ uploads: [] }));
  const uploads = data.uploads || [];
  if (uploads.length) elements.uploadPanel.hidden = false;
  elements.uploadSessionList.innerHTML = uploads.map((upload) => `
    <div class="upload-session-row">
      <div>
        <strong>${escapeHtml(upload.name)}</strong>
        <div class="muted">${escapeHtml(upload.status)} · ${upload.progress}% · ${Math.round((upload.uploadedBytes || 0) / 1024 / 1024)} / ${Math.round((upload.size || 0) / 1024 / 1024)} MB</div>
        <div class="install-track"><span style="width:${upload.progress}%"></span></div>
      </div>
      <button class="danger" type="button" data-action="upload-cancel" data-upload-path="${escapeHtml(upload.path)}">Cancel</button>
    </div>
  `).join('');
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
  const fileSha256 = await digestHex(file);
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
  if (uploadedBytes > 0) updateProgress('resuming');

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
  if (elements.terminalNav) elements.terminalNav.hidden = !(state.settings?.terminalEnabled && state.user?.role === 'owner');
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
    <button class="server-list-item ${server.id === state.activeServerId ? 'is-active' : ''}" type="button" data-action="activate-server" data-server-id="${server.id}">
      <span>${escapeHtml(server.name)}</span>
      <small>${escapeHtml(server.softwareName)} · ${escapeHtml(server.status)}</small>
    </button>
  `).join('') || '<p class="empty-state">No server yet. Create one.</p>';
}

function renderServerRows() {
  if (!elements.serverRowsGrid) return;
  if (!state.servers.length) {
    elements.serverRowsGrid.innerHTML = '<p class="empty-state">No servers yet. Create one from Dashboard or Templates.</p>';
    return;
  }
  elements.serverRowsGrid.innerHTML = state.servers.map((server) => `
    <article class="server-row-card ${server.id === state.activeServerId ? 'is-selected' : ''}" data-server-id="${server.id}">
      <div>
        <strong>${escapeHtml(server.name)}</strong>
        <span class="muted">${escapeHtml(server.softwareName)} · ${escapeHtml(server.type)} · ${escapeHtml(server.status)}</span>
      </div>
      <code>${escapeHtml(server.serverPath || '')}</code>
      <div class="row-actions">
        <button type="button" data-action="activate-server">Open</button>
        <button class="secondary" type="button" data-action="open-console">Console</button>
        <button class="danger" type="button" data-action="delete-server" ${server.status === 'online' ? 'disabled' : ''}>Delete</button>
      </div>
    </article>
  `).join('');
}

function renderServers() {
  if (!state.servers.length) {
    elements.serverGrid.innerHTML = '<p class="empty-state">No servers yet. Create one above, then install software from the Software tab.</p>';
    return;
  }

  elements.serverGrid.innerHTML = state.servers.map((server) => {
    const isOnline = server.status === 'online';
    const installed = server.installStatus === 'installed';
    return `
      <article class="server-card ${server.id === state.activeServerId ? 'is-selected' : ''}" data-server-id="${server.id}">
        <div class="status-row">
          <h3>${escapeHtml(server.name)}</h3>
          <span class="badge ${isOnline ? 'is-on' : ''}">${escapeHtml(server.status)}</span>
        </div>
        <div class="stat-row"><span class="muted">Software</span><strong>${escapeHtml(server.softwareName)}</strong></div>
        <div class="install-track"><span style="width:${server.installProgress}%"></span></div>
        <div class="stat-row"><span class="muted">${escapeHtml(server.installStatus)}</span><strong>${server.installProgress}%</strong></div>
        <div class="stat-row"><span class="muted">Address</span><strong>${server.host}:${server.port}</strong></div>
        <div class="stat-row"><span class="muted">Path</span><code>${escapeHtml(server.serverPath || 'pending')}</code></div>
        <div class="server-actions">
          <button type="button" data-action="select-server">Manage</button>
          <button class="secondary" type="button" data-action="open-console">Console</button>
          <button class="secondary" type="button" data-action="start-server" ${isOnline || !installed ? 'disabled' : ''}>Start</button>
          <button class="secondary" type="button" data-action="stop-server" ${isOnline ? '' : 'disabled'}>Stop</button>
          <button class="secondary" type="button" data-action="restart-server" ${isOnline ? '' : 'disabled'}>Restart</button>
          <button class="danger" type="button" data-action="delete-server" ${isOnline ? 'disabled' : ''}>Delete</button>
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
    <article class="software-card software-update-card">
      <div class="status-row">
        <strong>Software Versions</strong>
        <span class="pill">Live</span>
      </div>
      <p>Checks Paper, Purpur, Java, Bedrock, and PocketMine sources for new versions.</p>
      <button type="button" data-action="check-software-updates">Check Updates</button>
    </article>
  ` + (server.templateKey && server.type === 'custom' ? `
    <article class="software-card is-selected">
      <div class="status-row">
        <strong>${escapeHtml(server.softwareName || 'Nexu Template')}</strong>
        <span class="pill is-on">nexu</span>
      </div>
      <p>Installs from the template's own runtime commands, including SteamCMD app IDs where provided.</p>
      <div class="stat-row"><span class="muted">Executable</span><code>${escapeHtml(server.executablePath || 'resolved after install')}</code></div>
      <div class="install-track"><span style="width:${server.installProgress || 0}%"></span></div>
      <div class="stat-row"><span class="muted">${escapeHtml(server.installMessage || server.installStatus || 'Ready')}</span><strong>${server.installProgress || 0}%</strong></div>
      <button type="button" data-action="install-software" data-software-key="${escapeHtml(server.softwareKey || '')}">${server.installStatus === 'installed' ? 'Reinstall Template' : 'Install Template'}</button>
    </article>
  ` : '') + state.softwareCatalog.map((software) => {
    const compatible = software.edition === server.type;
    const selected = software.key === server.softwareKey;
    return `
      <article class="software-card ${selected ? 'is-selected' : ''}">
        <div class="status-row">
          <strong>${escapeHtml(software.name)}</strong>
          <span class="pill ${compatible ? 'is-on' : ''}">${compatible ? software.edition : 'blocked'}</span>
        </div>
        <p>${escapeHtml(software.notes)}</p>
        <div class="stat-row"><span class="muted">Executable</span><code>${escapeHtml(selected ? server.executablePath : software.expectedPath)}</code></div>
        <label>Version <select data-software-version="${software.key}" ${compatible ? '' : 'disabled'}><option value="latest">Latest</option></select></label>
        <div class="install-track"><span style="width:${selected ? server.installProgress : 0}%"></span></div>
        <div class="stat-row"><span class="muted">${selected ? `${escapeHtml(server.installMessage)} (${escapeHtml(server.softwareVersion || 'latest')})` : 'Not selected'}</span><strong>${selected ? `${server.installProgress}%` : ''}</strong></div>
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
  if (state.activeView === 'settings') renderSettings();
  if (state.activeView === 'terminal') renderTerminal();
}

function renderPlugins() {
  const canManagePlugins = can(state.permissions.MANAGE_FILES);
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
  } else {
    elements.modrinthForm.querySelector('input[name="query"]').placeholder = 'Search Modrinth: Geyser, LuckPerms, ViaVersion';
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
  const data = await api(`/api/servers/${server.id}/console`).catch(() => ({ lines: [] }));
  if (renderToken !== consoleRenderToken || state.activeServerId !== serverId) return;
  fillServerConfigForm(server);
  if (data.status && server.status !== data.status) {
    server.status = data.status;
    renderStats();
    renderServerSwitcher();
    if (state.activeView === 'dashboard') renderServers();
  }
  syncConsoleActionButtons(server, data.status || server.status);
  const lines = data.lines.length ? data.lines : [
    `[NexusPanel] ${server.name} is ${data.status || server.status}.`,
    `[NexusPanel] Install software, press Start, then logs will stream here.`,
  ];
  elements.consoleBox.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
  if (consoleStickToBottom) elements.consoleBox.scrollTop = elements.consoleBox.scrollHeight;
  const [metrics, serverMetrics] = await Promise.all([
    api('/api/system/metrics').catch(() => null),
    api(`/api/servers/${server.id}/metrics`).catch(() => null),
  ]);
  if (renderToken !== consoleRenderToken || state.activeServerId !== serverId) return;
  renderConsoleMetrics(server, metrics, serverMetrics);
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
      <div class="file-meta"><code>${escapeHtml(entry.path)}</code><time>${entry.modifiedAt ? escapeHtml(new Date(entry.modifiedAt).toLocaleString()) : ''}</time></div>
    </div>
  `).join('') || '<p class="empty-state">Folder is empty. Create a file or paste config here.</p>';
}

function renderSettings() {
  if (!elements.settingsPanel) return;
  
  // Initialize the settings manager if it exists
  if (window.settingsManager) {
    window.settingsManager.loadSettings();
    return;
  }
  
  // Fallback if settings.js didn't load
  const settings = state.settings || {};
  const update = settings.updateStatus || {};
  const isHost = settings.edition === 'host';
  const selectedZone = settings.timeZone || 'UTC';
  const zoneOptions = timeZones.map((zone) => `<option value="${escapeHtml(zone)}" ${zone === selectedZone ? 'selected' : ''}>${escapeHtml(zone)}</option>`).join('');
  
  elements.settingsPanel.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">Settings</p><h2>Panel engine</h2></div><button type="button" data-action="run-panel-update">Update from GitHub</button></div>
    <form class="settings-form" id="settingsForm">
      <label class="switch"><input name="terminalEnabled" type="checkbox" ${settings.terminalEnabled ? 'checked' : ''}><span></span>Owner terminal row</label>
      <label class="switch"><input name="nexusMarkEnabled" type="checkbox" ${settings.nexusMarkEnabled ? 'checked' : ''}><span></span>Nexus-Mark controls</label>
      <label>Panel version <input readonly value="${escapeHtml(settings.version || '1.2.0')}"></label>
      <label>Update source <input readonly value="${escapeHtml(settings.updateRepo || '')}"></label>
      <label>Update tag <input name="updateTargetTag" value="${escapeHtml(settings.updateTag || '')}" placeholder="normal-v1.2.0"></label>
      <label>Max allocatable RAM <input readonly value="${settings.maxAllocatableMemoryMb || 0} MB"></label>
      <label>Max CPU cores <input readonly value="${settings.maxCpuCores || 1}"></label>
      <label>Edition <input readonly value="${escapeHtml(settings.edition || 'normal')} (${escapeHtml(settings.updateTag || '')})"></label>
      
      <div class="settings-group">
        <label>Timezone <select name="timeZone" id="userTimezoneSelect">${zoneOptions}</select></label>
        <button type="button" class="secondary" data-action="save-timezone" style="margin-top: 8px;">Save Timezone</button>
        <span id="timezoneStatus" style="margin-left: 10px;"></span>
      </div>
      
      <button class="save-wide" type="submit">Save Settings</button>
    </form>
    <div class="upload-panel">
      <span>${escapeHtml(update.message || 'Updater idle')}</span>
      <div class="install-track"><span style="width:${Number(update.progress || 0)}%"></span></div>
      <small>${update.running ? 'Update is running...' : `Last exit: ${update.exitCode ?? 'none'}`}</small>
    </div>
    ${isHost && state.user?.role === 'owner' ? `<div class="server-actions"><button class="secondary" type="button" data-action="show-host-token">Show Host API Token</button><button class="danger" type="button" data-action="regen-host-token">Regenerate Host Token</button><code>${escapeHtml(settings.hostApiTokenPreview || '')}</code></div>` : ''}
    <div class="public-help-grid">
      <article><strong>Nexus-Mark</strong><span>Original lightweight control profile: safe paths, RAM caps, CPU plan metadata, and future cgroup/systemd slicing on Linux.</span></article>
      <article><strong>Template Imports</strong><span>JSON game blueprints. Custom game servers stay isolated per server.</span></article>
      <article><strong>Updater</strong><span>Pulls panel code while protecting server data and the external backup store.</span></article>
    </div>
  `;
}

function renderTerminal() {
  if (!elements.terminalPanel) return;
  if (!state.settings?.terminalEnabled || state.user?.role !== 'owner') {
    elements.terminalPanel.innerHTML = '<p class="empty-state">No permission. Terminal is owner-only and must be enabled in Settings.</p>';
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
      <label>Input <input name="input" placeholder="systemctl status nexuspanel --no-pager" autocomplete="off"></label>
      <button type="submit">Send</button>
    </form>
  `;
  if (terminalSession.id) startTerminalPolling();
}

function appendTerminalOutput(text) {
  const output = document.querySelector('#terminalOutput');
  if (!output || !text) return;
  output.textContent = `${output.textContent}${text}`.slice(-80000);
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
  }, 650);
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
  api(`/api/servers/${server.id}/backups`).then((data) => {
    elements.backupPanel.innerHTML = `
      <div class="section-head"><div><p class="eyebrow">Backups</p><h2>${escapeHtml(server.name)}</h2></div><button type="button" data-action="manual-backup">Manual backup</button></div>
      <form class="backup-settings" id="backupSettingsForm">
        <label class="switch"><input name="scheduledBackups" type="checkbox" ${server.scheduledBackups ? 'checked' : ''}><span></span>Auto backup</label>
        <label>Every hours <input name="backupIntervalHours" type="number" min="1" max="168" value="${server.backupIntervalHours || 24}"></label>
        <label>Keep latest <input name="backupRetention" type="number" min="1" max="50" value="${server.backupRetention || 4}"></label>
        <button type="submit">Save backup settings</button>
      </form>
      <p class="muted">Stored outside the panel install by default: <code>/var/lib/nexuspanel/backups/${server.id}/</code> on Linux. Server-folder <code>backups/</code>, <code>archives/</code>, and top-level ZIPs are skipped to prevent recursive giant backups.</p>
      <div class="plugin-list">${data.backups.map((backup) => `<div class="plugin-row"><div><strong>${escapeHtml(backup.name)}</strong><div class="muted">${Math.round(backup.size / 1024)} KB</div></div><div class="row-actions"><button class="secondary" type="button" data-action="restore-backup" data-backup-path="${escapeHtml(backup.path)}">Restore</button><a class="button-link" href="/api/servers/${server.id}/backups/download?name=${encodeURIComponent(backup.name)}">Download</a><button class="danger" type="button" data-action="delete-backup" data-backup-path="${escapeHtml(backup.path)}">Delete</button></div></div>`).join('') || '<p class="empty-state">No backups yet.</p>'}</div>
    `;
  }).catch((error) => showToast(error.message));
}

async function renderOptimizer() {
  if (!can(state.permissions.MANAGE_SERVERS)) return;
  
  try {
    const optimizer = state.optimizer || await api('/api/optimizer/status').catch(() => ({}));
    elements.optimizerSummary.innerHTML = `
      <article class="optimizer-action">
        <span>Host Optimizer</span>
        <strong>${escapeHtml(optimizer.platform || 'System')}</strong>
        <button type="button" data-action="apply-optimizer">Optimize</button>
      </article>
      ${[
        'BBR/fq tuning','UDP buffers','TCP fast open','MTU probing','DNS cache plan','Low swap profile','File limits','World I/O cache','Crash backup hooks','Chunked uploads',
        'Live whitelist reload','External backups','Server RAM watcher','Player tracker','Console scroll lock','Upload resume','Upload cancel','ZIP extract','Safe updater','Theme engine',
        'Per-server plugin paths','PocketMine PHP runtime','Bedrock auto install','Software version checker','Tunnel token vault','Admin access tiers','Mobile layout','One-click EULA','Backup rotation','No Docker overhead',
        'Direct process manager','Public alias notes','Safe path sandbox','Archive downloader','Systemd service mode','Live status polling','Low-RAM SQLite','No database daemon','Packs folders','Server delete guard'
      ].map((item) => `<article><span>${escapeHtml(item)}</span><strong>Ready</strong></article>`).join('')}
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
  elements.adminPanel.hidden = !can(state.permissions.MANAGE_ADMINS);
  if (!can(state.permissions.MANAGE_ADMINS)) return;

  if (!state.users || state.users.length === 0) {
    elements.userList.innerHTML = '<p class="empty-state">No admin users yet.</p>';
    return;
  }

  elements.userList.innerHTML = '<p class="muted access-help">Access guide: 0 view, 5 start/stop/restart/kill, 20 console view, 40 send commands, 60 manage servers, 80 files/config/backups, 100 owner/admin controls.</p>' + state.users.map((user) => `
    <div class="user-row" data-user-id="${user.id}">
      <div><strong>${escapeHtml(user.name)}</strong><div class="muted">${escapeHtml(user.email)} | ${user.role} | ${accessName(user.accessLevel)}</div></div>
      <div class="user-actions"><input type="number" min="0" max="100" step="5" value="${user.accessLevel}" ${user.role === 'owner' ? 'disabled' : ''}><button class="secondary" type="button" data-action="update-user" ${user.role === 'owner' ? 'disabled' : ''}>Save</button><button class="danger" type="button" data-action="delete-user" ${user.role === 'owner' ? 'disabled' : ''}>Delete</button></div>
    </div>
  `).join('');
}

async function renderSecurity(forceHealth = false) {
  if (!can(state.permissions.MANAGE_ADMINS)) {
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
        <div><p class="eyebrow">Smart Check</p><h2>${escapeHtml(state.health?.summary || 'No check yet')}</h2></div>
        <button type="button" data-action="run-health-check">Run check now</button>
      </div>
      <p class="muted">Last checked: ${escapeHtml(state.health?.checkedAtText ? new Date(state.health.checkedAtText).toLocaleString() : 'never')}</p>
      <div class="health-grid">
        ${checks.map((check) => `<article class="${check.ok ? 'is-ok' : 'is-bad'}"><strong>${escapeHtml(check.name)}</strong><span>${escapeHtml(check.message)}</span></article>`).join('') || '<p class="empty-state">Run a health check to verify panel folders, database, software, and Java.</p>'}
      </div>
    `;
  }

  if (elements.auditPanel) {
    elements.auditPanel.innerHTML = `
      <div class="section-head"><div><p class="eyebrow">Last Checked</p><h2>Recent logins</h2></div></div>
      <div class="audit-list">
        ${state.loginEvents.map((event) => `
          <article class="audit-row">
            <div><strong>${escapeHtml(event.email)}</strong><span>${escapeHtml(event.browser)} · ${escapeHtml(event.device)}</span></div>
            <code>${escapeHtml(event.ip || 'unknown IP')}</code>
            <time>${escapeHtml(new Date(event.createdAt).toLocaleString())}</time>
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
    const server = activeServer();
    const versions = await getSoftwareVersions(key);
    select.innerHTML = versions.slice(0, 80).map((version) => `<option value="${escapeHtml(version)}" ${server && server.softwareKey === key && server.softwareVersion === version ? 'selected' : ''}>${escapeHtml(version)}</option>`).join('');
  }));
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
  const overview = await api('/api/overview');
  state.servers = overview.servers || [];
  state.plugins = overview.plugins || state.plugins;
  state.settings = overview.settings || state.settings;
  state.loginEvents = overview.loginEvents || state.loginEvents;
  state.health = overview.health || state.health;
  if (state.activeServerId && !state.servers.some((server) => server.id === state.activeServerId)) {
    state.activeServerId = state.servers[0]?.id || null;
  }
  if (!state.activeServerId && state.servers.length) state.activeServerId = state.servers[0].id;
  renderStats();
  renderServerSwitcher();
  if (state.activeView === 'dashboard') renderServers();
  if (state.activeView === 'software') renderSoftware();
}

function setView(view) {
  state.activeView = view;
  if (view === 'console') {
    consoleStickToBottom = true;
  }
  renderView();
  renderActiveView().catch((error) => showToast(error.message));
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

function startRefreshLoop() {
  window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    if (!state.user) return;
    const dueStatus = Date.now() - state.statusRefreshAt > 3500;
    if (state.activeView === 'console') {
      renderConsole().catch(() => {});
      if (!dueStatus) return;
    }
    if (dueStatus || state.servers.some((server) => server.installStatus === 'installing')) {
      state.statusRefreshAt = Date.now();
      refreshServerStatusOnly().catch(() => {});
    }
    if (state.activeView === 'files') renderUploadSessions().catch(() => {});
  }, 1500);
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
  if (server.softwareKey === 'bedrock-vanilla') {
    elements.modrinthGrid.innerHTML = '<p class="empty-state">Bedrock Dedicated Server supports resource/behavior packs, not plugins. Use PocketMine for Bedrock plugins.</p>';
    return;
  }
  const payload = formData(elements.modrinthForm);
  try {
    const source = server.softwareKey === 'pocketmine' ? 'poggit' : 'modrinth';
    const data = await api(`/api/${source}/search?serverId=${server.id}&query=${encodeURIComponent(payload.query || '')}`);
    elements.modrinthGrid.innerHTML = data.hits.map((project) => `
      <article class="modrinth-card">
        <div class="status-row">
          <strong>${escapeHtml(project.title)}</strong>
          <span class="pill">${Number(project.downloads || 0).toLocaleString()} downloads</span>
        </div>
        <p>${escapeHtml(project.description || '')}</p>
        ${project.iconUrl ? `<img class="plugin-icon" src="${escapeHtml(project.iconUrl)}" alt="">` : ''}
        <div class="install-track" hidden><span style="width:0%"></span></div>
        <button type="button"
          data-action="${source === 'poggit' ? 'install-poggit' : 'install-modrinth'}"
          data-project-id="${escapeHtml(project.projectId || '')}"
          data-project-name="${escapeHtml(project.title)}"
          data-download-url="${escapeHtml(project.downloadUrl || '')}"
          data-file-name="${escapeHtml(project.fileName || '')}">Install</button>
      </article>
    `).join('') || `<p class="empty-state">${escapeHtml(data.message || `No ${source} plugins found. Try a broader search.`)}</p>`;
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
    await api(`/api/servers/${server.id}/command`, { method: 'POST', body: JSON.stringify(payload) });
    elements.commandForm.reset();
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
      type: server.type,
      softwareKey: server.softwareKey,
      softwareVersion: server.softwareVersion,
    };
    if (state.user?.role === 'owner') payload.maxMemoryMb = Number(elements.serverConfigForm.maxMemoryMb.value);
    try {
      await api(`/api/servers/${server.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('Server settings saved. Restart to apply RAM changes.');
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
    await api(`/api/terminal/session/${encodeURIComponent(terminalSession.id)}/input`, { method: 'POST', body: JSON.stringify({ input }) });
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
  payload.backupIntervalHours = Number(payload.backupIntervalHours);
  payload.backupRetention = Number(payload.backupRetention);
  try {
    await api(`/api/servers/${server.id}/backups/settings`, { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Backup settings saved.');
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

elements.adminForm.addEventListener('input', () => {
  elements.accessOutput.value = elements.adminForm.accessLevel.value;
});

elements.adminForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = formData(elements.adminForm);
  payload.accessLevel = Number(payload.accessLevel);
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
    elements.adminForm.reset();
    elements.accessOutput.value = '40';
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

    if (action === 'forgot-password') {
      const email = prompt('Enter your NexusPanel account email:');
      if (!email) return;
      const request = await api('/api/password/forgot', { method: 'POST', body: JSON.stringify({ email }) });
      showToast(request.message || 'OTP requested.');
      const otp = prompt('Enter the 6-digit OTP:');
      if (!otp) return;
      const password = prompt('Enter your new password (8+ chars):');
      if (!password) return;
      const reset = await api('/api/password/reset', { method: 'POST', body: JSON.stringify({ email, otp, password }) });
      showToast(reset.message || 'Password reset.');
      return;
    }

    if (action === 'logout') {
      await api('/api/logout', { method: 'POST' });
      state.user = null;
      window.clearInterval(state.refreshTimer);
      await refresh();
      return;
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
      const result = await api('/api/settings/update', { method: 'POST', body: JSON.stringify({}) });
      showToast(result.message || 'Update started.');
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
      return;
    }
    if (action === 'start-server' || action === 'stop-server' || action === 'kill-server' || action === 'restart-server') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
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
      showToast('Testing panel transfer speed...');
      const downloadSize = 8 * 1024 * 1024;
      const downloadStart = performance.now();
      const downloadBuffer = await fetch(`/api/network/download-test?size=${downloadSize}`, { credentials: 'same-origin' }).then((res) => {
        if (!res.ok) throw new Error('Download speed test failed.');
        return res.arrayBuffer();
      });
      const downloadSeconds = Math.max(0.001, (performance.now() - downloadStart) / 1000);
      const uploadBuffer = new Uint8Array(4 * 1024 * 1024).fill(90);
      const uploadStart = performance.now();
      const uploadResult = await fetch('/api/network/upload-test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: uploadBuffer,
      });
      if (!uploadResult.ok) throw new Error('Upload speed test failed.');
      const uploadSeconds = Math.max(0.001, (performance.now() - uploadStart) / 1000);
      await renderNetwork({
        downloadBytesPerSec: downloadBuffer.byteLength / downloadSeconds,
        uploadBytesPerSec: uploadBuffer.byteLength / uploadSeconds,
      });
      showToast('Network speed updated.');
      actionTarget.disabled = false;
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
    if (action === 'run-health-check') {
      showToast('Running panel health check...');
      await renderSecurity(true);
      showToast('Health check complete.');
      return;
    }
    if (action === 'delete-server') {
      const server = activeServer();
      if (!server) return;
      if (!confirm(`Delete server "${server.name}" and all its files? This cannot be undone.`)) return;
      await api(`/api/servers/${server.id}`, { method: 'DELETE' });
      showToast('Server deleted.');
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
      if (server.status === 'online') return showToast('Stop the server before restoring a backup.');
      if (!backupPath || !confirm(`Restore ${backupPath.split('/').pop()}? This deletes current server files except software/runtime, then unzips the backup.`)) return;
      showToast('Restoring backup...');
      await api(`/api/servers/${server.id}/backups/restore`, {
        method: 'POST',
        body: JSON.stringify({ name: backupPath }),
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
      fileClipboard = { mode: action === 'file-copy-selected' ? 'copy' : 'move', paths: selected };
      showToast(`${fileClipboard.mode === 'copy' ? 'Copied' : 'Cut'} ${selected.length} item(s).`);
      return;
    }
    if (action === 'file-paste') {
      const server = activeServer();
      if (!server) return showToast('Create a server first.');
      if (!fileClipboard.paths.length) return showToast('Nothing copied or cut.');
      await api(`/api/servers/${server.id}/files/${fileClipboard.mode === 'move' ? 'move' : 'copy'}`, {
        method: 'POST',
        body: JSON.stringify({ paths: fileClipboard.paths, destination: filePath }),
      });
      showToast(`${fileClipboard.mode === 'move' ? 'Moved' : 'Copied'} ${fileClipboard.paths.length} item(s).`);
      if (fileClipboard.mode === 'move') fileClipboard = { mode: '', paths: [] };
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
      await api(`/api/users/${row.dataset.userId}`, { method: 'PATCH', body: JSON.stringify({ accessLevel: Number(row.querySelector('input').value) }) });
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
enableDeveloperModeGuard();

refresh().then(startRefreshLoop).catch((error) => {
  showToast(error.message);
  console.error('Initial load error:', error);
});
