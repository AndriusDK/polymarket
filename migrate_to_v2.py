"""
Migrate Polymarket bot wallet from USDC.e (V1) to pUSD (V2).

Run BEFORE April 28, 2026 (~11:00 UTC) cutover:
    cd /var/www/html/polymarket
    venv/bin/python migrate_to_v2.py <private_key>

Steps performed:
  1. Wrap all USDC.e → pUSD via the Collateral Onramp (wrap() on pUSD contract)
  2. Approve V2 Exchange + V2 Neg Risk Exchange to spend pUSD
  3. Set ERC1155 approvals for V2 contracts (required for SELL orders)
"""

import sys

# ── Addresses (from py_clob_client_v2.config.get_contract_config(137)) ────────
PUSD                 = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"  # pUSD token / Collateral Onramp
V2_EXCHANGE          = "0xE111180000d2663C0091e4f400237545B87B996B"
V2_NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59"
CTF_TOKEN            = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"  # unchanged in V2

USDC_E               = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"  # old collateral

POLYGON_RPCS = [
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com",
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
    "https://polygon-rpc.com",
]

ERC20_ABI = [
    {"name": "approve",   "type": "function",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}], "stateMutability": "nonpayable"},
    {"name": "allowance", "type": "function",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
    {"name": "balanceOf", "type": "function",
     "inputs": [{"name": "account", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
]

WRAP_ABI = [
    {"name": "wrap", "type": "function",
     "inputs": [{"name": "amount", "type": "uint256"}],
     "outputs": [], "stateMutability": "nonpayable"},
]

ERC1155_ABI = [
    {"name": "setApprovalForAll", "type": "function",
     "inputs": [{"name": "operator", "type": "address"}, {"name": "approved", "type": "bool"}],
     "outputs": [], "stateMutability": "nonpayable"},
    {"name": "isApprovedForAll", "type": "function",
     "inputs": [{"name": "account", "type": "address"}, {"name": "operator", "type": "address"}],
     "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view"},
]

MAX_UINT256 = 2**256 - 1


def send(w3, contract_fn, wallet, private_key, nonce, gas=150_000):
    tx = contract_fn.build_transaction({
        "from": wallet, "nonce": nonce,
        "gas": gas, "gasPrice": w3.eth.gas_price, "chainId": 137,
    })
    signed  = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    ok = receipt.status == 1
    print(f"{'✓' if ok else '✗'} ({tx_hash.hex()})")
    return ok


def migrate(private_key: str):
    try:
        from web3 import Web3
        from eth_account import Account
    except ImportError:
        print("ERROR: web3 not installed. Run: venv/bin/pip install web3")
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
    print(f"Wallet : {wallet}\n")

    usdc_e_c = w3.eth.contract(address=Web3.to_checksum_address(USDC_E), abi=ERC20_ABI)
    pusd_c   = w3.eth.contract(address=Web3.to_checksum_address(PUSD),   abi=ERC20_ABI)

    usdc_e_bal = usdc_e_c.functions.balanceOf(wallet).call()
    pusd_bal   = pusd_c.functions.balanceOf(wallet).call()
    matic_bal  = w3.eth.get_balance(wallet)

    print(f"USDC.e : {usdc_e_bal / 1e6:.2f}")
    print(f"pUSD   : {pusd_bal   / 1e6:.2f}")
    print(f"MATIC  : {matic_bal  / 1e18:.4f}  (gas)\n")

    if matic_bal < int(0.01 * 1e18):
        print("WARNING: Low MATIC — you may not have enough gas. Top up the wallet first.\n")

    nonce = w3.eth.get_transaction_count(wallet)

    # ── Step 1: Wrap USDC.e → pUSD ────────────────────────────────────────────
    print("── Step 1: Wrap USDC.e → pUSD ──────────────────────────────────────")
    if usdc_e_bal > 0:
        print(f"  Wrapping {usdc_e_bal / 1e6:.2f} USDC.e → pUSD")

        allowance = usdc_e_c.functions.allowance(wallet, Web3.to_checksum_address(PUSD)).call()
        if allowance < usdc_e_bal:
            print("  Approving USDC.e spend by pUSD contract...", end=" ", flush=True)
            ok = send(w3, usdc_e_c.functions.approve(Web3.to_checksum_address(PUSD), MAX_UINT256),
                      wallet, private_key, nonce)
            if ok:
                nonce += 1
            else:
                print("  ✗ Approval failed — aborting wrap. Check wallet/gas and retry.")
                sys.exit(1)
        else:
            print("  ✓ USDC.e allowance already set")

        onramp = w3.eth.contract(address=Web3.to_checksum_address(PUSD), abi=WRAP_ABI)
        print(f"  Calling wrap({usdc_e_bal / 1e6:.2f} USDC.e)...", end=" ", flush=True)
        try:
            ok = send(w3, onramp.functions.wrap(usdc_e_bal), wallet, private_key, nonce, gas=200_000)
            if ok:
                nonce += 1
                new_pusd = pusd_c.functions.balanceOf(wallet).call()
                print(f"  pUSD balance after wrap: {new_pusd / 1e6:.2f}")
            else:
                print("  ✗ wrap() reverted. The Collateral Onramp may be at a different address.")
                print("    → Check https://docs.polymarket.com for the onramp contract address.")
                print("    → Continuing with approvals (wrap manually, then re-run).\n")
        except Exception as e:
            print(f"✗  wrap() failed: {e}")
            print("    → The pUSD contract may not be the Collateral Onramp.")
            print("    → Check https://docs.polymarket.com for the onramp address and wrap manually.\n")
    elif pusd_bal > 0:
        print(f"  No USDC.e to wrap — already holding {pusd_bal / 1e6:.2f} pUSD, skipping.")
    else:
        print("  WARNING: No USDC.e and no pUSD — fund your wallet before April 28.")
    print()

    # ── Step 2: Approve V2 exchanges to spend pUSD ───────────────────────────
    print("── Step 2: Approve V2 exchanges to spend pUSD ──────────────────────")
    v2_contracts = [
        ("V2 Exchange",          V2_EXCHANGE),
        ("V2 Neg Risk Exchange", V2_NEG_RISK_EXCHANGE),
    ]
    for name, spender in v2_contracts:
        cs      = Web3.to_checksum_address(spender)
        current = pusd_c.functions.allowance(wallet, cs).call()
        if current >= 10**18:
            print(f"  ✓ {name}: already approved")
            continue
        print(f"  Approving {name}...", end=" ", flush=True)
        ok = send(w3, pusd_c.functions.approve(cs, MAX_UINT256), wallet, private_key, nonce)
        if ok:
            nonce += 1
    print()

    # ── Step 3: ERC1155 setApprovalForAll (needed for SELL orders) ───────────
    print("── Step 3: ERC1155 approvals for V2 exchanges ───────────────────────")
    ctf = w3.eth.contract(address=Web3.to_checksum_address(CTF_TOKEN), abi=ERC1155_ABI)
    for name, addr in v2_contracts:
        cs = Web3.to_checksum_address(addr)
        if ctf.functions.isApprovedForAll(wallet, cs).call():
            print(f"  ✓ {name}: ERC1155 already approved")
            continue
        print(f"  Setting ERC1155 approval for {name}...", end=" ", flush=True)
        ok = send(w3, ctf.functions.setApprovalForAll(cs, True), wallet, private_key, nonce)
        if ok:
            nonce += 1
    print()

    print("Migration complete. Wallet is ready for Polymarket CLOB V2.")
    print("Restart the trade server after the April 28 cutover: venv/bin/python server.py")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: venv/bin/python migrate_to_v2.py <private_key>")
        sys.exit(1)
    migrate(sys.argv[1].strip())
