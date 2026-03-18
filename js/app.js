/**
 * app.js — Initialisation and wiring.
 *
 * Instantiates all modules, connects their events, and sets up
 * the draggable resize dividers.
 */

(function () {
  'use strict';

  // ── Module instances ───────────────────────────────────────────────────────

  const endpoint = new EndpointManager();

  const editor = new QueryEditor({
    onRun:  runQuery,
    onStop: stopQuery,
  });

  const results = new ResultsView();

  const mapView = new MapView();

  const views = new ViewsManager({
    onOpen: (view) => {
      editor.setQuery(view.query);
      logMessage(`Opened saved query: "${view.name}"`, 'info');
    },
  });

  // Caches the last schema result so toolbar buttons re-render without re-querying.
  const schemaCtx = { sampleResult: null, mermaidSrc: null, label: null };

  const schema = new SchemaManager({
    treeEl:       document.getElementById('schema-tree'),
    onQuery:      runSilentQuery,
    onSampleType: (sparql, label) => {
      schemaCtx.sampleResult = null; // cleared until the query completes
      schemaCtx.mermaidSrc   = null;
      schemaCtx.label        = label;
      runSchemaPreview(sparql, label);
    },
    onConnections: (mermaidSrc, label, errMsg) => {
      schemaCtx.mermaidSrc = mermaidSrc;
      schemaCtx.label      = label;
      runSchemaConnections(mermaidSrc, label, errMsg);
    },
  });

  // ── Restore last endpoint URL ──────────────────────────────────────────────

  const savedUrl = Storage.get('endpoint_url', '');
  if (savedUrl) {
    document.getElementById('endpoint-url').value = savedUrl;
  }

  // ── Endpoint bar ───────────────────────────────────────────────────────────

  const urlInput      = document.getElementById('endpoint-url');
  const btnConnect    = document.getElementById('btn-connect');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const connDot       = document.getElementById('connection-dot');

  btnConnect.addEventListener('click', () => connectEndpoint());

  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') connectEndpoint();
  });

  btnDisconnect.addEventListener('click', () => {
    endpoint.disconnect();
  });

  async function connectEndpoint() {
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); return; }

    btnConnect.disabled = true;
    btnConnect.textContent = 'Connecting…';
    setConnectionUI('connecting');

    const { ok, error } = await endpoint.connect(url);

    btnConnect.disabled   = false;
    btnConnect.textContent = 'Connect';

    if (ok) {
      setConnectionUI('connected');
      updateSidebarEndpoint(url, true);
      editor.enable();
      logMessage(`Connected to ${url}`, 'success');
      schema.load();
    } else {
      setConnectionUI('error');
      logMessage(`Connection failed: ${error}`, 'error');
      editor.disable();
    }
  }

  endpoint.on('statusChange', status => {
    setConnectionUI(status);
    if (status === 'disconnected') {
      editor.disable();
      updateSidebarEndpoint('', false);
      schema.clear();
      logMessage('Disconnected', 'info');
    }
  });

  function setConnectionUI(status) {
    connDot.className = `connection-dot ${status}`;
    connDot.title     = status.charAt(0).toUpperCase() + status.slice(1);

    const connected = status === 'connected';
    btnConnect.classList.toggle('hidden', connected);
    btnDisconnect.classList.toggle('hidden', !connected);
  }

  // ── Stop query ─────────────────────────────────────────────────────────────

  function stopQuery() {
    endpoint.abort();
    editor.setRunning(false);
    editor.setStatus('Query stopped', '');
    logMessage('Query stopped by user', 'warn');
  }

  // ── Schema queries ─────────────────────────────────────────────────────────

  /**
   * Run a SPARQL query silently (no results-pane side-effects).
   * Used by SchemaManager for types and properties queries.
   */
  async function runSilentQuery(sparql) {
    const { data } = await endpoint.queryDirect(sparql);
    return data;
  }

  /**
   * Run a schema sample query and render the result in the results pane,
   * exactly like a regular query — but without touching the editor.
   */
  async function runSchemaPreview(sparql, typeLabel) {
    results.clear();
    document.getElementById('tab-btn-map').classList.add('hidden');
    logMessage(`Schema preview: ${typeLabel}`, 'info');

    const t0 = performance.now();
    try {
      const { data, contentType, raw } = await endpoint.query(sparql);
      const ms = Math.round(performance.now() - t0);
      schemaCtx.sampleResult = { data, contentType, raw, ms };
      _renderSchemaProperties();
      logMessage(`Schema preview completed in ${ms} ms`, 'success');
    } catch (err) {
      if (err.name === 'AbortError') return;
      results.renderError(err.message);
      setResultsTab('messages');
      logMessage(`Schema preview error: ${err.message}`, 'error');
    }
  }

  /** Re-render the cached schema sample result (no network request). */
  function _renderSchemaProperties() {
    const { data, contentType, raw, ms } = schemaCtx.sampleResult;
    results.clear();
    document.getElementById('tab-btn-map').classList.add('hidden');
    results.render(data, ms, {}, 0, contentType, raw);
    results.setToolbarMode('none');
    setSchemaToolbar('properties');
    setResultsTab('results');
  }

  /**
   * Render a cached Mermaid connections diagram in the results pane.
   */
  async function runSchemaConnections(mermaidSrc, label, errMsg) {
    results.clear();
    hideSchemaToolbar();
    document.getElementById('tab-btn-map').classList.add('hidden');
    setResultsTab('results');
    logMessage(`Connections: ${label}`, 'info');

    const t0 = performance.now();
    if (errMsg) {
      results.renderError(errMsg);
      logMessage(`Connections error: ${errMsg}`, 'error');
      return;
    }
    await results.renderMermaid(mermaidSrc, Math.round(performance.now() - t0));
    setSchemaToolbar('connections');
    logMessage(`Connections graph rendered for ${label}`, 'success');
  }

  function setSchemaToolbar(active) {
    document.getElementById('btn-schema-properties').classList.remove('hidden');
    document.getElementById('btn-schema-connections').classList.remove('hidden');
    document.getElementById('btn-schema-properties')
      .classList.toggle('btn-schema-active', active === 'properties');
    document.getElementById('btn-schema-connections')
      .classList.toggle('btn-schema-active', active === 'connections');
  }

  function hideSchemaToolbar() {
    document.getElementById('btn-schema-properties').classList.add('hidden');
    document.getElementById('btn-schema-connections').classList.add('hidden');
  }

  // ── Query execution ────────────────────────────────────────────────────────

  // Extract PREFIX declarations from a SPARQL query string.
  // Returns { namespaceUri: 'prefix:' } — same shape as ResultsView's builtins.
  function extractPrefixes(sparql) {
    const prefixes = {};
    const re = /\bPREFIX\s+(\w*)\s*:\s*<([^>]+)>/gi;
    let m;
    while ((m = re.exec(sparql)) !== null) {
      prefixes[m[2]] = m[1] + ':';
    }
    return prefixes;
  }

  async function runQuery() {
    const query = editor.getQuery().trim();
    if (!query) return;

    if (!endpoint.isConnected()) {
      editor.setStatus('Not connected — please connect to an endpoint first', 'error');
      return;
    }

    editor.setRunning(true);
    editor.setStatus('Running…', 'running');
    results.clear();
    hideSchemaToolbar();
    document.getElementById('tab-btn-map').classList.add('hidden');
    logMessage(`Running query on ${endpoint.getUrl()}`, 'info');

    const t0 = performance.now();

    try {
      const { data, contentType, raw } = await endpoint.query(query);
      const ms       = Math.round(performance.now() - t0);
      const prefixes = extractPrefixes(query);

      const limitEl  = document.getElementById('row-limit');
      const limitVal = limitEl ? limitEl.value : '1000';
      const limit    = limitVal === '' ? 0 : parseInt(limitVal, 10);

      results.render(data, ms, prefixes, limit, contentType, raw);
      editor.setStatus(statusSummary(data, ms, contentType), 'success');
      editor.newCellIfNeeded();
      logMessage(`Query completed in ${ms} ms`, 'success');
      logMessage(`Content-Type: ${contentType || 'unknown'}`, 'info');

      // Show/hide map tab based on geometry presence
      const geomInfo = results.getGeomInfo();
      const mapTab   = document.getElementById('tab-btn-map');
      if (geomInfo) {
        mapTab.classList.remove('hidden');
      } else {
        mapTab.classList.add('hidden');
        // If map tab was active, switch back to results
        if (mapTab.getAttribute('aria-selected') === 'true') setResultsTab('results');
      }

      // Switch to results tab
      setResultsTab('results');
    } catch (err) {
      if (err.name === 'AbortError') return; // stopped by user

      const ms = Math.round(performance.now() - t0);
      results.renderError(err.message);
      editor.setStatus('Query failed', 'error');
      logMessage(`Error: ${err.message}`, 'error');

      setResultsTab('messages');
    } finally {
      editor.setRunning(false);
    }
  }

  function statusSummary(data, ms, contentType) {
    if (typeof data !== 'object' || data === null) {
      // RDF text result (Turtle, N-Triples, etc.)
      return `RDF — ${formatMs(ms)}`;
    }
    if (typeof data.boolean === 'boolean') return `ASK → ${data.boolean} — ${formatMs(ms)}`;
    if (data.results?.bindings) {
      const n = data.results.bindings.length;
      return `${n.toLocaleString()} row${n !== 1 ? 's' : ''} — ${formatMs(ms)}`;
    }
    return formatMs(ms);
  }

  function formatMs(ms) {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
  }

  // ── Row-limit selector ─────────────────────────────────────────────────────

  document.getElementById('btn-schema-properties').addEventListener('click', () => {
    if (schemaCtx.sampleResult) _renderSchemaProperties();
  });

  document.getElementById('btn-schema-connections').addEventListener('click', () => {
    if (schemaCtx.mermaidSrc) runSchemaConnections(schemaCtx.mermaidSrc, schemaCtx.label);
  });

  document.getElementById('row-limit').addEventListener('change', function () {
    const limit = this.value === '' ? 0 : parseInt(this.value, 10);
    results.rerender(limit);
  });

  document.getElementById('rdf-format').addEventListener('change', function () {
    results.rerenderRdf(this.value);
  });

  // ── Results tabs ───────────────────────────────────────────────────────────

  document.querySelectorAll('.results-tab').forEach(tab => {
    tab.addEventListener('click', () => setResultsTab(tab.dataset.tab));
  });

  function setResultsTab(tabName) {
    document.querySelectorAll('.results-tab').forEach(t => {
      const active = t.dataset.tab === tabName;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
      const active = p.id === 'tab-' + tabName;
      p.classList.toggle('active', active);
      p.hidden = !active;
    });
    if (tabName === 'map') {
      const geomInfo = results.getGeomInfo();
      if (geomInfo) mapView.render(geomInfo.vars, geomInfo.bindings, geomInfo.geomCols);
      setTimeout(() => mapView.invalidateSize(), 50);
    }
  }

  // ── Messages log ───────────────────────────────────────────────────────────

  function logMessage(text, level = 'info') {
    const log   = document.getElementById('messages-log');
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.innerHTML = `
      <span class="log-time">${new Date().toLocaleTimeString()}</span>
      <span class="log-body">${escapeHtml(text)}</span>`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Sidebar: endpoint display ──────────────────────────────────────────────

  function updateSidebarEndpoint(url, connected) {
    const list = document.getElementById('endpoint-list');
    if (!url) {
      list.innerHTML = '<div class="sidebar-empty">No endpoint connected.</div>';
      return;
    }
    const display = url.length > 36 ? '…' + url.slice(-34) : url;
    list.innerHTML = `
      <div class="endpoint-item ${connected ? 'connected' : ''}">
        <span class="ep-dot"></span>
        <span class="ep-url" title="${escapeHtml(url)}">${escapeHtml(display)}</span>
      </div>`;
  }

  // ── Sidebar: section toggles ───────────────────────────────────────────────

  document.querySelectorAll('.tree-section-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const section   = btn.closest('.tree-section');
      const body      = section.querySelector('.tree-section-body');
      const chevron   = btn.querySelector('.chevron');
      const expanded  = btn.getAttribute('aria-expanded') === 'true';

      btn.setAttribute('aria-expanded', !expanded);
      body.classList.toggle('collapsed', expanded);
      chevron.textContent = expanded ? '▸' : '▾';
    });
  });

  // ── Save view ──────────────────────────────────────────────────────────────

  document.addEventListener('views:save-requested', () => {
    const query = editor.getQuery().trim();
    if (!query) {
      editor.setStatus('Nothing to save — write a query first', 'error');
      return;
    }
    views.showSaveModal(query, endpoint.getUrl());
  });

  // ── Draggable dividers ─────────────────────────────────────────────────────

  initDividers();

  function initDividers() {
    // Horizontal divider: resize sidebar width
    makeDraggable({
      handle:   document.getElementById('divider-h'),
      axis:     'x',
      getCurrent: () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 260,
      getMin:   () => 160,
      getMax:   () => Math.floor(window.innerWidth * 0.5),
      onDrag: (px) => {
        document.documentElement.style.setProperty('--sidebar-w', px + 'px');
      },
      onDone: (px) => {
        Storage.set('sidebar_w', px);
      },
    });

    // Vertical divider: resize editor height
    makeDraggable({
      handle:   document.getElementById('divider-v'),
      axis:     'y',
      getCurrent: () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--editor-h')) || 320,
      getMin:   () => 80,
      getMax:   () => {
        const main = document.getElementById('main');
        return main.clientHeight - 100;
      },
      onDrag: (px) => {
        document.documentElement.style.setProperty('--editor-h', px + 'px');
      },
      onDone: (px) => {
        Storage.set('editor_h', px);
      },
    });

    // Restore saved sizes
    const sw = Storage.get('sidebar_w');
    const eh = Storage.get('editor_h');
    if (sw) document.documentElement.style.setProperty('--sidebar-w', sw + 'px');
    if (eh) document.documentElement.style.setProperty('--editor-h', eh + 'px');
  }

  function makeDraggable({ handle, axis, getCurrent, getMin, getMax, onDrag, onDone }) {
    let startPos  = 0;
    let startSize = 0;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      startPos  = axis === 'x' ? e.clientX : e.clientY;
      startSize = getCurrent();
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor     = axis === 'x' ? 'col-resize' : 'row-resize';

      function onMove(e) {
        const delta = (axis === 'x' ? e.clientX : e.clientY) - startPos;
        const size  = Math.min(getMax(), Math.max(getMin(), startSize + delta));
        onDrag(size);
      }

      function onUp(e) {
        const delta = (axis === 'x' ? e.clientX : e.clientY) - startPos;
        const size  = Math.min(getMax(), Math.max(getMin(), startSize + delta));
        onDone(size);
        handle.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor     = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup',   onUp);
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',   onUp);
    });
  }

  // ── Theme toggle ──────────────────────────────────────────────────────────

  const btnTheme = document.getElementById('btn-theme-toggle');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    btnTheme.textContent = theme === 'dark' ? '☀' : '☾';
    btnTheme.title       = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    Storage.set('grouse_theme', theme);

    // Keep browser chrome colour in sync with the sidebar background.
    const colour = theme === 'dark' ? '#222222' : '#f7f7f7';
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
      m.setAttribute('content', colour);
    });
  }

  btnTheme.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  // Sync button label with the theme already set by the <head> script
  (function syncThemeButton() {
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    btnTheme.textContent = theme === 'dark' ? '☀' : '☾';
    btnTheme.title       = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  })();

  // ── Expand endpoints section by default ───────────────────────────────────

  const endpointsHeader = document.querySelector('[data-section="endpoints"]');
  if (endpointsHeader) {
    const body    = document.getElementById('body-endpoints');
    const chevron = endpointsHeader.querySelector('.chevron');
    endpointsHeader.setAttribute('aria-expanded', 'true');
    body.classList.remove('collapsed');
    chevron.textContent = '▾';
  }

})();
