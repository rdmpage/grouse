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
    this._lastQuads     = null;   // parsed N3 quads for RDF results
    this._lastRaw       = '';     // raw server response text, for the Response tab

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
  render(data, ms, prefixes = {}, limit = 1000, contentType = '', raw = '') {
    this._queryPrefixes = prefixes;   // from PREFIX declarations in the query
    this._lastResults   = null;
    this._lastRaw       = raw;
    this._btnExport.classList.add('hidden');

    // Populate the Response tab with the raw server text.
    const responsePre = document.getElementById('response-pre');
    if (responsePre) responsePre.textContent = raw || '(no response body)';

    // RDF result (CONSTRUCT / DESCRIBE)
    if (typeof data === 'string' && this._isRdfContentType(contentType)) {
      this._renderRdf(data, ms, contentType);
      return;
    }

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
    this._lastQuads    = null;
    this._lastRaw      = '';
    this._btnExport.classList.add('hidden');
    this._showRdfControls(false);
    this._setTableTabLabel('Table');
    this._tabResults.classList.remove('graph-active');
    this._tabResults.innerHTML = '<div class="results-placeholder">Run a query to see results.</div>';
    const responsePre = document.getElementById('response-pre');
    if (responsePre) responsePre.textContent = '';
  }

  rerenderRdf(format) {
    if (!this._lastQuads) return;
    this._displayRdf(this._lastQuads, this._lastMs ?? 0, format);
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

  getLastRaw() {
    return this._lastRaw;
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
    this._showRdfControls(false);
    this._setTableTabLabel('Table');
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
      <div class="rdf-text-wrap">
        <pre class="rdf-pre">${this._escape(text)}</pre>
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

  // ── RDF rendering ─────────────────────────────────────────────────────────

  _isRdfContentType(ct) {
    return [
      'text/turtle', 'text/n3', 'application/n-triples',
      'application/n-quads', 'application/trig',
      'application/rdf+xml', 'application/ld+json',
    ].some(t => ct.startsWith(t));
  }

  _rdfContentTypeToN3Format(ct) {
    if (ct.startsWith('application/n-triples')) return 'N-Triples';
    if (ct.startsWith('application/n-quads'))  return 'N-Quads';
    if (ct.startsWith('application/trig'))     return 'TriG';
    if (ct.startsWith('text/n3'))              return 'N3';
    return 'Turtle'; // default
  }

  _renderRdf(text, ms, contentType) {
    this._lastMs = ms;
    this._setTableTabLabel('Triples');

    // JSON-LD: convert using N3 if available, else show formatted JSON
    if (contentType.startsWith('application/ld+json')) {
      if (window.N3) {
        // N3 can parse JSON-LD when passed as a string with the right format
        this._parseAndDisplayRdf(text, ms, 'application/ld+json');
      } else {
        try {
          this._tabResults.innerHTML = `<div class="rdf-text-wrap"><pre class="rdf-pre">${this._escape(JSON.stringify(JSON.parse(text), null, 2))}</pre>${this._footerHTML(null, ms)}</div>`;
        } catch {
          this._renderRaw(text, ms);
        }
      }
      return;
    }

    if (window.N3) {
      const n3Format = this._rdfContentTypeToN3Format(contentType);
      this._parseAndDisplayRdf(text, ms, n3Format);
    } else {
      this._renderRaw(text, ms);
    }
  }

  _parseAndDisplayRdf(text, ms, n3Format) {
    // Use the synchronous return form — parser.parse(string) returns Quad[]
    // and throws on error. The callback form fires asynchronously for string
    // input in the browserified build, leaving quads empty at render time.
    let quads;
    try {
      quads = new N3.Parser({ format: n3Format }).parse(text);
    } catch (e) {
      this._renderRaw(text, ms);
      return;
    }

    this._lastQuads = quads;
    this._showRdfControls(true);

    const fmtEl = document.getElementById('rdf-format');
    this._displayRdf(quads, ms, fmtEl ? fmtEl.value : 'triples');
  }

  _displayRdf(quads, ms, format) {
    switch (format) {
      case 'turtle':   return this._displayRdfText(quads, ms, 'Turtle');
      case 'ntriples': return this._displayRdfText(quads, ms, 'N-Triples');
      case 'jsonld':   return this._displayJsonLd(quads, ms);
      case 'graph':    return this._displayRdfGraph(quads, ms);
      default:         return this._displayRdfTriples(quads, ms);
    }
  }

  _displayRdfTriples(quads, ms) {
    const count = quads.length;
    if (count === 0) {
      this._tabResults.innerHTML = `<div class="results-placeholder">Query returned no triples.</div>`;
      return;
    }

    // Render as tab-separated text with prefix-shortened terms — readable but
    // distinct from the HTML table used for SELECT results.
    const lines = quads.map(q =>
      [q.subject, q.predicate, q.object].map(t => this._n3TermToText(t)).join('\t')
    ).join('\n');

    this._tabResults.innerHTML = `
      <div class="rdf-text-wrap">
        <pre class="rdf-pre no-wrap">${this._escape(lines)}</pre>
        ${this._footerHTML(count, ms)}
      </div>`;
  }

  // Serialise an N3 term to a short readable string (prefixed URIs, quoted literals).
  _n3TermToText(term) {
    if (term.termType === 'NamedNode') {
      const short = this._shortenUri(term.value);
      return short !== term.value ? short : `<${term.value}>`;
    }
    if (term.termType === 'BlankNode') return `_:${term.value}`;
    // Literal
    const val = `"${term.value}"`;
    if (term.language)  return `${val}@${term.language}`;
    if (term.datatype)  return `${val}^^${this._shortenUri(term.datatype.value)}`;
    return val;
  }

  // Human-readable label for a node in the graph (no angle brackets, truncated).
  _n3TermLabel(term) {
    if (term.termType === 'NamedNode') {
      const short = this._shortenUri(term.value);
      if (short !== term.value) return short;
      const h = term.value.lastIndexOf('#');
      const s = term.value.lastIndexOf('/');
      const cut = Math.max(h, s);
      if (cut > 0 && cut < term.value.length - 1) return term.value.slice(cut + 1);
      return term.value;
    }
    if (term.termType === 'BlankNode') return '_:' + term.value;
    const v = term.value;
    return v.length > 60 ? v.slice(0, 57) + '…' : v;
  }

  // ── Graph view (vis-network) ───────────────────────────────────────────────
  // Mermaid.js was tried first — see git history if you want to restore it.
  _displayRdfGraph(quads, ms) {
    if (!window.vis) {
      this._tabResults.innerHTML = '<div class="results-placeholder">Vis.js not loaded — graph view unavailable.</div>';
      return;
    }
    // Strip rdf:type triples (clutter) and deduplicate before building the graph.
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const seen     = new Set();
    quads = quads.filter(q => {
      if (q.predicate.value === RDF_TYPE) return false;
      const key = q.subject.value + '||' + q.predicate.value + '||' + q.object.value;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (quads.length === 0) {
      this._tabResults.innerHTML = '<div class="results-placeholder">No triples to visualise.</div>';
      return;
    }

    // Most-frequent subject becomes the "main" (light-yellow) node
    const freq = new Map();
    for (const q of quads) freq.set(q.subject.value, (freq.get(q.subject.value) || 0) + 1);
    const mainSubjVal = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const nodeData = [];
    const edgeData = [];
    const nodeReg  = new Map();  // URI/BNode value → true (dedup)
    const predReg  = new Map();  // `subjVal||predVal` → predicate-node id

    // Main subject node
    const mainTerm = quads.find(q => q.subject.value === mainSubjVal).subject;
    nodeData.push({ id: mainSubjVal, label: this._n3TermLabel(mainTerm), group: 'primary_uri' });
    nodeReg.set(mainSubjVal, true);

    for (const quad of quads) {
      const sId = quad.subject.value;

      // Additional subject nodes for multi-subject graphs
      if (!nodeReg.has(sId)) {
        nodeReg.set(sId, true);
        nodeData.push({ id: sId, label: this._n3TermLabel(quad.subject), group: 'uri' });
      }

      // One predicate-node (box) per unique (subject, predicate) pair
      const spKey = sId + '||' + quad.predicate.value;
      if (!predReg.has(spKey)) {
        const predId = `PRED:${predReg.size}`;
        predReg.set(spKey, predId);
        nodeData.push({ id: predId, label: this._shortenUri(quad.predicate.value), group: 'predicate_uri' });
        edgeData.push({ from: sId, to: predId });
      }
      const pId = predReg.get(spKey);

      // Object — literals unique per occurrence; URIs/BNodes shared
      let oId;
      if (quad.object.termType === 'Literal') {
        oId = `LIT:${edgeData.length}`;
        nodeData.push({ id: oId, label: this._n3TermLabel(quad.object), group: 'literal' });
      } else {
        oId = quad.object.value;
        if (!nodeReg.has(oId)) {
          nodeReg.set(oId, true);
          nodeData.push({ id: oId, label: this._n3TermLabel(quad.object), group: 'uri' });
        }
      }
      edgeData.push({ from: pId, to: oId });
    }

    // CSS drives the height so the graph always fills the panel.
    this._tabResults.classList.add('graph-active');
    this._tabResults.innerHTML = '<div id="vis-net"></div>';

    const container = document.getElementById('vis-net');
    const network   = new vis.Network(
      container,
      { nodes: new vis.DataSet(nodeData), edges: new vis.DataSet(edgeData) },
      {
        physics: {
          barnesHut:     { gravitationalConstant: -30000 },
          stabilization: { iterations: 2500 },
        },
        interaction: {
          hover:             true,
          navigationButtons: true,
          zoomView:          true,
        },
        nodes: {
          shape:       'dot',
          size:         25,
          font:        { size: 14, color: '#333' },
          borderWidth:  2,
        },
        edges: {
          color:  'gray',
          smooth: false,
          length: 150,
          arrows: { to: { enabled: true, scaleFactor: 0.3, type: 'arrow' } },
        },
        groups: {
          primary_uri: {
            color: { border: '#325D94', background: 'lightyellow',
                     highlight: { border: '#325D94', background: '#FFF59D' },
                     hover:     { border: '#325D94', background: '#FFF59D' } },
            size: 30,
            font: { size: 18, color: '#333' },
          },
          predicate_uri: {
            shape: 'box',
            color: { background: 'white', border: 'lightgreen',
                     highlight: { background: 'white', border: 'red' },
                     hover:     { background: 'white', border: '#F44336' } },
            font: { size: 12, color: '#1b5e20' },
          },
          uri: {
            color: { border: '#2672b0', background: '#5b9bd5',
                     highlight: { border: '#1a4d7a', background: '#3d7eb5' },
                     hover:     { border: '#1a4d7a', background: '#3d7eb5' } },
            font: { size: 13, color: '#fff' },
          },
          literal: {
            color: { border: '#90caf9', background: '#e3f2fd',
                     highlight: { border: '#64b5f6', background: '#bbdefb' },
                     hover:     { border: '#64b5f6', background: '#bbdefb' } },
            font: { size: 12, color: '#1a237e' },
          },
        },
      }
    );

    // Keep the canvas filling the panel as the user drags the splitter.
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        network.setSize('100%', '100%');
        network.redraw();
      }).observe(this._tabResults);
    }
  }

  _displayRdfText(quads, ms, format) {
    // Build prefix map for N3.Writer
    const prefixMap = {};
    const allPrefixes = Object.assign({}, BUILTIN_PREFIXES, this._queryPrefixes);
    for (const [ns, prefixColon] of Object.entries(allPrefixes)) {
      prefixMap[prefixColon.slice(0, -1)] = ns; // 'rdf' → 'http://...'
    }

    const writer = new N3.Writer({ format, prefixes: prefixMap });
    writer.addQuads(quads);
    writer.end((err, result) => {
      const text = err ? '# Serialisation error: ' + err.message : result;
      this._tabResults.innerHTML = `
        <div class="rdf-text-wrap">
          <pre class="rdf-pre">${this._escape(text)}</pre>
          ${this._footerHTML(quads.length, ms)}
        </div>`;
    });
  }

  _displayJsonLd(quads, ms) {
    // Build @context from known prefixes
    const allPrefixes = Object.assign({}, BUILTIN_PREFIXES, this._queryPrefixes);
    const context = {};
    for (const [ns, prefixColon] of Object.entries(allPrefixes)) {
      context[prefixColon.slice(0, -1)] = ns;
    }

    // Group triples by subject
    const subjects = new Map();
    for (const quad of quads) {
      const sid = quad.subject.termType === 'BlankNode'
        ? '_:' + quad.subject.value : quad.subject.value;
      if (!subjects.has(sid)) subjects.set(sid, { '@id': sid });
      const node = subjects.get(sid);

      const predUri  = quad.predicate.value;
      const predKey  = this._shortenUri(predUri);
      const objValue = this._n3TermToJsonLdValue(quad.object);

      if (node[predKey] === undefined) {
        node[predKey] = objValue;
      } else if (Array.isArray(node[predKey])) {
        node[predKey].push(objValue);
      } else {
        node[predKey] = [node[predKey], objValue];
      }
    }

    const jsonld = { '@context': context, '@graph': Array.from(subjects.values()) };
    const text   = JSON.stringify(jsonld, null, 2);

    this._tabResults.innerHTML = `
      <div class="rdf-text-wrap">
        <pre class="rdf-pre">${this._escape(text)}</pre>
        ${this._footerHTML(quads.length, ms)}
      </div>`;
  }

  _n3TermToJsonLdValue(term) {
    if (term.termType === 'NamedNode')  return { '@id': term.value };
    if (term.termType === 'BlankNode')  return { '@id': '_:' + term.value };
    // Literal
    if (term.language) return { '@language': term.language, '@value': term.value };
    const xsdString = 'http://www.w3.org/2001/XMLSchema#string';
    if (term.datatype && term.datatype.value !== xsdString) {
      return { '@type': term.datatype.value, '@value': term.value };
    }
    return term.value;
  }

  _renderN3Term(term) {
    switch (term.termType) {
      case 'NamedNode':
        return `<a class="val-uri" href="${this._escape(term.value)}" target="_blank" rel="noopener" title="${this._escape(term.value)}">${this._escape(this._shortenUri(term.value))}</a>`;
      case 'BlankNode':
        return `<span class="val-blank" title="Blank node">_:${this._escape(term.value)}</span>`;
      case 'Literal': {
        const esc = this._escape(term.value);
        if (term.language) {
          return `<span class="val-literal lang" data-lang="@${this._escape(term.language)}" title="@${this._escape(term.language)}">${esc}</span>`;
        }
        if (term.datatype) {
          const dtype = this._shortenUri(term.datatype.value);
          return `<span class="val-literal typed" data-type="${this._escape(dtype)}" title="^^${this._escape(dtype)}">${esc}</span>`;
        }
        return `<span class="val-literal">${esc}</span>`;
      }
      default:
        return this._escape(String(term.value));
    }
  }

  _showRdfControls(show) {
    const rdfLabel  = document.getElementById('rdf-format-label');
    const rdfSelect = document.getElementById('rdf-format');
    const rowLabel  = document.querySelector('.row-limit-label');
    const rowSelect = document.getElementById('row-limit');

    if (rdfLabel)  rdfLabel.classList.toggle('hidden', !show);
    if (rdfSelect) rdfSelect.classList.toggle('hidden', !show);
    if (rowLabel)  rowLabel.classList.toggle('hidden',  show);
    if (rowSelect) rowSelect.classList.toggle('hidden',  show);
  }

  _setTableTabLabel(label) {
    const btn = document.querySelector('.results-tab[data-tab="results"]');
    if (btn) btn.textContent = label;
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
