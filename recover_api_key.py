"""
Recover existing Polymarket API credentials from your private key.
Credentials are deterministically derived — this gives back the SAME
key/secret/passphrase you originally created, not new ones.

Usage:
    python3 recover_api_key.py <your_private_key>

The private key is the same one in your bot settings (poly-private-key).
"""

import sys

def recover():
    if len(sys.argv) < 2:
        print("Usage: python3 recover_api_key.py <private_key>")
        sys.exit(1)

    private_key = sys.argv[1].strip()

    try:
        from py_clob_client.client import ClobClient
    except ImportError:
        print("ERROR: py-clob-client not installed. Run: pip install py-clob-client")
        sys.exit(1)

    CLOB_API = "https://clob.polymarket.com"
    CHAIN_ID = 137  # Polygon mainnet

    print("Connecting to Polymarket CLOB...")
    client = ClobClient(CLOB_API, key=private_key, chain_id=CHAIN_ID)

    print("Deriving API credentials from private key...")
    try:
        creds = client.derive_api_key()
        print("\n✓ API credentials recovered:\n")
        print(f"  API Key:        {creds.api_key}")
        print(f"  API Secret:     {creds.api_secret}")
        print(f"  API Passphrase: {creds.api_passphrase}")
        print("\nPaste these into the bot settings page (poly-api-key, poly-api-secret, poly-passphrase).")
    except Exception as e:
        print(f"\nderive_api_key failed: {e}")
        print("\nTrying create_api_key as fallback...")
        try:
            creds = client.create_api_key()
            print("\n✓ New API credentials created:\n")
            print(f"  API Key:        {creds.api_key}")
            print(f"  API Secret:     {creds.api_secret}")
            print(f"  API Passphrase: {creds.api_passphrase}")
            print("\nPaste these into the bot settings page.")
        except Exception as e2:
            print(f"\ncreate_api_key also failed: {e2}")
            print("\nThis usually means the wallet already has keys and they need to be")
            print("recovered via derive_api_key. Check that py-clob-client is up to date:")
            print("  pip install --upgrade py-clob-client")

if __name__ == "__main__":
    recover()
