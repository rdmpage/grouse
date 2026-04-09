/**
 * schema.js — Schema browser.
 *
 * Runs the types query on connect, renders an accordion list of types
 * in the sidebar, and on expand fires:
 *   • a properties query  → fills the <details> body in the sidebar
 *   • a sample query      → renders results in the main results pane
 */

// ── Query templates ───────────────────────────────────────────────────────────

// Primary types query — counts instances and fetches labels.
// Works on standard endpoints (Oxigraph, DBpedia, …).  May time out on
// large stores (Blazegraph) where COUNT(DISTINCT) is expensive.
const SCHEMA_TYPES_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?type (SAMPLE(?lbl) AS ?label) (COUNT(DISTINCT ?thing) AS ?count) WHERE {
  ?thing a ?type .
  OPTIONAL {
    ?type rdfs:label ?lbl .
    FILTER(LANG(?lbl) = "" || LANG(?lbl) = "en")
  }
}
GROUP BY ?type
ORDER BY DESC(?count)`;

// Flat fallback — no aggregation, no labels, just raw ?s/?type rows.
// Safe on Blazegraph and any endpoint where COUNT(DISTINCT) times out.
// _parseTypes() deduplicates and counts the rows in JS.
const SCHEMA_TYPES_FLAT_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?type WHERE { ?s a ?type }
LIMIT 5000`;

// $URI is replaced with the actual type URI before execution.
// Primary form: counts properties across a 1 000-instance sample, sorted
// by frequency so the most common properties appear first.
const SCHEMA_PROPERTIES_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?p (COUNT(?p) AS ?count) WHERE {
  {
    SELECT ?s WHERE { ?s rdf:type <$URI> }
    LIMIT 1000
  }
  ?s ?p ?o .
  FILTER(isLiteral(?o))
}
GROUP BY ?p
ORDER BY DESC(?count)`;

// Fallback B: no COUNT/GROUP BY/ORDER BY, but still uses inner subquery.
const SCHEMA_PROPERTIES_SIMPLE_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?p WHERE {
  { SELECT ?s WHERE { ?s rdf:type <$URI> } LIMIT 20 }
  ?s ?p ?o .
  FILTER(isLiteral(?o))
}
LIMIT 100`;

// Fallback C: no subquery at all — works on Blazegraph and other engines
// that have trouble with outer-join variable scoping from inner SELECTs.
const SCHEMA_PROPERTIES_FLAT_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?p WHERE {
  ?s rdf:type <$URI> ; ?p ?o .
  FILTER(isLiteral(?o))
}
LIMIT 100`;

// $URI is replaced with the actual type URI before execution.
// The inner LIMIT 1000 subquery samples a representative set of instances
// rather than scanning the full type, making the query much faster on large stores.
const SCHEMA_CONNECTIONS_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?direction ?predicate ?nThings ?example (SAMPLE(?t) AS ?exampleType)
WHERE {
  {
    SELECT ("incoming" AS ?direction)
           ?predicate
           (COUNT(DISTINCT ?thing) AS ?nThings)
           (SAMPLE(?thing) AS ?example)
    WHERE {
      { SELECT DISTINCT ?centre WHERE { ?centre a <$URI> } LIMIT 1000 }
      ?thing ?predicate ?centre .
      FILTER(isIRI(?thing))
      FILTER(?predicate != rdf:type)
    }
    GROUP BY ?predicate
  }
  UNION
  {
    SELECT ("outgoing" AS ?direction)
           ?predicate
           (COUNT(DISTINCT ?thing) AS ?nThings)
           (SAMPLE(?thing) AS ?example)
    WHERE {
      { SELECT DISTINCT ?centre WHERE { ?centre a <$URI> } LIMIT 1000 }
      ?centre ?predicate ?thing .
      FILTER(isIRI(?thing))
      FILTER(?predicate != rdf:type)
    }
    GROUP BY ?predicate
  }
  OPTIONAL { ?example a ?t }
}
GROUP BY ?direction ?predicate ?nThings ?example
ORDER BY ?direction DESC(?nThings)`;

