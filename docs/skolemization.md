# Skolemization: replacing blank nodes with stable URIs

## The problem

Blank nodes (`_:b0`, `_:b1`, …) are anonymous RDF resources — they have no
URI, so two separate graphs cannot agree that `_:b0` in one graph is the same
thing as `_:b1` in another. This causes duplicates in graph visualisations and
makes data harder to merge, query, and dereference.

A common symptom: a DESCRIBE query returns a graph where "Oxford University
Press" appears as ten separate orange nodes, because the source RDF minted a
fresh blank node for the publisher in every record.

## What skolemization is

Skolemization (from the W3C RDF 1.1 spec,
https://www.w3.org/TR/rdf11-concepts/#section-skolemization) is the process of
replacing blank nodes with IRIs. The resulting URIs carry no additional meaning
— they are just stable identifiers — but they allow the same entity to be
recognised across records and graphs.

The W3C suggests the path `/.well-known/genid/` as a conventional location for
these generated URIs (building on IETF RFC 5785, which reserves `/.well-known/`
for machine-readable site metadata). In practice this convention is optional;
what matters is that the URI is stable and under a domain you control.

For background on good URI design generally, see the W3C's "Cool URIs for the
Semantic Web": https://www.w3.org/TR/cooluris/

---

## Strategy 1 — Named-entity slug URIs (preferred)

Use this when the entity has a human-readable identifying property (name,
title, code) and you want readable URIs.

**Pattern**

```
https://{your-domain}/{type}/{slug}
```

**PHP example**

```php
function slugUri(string $base, string $type, string $name): string {
    $slug = strtolower(trim($name));
    $slug = preg_replace('/[^a-z0-9]+/', '-', $slug);
    $slug = trim($slug, '-');
    return $base . '/' . $type . '/' . rawurlencode($slug);
}

// Usage
$uri = slugUri('https://rdmpage.github.io', 'publisher', 'Oxford University Press (OUP)');
// → https://rdmpage.github.io/publisher/oxford-university-press-oup

$publisher = $graph->resource($uri);
$publisher->set('schema:name', 'Oxford University Press (OUP)');
```

**Pros:** human-readable, debuggable, stable as long as the name is consistent
**Cons:** name variations (`OUP` vs `Oxford University Press`) produce different
URIs — normalise the name before slugging

---

## Strategy 2 — Content-hash URIs

Use this when there is no clean natural key, or when you want a fully
mechanical process that cannot produce collisions from name variations.

**Pattern**

```
https://{your-domain}/genid/{hex-hash}
```

Hash the entity's defining properties (type + name, or type + ISSN, etc.) to
get a short, stable, collision-resistant token.

**PHP example**

```php
function hashUri(string $base, string ...$parts): string {
    $hash = substr(md5(implode('|', $parts)), 0, 12);
    return $base . '/genid/' . $hash;
}

// Usage — publisher identified by name
$uri = hashUri('https://rdmpage.github.io', 'publisher', 'Oxford University Press (OUP)');

// Usage — journal identified by ISSN
$uri = hashUri('https://rdmpage.github.io', 'journal', '0039-7989');
```

**Pros:** fully automatic, no normalisation needed, works for any entity type
**Cons:** opaque URIs; changing the hash inputs (even fixing a typo) changes
the URI

---

## Strategy 3 — Use existing external identifiers (best of all)

Where a stable third-party URI already exists, use it directly rather than
minting your own.

| Entity type | Identifier | Example URI |
|---|---|---|
| Organisation | ROR | `https://ror.org/052gg0110` |
| Journal | ISSN-L via ISSN.org | `https://www.issn.org/resource/ISSN/0039-7989` |
| Person | ORCID | `https://orcid.org/0000-0002-7101-9767` |
| Article | DOI | `https://doi.org/10.1093/sysbio/syy072` |
| Taxon | GBIF / COL | `https://www.gbif.org/species/2436775` |

These URIs are already dereferenceable, globally unique, and maintained by
authoritative registries. Prefer them over any locally minted URI.

---

## Recommended approach for DOI metadata

When generating RDF from Crossref / DataCite JSON:

1. **Article** — use the DOI URI directly (`https://doi.org/…`)
2. **Authors** — use ORCID if present; otherwise mint a hash URI from
   `(givenName, familyName, affiliation)`
3. **Publisher** — look up the ROR ID; otherwise mint a slug from the
   publisher name (Crossref normalises publisher names, so slugs are stable)
4. **Journal** — use the ISSN-L as a URI; otherwise mint a slug from the
   journal title
5. **Affiliation** — use the ROR ID if Crossref supplies it (it increasingly
   does); otherwise mint a slug or hash from the affiliation string

The goal is: the same real-world entity → the same URI, every time, across
every record you process.
