// ============= SETTINGS MANAGER =============

class SettingsManager {
  constructor() {
    this.currentServerId = null;
    this.timezoneSelect = null;
    this.backupHoursInput = null;
    this.backupMinutesInput = null;
    this.backupDisplay = null;
  }

  async init() {
    await this.loadSettings();
    this.setupEventListeners();
  }

  async loadSettings() {
    try {
      const timezoneResponse = await fetch('/api/user/timezone', {
        credentials: 'include'
      });
      const timezoneData = await timezoneResponse.json();
      
      const timezonesResponse = await fetch('/api/timezones', {
        credentials: 'include'
      });
      const timezonesData = await timezonesResponse.json();
      
      this.renderSettings(timezoneData.timezone, timezonesData.timezones);
      
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.renderSettings('UTC', []);
    }
  }

  renderSettings(currentTimezone, availableTimezones) {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;

    panel.innerHTML = `
      <div class="settings-container">
        <div class="section-head">
          <div>
            <p class="eyebrow">Settings</p>
            <h2>Panel Configuration</h2>
          </div>
        </div>

        <!-- TIMEZONE SETTINGS -->
        <div class="settings-group">
          <h3>🌐 Timezone Settings</h3>
          <p class="help-text">Set your preferred timezone for all date displays in the panel.</p>
          
          <div class="setting-row">
            <label for="userTimezoneSelect">Your Timezone:</label>
            <div class="setting-input-group">
              <select id="userTimezoneSelect" class="timezone-select">
                ${this.renderTimezoneOptions(availableTimezones, currentTimezone)}
              </select>
              <button id="saveTimezoneBtn" class="btn btn-primary">Save Timezone</button>
              <span id="timezoneStatus" class="status-message"></span>
            </div>
          </div>
          <div class="setting-row">
            <span class="current-setting">Current: <strong id="currentTimezoneDisplay">${currentTimezone}</strong></span>
          </div>
        </div>

        <!-- BACKUP SETTINGS -->
        <div class="settings-group">
          <h3>💾 Backup Settings</h3>
          <p class="help-text">Configure automatic backup intervals for your servers.</p>
          
          <div class="setting-row">
            <label for="backupIntervalHours">Backup Interval:</label>
            <div class="setting-input-group">
              <input type="number" id="backupIntervalHours" min="0" max="168" value="24" class="interval-input" style="width: 80px;">
              <span class="interval-label">hours</span>
              <input type="number" id="backupIntervalMinutes" min="0" max="59" value="0" class="interval-input" style="width: 80px;">
              <span class="interval-label">minutes</span>
              <span id="backupIntervalDisplay" class="interval-display" style="margin-left: 10px; font-weight: bold;"></span>
            </div>
            <small class="help-text">Set to 0 hours and 0 minutes to disable automatic backups (minimum 1 hour)</small>
          </div>

          <div class="setting-row">
            <label for="backupRetention">Backup Retention:</label>
            <div class="setting-input-group">
              <input type="number" id="backupRetention" min="1" max="30" value="4" style="width: 80px;">
              <span class="interval-label">backups to keep</span>
            </div>
          </div>

          <div class="setting-row">
            <label class="switch-label">
              <input type="checkbox" id="scheduledBackups" checked>
              <span>Enable scheduled backups</span>
            </label>
          </div>

          <div class="setting-row">
            <button id="saveBackupSettingsBtn" class="btn btn-primary">Save Backup Settings</button>
            <span id="backupStatus" class="status-message"></span>
          </div>
        </div>

        <!-- SERVER SELECTION -->
        <div class="settings-group">
          <h3>🎯 Apply to Server</h3>
          <div class="setting-row">
            <label for="settingsServerSelect">Apply settings to:</label>
            <select id="settingsServerSelect">
              <option value="">Select a server...</option>
            </select>
          </div>
        </div>
      </div>
    `;

    this.timezoneSelect = document.getElementById('userTimezoneSelect');
    this.backupHoursInput = document.getElementById('backupIntervalHours');
    this.backupMinutesInput = document.getElementById('backupIntervalMinutes');
    this.backupDisplay = document.getElementById('backupIntervalDisplay');
    
    this.loadServerList();
    this.setupSettingsEventListeners();
    this.updateBackupDisplay();
  }

  renderTimezoneOptions(timezones, current) {
    if (!timezones || timezones.length === 0) {
      return `<option value="UTC">UTC</option>`;
    }
    
    const grouped = {};
    timezones.forEach(tz => {
      const region = tz.split('/')[0];
      if (!grouped[region]) grouped[region] = [];
      grouped[region].push(tz);
    });
    
    let html = '';
    const regions = Object.keys(grouped).sort();
    regions.forEach(region => {
      html += `<optgroup label="${region}">`;
      grouped[region].sort().forEach(tz => {
        const selected = tz === current ? 'selected' : '';
        html += `<option value="${tz}" ${selected}>${tz}</option>`;
      });
      html += `</optgroup>`;
    });
    
    return html;
  }

  async loadServerList() {
    try {
      const response = await fetch('/api/servers', {
        credentials: 'include'
      });
      const data = await response.json();
      const servers = data.servers || [];
      
      const select = document.getElementById('settingsServerSelect');
      if (!select) return;
      
      select.innerHTML = '<option value="">Select a server...</option>';
      
      if (servers.length > 0) {
        servers.forEach(server => {
          const option = document.createElement('option');
          option.value = server.id;
          option.textContent = `${server.name} (ID: ${server.id})`;
          select.appendChild(option);
        });
        
        this.currentServerId = servers[0].id;
        this.loadServerSettings(servers[0].id);
      }
      
      select.addEventListener('change', (e) => {
        if (e.target.value) {
          this.currentServerId = parseInt(e.target.value);
          this.loadServerSettings(this.currentServerId);
        }
      });
      
    } catch (error) {
      console.error('Failed to load servers:', error);
    }
  }

