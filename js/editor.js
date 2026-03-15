/**
 * editor.js — Query editor: textarea, line numbers, validation, run/stop.
 *
 * Uses SPARQL.js (window.sparqljs) for validation when available;
 * falls back to a structural syntax check otherwise.
 */

class QueryEditor {
  constructor({ onRun, onStop, onValidate }) {
    this._onRun      = onRun;
    this._onStop     = onStop;
    this._onValidate = onValidate;
    this._valid      = null;   // true | false | null (unknown)

    this._el = {
      editor:     document.getElementById('query-editor'),
      lineNums:   document.getElementById('line-numbers'),
      status:     document.getElementById('editor-status'),
      validDot:   document.getElementById('validation-dot'),
      validMsg:   document.getElementById('validation-message'),
      btnRun:     document.getElementById('btn-run'),
      btnStop:    document.getElementById('btn-stop'),
      btnValidate:document.getElementById('btn-validate'),
      btnFormat:  document.getElementById('btn-format'),
    };

    this._bind();
    this._updateLineNumbers();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getQuery() {
    return this._el.editor.value;
  }

  setQuery(text) {
    this._el.editor.value = text;
    this._updateLineNumbers();
    this._clearValidation();
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
    const el = this._el.status;
    el.textContent = msg;
    el.className   = 'editor-status' + (type ? ' ' + type : '');
  }

  clearStatus() {
    this.setStatus('');
  }

  setRunning(running) {
    this._el.btnRun.classList.toggle('hidden', running);
    this._el.btnStop.classList.toggle('hidden', !running);
    this._el.editor.readOnly = running;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  validate() {
    const query = this.getQuery().trim();
    if (!query) {
      this._clearValidation();
      return;
    }

    const result = this._parseQuery(query);

    if (result.ok) {
      this._setValidation(true, null);
      if (this._onValidate) this._onValidate(true, null, result.parsed);
    } else {
      this._setValidation(false, result.error);
      if (this._onValidate) this._onValidate(false, result.error, null);
    }
  }

  // ── Format ────────────────────────────────────────────────────────────────

  format() {
    const query = this.getQuery().trim();
    if (!query) return;

    const formatted = this._formatQuery(query);
    if (formatted) {
      this.setQuery(formatted);
      this.setStatus('Formatted', 'success');
      setTimeout(() => this.clearStatus(), 1500);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _bind() {
    const { editor, btnRun, btnStop, btnValidate, btnFormat } = this._el;

    // Sync line numbers on every input
    editor.addEventListener('input', () => {
      this._updateLineNumbers();
      this._clearValidation();
    });

    // Keep line numbers in sync with scroll
    editor.addEventListener('scroll', () => this._syncScroll());

    // Tab key → insert spaces (don't move focus)
    editor.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: e2, value } = editor;
        const indent = '  ';
        editor.value = value.slice(0, s) + indent + value.slice(e2);
        editor.selectionStart = editor.selectionEnd = s + indent.length;
        this._updateLineNumbers();
        return;
      }

      // Ctrl/Cmd + Enter → run
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!btnRun.disabled) this._onRun && this._onRun();
        return;
      }

      // Ctrl/Cmd + Shift + F → format
      if (e.key === 'F' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        this.format();
      }
    });

    btnRun.addEventListener('click', () => {
      if (this._onRun) this._onRun();
    });

    btnStop.addEventListener('click', () => {
      if (this._onStop) this._onStop();
    });

    btnValidate.addEventListener('click', () => this.validate());

    btnFormat.addEventListener('click', () => this.format());
  }

  _updateLineNumbers() {
    const lines = this._el.editor.value.split('\n');
    this._el.lineNums.innerHTML = lines
      .map((_, i) => `<div>${i + 1}</div>`)
      .join('');
    this._syncScroll();
  }

  _syncScroll() {
    this._el.lineNums.scrollTop = this._el.editor.scrollTop;
  }

  _clearValidation() {
    this._valid = null;
    this._el.validDot.className  = 'validation-dot';
    this._el.validDot.title      = '';
    this._el.validMsg.textContent = '';
    this._el.validMsg.classList.add('hidden');
  }

  _setValidation(valid, errorMsg) {
    this._valid = valid;
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

  // ── SPARQL parsing ────────────────────────────────────────────────────────

  _parseQuery(query) {
    // Try SPARQL.js first (if loaded)
    if (window.sparqljs) {
      try {
        const Parser = new window.sparqljs.Parser();
        const parsed = Parser.parse(query);
        return { ok: true, parsed };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // Fallback: structural checks
    return this._basicValidate(query);
  }

  _basicValidate(query) {
    const q = query.replace(/\s*#[^\n]*/g, '').trim();

    // Check balanced braces
    let depth = 0;
    for (const ch of q) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) return { ok: false, error: 'Unexpected "}" — unbalanced braces' };
    }
    if (depth !== 0) return { ok: false, error: 'Unbalanced braces — missing "}"' };

    // Check balanced parentheses
    let pdepth = 0;
    for (const ch of q) {
      if (ch === '(') pdepth++;
      else if (ch === ')') pdepth--;
      if (pdepth < 0) return { ok: false, error: 'Unexpected ")" — unbalanced parentheses' };
    }
    if (pdepth !== 0) return { ok: false, error: 'Unbalanced parentheses — missing ")"' };

    // Check for a query form keyword
    const upper = q.toUpperCase();
    const hasForm = /^(PREFIX\s+\S+\s+<[^>]*>\s*)*(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/.test(upper);
    if (!hasForm) {
      return { ok: false, error: 'Query must begin with SELECT, ASK, CONSTRUCT, or DESCRIBE (after PREFIX declarations)' };
    }

    // Check WHERE clause for SELECT
    if (/\bSELECT\b/.test(upper) && !/\bWHERE\b/.test(upper)) {
      return { ok: false, error: 'SELECT query is missing a WHERE clause' };
    }

    return { ok: true, parsed: null };
  }

  // ── Formatter ─────────────────────────────────────────────────────────────

  _formatQuery(query) {
    try {
      // 1. Collapse all whitespace runs to a single space.
      let q = query.replace(/\s+/g, ' ').trim();

      // 2. Insert newlines at structural boundaries (coarse → fine).

      // Between successive PREFIX declarations.
      q = q.replace(/>\s+(?=PREFIX\b)/gi, '>\n');

      // Between the last PREFIX URI and the query-form keyword.
      q = q.replace(/>\s+(?=SELECT\b|ASK\b|CONSTRUCT\b|DESCRIBE\b)/gi, '>\n');

      // Before WHERE { (SELECT vars stay on the SELECT line).
      q = q.replace(/\s+WHERE\s*\{/gi, '\nWHERE {');

      // After every opening brace.
      q = q.replace(/\{\s*/g, '{\n');

      // Before every closing brace.
      q = q.replace(/\s*\}/g, '\n}');

      // Clause-level keywords inside graph patterns.
      q = q.replace(/\s+(OPTIONAL|FILTER|UNION|MINUS|BIND|VALUES|GRAPH|SERVICE)\b/gi, '\n$1');

      // Triple terminator dot before a variable, URI, or blank node.
      q = q.replace(/\.\s+(?=[?<_])/g, '.\n');

      // Result modifiers on their own line.
      q = q.replace(/\s+(ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET)\b/gi, '\n$1');

      // 3. Re-indent based on brace depth.
      const lines = q.split('\n').map(l => l.trim()).filter(Boolean);
      const out   = [];
      let depth   = 0;

      for (const line of lines) {
        const opens  = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;

        // Decrease depth before a line that opens with '}'.
        if (line.startsWith('}')) depth = Math.max(0, depth - 1);

        out.push('  '.repeat(depth) + line);

        // Adjust depth after the line; compensate for the pre-decrement above.
        depth = Math.max(0, line.startsWith('}')
          ? depth + opens - closes + 1   // +1 undoes the pre-decrement
          : depth + opens - closes);
      }

      return out.join('\n');
    } catch {
      return null;
    }
  }
}
