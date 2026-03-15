<?php
/**
 * proxy.php — SPARQL proxy to sidestep browser CORS restrictions.
 *
 * endpoint.js POSTs here whenever the target endpoint is on a different
 * origin (different host or port). PHP forwards the query server-side
 * and pipes the response back verbatim.
 *
 * POST params:
 *   endpoint  — full SPARQL endpoint URL
 *   query     — SPARQL query string
 *
 * The Accept header from the browser is forwarded to the endpoint.
 */

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('Method Not Allowed');
}

$endpoint = trim($_POST['endpoint'] ?? '');
$query    = trim($_POST['query']    ?? '');
$accept   = $_SERVER['HTTP_ACCEPT'] ?? 'application/sparql-results+json';

// ── Validate inputs ────────────────────────────────────────────────────────

if (!$endpoint || !$query) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Missing endpoint or query parameter']);
    exit;
}

if (!preg_match('/^https?:\/\//i', $endpoint)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Endpoint must be an http:// or https:// URL']);
    exit;
}

if (!function_exists('curl_init')) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'PHP cURL extension is required but not available']);
    exit;
}

// ── Forward the query ──────────────────────────────────────────────────────

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL            => $endpoint,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => http_build_query(['query' => $query]),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/x-www-form-urlencoded',
        'Accept: ' . $accept,
    ],
    CURLOPT_TIMEOUT        => 60,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 3,
]);

$body     = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$ct       = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$curlErr  = curl_error($ch);
curl_close($ch);

// ── Return the response ────────────────────────────────────────────────────

if ($curlErr) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Proxy error: ' . $curlErr]);
    exit;
}

http_response_code($httpCode);
if ($ct) header('Content-Type: ' . $ct);
echo $body;
