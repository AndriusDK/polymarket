"""
1. Approves CTF Exchange to transfer your conditional tokens (fixes SELL orders)
2. Redeems all resolved winning positions for USDC.e

Usage:
    python3 redeem_all.py <private_key>
"""

import sys
import requests

CTF_TOKEN         = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"  # ERC1155
CTF_EXCHANGE      = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"
NEG_RISK_ADAPTER  = "0xd91E80cF2EA7be683d6e2C87B9DaAe82D2Beb9a8"
USDC_E            = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
ZERO_BYTES32      = b"\x00" * 32

POLYGON_RPCS = [
    "https://rpc.ankr.com/polygon",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.llamarpc.com",
    "https://polygon.meowrpc.com",
    "https://1rpc.io/matic",
]

ERC1155_ABI = [
    {
        "name": "setApprovalForAll",
        "type": "function",
        "inputs": [
            {"name": "operator", "type": "address"},
            {"name": "approved",  "type": "bool"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "isApprovedForAll",
        "type": "function",
        "inputs": [
            {"name": "account",  "type": "address"},
            {"name": "operator", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
    },
    {
        "name": "redeemPositions",
        "type": "function",
        "inputs": [
            {"name": "collateralToken",     "type": "address"},
            {"name": "parentCollectionId",  "type": "bytes32"},
            {"name": "conditionId",         "type": "bytes32"},
            {"name": "indexSets",           "type": "uint256[]"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "balanceOf",
        "type": "function",
        "inputs": [
            {"name": "account", "type": "address"},
            {"name": "id",      "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
]


def connect(rpcs):
    from web3 import Web3
    for rpc in rpcs:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 8}))
            if w3.is_connected():
                print(f"Connected via {rpc}")
                return w3
        except Exception:
            continue
    raise RuntimeError("Could not connect to any Polygon RPC")


def get_condition_id(token_id: str) -> str | None:
    """Fetch conditionId for a token from the CLOB API."""
    try:
        r = requests.get(
            "https://clob.polymarket.com/markets",
            params={"token_id": token_id},
            timeout=10,
        )
        if r.ok:
            data = r.json()
            cid = data.get("condition_id") or data.get("conditionId")
            if cid:
                return cid
    except Exception as e:
        print(f"  CLOB API error: {e}")
    return None


def get_user_positions(wallet: str) -> list[dict]:
    """Fetch open positions from Polymarket data API."""
    endpoints = [
        f"https://data-api.polymarket.com/positions?user={wallet}&sizeThreshold=0.01",
        f"https://gamma-api.polymarket.com/positions?user={wallet}",
    ]
    for url in endpoints:
        try:
            r = requests.get(url, timeout=15)
            if r.ok:
                data = r.json()
                if isinstance(data, list) and data:
                    print(f"Found {len(data)} position(s) from {url.split('/')[2]}")
                    return data
        except Exception:
            continue
    return []


def main(private_key: str):
    from web3 import Web3
    from eth_account import Account

    w3      = connect(POLYGON_RPCS)
    account = Account.from_key(private_key)
    wallet  = account.address
    print(f"Wallet: {wallet}\n")

    ctf    = w3.eth.contract(address=Web3.to_checksum_address(CTF_TOKEN), abi=ERC1155_ABI)
    nonce  = w3.eth.get_transaction_count(wallet)

    # ── Step 1: setApprovalForAll for all exchange contracts ──────────────
    print("── Step 1: ERC1155 approvals (needed for SELL orders) ──")
    exchanges = [
        ("CTF Exchange",      CTF_EXCHANGE),
        ("Neg Risk Exchange", NEG_RISK_EXCHANGE),
        ("Neg Risk Adapter",  NEG_RISK_ADAPTER),
    ]
    for name, addr in exchanges:
        cs = Web3.to_checksum_address(addr)
        if ctf.functions.isApprovedForAll(wallet, cs).call():
            print(f"  ✓ {name}: already approved")
            continue
        print(f"  Approving {name}...", end=" ", flush=True)
        tx = ctf.functions.setApprovalForAll(cs, True).build_transaction({
            "from":     wallet,
            "nonce":    nonce,
            "gas":      100_000,
            "gasPrice": w3.eth.gas_price,
            "chainId":  137,
        })
        signed  = w3.eth.account.sign_transaction(tx, private_key)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status == 1:
            print(f"✓ confirmed ({tx_hash.hex()[:16]}...)")
        else:
            print(f"✗ FAILED")
        nonce += 1

    # ── Step 2: Redeem resolved positions ────────────────────────────────
    print("\n── Step 2: Redeem resolved positions ──")
    positions = get_user_positions(wallet)

    if not positions:
        print("  No positions found via API — trying known token IDs from logs...")
        # Fallback: known token IDs captured in trading logs
        positions = [
            {"token_id": "47434840510424669123903753382175841069751983405163165733920213361038701462753"},
            {"token_id": "98377969270960866518640723186744526412466171120248279359716763364026628939091"},
        ]

    redeemed = 0
    seen_conditions = set()

    for pos in positions:
        token_id  = str(pos.get("asset_id") or pos.get("token_id") or pos.get("tokenId") or "")
        cond_id   = pos.get("conditionId") or pos.get("condition_id") or ""
        market    = pos.get("title") or pos.get("market") or token_id[:20] + "..."

        if not token_id:
            continue

        # Check on-chain balance
        try:
            balance = ctf.functions.balanceOf(wallet, int(token_id)).call()
        except Exception:
            balance = 0

        if balance == 0:
            print(f"  SKIP {market[:50]} — balance 0")
            continue

        print(f"  Found {balance / 1e6:.4f} tokens: {market[:50]}")

        # Get conditionId if not in position data
        if not cond_id:
            cond_id = get_condition_id(token_id)

        if not cond_id:
            print(f"    ✗ Could not find conditionId — skipping")
            continue

        if cond_id in seen_conditions:
            print(f"    Already redeemed this condition")
            continue
        seen_conditions.add(cond_id)

        # Redeem both index sets — winning tokens return $1, losing return $0
        cond_bytes = bytes.fromhex(cond_id.lstrip("0x"))
        print(f"    Redeeming conditionId {cond_id[:16]}...", end=" ", flush=True)
        try:
            tx = ctf.functions.redeemPositions(
                Web3.to_checksum_address(USDC_E),
                ZERO_BYTES32,
                cond_bytes,
                [1, 2],  # both YES and NO index sets; only winner pays
            ).build_transaction({
                "from":     wallet,
                "nonce":    nonce,
                "gas":      200_000,
                "gasPrice": w3.eth.gas_price,
                "chainId":  137,
            })
            signed  = w3.eth.account.sign_transaction(tx, private_key)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                print(f"✓ confirmed ({tx_hash.hex()[:16]}...)")
                redeemed += 1
            else:
                print(f"✗ FAILED (market may not be resolved yet)")
        except Exception as e:
            print(f"✗ Error: {e}")
        nonce += 1

    print(f"\nDone. Redeemed {redeemed} position(s).")
    print("Check your USDC.e balance — winning tokens converted to USDC.e.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 redeem_all.py <private_key>")
        sys.exit(1)
    main(sys.argv[1].strip())
