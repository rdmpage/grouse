/**
 * map.js — Map visualisation for SPARQL results containing WKT geometries.
 * Requires Leaflet (lib/leaflet.min.js) to be loaded first.
 */

class MapView {
  constructor() {
    this._map      = null;
    this._features = null; // L.featureGroup
  }

  render(vars, bindings, geomCols) {
    if (!this._map) this._initMap();

    this._features.clearLayers();

    const geomCol   = geomCols[0];
    const nonGeom   = vars.filter(v => !geomCols.includes(v));
    const style     = { color: '#4a9eff', weight: 2, fillOpacity: 0.25, fillColor: '#4a9eff' };
    const ptOptions = { radius: 6, color: '#4a9eff', fillColor: '#4a9eff', fillOpacity: 0.8 };

    for (const binding of bindings) {
      const term = binding[geomCol];
      if (!term) continue;

      // Strip optional CRS URI prefix: <...> then whitespace
      const raw = term.value.replace(/^\s*<[^>]+>\s*/, '').trim();
      const geojson = wktToGeoJSON(raw);
      if (!geojson) continue;

      // Build popup HTML from non-geometry columns
      const rows = nonGeom.map(v => {
        const t = binding[v];
        const val = t ? _escapeHtml(t.value) : '<em style="color:#888">—</em>';
        return `<tr><th>${_escapeHtml(v)}</th><td>${val}</td></tr>`;
      }).join('');
      const popupHtml = rows
        ? `<table class="map-popup-table">${rows}</table>`
        : '';

      const layer = L.geoJSON(geojson, {
        style: () => style,
        pointToLayer: (feature, latlng) => L.circleMarker(latlng, ptOptions),
      });

      if (popupHtml) layer.bindPopup(popupHtml);
      layer.addTo(this._features);
    }

    if (this._features.getLayers().length > 0) {
      this._map.fitBounds(this._features.getBounds(), { padding: [20, 20] });
    }

    // Invalidate after 150 ms to handle just-revealed tab layout
    setTimeout(() => { if (this._map) this._map.invalidateSize(); }, 150);
  }

  clear() {
    if (this._features) this._features.clearLayers();
  }

  invalidateSize() {
    if (this._map) this._map.invalidateSize();
  }

  _initMap() {
    this._map = L.map('map-container');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(this._map);
    this._features = L.featureGroup().addTo(this._map);
  }
}

// ── Standalone WKT → GeoJSON ──────────────────────────────────────────────────
// Returns a GeoJSON geometry object, or null on failure.
// Supports: POINT, LINESTRING, POLYGON, MULTIPOINT, MULTILINESTRING, MULTIPOLYGON.
// Coordinates are output as [longitude, latitude] (GeoJSON convention).

function wktToGeoJSON(wkt) {
  if (!wkt) return null;
  const s = wkt.trim();

  try {
    // Match geometry type keyword
    const typeMatch = s.match(/^([A-Z]+)\s*(\(.*\))$/is);
    if (!typeMatch) return null;

    const type   = typeMatch[1].toUpperCase();
    const rest   = typeMatch[2];

    switch (type) {
      case 'POINT':            return _parsePoint(rest);
      case 'LINESTRING':       return _parseLineString(rest);
      case 'POLYGON':          return _parsePolygon(rest);
      case 'MULTIPOINT':       return _parseMultiPoint(rest);
      case 'MULTILINESTRING':  return _parseMultiLineString(rest);
      case 'MULTIPOLYGON':     return _parseMultiPolygon(rest);
      default:                 return null;
    }
  } catch (e) {
    return null;
  }
}

// Parse a coordinate pair "lon lat" or "lon lat z" → [lon, lat]
function _parseCoord(str) {
  const parts = str.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const lon = parseFloat(parts[0]);
  const lat = parseFloat(parts[1]);
  if (isNaN(lon) || isNaN(lat)) return null;
  return [lon, lat];
}

// Parse a sequence of coordinates from "x1 y1, x2 y2, ..."
function _parseCoordSeq(inner) {
  return inner.split(',').map(s => _parseCoord(s)).filter(Boolean);
}

// Strip outer parentheses: "(content)" → "content"
function _stripParens(str) {
  const s = str.trim();
  if (s[0] === '(' && s[s.length - 1] === ')') return s.slice(1, -1);
  return s;
}

function _parsePoint(rest) {
  const inner = _stripParens(rest);
  const coord = _parseCoord(inner);
  if (!coord) return null;
  return { type: 'Point', coordinates: coord };
}

function _parseLineString(rest) {
  const inner = _stripParens(rest);
  return { type: 'LineString', coordinates: _parseCoordSeq(inner) };
}

function _parsePolygon(rest) {
  const inner    = _stripParens(rest);
  const rings    = _splitRings(inner);
  const coords   = rings.map(r => _parseCoordSeq(_stripParens(r)));
  return { type: 'Polygon', coordinates: coords };
}

function _parseMultiPoint(rest) {
  // Each point may be "(x y)" or just "x y"
  const inner  = _stripParens(rest);
  const points = _splitRings(inner).map(p => {
    const s = p.trim();
    const inner2 = s[0] === '(' ? _stripParens(s) : s;
    return _parseCoord(inner2);
  }).filter(Boolean);
  return { type: 'MultiPoint', coordinates: points };
}

function _parseMultiLineString(rest) {
  const inner = _stripParens(rest);
  const lines = _splitRings(inner).map(r => _parseCoordSeq(_stripParens(r)));
  return { type: 'MultiLineString', coordinates: lines };
}

function _parseMultiPolygon(rest) {
  const inner    = _stripParens(rest);
  const polys    = _splitPolygons(inner);
  const coords   = polys.map(p => {
    const pInner = _stripParens(p.trim());
    return _splitRings(pInner).map(r => _parseCoordSeq(_stripParens(r)));
  });
  return { type: 'MultiPolygon', coordinates: coords };
}

// Split a string by commas that are at depth 0 (not inside parentheses)
function _splitAtDepth0(str) {
  const parts = [];
  let depth   = 0;
  let start   = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') { depth++; continue; }
    if (str[i] === ')') { depth--; continue; }
    if (str[i] === ',' && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

// Split ring list: "(x y, x y), (x y, x y)" into individual ring strings
function _splitRings(str) {
  return _splitAtDepth0(str).map(s => s.trim()).filter(Boolean);
}

// Split polygon list for MULTIPOLYGON: "((rings)), ((rings))"
function _splitPolygons(str) {
  return _splitAtDepth0(str).map(s => s.trim()).filter(Boolean);
}

// Minimal HTML escape for popup content
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
