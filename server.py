#!/usr/bin/env python3
"""
Server for the Polymarket AI frontend.

Serves static files from frontend/ and proxies Gamma API requests
to avoid CORS issues in the browser.

Usage:
    python server.py [port]           (default port: 8080)
    PORT=3000 python server.py        (env var, used by cloud platforms)
"""

import sys
import os
import json
import urllib.request
import urllib.parse
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler

# Allow importing from bot/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "bot"))

GAMMA_API = "https://gamma-api.polymarket.com"
PROXY_PREFIX = "/api/gamma"
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "frontend")


class ProxyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        elif self.path.startswith("/price"):
            self._handle_price()
        elif self.path.startswith(PROXY_PREFIX):
            self._proxy_gamma()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/trade":
            self._handle_trade()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_trade(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))

            token_id      = body["token_id"]
            side          = body.get("side", "BUY")
            amount_usdc   = float(body["amount_usdc"])
            entry_price   = float(body["entry_price"]) if "entry_price" in body else None
            order_type    = body.get("order_type", "fok")   # "fok" or "gtc"
            private_key   = body["private_key"]
            api_key       = body["api_key"]
            api_secret    = body["api_secret"]
            api_passphrase = body["api_passphrase"]

            from market_client import PolymarketClient
            client = PolymarketClient(
                api_key=api_key,
                api_secret=api_secret,
                api_passphrase=api_passphrase,
                private_key=private_key,
            )

            result = client.place_market_order(token_id, side, amount_usdc, dry_run=False,
                                               entry_price=entry_price, order_type=order_type)
            resp = json.dumps(result).encode()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(resp)

        except Exception as e:
            err = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(err)

    def _handle_price(self):
        """Return live best_bid/best_ask from the Polymarket CLOB (public, no auth)."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            token_id = params.get("token_id", [None])[0]
            if not token_id:
                raise ValueError("missing token_id")

            clob_url = f"https://clob.polymarket.com/book?token_id={urllib.parse.quote(token_id)}"
            req = urllib.request.Request(clob_url, headers={"User-Agent": "polymarket-ai-bot/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                book = json.loads(resp.read())

            bids = book.get("bids", [])
            asks = book.get("asks", [])
            best_bid = float(bids[0]["price"]) if bids else 0.0
            best_ask = float(asks[0]["price"]) if asks else 1.0

            # Pass top-15 depth levels so frontend can simulate fill price for our order size
            ask_levels = [{"price": float(a["price"]), "size": float(a["size"])} for a in asks[:15]]
            bid_levels = [{"price": float(b["price"]), "size": float(b["size"])} for b in bids[:15]]

            # last_trade_price: "0" until a real trade has happened. Used by the frontend
            # early-window gate as a signal that the book has moved past the 50¢/50¢ phase.
            try:    last_trade_price = float(book.get("last_trade_price") or 0)
            except: last_trade_price = 0.0

            body = json.dumps({
                "best_bid": best_bid,
                "best_ask": best_ask,
                "asks": ask_levels,
                "bids": bid_levels,
                "last_trade_price": last_trade_price,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            err = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(err)

    def _proxy_gamma(self):
        # Strip /api/gamma prefix and forward to Gamma API
        suffix = self.path[len(PROXY_PREFIX):]
        upstream_url = GAMMA_API + suffix

        try:
            req = urllib.request.Request(
                upstream_url,
                headers={"User-Agent": "polymarket-ai-bot/1.0"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            msg = str(e).encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, fmt, *args):
        # Suppress noisy access logs for static assets
        path = args[0] if args else ""
        if not any(path.endswith(ext) for ext in (".css", ".js", ".ico", ".png")):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8080))
    server = HTTPServer(("0.0.0.0", port), ProxyHandler)
    print(f"Server running on port {port}")
    print(f"Serving frontend from: {FRONTEND_DIR}")
    print(f"Proxying /api/gamma/* → {GAMMA_API}/*")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
