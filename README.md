# Grouse — SPARQL Workbench

**GRaph brOWSE** — a lightweight, browser-based SPARQL workbench.

Brings the ergonomics of SQL desktop clients (SQLiteFlow, DBeaver, TablePlus) to SPARQL endpoints. Vanilla HTML/CSS/JS — no build step, no `node_modules`.

---

## Running

```bash
php -S localhost:8000
```

Then open `http://localhost:8000` in your browser. Any static server works — Python's `http.server`, `npx serve`, etc.

---

## Features (Phase 1)

- Connect to any SPARQL endpoint (Wikidata, DBpedia, Fuseki, GraphDB, Virtuoso, …)
- Write and run SPARQL queries with **Ctrl+Enter** (or **Cmd+Enter**)
- Results displayed in a scrollable table with URI linking
- ASK queries show a true/false result
- CONSTRUCT/DESCRIBE queries show raw Turtle
- Basic query validation (structural — balanced braces, query form detection)
- **Export CSV** for SELECT results
- **Save queries** — name and persist queries to localStorage for later reuse
- Draggable sidebar and editor/results dividers — resizes persist across sessions
- Dark theme

---

## Testing Endpoints

| Endpoint | URL |
|---|---|
| Wikidata | https://query.wikidata.org/sparql |
| DBpedia | https://dbpedia.org/sparql |
| UniProt | https://sparql.uniprot.org/sparql |
| OSM Planet | https://qlever.dev/api/osm-planet |
| Persée | https://data.persee.fr/sparql |

---

### Example queries

#### Buildings in Stühlinger (OSM Planet)

```
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX ogc: <http://www.opengis.net/rdf#>
PREFIX osmrel: <https://www.openstreetmap.org/relation/>
SELECT ?osm_id ?hasgeometry
WHERE {
  osmrel:1960198 ogc:sfContains ?osm_id .
  ?osm_id geo:hasGeometry/geo:asWKT ?hasgeometry .
  ?osm_id osmkey:building ?building .
}
```

#### Mungo National Park (OSM Planet)

Finds osm:6321578 https://www.openstreetmap.org/relation/6321578, which is Mungo National Park, which you can see here: https://www.openstreetmap.org/relation/6321578#map=10/-33.5309/143.0487&layers=C

```
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
SELECT *
WHERE {
  ?place osmkey:name "Mungo National Park" .
  ?place geo:hasGeometry/geo:asWKT ?geometry .
}
```

## LSID Resolution

[LSIDs](https://www.tdwg.org/standards/lsid/) (Life Science Identifiers) take the form `urn:lsid:<authority>:<namespace>:<object>` and are widely used in biodiversity data. Bare `urn:` URIs are not resolvable by browsers, so Grouse translates them to HTTP links at display time.

Three modes are available in `js/results.js`:

| Mode | Behaviour |
|------|-----------|
| `'none'` | Display the raw LSID — clicking will fail in most browsers |
| `'proxy'` | Route through `LSID_PROXY_URL` (default: `https://lsid.io/`) which resolves the LSID server-side and redirects to the resource |
| `'native'` | Reserved for a future built-in resolver; currently falls back to proxy behaviour |

To change the proxy or mode, edit the two constants near the top of `js/results.js`:

```js
const LSID_RESOLUTION = 'proxy';          // 'none' | 'proxy' | 'native'
const LSID_PROXY_URL  = 'https://lsid.io/';
```

The tooltip on each LSID link always shows the original `urn:lsid:…` identifier regardless of mode.

---

## CORS

Browser security requires the SPARQL endpoint to send CORS headers (`Access-Control-Allow-Origin: *`). Public endpoints like Wikidata and DBpedia support this. For local/private endpoints:

- **Apache Jena Fuseki** — CORS is supported via the `--cors` flag or `shiro.ini` config
- **GraphDB** — enable CORS in Settings → Advanced
- **Virtuoso** — set `CrossOriginResourceSharing` in `virtuoso.ini`

If you can't enable CORS on the endpoint, a simple PHP proxy is planned for a future release.

---

## SPARQL.js (optional)

The `lib/sparqljs.min.js` slot is reserved for a browser-bundled version of [SPARQL.js](https://github.com/RubenVerborgh/SPARQL.js) for full parse-tree validation. The current validator covers the common structural cases. If you have a bundled copy, drop it in `lib/sparqljs.min.js` and the app will use it automatically.

---

## Roadmap

- **Phase 2** — Schema sidebar: class/property discovery, instance counts, click to insert query
- **Phase 3** — Multi-tab editor, query history
- **Phase 4** — Autocomplete from schema, multiple endpoints, graph visualisation
