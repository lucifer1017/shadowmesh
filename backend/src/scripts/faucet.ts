import "dotenv/config";
import {
  createWalletClient,
  http,
  isAddress,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { MOCK_ERC20_ABI } from "../lib/constants.js";

const {
  SEPOLIA_RPC_URL,
  SEPOLIA_PRIVATE_KEY,
  AGENT_A_PRIVATE_KEY,
  AGENT_B_PRIVATE_KEY,
  MOCK_USDC_ADDRESS,
  MOCK_WETH_ADDRESS,
} = process.env;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function requirePrivateKey(name: string, value: string): `0x${string}` {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  const hex = normalized.startsWith("0x") ? normalized.slice(2) : normalized;

  if (/^0x[a-fA-F0-9]{40}$/.test(normalized) || /^[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(
      `Invalid ${name}: this looks like a wallet address, not a private key.`
    );
  }

  if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error(
      `Invalid private key format for ${name}. Expected 64 hex chars (with or without 0x prefix).`
    );
  }

  return `0x${hex}` as `0x${string}`;
}

function requireAddress(name: string, value: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new Error(`Invalid address for ${name}: ${value}`);
  }
  return value as `0x${string}`;
}

const rpcUrl = requireEnv("SEPOLIA_RPC_URL", SEPOLIA_RPC_URL);

const keeperPrivateKey = requirePrivateKey(
  "SEPOLIA_PRIVATE_KEY",
  requireEnv("SEPOLIA_PRIVATE_KEY", SEPOLIA_PRIVATE_KEY)
);
const agentAPrivateKey = requirePrivateKey(
  "AGENT_A_PRIVATE_KEY",
  requireEnv("AGENT_A_PRIVATE_KEY", AGENT_A_PRIVATE_KEY)
);
const agentBPrivateKey = requirePrivateKey(
  "AGENT_B_PRIVATE_KEY",
  requireEnv("AGENT_B_PRIVATE_KEY", AGENT_B_PRIVATE_KEY)
);

const mockUsdcAddress = requireAddress(
  "MOCK_USDC_ADDRESS",
  requireEnv("MOCK_USDC_ADDRESS", MOCK_USDC_ADDRESS)
);
const mockWethAddress = requireAddress(
  "MOCK_WETH_ADDRESS",
  requireEnv("MOCK_WETH_ADDRESS", MOCK_WETH_ADDRESS)
);

const keeperAccount = privateKeyToAccount(keeperPrivateKey);
const agentAAccount = privateKeyToAccount(agentAPrivateKey);
const agentBAccount = privateKeyToAccount(agentBPrivateKey);

const client = createWalletClient({
  account: keeperAccount,
  chain: sepolia,
  transport: http(rpcUrl),
}).extend(publicActions);

const USDC_MINT_AMOUNT = 50000n * 10n ** 18n;
const WETH_MINT_AMOUNT = 100n * 10n ** 18n;

async function main() {
  console.log("Starting faucet mint flow...");
  console.log(`Keeper: ${keeperAccount.address}`);
  console.log(`Agent A (Buyer): ${agentAAccount.address}`);
  console.log(`Agent B (Seller): ${agentBAccount.address}`);

  console.log("Minting Mock USDC to Agent A...");
  const usdcMintHash = await client.writeContract({
    address: mockUsdcAddress,
    abi: MOCK_ERC20_ABI,
    functionName: "mint",
    args: [agentAAccount.address, USDC_MINT_AMOUNT],
  });
  console.log(`USDC mint tx sent: ${usdcMintHash}`);

  const usdcReceipt = await client.waitForTransactionReceipt({ hash: usdcMintHash });
  console.log(`USDC mint confirmed in block ${usdcReceipt.blockNumber}`);

  console.log("Minting Mock WETH to Agent B...");
  const wethMintHash = await client.writeContract({
    address: mockWethAddress,
    abi: MOCK_ERC20_ABI,
    functionName: "mint",
    args: [agentBAccount.address, WETH_MINT_AMOUNT],
  });
  console.log(`WETH mint tx sent: ${wethMintHash}`);

  const wethReceipt = await client.waitForTransactionReceipt({ hash: wethMintHash });
  console.log(`WETH mint confirmed in block ${wethReceipt.blockNumber}`);

  console.log("Faucet mint flow completed successfully.");
}

main().catch((error) => {
  console.error("Faucet mint flow failed:", error);
  process.exit(1);
});