// Fallback sample query when no literal properties are discovered.
// Uses a flat triple pattern (no inner subquery) for broad compatibility.
const SCHEMA_SAMPLE_QUERY_FALLBACK = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?resourceURI ?p ?o WHERE {
  ?resourceURI rdf:type <$URI> ; ?p ?o .
  FILTER(isLiteral(?o))
}
LIMIT 100`;

// ── SchemaManager ─────────────────────────────────────────────────────────────

class SchemaManager {
  /**
   * @param {object} opts
   * @param {HTMLElement}        opts.treeEl        — #schema-tree container
   * @param {Function}           opts.onQuery        — async (sparql) => data  (silent)
   * @param {Function}           opts.onSampleType   — (sparql, typeLabel) => void
   *                                                    renders sample table to results pane
   * @param {Function}           opts.onConnections  — (mermaidSrc, typeLabel) => void
   *                                                    renders connections graph to results pane
   */
  constructor({ treeEl, onQuery, onSampleType, onConnectionsStart, onConnections }) {
    this._treeEl               = treeEl;
    this._onQuery              = onQuery;
    this._onSampleType         = onSampleType;
    this._onConnectionsStart   = onConnectionsStart || (() => {});
    this._onConnections        = onConnections || (() => {});
    this._types                = [];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Load the schema for a given endpoint URL.
   *
   * Strategy:
   *   1. Run the SPARQL types query — works on most endpoints.
   *   2. If that fails, look for  schemas/<hostname>.json  on the server.
   *      This file can be hand-crafted for endpoints that are too large or
   *      too restrictive to support automatic discovery (e.g. Persée, Wikidata).
   *   3. If both fail, show a clear error with instructions.
   *
   * @param {string} endpointUrl  Full URL of the connected SPARQL endpoint.
   */
  async load(endpointUrl = '') {
    this._endpointUrl = endpointUrl;
    this._setLoading();

    // ── Strategy 0: SPARQL Service Description (VoID) ─────────────────────
    // GET the endpoint URL — standards-compliant endpoints return a VoID/SD
    // document with pre-computed class statistics.  No SPARQL query needed.
    try {
      const types = await this._fetchServiceDescription(endpointUrl);
      if (types.length > 0) {
        this._types = types;
        this._render();
        return;
      }
    } catch (err) {
      console.warn('[schema] service description fetch failed:', err.message);
    }

    // ── Strategy 1: SPARQL discovery (two query variants) ─────────────────
    for (const query of [SCHEMA_TYPES_QUERY, SCHEMA_TYPES_FLAT_QUERY]) {
      try {
        const data = await this._onQuery(query);
        this._types = this._parseTypes(data);
        if (this._types.length > 0) { this._render(); return; }
      } catch (err) {
        console.warn('[schema] types query failed, trying next:', err.message);
      }
    }

    // ── Strategy 2: local schema file ─────────────────────────────────────
    try {
      const hostname = new URL(endpointUrl).hostname;
      const resp     = await fetch(`schemas/${hostname}.json`);
      if (resp.ok) {
        const json  = await resp.json();
        this._types = this._parseLocalSchema(json);
        if (this._types.length > 0) { this._render(); return; }
      }
    } catch (_) { /* fall through to error */ }

    // ── Nothing worked ────────────────────────────────────────────────────
    let hostname = '';
    try { hostname = new URL(endpointUrl).hostname; } catch (_) {}
    this._setError(
      `Schema discovery failed for this endpoint.` +
      (hostname ? ` You can add a <code>schemas/${hostname}.json</code> file to enable manual schema browsing.` : '')
    );
  }

  /**
   * Fetch the SPARQL Service Description from the endpoint and extract
   * VoID class partition data (void:class + void:triples).
   * Works for any endpoint that serves SD on a plain GET request.
   */
  async _fetchServiceDescription(endpointUrl) {
    const isCrossOrigin = (() => {
      try { return new URL(endpointUrl).origin !== window.location.origin; }
      catch { return false; }
    })();

    const fetchUrl = isCrossOrigin
      ? `proxy.php?endpoint=${encodeURIComponent(endpointUrl)}`
      : endpointUrl;

    const resp = await fetch(fetchUrl, {
      headers: { Accept: 'application/rdf+xml, text/turtle;q=0.9, */*;q=0.5' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const ct   = (resp.headers.get('content-type') || '').split(';')[0].trim();
    const text = await resp.text();

    if (ct === 'text/turtle' || ct === 'text/n3') {
      return this._parseVoidTurtle(text);
    }
    // Default: RDF/XML
    return this._parseVoidRdfXml(text);
  }

  /** Parse void:class / void:triples from RDF/XML using DOMParser. */
  _parseVoidRdfXml(xmlText) {
    const VOID = 'http://rdfs.org/ns/void#';
    const RDF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    let doc;
    try {
      doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    } catch { return []; }

    const types = [];
    for (const desc of doc.getElementsByTagNameNS(RDF, 'Description')) {
      const classEl = desc.getElementsByTagNameNS(VOID, 'class')[0];
      if (!classEl) continue;
      const uri = classEl.getAttributeNS(RDF, 'resource') ||
                  classEl.getAttribute('rdf:resource');
      if (!uri) continue;
      const triplesEl = desc.getElementsByTagNameNS(VOID, 'triples')[0];
      const count = triplesEl ? parseInt(triplesEl.textContent, 10) || 0 : 0;
      types.push({ uri, label: null, count });
    }
    return types.sort((a, b) => b.count - a.count);
  }

  /** Parse void:class / void:triples from Turtle using N3.js. */
  _parseVoidTurtle(turtle) {
    if (!window.N3) return [];
    const VOID = 'http://rdfs.org/ns/void#';
    let quads;
    try { quads = new N3.Parser().parse(turtle); } catch { return []; }

    const classMap   = new Map(); // nodeId → class URI
    const triplesMap = new Map(); // nodeId → count

    for (const q of quads) {
      const s = q.subject.value, p = q.predicate.value, o = q.object;
      if (p === VOID + 'class'   && o.termType === 'NamedNode')
        classMap.set(s, o.value);
      if (p === VOID + 'triples' && o.termType === 'Literal')
        triplesMap.set(s, parseInt(o.value, 10) || 0);
    }

    return [...classMap.entries()]
      .map(([id, uri]) => ({ uri, label: null, count: triplesMap.get(id) || 0 }))
      .sort((a, b) => b.count - a.count);
  }

  /** Reset sidebar to initial state (called on disconnect). */
  clear() {
    this._types = [];
    this._treeEl.innerHTML =
      '<div class="sidebar-empty">Connect to an endpoint to browse schema.</div>';
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  // Handles both aggregated results (?type ?label ?count from GROUP BY query)
  // and flat results (?type rows from the no-aggregation fallback query).
  // Deduplicates flat rows in JS and uses occurrence frequency as sort key.
  _parseTypes(data) {
    if (!data?.results?.bindings) return [];
    const map = new Map();
    for (const row of data.results.bindings) {
      if (!row.type) continue;
      const uri = row.type.value;
      if (map.has(uri)) {
        map.get(uri).count++;          // flat query: count occurrences
      } else {
        map.set(uri, {
          uri,
          label: row.label?.value || null,
          count: parseInt(row.count?.value, 10) || 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * Parse a hand-crafted local schema file.
   *
   * Accepted formats:
   *   • Array of URI strings:           ["http://...", ...]
   *   • Array of objects:               [{ "uri": "http://...", "label": "...", "count": 0 }, ...]
   */
  _parseLocalSchema(json) {
    if (!Array.isArray(json)) return [];
    return json.map(item => {
      if (typeof item === 'string') return { uri: item, label: null, count: 0 };
      return {
        uri:   item.uri   || item.type || '',
        label: item.label || null,
        count: parseInt(item.count, 10) || 0,
      };
    }).filter(t => t.uri);
  }

  _render() {
    if (this._types.length === 0) {
      this._treeEl.innerHTML = '<div class="sidebar-empty">No types found in this endpoint.</div>';
      return;
    }

    this._treeEl.innerHTML = this._types.map((t, i) => {
      const display = this._esc(t.label || this._localName(t.uri));
      const title   = this._esc(t.uri);
      const count   = t.count.toLocaleString();
      return `<details class="schema-type" data-index="${i}">
  <summary class="schema-type-summary" title="${title}">
    <span class="schema-type-chevron">&gt;</span>
    <span class="schema-type-label">${display}</span>
    <span class="schema-type-count">${count}</span>
    <button class="schema-connections-btn" title="Show connections graph">⇌</button>
  </summary>
  <div class="schema-type-body"></div>
