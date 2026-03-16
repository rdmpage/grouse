/**
 * endpoint.js — SPARQL endpoint connection management and HTTP client.
 *
 * Sends queries via HTTP POST with application/x-www-form-urlencoded body.
 * Accepts application/sparql-results+json for SELECT/ASK.
 * Accepts text/turtle or application/ld+json for CONSTRUCT/DESCRIBE.
 */

class EndpointManager {
  constructor() {
    this.url        = '';
    this.connected  = false;
    this._abort     = null;       // AbortController for the active query
    this._listeners = {};
  }

  // ── Event system ──────────────────────────────────────────────────────────

  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    return this;
  }

  _emit(event, ...args) {
    (this._listeners[event] || []).forEach(fn => fn(...args));
  }

  // ── Connection ────────────────────────────────────────────────────────────

  /**
   * Test an endpoint URL by running a minimal ASK query.
   * Returns { ok, error }.
   */
  async connect(url) {
    this.url       = url.trim();
    this.connected = false;
    this._emit('statusChange', 'connecting');

    try {
      await this._fetch('ASK { ?s ?p ?o }', 'application/sparql-results+json');
      this.connected = true;
      Storage.set('endpoint_url', this.url);
      this._emit('statusChange', 'connected');
      return { ok: true };
    } catch (err) {
      this._emit('statusChange', 'error');
      return { ok: false, error: err.message };
    }
  }

  disconnect() {
    this.abort();
    this.url       = '';
    this.connected = false;
    this._emit('statusChange', 'disconnected');
  }

  // ── Query execution ───────────────────────────────────────────────────────

  /**
   * Execute a SPARQL query against the connected endpoint.
   * Returns the parsed JSON (for SELECT/ASK) or text (for CONSTRUCT/DESCRIBE).
   * Throws on network errors or non-2xx HTTP responses.
   */
  async query(sparql, accept) {
    if (!this.url) throw new Error('No endpoint configured. Please connect to an endpoint first.');

    const queryType = this._detectQueryType(sparql);
    if (!accept) {
      accept = (queryType === 'construct' || queryType === 'describe')
        ? 'text/turtle,application/n-triples,application/n-quads,application/ld+json;q=0.9,*/*;q=0.5'
        : 'application/sparql-results+json';
    }

    return this._fetch(sparql, accept);
  }

  abort() {
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _fetch(sparql, accept) {
    this.abort();
    this._abort = new AbortController();

    // Route cross-origin requests through the PHP proxy to avoid CORS errors.
    const crossOrigin = this._isCrossOrigin();
    const fetchUrl    = crossOrigin ? 'proxy.php' : this.url;
    const body        = crossOrigin
      ? new URLSearchParams({ endpoint: this.url, query: sparql })
      : new URLSearchParams({ query: sparql });

    let response;
    try {
      response = await fetch(fetchUrl, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept':        accept,
        },
        body:   body.toString(),
        signal: this._abort.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error(`Network error: ${err.message}. Check that the endpoint URL is correct and that the server is reachable.`);
    } finally {
      this._abort = null;
    }

    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch {}
      throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? ': ' + detail.slice(0, 300) : ''}`);
    }

    const ct = response.headers.get('content-type') || '';
    const ctBase = ct.split(';')[0].trim().toLowerCase();

    if (ctBase === 'application/sparql-results+json' || ctBase === 'application/json') {
      const json = await response.json();
      if (json.error) throw new Error(json.error);
      return { data: json, contentType: ctBase };
    }

    // For RDF or unknown, return text with content-type
    const text = await response.text();

    // If content-type says JSON but we didn't handle it above, try parsing
    if (ctBase.includes('json')) {
      try {
        const json = JSON.parse(text);
        if (json.error) throw new Error(json.error);
        return { data: json, contentType: ctBase };
      } catch {}
    }

    return { data: text, contentType: ctBase || 'text/plain' };
  }

  _isCrossOrigin() {
    try {
      return new URL(this.url).origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  _detectQueryType(sparql) {
    const s = sparql.replace(/^\s*#[^\n]*/gm, '').trim().toLowerCase();
    if (s.startsWith('construct')) return 'construct';
    if (s.startsWith('describe'))  return 'describe';
    if (s.startsWith('ask'))       return 'ask';
    return 'select';
  }

  isConnected() {
    return this.connected;
  }

  getUrl() {
    return this.url;
  }
}
