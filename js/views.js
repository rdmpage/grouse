/**
 * views.js — Saved queries (views): CRUD, persistence in localStorage,
 * and sidebar rendering.
 */

class ViewsManager {
  constructor({ onOpen }) {
    this._onOpen   = onOpen;
    this._key      = 'grouse_views';
    this._listEl   = document.getElementById('views-list');
    this._saveBtn  = document.getElementById('btn-save-view');

    this._saveBtn.addEventListener('click', () => this._promptSave());
    this._render();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Save a named view. If called with no arguments, prompts for a name.
   */
  save(name, query, endpointUrl) {
    if (!name || !query) return;
    const views = this._load();
    const id    = Date.now().toString(36) + Math.random().toString(36).slice(2);
    views.push({ id, name, query, endpointUrl, savedAt: Date.now() });
    this._persist(views);
    this._render();
  }

  delete(id) {
    const views = this._load().filter(v => v.id !== id);
    this._persist(views);
    this._render();
  }

  list() {
    return this._load();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _promptSave() {
    // Dispatch custom event so app.js can supply the current query/endpoint
    const event = new CustomEvent('views:save-requested', { bubbles: true, detail: { manager: this } });
    document.dispatchEvent(event);
  }

  showSaveModal(query, endpointUrl) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">Save Query</h2>
        <label for="view-name-input">Name</label>
        <input type="text" id="view-name-input" placeholder="e.g. All people with ORCID" autocomplete="off">
        <div class="modal-actions">
          <button class="btn btn-muted" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-save">Save</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const input     = overlay.querySelector('#view-name-input');
    const saveBtn   = overlay.querySelector('#modal-save');
    const cancelBtn = overlay.querySelector('#modal-cancel');

    input.focus();

    const close = () => overlay.remove();

    const doSave = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      this.save(name, query, endpointUrl);
      close();
    };

    saveBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  doSave();
      if (e.key === 'Escape') close();
    });
  }

  _render() {
    const views = this._load();
    if (views.length === 0) {
      this._listEl.innerHTML = '<div class="sidebar-empty">No saved queries yet.</div>';
      return;
    }

    this._listEl.innerHTML = views.map(v => `
      <div class="view-item" data-id="${this._escape(v.id)}" title="${this._escape(v.query)}">
        <span class="view-item-name">${this._escape(v.name)}</span>
        <button class="view-item-delete" data-id="${this._escape(v.id)}" title="Delete">×</button>
      </div>`).join('');

    // Open view on click
    this._listEl.querySelectorAll('.view-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.classList.contains('view-item-delete')) return;
        const id   = el.dataset.id;
        const view = this._load().find(v => v.id === id);
        if (view && this._onOpen) this._onOpen(view);
      });
    });

    // Delete button
    this._listEl.querySelectorAll('.view-item-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const view = this._load().find(v => v.id === id);
        if (view && confirm(`Delete saved query "${view.name}"?`)) {
          this.delete(id);
        }
      });
    });
  }

  _load() {
    return Storage.get(this._key, []);
  }

  _persist(views) {
    Storage.set(this._key, views);
  }

  _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
