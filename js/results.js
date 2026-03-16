/**
 * results.js — Renders SPARQL query results.
 *
 * Handles:
 *   SELECT  → tabular results (application/sparql-results+json)
 *   ASK     → boolean result
 *   CONSTRUCT/DESCRIBE → raw text (Turtle etc.)
 *   Errors  → error message display
 */

// Well-known prefix map: namespace URI → display prefix.
// Defined once at module level so it isn't rebuilt on every _shortenUri call.
const BUILTIN_PREFIXES = {
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf:',
  'http://www.w3.org/2000/01/rdf-schema#':        'rdfs:',
  'http://www.w3.org/2002/07/owl#':               'owl:',
  'http://www.w3.org/2001/XMLSchema#':            'xsd:',
  'http://schema.org/':                           'schema:',
  'http://xmlns.com/foaf/0.1/':                   'foaf:',
  'http://purl.org/dc/terms/':                    'dcterms:',
  'http://purl.org/dc/elements/1.1/':             'dc:',
  'http://www.w3.org/2004/02/skos/core#':         'skos:',
  'https://schema.org/':                          'schema:',
  'http://www.wikidata.org/entity/':              'wd:',
  'http://www.wikidata.org/prop/direct/':         'wdt:',
  'http://www.w3.org/ns/prov#':                   'prov:',
};

