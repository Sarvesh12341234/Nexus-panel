'use strict';

/**
 * NexusPanel live widgets.
 *
 * These live in an external file so the panel can keep a strict
 * `script-src 'self'` Content-Security-Policy. Every value coming from the
 * API is inserted with textContent, never with innerHTML.
 */
(function () {
  const activityRoot = document.getElementById('nx-autonomy-events');
  const graphBox = document.getElementById('nexus-neural-graph');
  const graphCanvas = document.getElementById('nexus-neural-canvas');
  const POLL_MS = 2000;
  let activityTimer = 0;
  let graphTimer = 0;
  let graphFrame = 0;
  let graphState = { nodes: [], edges: [], events: [] };
  const repairPulses = [];

  function safeText(value) {
    return String(value ?? '');
  }

  function renderActivity(events) {
    if (!activityRoot) return;
    const rows = Array.isArray(events) ? events.slice(-8).reverse() : [];
    if (!rows.length) {
      activityRoot.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'nx-autonomy-empty';
      empty.textContent = 'No autonomous activity recorded yet.';
      activityRoot.append(empty);
      return;
    }
    const nodes = rows.map((event) => {
      const row = document.createElement('div');
      row.className = 'a';
      row.setAttribute('role', 'listitem');
      const time = document.createElement('b');
      const stamp = Number(event?.ts) || Number(event?.createdAt) || 0;
      time.textContent = stamp ? new Date(stamp).toLocaleTimeString() : '';
      row.append(
        time,
        document.createTextNode(` · ${safeText(event?.kind || event?.category || 'event')}${event?.message ? ` — ${safeText(event.message)}` : ''}`),
      );
      return row;
    });
    activityRoot.replaceChildren(...nodes);
  }

  async function pullActivity() {
    if (!activityRoot) return;
    try {
      const response = await fetch('/api/advanced/autonomy/activity', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      renderActivity(payload.events);
    } catch {
      // Live widgets must never interrupt panel interaction.
    }
  }

  function graphPoint(index, total, width, height) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
    const radius = Math.min(width, height) * .34;
    return {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    };
  }

  function resizeGraph() {
    if (!graphBox || !graphCanvas) return;
    const rect = graphBox.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    graphCanvas.width = Math.max(1, Math.round(rect.width * ratio));
    graphCanvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = graphCanvas.getContext('2d');
    if (context) context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function drawGraph(timestamp) {
    if (!graphBox || !graphCanvas) return;
    if (!graphVisible() || document.hidden) {
      graphFrame = 0;
      return;
    }
    const context = graphCanvas.getContext('2d');
    if (!context) return;
    const width = graphBox.clientWidth;
    const height = graphBox.clientHeight;
    context.clearRect(0, 0, width, height);
    const points = new Map();
    const total = Math.max(1, graphState.nodes.length);
    graphState.nodes.forEach((node, index) => {
      points.set(node.id, graphPoint(index, total, width, height));
    });
    context.lineWidth = 1;
    graphState.edges.forEach((edge) => {
      const from = points.get(edge.from);
      const to = points.get(edge.to);
      if (!from || !to) return;
      const glow = Math.max(.08, Math.min(1, edge.activity || 0));
      context.globalAlpha = .18 + glow * .5;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      if (glow > .12) {
        const speed = 0.00008 + glow * 0.00025;
        const position = (timestamp * speed) % 1;
        const x = from.x + (to.x - from.x) * position;
        const y = from.y + (to.y - from.y) * position;
        context.globalAlpha = .8;
        context.beginPath();
        context.arc(x, y, 2.2 + glow * 2, 0, Math.PI * 2);
        context.fill();
      }
    });
    graphState.nodes.forEach((node, index) => {
      const point = points.get(node.id);
      if (!point) return;
      const pulse = 1 + 0.12 * Math.sin(timestamp * .004 + index);
      context.globalAlpha = .9;
      context.beginPath();
      context.arc(point.x, point.y, 6 * pulse, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = .8;
      context.font = '11px system-ui';
      context.fillText(node.label || node.id, point.x + 10, point.y + 4);
    });
    drawRepairOverlay(context, timestamp, width, height);
    graphFrame = window.requestAnimationFrame(drawGraph);
  }

  function drawRepairOverlay(context, timestamp, width, height) {
    if (!graphBox.classList.contains('active')) return;
    context.save();
    context.font = '11px system-ui';
    let y = height - 18;
    const recent = repairPulses.filter((pulse) => timestamp - pulse.t < 4500).slice(-5);
    recent.forEach((pulse, index) => {
      const alpha = Math.max(0, 1 - (timestamp - pulse.t) / 4500);
      context.globalAlpha = alpha * .9;
      const phase = safeText(pulse.type).replace(/^repair\./, '');
      context.fillText(`● AI ${phase} → ${safeText(pulse.to || 'target')}`, 18, y - index * 17);
    });
    context.restore();
  }

  async function pullGraph() {
    if (!graphBox) return;
    try {
      const response = await fetch('/api/advanced/neural-graph', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      graphState = {
        nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
        edges: Array.isArray(payload.edges) ? payload.edges : [],
        events: Array.isArray(payload.events) ? payload.events : [],
      };
      for (const event of graphState.events) {
        if (/^repair\./.test(safeText(event?.type))) {
          repairPulses.push({ ...event, t: performance.now() });
        }
      }
      while (repairPulses.length > 80) repairPulses.shift();
    } catch {
      // Live widgets must never interrupt panel interaction.
    }
  }

  function graphVisible() {
    if (!graphBox) return false;
    const section = graphBox.closest('.view-section');
    return graphBox.classList.contains('active') && (!section || !section.hidden);
  }

  function syncGraphVisibility() {
    if (!graphBox) return;
    const toggle = document.querySelector('[data-nexus-neural-graph-toggle]');
    if (toggle && !toggle.dataset.initialized) {
      toggle.checked = localStorage.getItem('nexusNeuralGraph') === '1';
      toggle.dataset.initialized = '1';
    }
    graphBox.classList.toggle('active', Boolean(toggle?.checked));
    if (graphBox.classList.contains('active')) {
      resizeGraph();
      if (!graphFrame) graphFrame = window.requestAnimationFrame(drawGraph);
    } else if (graphFrame) {
      window.cancelAnimationFrame(graphFrame);
      graphFrame = 0;
    }
  }

  function startTimers() {
    window.clearInterval(activityTimer);
    window.clearInterval(graphTimer);
    activityTimer = window.setInterval(() => {
      if (document.hidden) return;
      const section = activityRoot?.closest('.view-section');
      if (section && section.hidden) return;
      void pullActivity();
    }, POLL_MS);
    graphTimer = window.setInterval(() => {
      if (document.hidden || !graphVisible()) return;
      void pullGraph();
    }, POLL_MS);
  }

  document.addEventListener('change', (event) => {
    if (!event.target?.matches?.('[data-nexus-neural-graph-toggle]')) return;
    localStorage.setItem('nexusNeuralGraph', event.target.checked ? '1' : '0');
    syncGraphVisibility();
  });
  window.addEventListener('resize', () => {
    if (graphVisible()) resizeGraph();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (graphFrame) window.cancelAnimationFrame(graphFrame);
      graphFrame = 0;
    } else if (graphVisible() && !graphFrame) {
      graphFrame = window.requestAnimationFrame(drawGraph);
    }
  });

  // Deliberately quiet helper: no toast, modal, overlay, or notification.
  window.Nexus5QuietStatus = function (element, status) {
    if (!element) return;
    element.classList.add('nx5-status-dot');
    element.dataset.state = status || 'idle';
  };

  syncGraphVisibility();
  resizeGraph();
  void pullActivity();
  void pullGraph();
  startTimers();
})();