  async loadServerSettings(serverId) {
    try {
      const response = await fetch(`/api/servers/${serverId}`, {
        credentials: 'include'
      });
      const server = await response.json();
      
      if (this.backupHoursInput) {
        this.backupHoursInput.value = server.backup_interval_hours || 24;
      }
      if (this.backupMinutesInput) {
        this.backupMinutesInput.value = server.backup_interval_minutes || 0;
      }
      if (document.getElementById('backupRetention')) {
        document.getElementById('backupRetention').value = server.backup_retention || 4;
      }
      if (document.getElementById('scheduledBackups')) {
        document.getElementById('scheduledBackups').checked = server.scheduled_backups === 1;
      }
      
      this.updateBackupDisplay();
      
    } catch (error) {
      console.error('Failed to load server settings:', error);
    }
  }

  updateBackupDisplay() {
    const hours = parseInt(this.backupHoursInput?.value) || 0;
    const minutes = parseInt(this.backupMinutesInput?.value) || 0;
    
    if (this.backupDisplay) {
      if (hours === 0 && minutes === 0) {
        this.backupDisplay.textContent = 'Disabled';
        this.backupDisplay.style.color = '#999';
      } else if (hours === 0) {
        this.backupDisplay.textContent = `${minutes} minute${minutes > 1 ? 's' : ''}`;
        this.backupDisplay.style.color = '#4CAF50';
      } else if (minutes === 0) {
        this.backupDisplay.textContent = `${hours} hour${hours > 1 ? 's' : ''}`;
        this.backupDisplay.style.color = '#4CAF50';
      } else {
        this.backupDisplay.textContent = `${hours}h ${minutes}m`;
        this.backupDisplay.style.color = '#4CAF50';
      }
    }
  }

  setupSettingsEventListeners() {
    if (this.backupHoursInput) {
      this.backupHoursInput.addEventListener('input', () => this.updateBackupDisplay());
    }
    if (this.backupMinutesInput) {
      this.backupMinutesInput.addEventListener('input', () => this.updateBackupDisplay());
    }
    
    const saveTimezoneBtn = document.getElementById('saveTimezoneBtn');
    if (saveTimezoneBtn) {
      saveTimezoneBtn.addEventListener('click', () => this.saveTimezone());
    }
    
    const saveBackupBtn = document.getElementById('saveBackupSettingsBtn');
    if (saveBackupBtn) {
      saveBackupBtn.addEventListener('click', () => this.saveBackupSettings());
    }
  }

  async saveTimezone() {
    const select = document.getElementById('userTimezoneSelect');
    const status = document.getElementById('timezoneStatus');
    
    if (!select || !select.value) {
      this.showStatus(status, 'Please select a timezone', 'error');
      return;
    }
    
    try {
      const response = await fetch('/api/user/timezone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ timezone: select.value })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        this.showStatus(status, `✅ Timezone set to ${select.value}`, 'success');
        document.getElementById('currentTimezoneDisplay').textContent = select.value;
      } else {
        this.showStatus(status, `❌ Error: ${data.error}`, 'error');
      }
    } catch (error) {
      this.showStatus(status, `❌ Error: ${error.message}`, 'error');
    }
  }

  async saveBackupSettings() {
    if (!this.currentServerId) {
      const status = document.getElementById('backupStatus');
      this.showStatus(status, 'Please select a server first', 'error');
      return;
    }
    
    const hours = parseInt(this.backupHoursInput?.value) || 0;
    const minutes = parseInt(this.backupMinutesInput?.value) || 0;
    const retention = parseInt(document.getElementById('backupRetention')?.value) || 4;
    const scheduled = document.getElementById('scheduledBackups')?.checked ? 1 : 0;
    
    if (hours < 0 || hours > 168) {
      alert('Hours must be between 0 and 168');
      return;
    }
    if (minutes < 0 || minutes > 59) {
      alert('Minutes must be between 0 and 59');
      return;
    }
    
    const status = document.getElementById('backupStatus');
    
    try {
      const response = await fetch(`/api/servers/${this.currentServerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          backup_interval_hours: hours,
          backup_interval_minutes: minutes,
          backup_retention: retention,
          scheduled_backups: scheduled
        })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        this.showStatus(status, '✅ Backup settings saved successfully!', 'success');
        this.updateBackupDisplay();
      } else {
        this.showStatus(status, `❌ Error: ${data.error}`, 'error');
      }
    } catch (error) {
      this.showStatus(status, `❌ Error: ${error.message}`, 'error');
    }
  }

  showStatus(element, message, type) {
    if (!element) return;
    element.textContent = message;
    element.className = `status-message ${type}`;
    element.style.display = 'block';
    
    clearTimeout(this.statusTimeout);
    this.statusTimeout = setTimeout(() => {
      element.style.display = 'none';
    }, 5000);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const settingsPanel = document.getElementById('settingsPanel');
  if (settingsPanel) {
    const settingsManager = new SettingsManager();
    settingsManager.init();
    window.settingsManager = settingsManager;
  }
});