class ResultsView {
  constructor() {
    this._tabResults    = document.getElementById('tab-results');
    this._btnExport     = document.getElementById('btn-export-csv');
    this._lastResults   = null;   // { vars, bindings } — full set, for CSV and rerender
    this._lastMs        = null;   // query duration, kept for rerender
    this._queryPrefixes = {};     // populated from PREFIX declarations at render time
    this._lastGeomInfo  = null;   // { vars, bindings, geomCols } when WKT found

    this._btnExport.addEventListener('click', () => this.exportCSV());
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Render a successful query result.
   * @param {object|string} data  Parsed JSON or raw text string.
   * @param {number}        ms    Query duration in milliseconds.
   */
  /**
   * @param {object|string} data     Parsed JSON or raw text string.
   * @param {number}        ms       Query duration in milliseconds.
   * @param {object}        prefixes PREFIX map extracted from the query.
   * @param {number}        limit    Max rows to display (0 = no limit).
   */
  render(data, ms, prefixes = {}, limit = 1000) {
    this._queryPrefixes = prefixes;   // from PREFIX declarations in the query
    this._lastResults = null;
    this._btnExport.classList.add('hidden');

    if (typeof data === 'string') {
      this._renderRaw(data, ms);
      return;
    }

    // ASK query
    if (typeof data.boolean === 'boolean') {
      this._renderAsk(data.boolean, ms);
      return;
    }

    // SELECT query
    if (data.results && data.results.bindings !== undefined) {
      this._renderSelect(data, ms, limit);
      return;
    }

    // Unknown shape — dump as JSON
    this._renderRaw(JSON.stringify(data, null, 2), ms);
  }

  renderError(message) {
    this._lastResults = null;
    this._btnExport.classList.add('hidden');
    this._tabResults.innerHTML = `
      <div class="results-placeholder" style="flex-direction:column; gap:8px;">
        <span style="color:var(--error); font-weight:600;">Query failed</span>
        <span style="color:var(--text-muted); font-family:var(--font-mono); font-size:12px; max-width:600px; white-space:pre-wrap;">${this._escape(message)}</span>
      </div>`;
  }

  clear() {
    this._lastResults  = null;
    this._lastMs       = null;
    this._lastGeomInfo = null;
    this._btnExport.classList.add('hidden');
    this._tabResults.innerHTML = '<div class="results-placeholder">Run a query to see results.</div>';
  }

  /** Re-render the last SELECT result with a new display limit (no re-fetch needed). */
  rerender(limit) {
    if (!this._lastResults) return;
    const { vars, bindings } = this._lastResults;
    this._renderSelect(
      { head: { vars }, results: { bindings } },
      this._lastMs ?? 0,
      limit,
    );
  }

  getGeomInfo() {
    return this._lastGeomInfo;
  }

  exportCSV() {
    if (!this._lastResults) return;
    const { vars, bindings } = this._lastResults;
    const rows = [vars];
    for (const binding of bindings) {
      rows.push(vars.map(v => {
        const term = binding[v];
        if (!term) return '';
        return term.value;
      }));
    }
    const csv = rows.map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'results.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  _renderSelect(data, ms, limit = 1000) {
    const vars        = data.head.vars;
    const allBindings = data.results.bindings;
    const totalCount  = allBindings.length;

    // Always store the full result set so CSV export and rerender are unaffected by the display limit.
    this._lastResults = { vars, bindings: allBindings };
    this._lastMs      = ms;

    if (totalCount === 0) {
      this._tabResults.innerHTML = `
        <div class="results-placeholder">Query returned no results.</div>
        ${this._footerHTML(0, ms)}`;
      return;
    }

    // Apply display limit (limit = 0 means show everything).
    const truncated    = limit > 0 && totalCount > limit;
    const bindings     = truncated ? allBindings.slice(0, limit) : allBindings;
    const displayCount = bindings.length;

    // Build table
    const thead = `<tr>${vars.map(v => `<th>${this._escape(v)}</th>`).join('')}</tr>`;
    const tbody = bindings.map(binding => {
      const cells = vars.map(v => {
        const term = binding[v];
        return `<td>${term ? this._renderTerm(term) : '<span class="val-blank">—</span>'}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    this._tabResults.innerHTML = `
      <div class="results-table-wrap">
        <table class="results-table">
          <thead>${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
        ${this._footerHTML(totalCount, ms, displayCount, truncated)}
      </div>`;

    this._btnExport.classList.remove('hidden');

    // Geometry detection uses the full result set so all features appear on the map.
    this._lastGeomInfo = null;
    const geomCols = this._detectGeomCols(vars, allBindings);
    if (geomCols.length > 0) {
      this._lastGeomInfo = { vars, bindings: allBindings, geomCols };
    }
  }

  _renderAsk(boolean, ms) {
    const label = boolean ? 'true' : 'false';
    this._tabResults.innerHTML = `
      <div class="ask-result">
        <div class="ask-value ${label}">${label}</div>
        <div style="color:var(--text-muted);font-size:12px;">ASK result — ${this._formatMs(ms)}</div>
      </div>`;
  }

  _renderRaw(text, ms) {
    this._tabResults.innerHTML = `
      <div style="padding:12px;">
        <pre style="font-family:var(--font-mono);font-size:12px;color:var(--text);white-space:pre-wrap;word-break:break-all;">${this._escape(text)}</pre>
        ${this._footerHTML(null, ms)}
      </div>`;
  }

  _renderTerm(term) {
    switch (term.type) {
      case 'uri':
        return `<a class="val-uri" href="${this._escape(term.value)}" target="_blank" rel="noopener" title="${this._escape(term.value)}">${this._escape(this._shortenUri(term.value))}</a>`;

      case 'literal': {
        const escaped = this._escape(term.value);
        if (term['xml:lang']) {
          return `<span class="val-literal lang" data-lang="@${this._escape(term['xml:lang'])}" title="@${this._escape(term['xml:lang'])}">${escaped}</span>`;
        }
        if (term.datatype) {
          const dtype = this._shortenUri(term.datatype);
          return `<span class="val-literal typed" data-type="${this._escape(dtype)}" title="^^${this._escape(dtype)}">${escaped}</span>`;
        }
        return `<span class="val-literal">${escaped}</span>`;
      }

      case 'bnode':
        return `<span class="val-blank" title="Blank node">_:${this._escape(term.value)}</span>`;

      default:
        return `<span>${this._escape(String(term.value))}</span>`;
    }
  }

  _footerHTML(count, ms, displayCount = null, truncated = false) {
    const parts = [];
    if (count !== null) {
      if (truncated && displayCount !== null) {
        parts.push(`Showing ${displayCount.toLocaleString()} of ${count.toLocaleString()} rows`);
      } else {
        parts.push(`${count.toLocaleString()} row${count !== 1 ? 's' : ''}`);
      }
    }
    if (ms !== undefined && ms !== null) parts.push(this._formatMs(ms));
    return parts.length
      ? `<div class="results-footer">${parts.map(p => `<span>${p}</span>`).join('')}</div>`
      : '';
  }

  // ── Geometry detection ────────────────────────────────────────────────────

  _detectGeomCols(vars, bindings) {
    const WKT_TYPE    = 'http://www.opengis.net/ont/geosparql#wktLiteral';
    const WKT_PATTERN = /^\s*(<[^>]+>\s*)?(POINT|LINESTRING|POLYGON|MULTI|GEOMETRYCOLLECTION)\s*[\s(]/i;

    return vars.filter(v => {
      for (const binding of bindings) {
        const term = binding[v];
        if (!term) continue;
        if (term.datatype === WKT_TYPE) return true;
        if (term.type === 'literal' && WKT_PATTERN.test(term.value)) return true;
      }
      return false;
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _formatMs(ms) {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  // Shorten URIs using query-defined prefixes first, then well-known built-ins.
  _shortenUri(uri) {
    // Pass 1: query-defined prefixes (mirror exactly what the query declared).
    for (const [ns, prefix] of Object.entries(this._queryPrefixes)) {
      if (uri.startsWith(ns)) return prefix + uri.slice(ns.length);
    }
    // Pass 2: built-in well-known prefixes.
    for (const [ns, prefix] of Object.entries(BUILTIN_PREFIXES)) {
      if (uri.startsWith(ns)) return prefix + uri.slice(ns.length);
    }
    // Pass 3: last-segment truncation for long unrecognised URIs.
    if (uri.length > 60) {
      const cut = Math.max(uri.lastIndexOf('#'), uri.lastIndexOf('/'));
      if (cut > 0 && cut < uri.length - 1) return '…' + uri.slice(cut);
    }
    return uri;
  }
}
