# Uniswap Developer Platform Feedback
**Project:** ShadowMesh (Agentic Dark Pool)
**Track:** Best Uniswap API Integration

## Context: Building at the Edge of v4
For ShadowMesh, we bypassed traditional REST APIs and integrated directly with the raw **Uniswap v4 Smart Contract API**. Our architecture requires a Trustless Agentic Dark Pool, meaning we utilized the `IPoolManager` and created a custom `ShadowMeshHook` to intercept the `beforeSwap` execution phase. This allowed us to mathematically verify off-chain AI EIP-712 signatures before the swap ever touches the liquidity pool.

Here is our candid feedback from the trenches on the Developer Experience (DX) of building advanced agentic primitives on v4.

---

### 🟢 What Worked Beautifully
1. **The `IPoolManager` Abstraction:** The architectural shift to a singleton `PoolManager` is brilliant. Routing our Agent-to-Agent settlement through our relayer directly into the `PoolManager` felt incredibly clean. We didn't have to wrangle factory contracts or proxy addresses; we just passed our `IPoolKey` and `IPoolManager.SwapParams` and let the architecture handle the rest.
2. **Hook Composability as a Cryptographic Judge:** The `beforeSwap` hook is the perfect execution environment for bridging AI and DeFi. It allowed us to turn a standard liquidity pool into a cryptographic arbiter for off-chain intents seamlessly.

### 🔴 DX Friction, Bugs & What Didn't Work
1. **Silent `estimateGas` Failures on Narrow Tick Spacings:** 
   When testing our high-frequency agent swaps using a `100` fee tier and a tick spacing of `1` on Sepolia, the RPC node repeatedly choked with a `missing revert data (action="estimateGas")` error.
   * **The Friction:** Instead of throwing our custom Hook error (`InvalidSwap()`) or a standard Uniswap math error, the transaction silently failed during gas simulation. We deduced this was a precision rounding underflow caused by the tight tick spacing and tokens with differing decimals (WETH 18, USDC 6). This lack of revert data turns the developer loop into blind trial and error. We had to migrate our settlement to `3000/60` and `10000/200` pools to stabilize the math libraries.
2. **CREATE2 Hook Address Mining Breaks Rapid Iteration:**
   Because v4 Hooks require specific address prefixes to enable callbacks (e.g., matching the `BEFORE_SWAP_FLAG`), we couldn't just deploy our smart contract. We had to write a custom script to brute-force thousands of salts via `CREATE2` to get a valid address. This is a massive DX friction point that breaks standard CI/CD pipelines and slows down rapid hackathon prototyping.

### 📚 Documentation Gaps
1. **The Definition of "API":** The docs heavily index on the web/REST APIs and the v3 SDK. Finding deep, architectural documentation on constructing raw v4 `SwapParams` from scratch—especially when dealing with custom hooks and EIP-712 off-chain signatures—required reading the actual Solidity source code rather than the docs.
2. **TickMath Edge Cases:** There needs to be a dedicated documentation page explaining the exact limits, precision loss, and failure states of `TickMath` when testing locally or on testnets with mock tokens of varying decimals. 

### 🌠 What We Wish Existed (The Wishlist)
1. **Official Hook Deployer Tooling:** Please release an official Hardhat/Foundry plugin (`@uniswap/v4-hook-deployer`) that abstracts away the CREATE2 salt mining. Developers should be able to run `npx hardhat deploy-hook --flags beforeSwap` and have the tool handle the cryptographic mining automatically.

---
**Final Thoughts:**
Despite the sharp edges around testnet math and hook deployment, Uniswap v4 is the most powerful execution environment we have built on. The ability to inject custom cryptographic logic into the settlement layer is what makes Agentic Finance possible. Thank you for the incredible protocol.