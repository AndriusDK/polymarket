"""
Migrate Polymarket bot wallet from USDC.e (V1) to pUSD (V2).

Run BEFORE April 28, 2026 (~11:00 UTC) cutover:
    cd /var/www/html/polymarket
    venv/bin/python migrate_to_v2.py <private_key>

Steps performed:
  1. Wrap all USDC.e → pUSD via the Collateral Onramp
  2. Approve V2 Exchange + V2 Neg Risk Exchange to spend pUSD
  3. Set ERC1155 approvals for V2 contracts (required for SELL orders)
"""

import sys

# ── Addresses (from py_clob_client_v2.config.get_contract_config(137)) ────────
PUSD                 = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"  # pUSD token
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

# Try wrap() and deposit() — different contracts use different names for the same operation
WRAP_ABI = [
    {"name": "wrap",    "type": "function",
     "inputs": [{"name": "amount", "type": "uint256"}],
     "outputs": [], "stateMutability": "nonpayable"},
    {"name": "deposit", "type": "function",
     "inputs": [{"name": "amount", "type": "uint256"}],
     "outputs": [], "stateMutability": "nonpayable"},
]

# View functions that might point to the Collateral Onramp address
PROBE_ABI = [
    {"name": "onramp",          "type": "function", "inputs": [], "outputs": [{"type": "address"}], "stateMutability": "view"},
    {"name": "collateralOnramp","type": "function", "inputs": [], "outputs": [{"type": "address"}], "stateMutability": "view"},
    {"name": "wrapper",         "type": "function", "inputs": [], "outputs": [{"type": "address"}], "stateMutability": "view"},
    {"name": "minter",          "type": "function", "inputs": [], "outputs": [{"type": "address"}], "stateMutability": "view"},
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


def fresh_nonce(w3, wallet):
    """Always read nonce from chain — avoids stale-nonce bugs after reverts."""
    return w3.eth.get_transaction_count(wallet)


def send(w3, contract_fn, wallet, private_key, gas=150_000):
    nonce = fresh_nonce(w3, wallet)
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


def try_wrap(w3, wallet, private_key, usdc_e_c, pusd_c, usdc_e_bal, onramp_addr):
    """Try wrap() then deposit() on the given onramp_addr. Returns True if pUSD received."""
    cs = w3.eth.to_checksum_address(onramp_addr)

    # Approve onramp to pull USDC.e
    current = usdc_e_c.functions.allowance(wallet, cs).call()
    if current < usdc_e_bal:
        print(f"  Approving USDC.e → {cs[:10]}...", end=" ", flush=True)
        ok = send(w3, usdc_e_c.functions.approve(cs, MAX_UINT256), wallet, private_key)
        if not ok:
            print("  ✗ Approval failed.")
            return False

    onramp = w3.eth.contract(address=cs, abi=WRAP_ABI)
    for fn_name in ("wrap", "deposit"):
        print(f"  Calling {fn_name}({usdc_e_bal / 1e6:.2f}) on {cs[:10]}...", end=" ", flush=True)
        try:
            fn = getattr(onramp.functions, fn_name)(usdc_e_bal)
            ok = send(w3, fn, wallet, private_key, gas=250_000)
            if ok:
                new_pusd = pusd_c.functions.balanceOf(wallet).call()
                print(f"  pUSD balance after {fn_name}: {new_pusd / 1e6:.2f}")
                return True
            else:
                print(f"  {fn_name}() reverted, trying next...")
        except Exception as e:
            print(f"✗ ({e})")
    return False


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

    usdc_e_c = w3.eth.contract(address=w3.eth.to_checksum_address(USDC_E), abi=ERC20_ABI)
    pusd_c   = w3.eth.contract(address=w3.eth.to_checksum_address(PUSD),   abi=ERC20_ABI)

    usdc_e_bal = usdc_e_c.functions.balanceOf(wallet).call()
    pusd_bal   = pusd_c.functions.balanceOf(wallet).call()
    matic_bal  = w3.eth.get_balance(wallet)

    print(f"USDC.e : {usdc_e_bal / 1e6:.2f}")
    print(f"pUSD   : {pusd_bal   / 1e6:.2f}")
    print(f"MATIC  : {matic_bal  / 1e18:.4f}  (gas)\n")

    if matic_bal < int(0.01 * 1e18):
        print("WARNING: Low MATIC — you may not have enough gas. Top up the wallet first.\n")

    # ── Step 1: Wrap USDC.e → pUSD ────────────────────────────────────────────
    print("── Step 1: Wrap USDC.e → pUSD ──────────────────────────────────────")
    if usdc_e_bal > 0:
        # Probe pUSD contract for a view fn that returns the real Collateral Onramp address
        onramp_addr = None
        probe = w3.eth.contract(address=w3.eth.to_checksum_address(PUSD), abi=PROBE_ABI)
        for fn_name in ("onramp", "collateralOnramp", "wrapper", "minter"):
            try:
                addr = getattr(probe.functions, fn_name)().call()
                if addr and addr != "0x" + "0" * 40:
                    print(f"  Found Collateral Onramp via {fn_name}(): {addr}")
                    onramp_addr = addr
                    break
            except Exception:
                pass

        # Try wrapping via discovered onramp, then fall back to pUSD address itself
        candidates = ([onramp_addr] if onramp_addr else []) + [PUSD]
        wrapped = False
        for addr in candidates:
            print(f"  Trying onramp at {addr}...")
            if try_wrap(w3, wallet, private_key, usdc_e_c, pusd_c, usdc_e_bal, addr):
                wrapped = True
                break

        if not wrapped:
            print()
            print("  ✗ Could not wrap USDC.e → pUSD automatically.")
            print("  The Collateral Onramp address is not exposed by the SDK.")
            print("  Options:")
            print("  A) Check Polymarket Discord for the Collateral Onramp contract address,")
            print("     then add it to this script as ONRAMP and re-run.")
            print("  B) Wait until April 28 cutover — Polymarket UI handles wrapping on login.")
            print("  Continuing with pUSD approvals (wrap manually before trading).")
    elif pusd_bal > 0:
        print(f"  Already holding {pusd_bal / 1e6:.2f} pUSD — no wrap needed.")
    else:
        print("  WARNING: No USDC.e and no pUSD — fund the wallet before trading on V2.")
    print()

    # ── Step 2: Approve V2 exchanges to spend pUSD ───────────────────────────
    print("── Step 2: Approve V2 exchanges to spend pUSD ──────────────────────")
    v2_contracts = [
        ("V2 Exchange",          V2_EXCHANGE),
        ("V2 Neg Risk Exchange", V2_NEG_RISK_EXCHANGE),
    ]
    for name, spender in v2_contracts:
        cs      = w3.eth.to_checksum_address(spender)
        current = pusd_c.functions.allowance(wallet, cs).call()
        if current >= 10**18:
            print(f"  ✓ {name}: already approved")
            continue
        print(f"  Approving {name}...", end=" ", flush=True)
        send(w3, pusd_c.functions.approve(cs, MAX_UINT256), wallet, private_key)
    print()

    # ── Step 3: ERC1155 setApprovalForAll (needed for SELL orders) ───────────
    print("── Step 3: ERC1155 approvals for V2 exchanges ───────────────────────")
    ctf = w3.eth.contract(address=w3.eth.to_checksum_address(CTF_TOKEN), abi=ERC1155_ABI)
    for name, addr in v2_contracts:
        cs = w3.eth.to_checksum_address(addr)
        if ctf.functions.isApprovedForAll(wallet, cs).call():
            print(f"  ✓ {name}: ERC1155 already approved")
            continue
        print(f"  Setting ERC1155 approval for {name}...", end=" ", flush=True)
        send(w3, ctf.functions.setApprovalForAll(cs, True), wallet, private_key)
    print()

    pusd_final = pusd_c.functions.balanceOf(wallet).call()
    usdc_e_final = usdc_e_c.functions.balanceOf(wallet).call()
    print(f"Final balances — USDC.e: {usdc_e_final / 1e6:.2f}  pUSD: {pusd_final / 1e6:.2f}")
    print("Done. Restart the trade server after the April 28 cutover.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: venv/bin/python migrate_to_v2.py <private_key>")
        sys.exit(1)
    migrate(sys.argv[1].strip())
