/**
 * schema.js — Schema browser.
 *
 * Runs the types query on connect, renders an accordion list of types
 * in the sidebar, and on expand fires:
 *   • a properties query  → fills the <details> body in the sidebar
 *   • a sample query      → renders results in the main results pane
 */

// ── Query templates ───────────────────────────────────────────────────────────

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

// $URI is replaced with the actual type URI before execution
const SCHEMA_PROPERTIES_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?p (COUNT(?p) AS ?count) WHERE {
  {
    SELECT ?s WHERE {
      ?s rdf:type <$URI> .
    }
    LIMIT 1000
  }
  ?s ?p ?o .
  FILTER(isLiteral(?o))
}
GROUP BY ?p
ORDER BY DESC(?count)`;

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

// Fallback used when a type has no discoverable literal properties
const SCHEMA_SAMPLE_QUERY_FALLBACK = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?resourceURI ?p ?o WHERE {
  { SELECT ?resourceURI WHERE { ?resourceURI rdf:type <$URI> } LIMIT 10 }
  ?resourceURI ?p ?o .
  FILTER(isLiteral(?o))
}`;

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

  /** Run the types query and render the sidebar accordion. */
  async load() {
    this._setLoading();
    try {
      const data   = await this._onQuery(SCHEMA_TYPES_QUERY);
      this._types  = this._parseTypes(data);
      this._render();
    } catch (err) {
      this._setError(err.message);
    }
  }

  /** Reset sidebar to initial state (called on disconnect). */
  clear() {
    this._types = [];
    this._treeEl.innerHTML =
      '<div class="sidebar-empty">Connect to an endpoint to browse schema.</div>';
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _parseTypes(data) {
    if (!data?.results?.bindings) return [];
    return data.results.bindings.map(row => ({
      uri:   row.type.value,
      label: row.label?.value || null,
      count: parseInt(row.count.value, 10) || 0,
    }));
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
      const propsQ   = SCHEMA_PROPERTIES_QUERY.replace(/\$URI/g, type.uri);
      const data     = await this._onQuery(propsQ);
      const propUris = this._renderProperties(body, data);

      // Build pivoted SELECT (or fall back if no literal properties found)
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

    return `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?resourceURI ${selectVars} WHERE {
  { SELECT ?resourceURI WHERE { ?resourceURI rdf:type <${typeUri}> } LIMIT 10 }
${optionals}
}`;
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

  /** Render property list into body; returns array of property URIs. */
  _renderProperties(body, data) {
    const bindings = data?.results?.bindings || [];
    if (bindings.length === 0) {
      body.innerHTML = '<div class="schema-props-empty">No literal properties found.</div>';
      return [];
    }
    body.innerHTML = bindings.map(row => {
      const uri   = row.p.value;
      const count = parseInt(row.count.value, 10).toLocaleString();
      const label = this._localName(uri);
      return `<div class="schema-prop" title="${this._esc(uri)}">
  <span class="schema-prop-label">${this._esc(label)}</span>
  <span class="schema-prop-count">${count}</span>
</div>`;
    }).join('');
    return bindings.map(row => row.p.value);
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
