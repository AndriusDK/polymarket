<?php
// Proxy for Polymarket Gamma API — avoids CORS issues in the browser.
// Forwards all GET params directly to the /markets endpoint.

if ($_SERVER["REQUEST_METHOD"] !== "GET") {
    http_response_code(405);
    exit("Method Not Allowed");
}

$query = http_build_query($_GET);
$url   = "https://gamma-api.polymarket.com/markets" . ($query ? "?$query" : "");

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 15,
    CURLOPT_HTTPHEADER     => ["User-Agent: polymarket-ai-bot/1.0"],
    CURLOPT_SSL_VERIFYPEER => true,
]);

$body   = curl_exec($ch);
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
