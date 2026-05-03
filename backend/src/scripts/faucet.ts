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

  const fundingRounds = [
    {
      agentLabel: "Agent A",
      recipient: agentAAccount.address,
    },
    {
      agentLabel: "Agent B",
      recipient: agentBAccount.address,
    },
  ] as const;

  const mintSequence = [
    {
      tokenLabel: "Mock USDC",
      tokenAddress: mockUsdcAddress,
      amount: USDC_MINT_AMOUNT,
    },
    {
      tokenLabel: "Mock WETH",
      tokenAddress: mockWethAddress,
      amount: WETH_MINT_AMOUNT,
    },
  ] as const;

  for (const { agentLabel, recipient } of fundingRounds) {
    console.log(`\nMinting Mock USDC & Mock WETH to ${agentLabel}...`);

    for (const { tokenLabel, tokenAddress, amount } of mintSequence) {
      const { request } = await client.simulateContract({
        account: keeperAccount,
        address: tokenAddress,
        abi: MOCK_ERC20_ABI,
        functionName: "mint",
        args: [recipient, amount],
      });

      const hash = await client.writeContract(request);
      console.log(`  ${tokenLabel} mint tx sent: ${hash}`);

      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(
          `${tokenLabel} mint to ${agentLabel} failed (status: ${receipt.status}, tx: ${hash})`
        );
      }

      console.log(`  ${tokenLabel} mint confirmed in block ${receipt.blockNumber}`);
    }
  }

  console.log("\nFaucet mint flow completed successfully.");
}

main().catch((error) => {
  console.error("Faucet mint flow failed:", error);
  process.exit(1);
});
