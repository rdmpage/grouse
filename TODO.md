# Grouse — Roadmap / TODO

## Phase 3 — Schema: Relationships view

The schema browser currently shows types and their literal properties. The next
step is to reveal how types relate to each other (object properties).

### Relationship query

For each type `<$URI>`, run:

```sparql
PREFIX rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX schema: <http://schema.org/>
SELECT ?direction ?predicate ?nThings ?example (SAMPLE(?t) AS ?exampleType)
WHERE {
  {
    SELECT ("incoming" AS ?direction) ?predicate
           (COUNT(DISTINCT ?thing) AS ?nThings) (SAMPLE(?thing) AS ?example)
    WHERE {
      ?centre a <$URI> .
      ?thing ?predicate ?centre .
      FILTER(isIRI(?thing))
      FILTER(?predicate != rdf:type)
    }
    GROUP BY ?predicate
  }
  UNION
  {
    SELECT ("outgoing" AS ?direction) ?predicate
           (COUNT(DISTINCT ?thing) AS ?nThings) (SAMPLE(?thing) AS ?example)
    WHERE {
      ?centre a <$URI> .
      ?centre ?predicate ?thing .
      FILTER(isIRI(?thing))
      FILTER(?predicate != rdf:type)
    }
    GROUP BY ?predicate
  }
  OPTIONAL { ?example a ?t }
}
GROUP BY ?direction ?predicate ?nThings ?example
ORDER BY ?direction DESC(?nThings)
```

### UI

- When a type `<details>` is open, the results toolbar gains two extra buttons:
  **Properties** (default, current table view) and **Connections** (Mermaid graph).
- The normal query toolbar buttons (Table / Response / RDF…) are hidden in schema
  context and restored when the user runs a regular SPARQL query (`results.clear()`
  resets the mode).
- Clicking **Connections** runs the relationship query and renders a Mermaid
  flowchart with the type as the centre node, annotated with predicate labels and
  `nThings` counts.
- Clicking **Properties** re-runs the sample query and shows the table view.

### Mermaid rendering

- Load Mermaid from CDN or bundle in `lib/`.
- Render into a dedicated `#tab-schema-graph` panel (or reuse the existing results
  panel with `innerHTML`).
- Node labels: shortened URI or `rdfs:label`. Edge labels: predicate local name +
  count. Incoming edges point *to* the centre node; outgoing edges point *from* it.

---

## Schema caching

Currently the types query re-runs on every connect and per-type properties are
fetched fresh on every `<details>` open.

### Plan

- Cache schema data in `localStorage` keyed by endpoint URL, with a **1-week TTL**.
- Store format (same shape as external YAML — see below):
  ```json
  {
    "endpoint": "https://…",
    "cached":   "2026-03-16T15:00:00Z",
    "types": [
      {
        "uri":   "http://schema.org/Person",
        "label": "Person",
        "count": 12450000,
        "properties": null
      }
    ]
  }
  ```
- `properties: null` means not yet fetched; `properties: []` means fetched and
  empty. Once loaded, the array of `{ uri, count }` objects is written back to the
  cache entry for that type.
- Add a **↻ Refresh schema** button in the Schema section header to force
  invalidation and re-fetch.
- Implement in `schema.js` using the existing `Storage` wrapper.

---

## External YAML schema files (large/complex triple stores)

For triple stores too large for live queries (e.g. Wikidata, large biodiversity
graphs), support loading a hand-authored or pre-generated YAML file that
describes the schema.

### File format

```yaml
endpoint: https://query.wikidata.org/sparql
cached:   2026-03-01T00:00:00Z
types:
  - uri:   http://www.wikidata.org/ontology#Item
    label: Item
    count: 100000000
    properties:
      - uri:   http://schema.org/name
        count: 80000000
      - uri:   http://www.w3.org/2004/02/skos/core#altLabel
        count: 60000000
```

- Same structure as the localStorage cache — one code path reads both.
- UI: a **Load schema file…** button in the Schema section header opens a file
  picker accepting `.yaml` / `.yml`.
- Parsed with a minimal YAML parser (or convert to JSON if simpler).
- Loaded schema is stored in `localStorage` under the endpoint URL, overwriting
  any live-queried cache, with the file's `cached` timestamp preserved.
