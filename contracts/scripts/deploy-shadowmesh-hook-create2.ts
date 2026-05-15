import { readFile, writeFile } from "node:fs/promises";
import { artifacts, network } from "hardhat";
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  isAddress,
  keccak256,
  padHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

// THE CORRECT LOW-BIT MATH (v4-periphery BaseHook validation)
const BEFORE_SWAP_FLAG = 1n << 7n;
const BEFORE_SWAP_RETURNS_DELTA_FLAG = 1n << 3n;
const REQUIRED_HOOK_FLAGS = BEFORE_SWAP_FLAG | BEFORE_SWAP_RETURNS_DELTA_FLAG;
const FLAG_MASK = (1n << 14n) - 1n;
const MAX_SALT_ATTEMPTS = 5_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const parametersPath = new URL("../ignition/parameters.json", import.meta.url);

type ShadowMeshParameters = {
  ShadowMeshModule?: {
    poolManager?: string;
    keeper?: string;
    shadowMeshHook?: string;
    shadowMeshSwapRouter?: string;
  };
};

function requireAddress(value: string | undefined, name: string): Address {
  if (value === undefined || !isAddress(value) || getAddress(value) === ZERO_ADDRESS) {
    throw new Error(`Missing or invalid ${name} in .env`);
  }
  return getAddress(value);
}

function computeCreate2Address(deployer: Address, salt: Hex, creationCodeHash: Hex): Address {
  const hash = keccak256(concatHex(["0xff", deployer, salt, creationCodeHash]));
  return getAddress(`0x${hash.slice(26)}`);
}

function readAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`Invalid ${label}: expected address, got ${String(value)}`);
  }
  return getAddress(value);
}

async function main() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployerWallet] = await viem.getWalletClients();

  const rawParameters = await readFile(parametersPath, "utf8");
  const parameters = JSON.parse(rawParameters) as ShadowMeshParameters;
  const moduleParameters = parameters.ShadowMeshModule ?? {};

  const poolManager = requireAddress(process.env.POOL_MANAGER ?? moduleParameters.poolManager, "POOL_MANAGER");
  const keeper = requireAddress(process.env.KEEPER ?? moduleParameters.keeper, "KEEPER");
  const owner = deployerWallet.account.address;

  const create2Deployer = await viem.deployContract("Create2Deployer", []);
  const artifact = await artifacts.readArtifact("ShadowMeshHook");
  const bytecode = artifact.bytecode as Hex;

  if (bytecode === "0x") {
    throw new Error("ShadowMeshHook bytecode is empty");
  }

  const constructorArgs = encodeAbiParameters(
    [
      { name: "_poolManager", type: "address" },
      { name: "initialOwner", type: "address" },
      { name: "initialKeeper", type: "address" },
      { name: "initialAllowedSwapSenders", type: "address[]" },
    ],
    [poolManager, owner, keeper, []]
  );

  const creationCode = concatHex([bytecode, constructorArgs]);
  const creationCodeHash = keccak256(creationCode);

  let saltNumber = 0n;
  let salt = padHex("0x0", { size: 32 });
  let hookAddress = computeCreate2Address(create2Deployer.address, salt, creationCodeHash);

  console.log(`⛏️ Mining hook address for flags 0x${REQUIRED_HOOK_FLAGS.toString(16)}...`);
  while ((hexToBigInt(hookAddress) & FLAG_MASK) !== REQUIRED_HOOK_FLAGS) {
    saltNumber++;
    if (saltNumber > MAX_SALT_ATTEMPTS) {
      throw new Error(`Unable to mine hook flags`);
    }
    salt = padHex(`0x${saltNumber.toString(16)}`, { size: 32 });
    hookAddress = computeCreate2Address(create2Deployer.address, salt, creationCodeHash);
  }

  const existingCode = await publicClient.getBytecode({ address: hookAddress });
  if (existingCode === undefined || existingCode === "0x") {
    const txHash = await create2Deployer.write.deploy([salt, creationCode]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  const deployedCode = await publicClient.getBytecode({ address: hookAddress });
  if (deployedCode === undefined || deployedCode === "0x") {
    throw new Error("ShadowMeshHook deployment failed");
  }

  const shadowMeshHook = await viem.getContractAt("ShadowMeshHook", hookAddress);

  let swapRouterAddress = readAddress(await shadowMeshHook.read.swapRouter(), "swapRouter");
  if (swapRouterAddress === zeroAddress) {
    console.log("📦 Deploying ShadowMeshSwapRouter...");
    const swapRouter = await viem.deployContract("ShadowMeshSwapRouter", [poolManager, hookAddress]);
    swapRouterAddress = getAddress(swapRouter.address);

    const initTx = await shadowMeshHook.write.initializeSwapRouter([swapRouterAddress]);
    await publicClient.waitForTransactionReceipt({ hash: initTx });
  }

  const routerAllowed = await shadowMeshHook.read.allowedSwapSender([swapRouterAddress]);
  const configuredRouter = readAddress(await shadowMeshHook.read.swapRouter(), "swapRouter");

  if (configuredRouter !== swapRouterAddress) {
    throw new Error("swapRouter on hook does not match deployed router");
  }
  if (!routerAllowed) {
    throw new Error("ShadowMeshSwapRouter was not allowlisted on the hook");
  }

  parameters.ShadowMeshModule = {
    ...moduleParameters,
    shadowMeshHook: hookAddress,
    shadowMeshSwapRouter: swapRouterAddress,
  };
  await writeFile(parametersPath, `${JSON.stringify(parameters, null, 2)}\n`);

  console.log("✅ Deployment Successful!");
  console.log("ShadowMeshHook:", hookAddress);
  console.log("ShadowMeshSwapRouter:", swapRouterAddress);
  console.log("allowedSwapSender[router]:", routerAllowed);
}

await main();
