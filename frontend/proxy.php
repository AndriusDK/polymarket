<?php
// Proxy for Polymarket Gamma API — avoids CORS issues in the browser.
// Place this file anywhere on your web server and point GAMMA_API in api.js to its URL.

$GAMMA_API = "https://gamma-api.polymarket.com";

// Only allow GET requests
if ($_SERVER["REQUEST_METHOD"] !== "GET") {
    http_response_code(405);
    exit("Method Not Allowed");
}

// Forward the path and query string
$path  = isset($_GET["path"])  ? $_GET["path"]  : "/markets";
$query = isset($_GET["query"]) ? $_GET["query"] : "";

// Whitelist allowed paths to prevent open proxy abuse
if (!preg_match('#^/markets(/|$)#', $path) && $path !== "/markets") {
    http_response_code(403);
    exit("Forbidden");
}

$url = $GAMMA_API . $path . ($query ? "?" . $query : "");

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 15,
    CURLOPT_HTTPHEADER     => ["User-Agent: polymarket-ai-bot/1.0"],
    CURLOPT_SSL_VERIFYPEER => true,
]);

$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error  = curl_error($ch);
curl_close($ch);

if ($error) {
    http_response_code(502);
    header("Content-Type: text/plain");
    exit("Proxy error: " . $error);
}

http_response_code($status);
header("Content-Type: application/json");
header("Access-Control-Allow-Origin: *");
echo $body;
