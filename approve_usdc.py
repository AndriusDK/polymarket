"""
Approve USDC for Polymarket's exchange contracts on Polygon.
This is required once before the CLOB bot can place orders.

Usage:
    python3 approve_usdc.py <your_private_key>
"""

import sys

# Polymarket contract addresses on Polygon mainnet
CTF_EXCHANGE          = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"
NEG_RISK_ADAPTER      = "0xd91E80cF2EA7be683d6e2C87B9DaAe82D2Beb9a8"

# USDC on Polygon (native USDC — not bridged USDC.e)
USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"

POLYGON_RPCS = [
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon-rpc.com",
    "https://1rpc.io/matic",
]

ERC20_APPROVE_ABI = [
    {
        "name": "approve",
        "type": "function",
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount",  "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
    },
    {
        "name": "allowance",
        "type": "function",
        "inputs": [
            {"name": "owner",   "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
    {
        "name": "balanceOf",
        "type": "function",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
]

MAX_UINT256 = 2**256 - 1


def approve(private_key: str):
    try:
        from web3 import Web3
        from eth_account import Account
    except ImportError:
        print("ERROR: web3 not installed. Run: pip install web3")
        sys.exit(1)

    w3 = None
    for rpc in POLYGON_RPCS:
        try:
            candidate = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 8}))
            if candidate.is_connected():
                print(f"Connected via {rpc}")
                w3 = candidate
                break
        except Exception:
            continue
    if w3 is None:
        print("ERROR: Could not connect to any Polygon RPC")
        sys.exit(1)

    account = Account.from_key(private_key)
    wallet  = account.address
    print(f"Wallet: {wallet}")

    usdc = w3.eth.contract(address=Web3.to_checksum_address(USDC), abi=ERC20_APPROVE_ABI)

    balance = usdc.functions.balanceOf(wallet).call()
    print(f"USDC balance: {balance / 1e6:.2f} USDC")

    if balance == 0:
        print("\nWARNING: Wallet has 0 native USDC (0x3c499c...). Checking USDC.e...")
        USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
        usdce = w3.eth.contract(address=Web3.to_checksum_address(USDCE), abi=ERC20_APPROVE_ABI)
        bal_e = usdce.functions.balanceOf(wallet).call()
        print(f"USDC.e balance: {bal_e / 1e6:.2f} USDC.e")
        if bal_e > 0:
            print("You have USDC.e (bridged). Polymarket needs native USDC.")
            print("Swap USDC.e → USDC on Polygon via https://app.uniswap.org or similar.")
        else:
            print("No USDC found. Deposit USDC to your wallet first.")
        sys.exit(1)

    contracts_to_approve = [
        ("CTF Exchange",          CTF_EXCHANGE),
        ("Neg Risk CTF Exchange", NEG_RISK_CTF_EXCHANGE),
        ("Neg Risk Adapter",      NEG_RISK_ADAPTER),
    ]

    nonce = w3.eth.get_transaction_count(wallet)

    for name, spender in contracts_to_approve:
        spender_cs = Web3.to_checksum_address(spender)
        current = usdc.functions.allowance(wallet, spender_cs).call()
        if current >= 10**18:
            print(f"✓ {name}: already approved ({current / 1e6:.0f} USDC)")
            continue

        print(f"  Approving {name}...", end=" ", flush=True)
        tx = usdc.functions.approve(spender_cs, MAX_UINT256).build_transaction({
            "from":     wallet,
            "nonce":    nonce,
            "gas":      100_000,
            "gasPrice": w3.eth.gas_price,
            "chainId":  137,
        })
        signed = w3.eth.account.sign_transaction(tx, private_key)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status == 1:
            print(f"✓ confirmed (tx: {tx_hash.hex()})")
        else:
            print(f"✗ FAILED (tx: {tx_hash.hex()})")
        nonce += 1

    print("\nAll approvals done. The bot can now place orders.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 approve_usdc.py <private_key>")
        sys.exit(1)
    approve(sys.argv[1].strip())
