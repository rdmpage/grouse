/**
 * storage.js — thin wrapper around localStorage with JSON serialisation.
 */

const Storage = (() => {
  function get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('Storage.set failed:', e);
    }
  }

  function remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }

  function update(key, updater, fallback = {}) {
    set(key, updater(get(key, fallback)));
  }

  return { get, set, remove, update };
})();
