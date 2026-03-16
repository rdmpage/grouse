/**
 * editor.js — Multi-cell query editor.
 *
 * Manages a vertical stack of SPARQL query cells (circular buffer, max 20).
 * One cell is "active" at a time — the toolbar Run/Validate/Format buttons
 * always operate on the active cell.  Cmd/Ctrl+Enter runs from any cell.
 *
 * Public API (unchanged from single-editor version):
 *   getQuery()          → active cell text
 *   setQuery(text)      → fill active cell (or new cell if active has content)
 *   newCell(query='')   → add a new cell at the bottom, activate it
 *   enable() / disable()
 *   setRunning(bool)
 *   setStatus(msg, type)
 *   clearStatus()
 *   validate()
 *   format()
 */

class QueryEditor {
  constructor({ onRun, onStop, onValidate }) {
    this._onRun      = onRun;
    this._onStop     = onStop;
    this._onValidate = onValidate;

    this._cells    = [];
    this._activeId = null;
    this._seq      = 0;
    this._maxCells = 20;

    this._el = {
      container:   document.getElementById('cells-container'),
      status:      document.getElementById('editor-status'),
      validDot:    document.getElementById('validation-dot'),
      validMsg:    document.getElementById('validation-message'),
      btnRun:      document.getElementById('btn-run'),
      btnStop:     document.getElementById('btn-stop'),
      btnValidate: document.getElementById('btn-validate'),
      btnFormat:   document.getElementById('btn-format'),
    };

    this._bindToolbar();
    this.newCell();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getQuery() {
    const ta = this._activeTa();
    return ta ? ta.value : '';
  }

  setQuery(text) {
    const ta = this._activeTa();
    if (ta && ta.value.trim() === '') {
      ta.value = text;
      this._autoResize(ta);
      this._clearValidation();
    } else {
      this.newCell(text);
    }
  }

  newCell(query = '') {
    if (this._cells.length >= this._maxCells) {
      this._removeCell(this._cells[0].id);
    }

    const id   = `qc-${this._seq++}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const num  = this._seq;

    const el = document.createElement('div');
    el.id        = id;
    el.className = 'query-cell';
    el.innerHTML = `
      <div class="cell-header">
        <span class="cell-num">#${num}</span>
        <span class="cell-time">${time}</span>
        <button class="cell-del" title="Remove this query" tabindex="-1">\u00d7</button>
      </div>
      <textarea class="cell-textarea" spellcheck="false" autocomplete="off"
        autocorrect="off" autocapitalize="off"
        placeholder="SPARQL query\u2026"></textarea>`;

    const ta = el.querySelector('textarea');
    ta.value = query;

    ta.addEventListener('focus', () => this._activate(id));

    ta.addEventListener('input', () => {
      this._autoResize(ta);
      this._clearValidation();
    });

    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: s2, value } = ta;
        ta.value = value.slice(0, s) + '  ' + value.slice(s2);
        ta.selectionStart = ta.selectionEnd = s + 2;
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!this._el.btnRun.disabled) this._onRun && this._onRun();
        return;
      }
      if (e.key === 'F' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        this.format();
      }
    });

    el.querySelector('.cell-header').addEventListener('click', () => {
      this._activate(id);
      ta.focus();
    });

    el.querySelector('.cell-del').addEventListener('click', e => {
      e.stopPropagation();
      this._removeCell(id);
    });

    this._el.container.appendChild(el);
    this._cells.push({ id, el, ta });

    this._autoResize(ta);
    this._activate(id);
    ta.focus();
    el.scrollIntoView({ block: 'end', behavior: 'smooth' });

    return id;
  }

  enable() {
    this._el.btnRun.disabled      = false;
    this._el.btnValidate.disabled = false;
    this._el.btnFormat.disabled   = false;
  }

  disable() {
    this._el.btnRun.disabled      = true;
    this._el.btnValidate.disabled = true;
    this._el.btnFormat.disabled   = true;
  }

  setStatus(msg, type = '') {
    const el   = this._el.status;
    el.textContent = msg;
    el.className   = 'editor-status' + (type ? ' ' + type : '');
  }

  clearStatus() { this.setStatus(''); }

  setRunning(running) {
    this._el.btnRun.classList.toggle('hidden',  running);
    this._el.btnStop.classList.toggle('hidden', !running);
    this._cells.forEach(c => { c.ta.readOnly = running; });
  }

  validate() {
    const query = this.getQuery().trim();
    if (!query) { this._clearValidation(); return; }
    const result = this._parseQuery(query);
    if (result.ok) {
      this._setValidation(true, null);
      if (this._onValidate) this._onValidate(true, null, result.parsed);
    } else {
      this._setValidation(false, result.error);
      if (this._onValidate) this._onValidate(false, result.error, null);
    }
  }

  format() {
    const query = this.getQuery().trim();
    if (!query) return;
    const formatted = this._formatQuery(query);
    if (formatted) {
      const ta = this._activeTa();
      if (ta) { ta.value = formatted; this._autoResize(ta); this._clearValidation(); }
      this.setStatus('Formatted', 'success');
      setTimeout(() => this.clearStatus(), 1500);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _activeTa() {
    const cell = this._cells.find(c => c.id === this._activeId);
    return cell ? cell.ta : null;
  }

  _activate(id) {
    this._cells.forEach(c => c.el.classList.toggle('active', c.id === id));
    if (this._activeId !== id) this._clearValidation();
    this._activeId = id;
  }

  _removeCell(id) {
    const idx = this._cells.findIndex(c => c.id === id);
    if (idx === -1) return;
    this._cells[idx].el.remove();
    this._cells.splice(idx, 1);
    if (this._cells.length === 0) {
      this.newCell();
    } else if (this._activeId === id) {
      const next = this._cells[Math.min(idx, this._cells.length - 1)];
      this._activate(next.id);
      next.ta.focus();
    }
  }

  _autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 80) + 'px';
  }

  _bindToolbar() {
    const { btnRun, btnStop, btnValidate, btnFormat } = this._el;
    btnRun.addEventListener('click',      () => this._onRun      && this._onRun());
    btnStop.addEventListener('click',     () => this._onStop     && this._onStop());
    btnValidate.addEventListener('click', () => this.validate());
    btnFormat.addEventListener('click',   () => this.format());
  }

  _clearValidation() {
    this._el.validDot.className   = 'validation-dot';
    this._el.validDot.title       = '';
    this._el.validMsg.textContent = '';
    this._el.validMsg.classList.add('hidden');
  }

  _setValidation(valid, errorMsg) {
    const dot = this._el.validDot;
    if (valid) {
      dot.className = 'validation-dot valid';
      dot.title     = 'Query syntax is valid';
      this._el.validMsg.classList.add('hidden');
    } else {
      dot.className = 'validation-dot invalid';
      dot.title     = errorMsg || 'Syntax error';
      this._el.validMsg.textContent = errorMsg || 'Syntax error';
      this._el.validMsg.classList.remove('hidden');
    }
  }

  _parseQuery(query) {
    if (window.sparqljs) {
      try {
        const parsed = new window.sparqljs.Parser().parse(query);
        return { ok: true, parsed };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return this._basicValidate(query);
  }

  _basicValidate(query) {
    const q = query.replace(/\s*#[^\n]*/g, '').trim();
    let depth = 0;
    for (const ch of q) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) return { ok: false, error: 'Unexpected "}" \u2014 unbalanced braces' };
    }
    if (depth !== 0) return { ok: false, error: 'Unbalanced braces \u2014 missing "}"' };
    let pdepth = 0;
    for (const ch of q) {
      if (ch === '(') pdepth++;
      else if (ch === ')') pdepth--;
      if (pdepth < 0) return { ok: false, error: 'Unexpected ")" \u2014 unbalanced parentheses' };
    }
    if (pdepth !== 0) return { ok: false, error: 'Unbalanced parentheses \u2014 missing ")"' };
    const upper = q.toUpperCase();
    const hasForm = /^(PREFIX\s+\S+\s+<[^>]*>\s*)*(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/.test(upper);
    if (!hasForm) return { ok: false, error: 'Query must begin with SELECT, ASK, CONSTRUCT, or DESCRIBE' };
    if (/\bSELECT\b/.test(upper) && !/\bWHERE\b/.test(upper)) return { ok: false, error: 'SELECT query is missing a WHERE clause' };
    return { ok: true, parsed: null };
  }

  _formatQuery(query) {
    try {
      let q = query.replace(/\s+/g, ' ').trim();
      q = q.replace(/>\s+(?=PREFIX\b)/gi, '>\n');
      q = q.replace(/>\s+(?=SELECT\b|ASK\b|CONSTRUCT\b|DESCRIBE\b)/gi, '>\n');
      q = q.replace(/\s+WHERE\s*\{/gi, '\nWHERE {');
      q = q.replace(/\{\s*/g, '{\n');
      q = q.replace(/\s*\}/g, '\n}');
      q = q.replace(/\s+(OPTIONAL|FILTER|UNION|MINUS|BIND|VALUES|GRAPH|SERVICE)\b/gi, '\n$1');
      q = q.replace(/\.\s+(?=[?<_])/g, '.\n');
      q = q.replace(/\s+(ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET)\b/gi, '\n$1');
      const lines = q.split('\n').map(l => l.trim()).filter(Boolean);
      const out = [];
      let depth = 0;
      for (const line of lines) {
        const opens  = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        if (line.startsWith('}')) depth = Math.max(0, depth - 1);
        out.push('  '.repeat(depth) + line);
        depth = Math.max(0, line.startsWith('}') ? depth + opens - closes + 1 : depth + opens - closes);
      }
      return out.join('\n');
    } catch { return null; }
  }
}
