/**
 * Wire ShadowMeshSwapRouter to an already-deployed hook (one-time).
 * Use after upgrading hook bytecode or if deploy script skipped router init.
 *
 *   npx hardhat run scripts/initialize-swap-router.ts --network sepolia
 */
import { readFile } from "node:fs/promises";
import { network } from "hardhat";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";

const parametersPath = new URL("../ignition/parameters.json", import.meta.url);

type ShadowMeshParameters = {
  ShadowMeshModule?: {
    poolManager?: string;
    shadowMeshHook?: string;
    shadowMeshSwapRouter?: string;
  };
};

function readAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`Invalid ${label}: expected address, got ${String(value)}`);
  }
  return getAddress(value);
}

async function main() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const raw = await readFile(parametersPath, "utf8");
  const params = JSON.parse(raw) as ShadowMeshParameters;
  const mod = params.ShadowMeshModule ?? {};

  const poolManager = process.env.POOL_MANAGER ?? mod.poolManager;
  const hookAddress = process.env.SHADOW_MESH_HOOK_ADDRESS ?? mod.shadowMeshHook;

  if (!poolManager || !hookAddress || !isAddress(poolManager) || !isAddress(hookAddress)) {
    throw new Error("Set POOL_MANAGER and SHADOW_MESH_HOOK_ADDRESS (or ignition/parameters.json)");
  }

  const hook = await viem.getContractAt("ShadowMeshHook", getAddress(hookAddress));
  const existingRouter = readAddress(await hook.read.swapRouter(), "swapRouter");

  if (existingRouter !== zeroAddress) {
    console.log("✅ swapRouter already set:", existingRouter);
    return;
  }

  console.log("📦 Deploying ShadowMeshSwapRouter for hook", hookAddress);
  const swapRouter = await viem.deployContract("ShadowMeshSwapRouter", [
    getAddress(poolManager),
    getAddress(hookAddress),
  ]);

  const hash = await hook.write.initializeSwapRouter([swapRouter.address], {
    account: deployer.account,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const configured = readAddress(await hook.read.swapRouter(), "swapRouter");
  const allowed = await hook.read.allowedSwapSender([swapRouter.address]);

  console.log("ShadowMeshSwapRouter:", swapRouter.address);
  console.log("hook.swapRouter:", configured);
  console.log("allowedSwapSender[router]:", allowed);

  if (configured !== getAddress(swapRouter.address) || !allowed) {
    throw new Error("Router initialization verification failed");
  }
  console.log("✅ Swap router initialized.");
}

await main();