</details>`;
    }).join('');

    this._treeEl.querySelectorAll('details.schema-type').forEach(el => {
      el.addEventListener('toggle', () => {
        const chevron = el.querySelector('.schema-type-chevron');
        if (chevron) chevron.textContent = el.open ? '⌄' : '>';
        if (!el.open) return;
        const idx = parseInt(el.dataset.index, 10);
        this._openType(el, this._types[idx]);
      });

      el.querySelector('.schema-connections-btn').addEventListener('click', e => {
        e.stopPropagation(); // don't toggle the <details>
        const idx = parseInt(el.dataset.index, 10);
        this._clickConnections(el, this._types[idx]);
      });
    });
  }

  async _openType(el, type) {
    const label = type.label || this._localName(type.uri);
    const body  = el.querySelector('.schema-type-body');

    if (body.dataset.loaded) {
      // Properties already cached — re-fire the sample immediately
      this._onSampleType(body._sampleQuery, label);
      return;
    }

    // First open: fetch properties, then build and fire the pivoted sample query
    body.dataset.loaded = 'true';
    body.innerHTML = '<div class="schema-props-loading">Loading properties…</div>';

    try {
      const propUris = await this._fetchProperties(type.uri);
      this._renderProperties(body, propUris);

      body._sampleQuery = propUris.length > 0
        ? this._buildPivotedQuery(type.uri, propUris)
        : SCHEMA_SAMPLE_QUERY_FALLBACK.replace(/\$URI/g, type.uri);

      this._onSampleType(body._sampleQuery, label);
    } catch (err) {
      body.innerHTML =
        `<div class="schema-props-error">Failed: ${this._esc(err.message)}</div>`;
    }
  }

  /**
   * Build a pivoted SELECT query: one column per literal property,
   * 10 sampled entities of the given type.
   */
  _buildPivotedQuery(typeUri, propUris) {
    const used = new Set(['resourceURI']);
    const vars = propUris.map(uri => {
      // Derive a valid SPARQL variable name from the property's local name
      let base = this._localName(uri)
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^([^a-zA-Z_])/, '_$1');
      let name = base;
      let i = 2;
      while (used.has(name)) name = `${base}_${i++}`;
      used.add(name);
      return { uri, name };
    });

    const selectVars = vars.map(v => `?${v.name}`).join(' ');
    const optionals  = vars.map(v =>
      `  OPTIONAL { ?resourceURI <${v.uri}> ?${v.name} }`
    ).join('\n');

    // Outer LIMIT rather than an inner subquery — avoids Blazegraph's
    // variable-scoping issues with the { SELECT ... } LIMIT N join pattern.
    return `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?resourceURI ${selectVars} WHERE {
  ?resourceURI rdf:type <${typeUri}> .
${optionals}
}
LIMIT 10`;
  }

  async _clickConnections(el, type) {
    const label = type.label || this._localName(type.uri);
    const body  = el.querySelector('.schema-type-body');
    const t0    = performance.now();

    // Immediate feedback: clear pane and show loading state
    this._onConnectionsStart(label);

    // Use cached Mermaid source if available
    if (body._mermaidSrc) {
      this._onConnections(body._mermaidSrc, label, null, Math.round(performance.now() - t0));
      return;
    }

    try {
      const q        = SCHEMA_CONNECTIONS_QUERY.replace(/\$URI/g, type.uri);
      const data     = await this._onQuery(q);
      const bindings = data?.results?.bindings || [];
      const src      = this._buildMermaidDiagram(type.uri, label, bindings);
      body._mermaidSrc = src;
      this._onConnections(src, label, null, Math.round(performance.now() - t0));
    } catch (err) {
      this._onConnections(null, label, err.message, Math.round(performance.now() - t0));
    }
  }

  _buildMermaidDiagram(typeUri, typeLabel, bindings) {
    const centreId = 'centre';
    // Centre node as a circle; related nodes as plain rectangles —
    // both use simple straight/arc paths that render cleanly without jagged edges.
    const lines    = ['flowchart LR', `  ${centreId}(("${this._mermaidEsc(typeLabel)}"))`];
    const nodeMap  = new Map(); // related type URI → node id

    for (const row of bindings) {
      const direction = row.direction?.value;
      const predLabel = this._localName(row.predicate?.value || '?');
      const count     = parseInt(row.nThings?.value || '0', 10).toLocaleString();
      const relType   = row.exampleType?.value;
      const relLabel  = this._mermaidEsc(relType ? this._localName(relType) : '?');
      const edgeLabel = `"${this._mermaidEsc(predLabel)}\\n${count}"`;

      let nodeId;
      if (relType) {
        if (!nodeMap.has(relType)) {
          nodeId = `n${nodeMap.size}`;
          nodeMap.set(relType, nodeId);
          lines.push(`  ${nodeId}["${relLabel}"]`);
        }
        nodeId = nodeMap.get(relType);
      } else {
        nodeId = `u${lines.length}`;
        lines.push(`  ${nodeId}["?"]`);
      }

      if (direction === 'outgoing') {
        lines.push(`  ${centreId} -->|${edgeLabel}| ${nodeId}`);
      } else {
        lines.push(`  ${nodeId} -->|${edgeLabel}| ${centreId}`);
      }
    }

    if (lines.length <= 2) {
      return 'flowchart LR\n  centre(["No connections found"])';
    }
    return lines.join('\n');
  }

  /**
   * Fetch literal-valued properties for a type URI.
   * Tries the counted query first (useful for ordering), then the simpler
   * DISTINCT query, and returns a plain array of property URIs.
   */
  async _fetchProperties(typeUri) {
    const queries = [
      SCHEMA_PROPERTIES_QUERY,        // counted, subquery inner LIMIT
      SCHEMA_PROPERTIES_SIMPLE_QUERY, // distinct, subquery inner LIMIT
      SCHEMA_PROPERTIES_FLAT_QUERY,   // distinct, no subquery (Blazegraph-safe)
    ];
    for (const tmpl of queries) {
      try {
        const data     = await this._onQuery(tmpl.replace(/\$URI/g, typeUri));
        const bindings = data?.results?.bindings || [];
        const uris     = bindings.map(row => row.p?.value).filter(Boolean);
        if (uris.length > 0) return uris;
      } catch (err) {
        console.warn('[schema] properties query failed, trying next fallback:', err.message);
      }
    }
    return [];
  }

  /** Render property list into the sidebar body element. */
  _renderProperties(body, propUris) {
    if (propUris.length === 0) {
      body.innerHTML = '<div class="schema-props-empty">No literal properties found.</div>';
      return;
    }
    body.innerHTML = propUris.map(uri => {
      const label = this._localName(uri);
      return `<div class="schema-prop" title="${this._esc(uri)}">
  <span class="schema-prop-label">${this._esc(label)}</span>
</div>`;
    }).join('');
    return;
  }

  _setLoading() {
    this._treeEl.innerHTML = '<div class="sidebar-empty">Loading schema…</div>';
  }

  _setError(msg) {
    this._treeEl.innerHTML =
      `<div class="sidebar-empty schema-load-error">Schema error: ${this._esc(msg)}</div>`;
  }

  _localName(uri) {
    const m = uri.match(/[#/]([^#/]+)$/);
    return m ? m[1] : uri;
  }

  _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Escape characters that break Mermaid node/edge label syntax.
  _mermaidEsc(str) {
    return String(str)
      .replace(/"/g, "'")   // double quotes break node label delimiters
      .replace(/[()[\]{}]/g, ''); // brackets confuse shape parsing
  }
}
