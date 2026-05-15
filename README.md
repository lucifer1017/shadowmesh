# 🌒 ShadowMesh | The Agentic Dark Pool

**GitHub Repository:** [https://github.com/lucifer1017/shadowmesh](https://github.com/lucifer1017/shadowmesh)

---

## 📖 What is ShadowMesh?
ShadowMesh is the first trustless, AI-to-AI, MEV-protected dark pool built on Uniswap v4. We replace centralized matching engines with autonomous AI agents (powered by Gemini) that negotiate trades in total secrecy over a peer-to-peer mesh network and settle them cryptographically on-chain.

## 🛑 The Problem it Solves
In modern DeFi, large-volume execution suffers from **Intent Leakage**. Trading on public AMMs exposes users to MEV sandwich attacks, while public limit order books broadcast intent, crashing the price before execution. Bringing "Dark Pools" to Web3 has historically required centralized off-chain order books, reintroducing trust assumptions. ShadowMesh eliminates the centralized middleman entirely.

## 🌊 The Architecture Flow
1. **Initiation:** The user inputs the desired WETH swap amount into the Frontend UI. This triggers the Buyer Agent.
2. **The Dark Room (Gensyn AXL):** The Buyer and Seller AI agents connect via the Gensyn AXL P2P mesh network. They fetch live pricing from the **Pyth Network** and begin high-frequency haggling completely off-chain with zero public footprint.
3. **The State Lock (EIP-712):** Upon reaching an agreement, both agents generate a strictly typed `DarkPoolIntent` payload and sign it using EIP-712 cryptographic standards.
4. **Stealth Routing (KeeperHub):** To avoid the public mempool, the Buyer agent routes the signed payload through KeeperHub.
5. **Trustless Settlement (Uniswap v4):** KeeperHub submits **`executeDarkPoolSwap`** on our deployed **`ShadowMeshHook`**. The hook calls **`PoolManager.unlock` → `swap`**, runs **`beforeSwap`** (EIP-712 verification, seller `tokenOut` settlement, ERC-6909 mint to the seller), then in **`unlockCallback`** pulls **`tokenIn`** from the buyer and uses **`take`** to deliver **`tokenOut`** to the buyer so PoolManager deltas net to zero—no `PoolSwapTest` / Universal Router leg.

---

## 🛠️ System Setup & Installation

### 1. Generating Gensyn AXL Keys
Gensyn requires cryptographic keys for node identity. Open **Git Bash** (if on Windows) in the root directory and run:
```bash
# Generate Buyer Key
openssl genpkey -algorithm ed25519 -out buyer-private.pem

# Generate Seller Key
openssl genpkey -algorithm ed25519 -out seller-private.pem
```

2. Gensyn Configuration Files
Create two configuration files in the root directory to define how the AXL nodes interact.

buyer-config.json: Set the listening port (e.g., 8000) and point the identity to buyer-private.pem.

seller-config.json: Set the listening port (e.g., 8001), point the identity to seller-private.pem, and add the buyer's multiaddress to the peers array to bridge the mesh.

🔐 Environment Variables Guide
Global Backend Configuration (backend/.env)
UNISWAP_API_KEY: API key for Uniswap developer services.

GEMINI_API_KEY: API key for the Gemini LLM powering the negotiation.

POOL_MANAGER_ADDRESS: Uniswap v4 PoolManager address.

MOCK_WETH_ADDRESS: Deployed mock WETH address.

MOCK_USDC_ADDRESS: Deployed mock USDC address.

SHADOW_MESH_HOOK_ADDRESS: The CREATE2-mined address of **`ShadowMeshHook`**. Used as the EIP-712 **`verifyingContract`**, as the **KeeperHub `contract_address`** for settlement (**`executeDarkPoolSwap`**), and as the **ERC-20 `spender`** the buyer must **`approve`** for **`tokenIn`** (the buyer agent sends this approval before calling KeeperHub). The hook’s on-chain **`authorizedKeeper`** must match the **`KEEPER`** wallet you set in **`contracts/.env`** when deploying.

SEPOLIA_RPC_URL: Your Alchemy/Infura RPC endpoint.

SEPOLIA_PRIVATE_KEY: Wallet used for general testnet interactions.

AGENT_A_PRIVATE_KEY: Buyer's wallet private key (for EIP-712 signing).

AGENT_B_PRIVATE_KEY: Seller's wallet private key (for EIP-712 signing).

Buyer Agent Specifics (backend/.env.buyer)
KEEPERHUB_API_KEY: Authentication for stealth relaying via KeeperHub.

SHADOW_MESH_HOOK_ADDRESS: Must match the deployed hook (same as global). Settlement targets this contract, not a router.

SELLER_ADDRESS: Wallet address of the opposing (Seller) agent.

TOKEN_IN: Address of the token the Buyer is giving (e.g., USDC).

TOKEN_OUT: Address of the token the Buyer wants to receive (e.g., WETH).

POOL_FEE: Target Uniswap pool fee tier (e.g., 3000).

POOL_TICK_SPACING: Target Uniswap tick spacing (e.g., 60).

TARGET_PUBKEY: The Gensyn Peer ID of the Seller.

How to procure: curl.exe -s http://127.0.0.1:9001/topology, this generates a publicKey, copy it.

Seller Agent Specifics (backend/.env.seller)
KEEPERHUB_API_KEY: Authentication for stealth relaying.

SHADOW_MESH_HOOK_ADDRESS: Must match the deployed hook (EIP-712 domain and **`tokenOut`** approvals use the hook as **`spender`** where applicable).

SELLER_ADDRESS: The Seller's own wallet address.

TOKEN_IN: Address of the token the Seller is giving (e.g., WETH).

TOKEN_OUT: Address of the token the Seller wants to receive (e.g., USDC).

POOL_FEE: Target Uniswap pool fee tier (e.g., 3000).

POOL_TICK_SPACING: Target Uniswap tick spacing (e.g., 60).

TARGET_PUBKEY: The Gensyn Peer ID of the Buyer.

How to procure: curl.exe -s http://127.0.0.1:9002/topology, this generates a publicKey, copy it.

Smart Contract Deployment (contracts/.env)
SEPOLIA_RPC_URL: RPC endpoint for deployment (e.g., Alchemy/Infura).

SEPOLIA_PRIVATE_KEY: Deployer wallet private key.

POOL_MANAGER: Uniswap v4 PoolManager address.

KEEPER: The KeeperHub execution wallet address. This value is passed into the hook constructor as **`authorizedKeeper`** and must be the same wallet KeeperHub uses to call **`executeDarkPoolSwap`**.

🏗️ Deployment & Execution Instructions
Phase 1: Smart Contracts (/contracts)
Navigate to the contracts directory and install dependencies.

Bash
cd contracts
npm install

1. Deploy ShadowMeshHook: Uniswap v4 requires hook addresses to have specific leading bytes. We use Create2Deployer.sol and a custom script to mine a valid address.

Bash
npx hardhat run scripts/deploy-shadowmesh-hook-create2.ts --network sepolia
(Remember to update your .env files with the newly generated contract addresses!), this automatically updates our ignition/parameters.json

2. Deploy Mock Tokens: We use an Ignition module to spin up testnet liquidity.

Bash
npx hardhat ignition deploy ignition/modules/ShadowMesh.ts --network sepolia


Phase 2: Backend Infrastructure (/backend)
Navigate to the backend directory and install dependencies.

Bash
cd ../backend
npm install
1. Start the Gensyn P2P Nodes:
Open two separate terminals and boot up the mesh infrastructure:

Bash
# Terminal 1 (Buyer Node)
npm run dev:axl-buyer

# Terminal 2 (Seller Node)
npm run dev:axl-seller
2. Start the Seller Agent:
Open a third terminal. The Seller agent needs to be actively listening on the mesh network. (Note: The Buyer agent does not need a terminal; it is dynamically triggered by the frontend).

Bash
# Terminal 3 (Seller Agent)
npm run dev:seller
Phase 3: Frontend Demo (/frontend)
Navigate to the frontend directory, install dependencies, and run the development server.

Bash
cd ../frontend
npm install
npm run dev
🧪 Testing the Flow
Open http://localhost:3000 in your browser.

You will see the glowing ShadowMesh Command Center UI.

Type the amount of WETH you wish to swap/acquire.

Click "INITIATE PROTOCOL".

Watch the results: The frontend will awaken the Buyer agent. Observe the backend terminal logs as the Gemini AIs haggle over Gensyn AXL, query Pyth for prices, sign the EIP-712 payload, and trigger KeeperHub to settle safely on Uniswap v4!

ShadowMesh is designed for the future of agentic finance. By combining off-chain AI coordination with on-chain cryptographic settlement, we provide a blueprint for high-volume, MEV-protected trading.

## 🏆 Hackathon Bounties & Partner Integrations

This project was purpose-built to push the boundaries of Agentic Finance by deeply integrating with our partner infrastructure. Below is our formal write-up for the Gensyn and KeeperHub judging teams.

### 📡 Gensyn AXL: The "Dark Room" Mesh
**Track:** Best Application of Agent eXchange Layer (AXL)

ShadowMesh utilizes Gensyn AXL not just as a novelty messaging layer, but as the foundational privacy infrastructure for a new DeFi primitive: **The Agentic Dark Pool**. To solve the DeFi "Intent Leakage" trilemma, institutional trade negotiations must happen off-chain with zero centralized logging. We achieved this by routing all Gemini AI agent negotiations exclusively through the Gensyn AXL peer-to-peer mesh.

**How we exceed the Judging Criteria:**
* **Real Utility:** AXL acts as the trustless "Dark Room" where high-frequency trading algorithms negotiate spot prices securely before generating cryptographic state-locks.
* **Strict Node Separation (Qualification Met):** We do not use in-process mocking or centralized message brokers. The architecture runs **two distinct, isolated AXL binaries** (a Buyer Node on port 8000 and a Seller Node on port 8001). The agents communicate entirely across this localized mesh topology.
* **Built-in A2A:** We heavily leveraged AXL's Agent-to-Agent (A2A) capabilities to parse structured negotiation JSONs between the isolated Gemini instances.

### 💚 KeeperHub: Stealth MEV-Proof Execution
**Track:** Best Innovative Use of KeeperHub (Focus Area 1)

As KeeperHub noted, "Agents are great at reasoning, but they hit a wall when they need to actually move value." ShadowMesh uses KeeperHub to smash through that wall by solving the most critical vulnerability in DeFi: **MEV Sandwich Attacks**.

When our AI agents reach consensus over the Gensyn mesh, they generate an EIP-712 signed `DarkPoolIntent`. If broadcast normally, this payload would be sniped in the public mempool. 

**How we exceed the Judging Criteria:**
* **The Integration Approach:** We utilize KeeperHub as a **Stealth Relayer**. The buyer agent bundles the EIP-712 intent and signatures and submits them via the KeeperHub MCP/API as an **`execute_contract_call`** to **`ShadowMeshHook.executeDarkPoolSwap`** (Sepolia), with **`SHADOW_MESH_HOOK_ADDRESS`** as the target contract. 
* **Real Utility:** KeeperHub bypasses the public mempool and routes execution to our **`ShadowMeshHook.executeDarkPoolSwap`**, which drives **`PoolManager`** settlement in a single lock. That gives MEV-protected relaying from AI consensus to deterministic on-chain settlement without relying on **`PoolSwapTest`** or the Universal Router for this flow. KeeperHub acts as the bridge between probabilistic AI reasoning and deterministic EVM execution.

### 👥 Team & Project Info
* **Project Name:** ShadowMesh
* **Contact:** kartikaytyagi.61@gmail.com | Twitter: @kartikHere101 | Telegram: @KartikTyagi