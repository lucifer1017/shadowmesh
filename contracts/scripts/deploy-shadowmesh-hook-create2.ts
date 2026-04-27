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
  type Address,
  type Hex,
} from "viem";

const FLAG_MASK = (1n << 14n) - 1n;
const BEFORE_SWAP_FLAG = 1n << 7n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const parametersPath = new URL("../ignition/parameters.json", import.meta.url);

type ShadowMeshParameters = {
  ShadowMeshModule?: {
    poolManager?: string;
    keeper?: string;
    shadowMeshHook?: string;
  };
};

function requireAddress(value: string | undefined, name: string): Address {
  if (value === undefined || !isAddress(value) || getAddress(value) === ZERO_ADDRESS) {
    throw new Error(`Missing or invalid ${name} in .env (or fallback ignition/parameters.json)`);
  }
  return getAddress(value);
}

function computeCreate2Address(deployer: Address, salt: Hex, creationCodeHash: Hex): Address {
  const hash = keccak256(concatHex(["0xff", deployer, salt, creationCodeHash]));
  return getAddress(`0x${hash.slice(26)}`);
}

async function main() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployerWallet] = await viem.getWalletClients();

  const rawParameters = await readFile(parametersPath, "utf8");
  const parameters = JSON.parse(rawParameters) as ShadowMeshParameters;
  const moduleParameters = parameters.ShadowMeshModule ?? {};

  const poolManager = requireAddress(
    process.env.POOL_MANAGER ?? moduleParameters.poolManager,
    "POOL_MANAGER",
  );
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
    ],
    [poolManager, owner, keeper],
  );

  const creationCode = concatHex([bytecode, constructorArgs]);
  const creationCodeHash = keccak256(creationCode);

  let saltNumber = 0n;
  let salt = padHex("0x0", { size: 32 });
  let hookAddress = computeCreate2Address(create2Deployer.address, salt, creationCodeHash);

  while ((hexToBigInt(hookAddress) & FLAG_MASK) !== BEFORE_SWAP_FLAG) {
    saltNumber++;
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
  const deployedPoolManager = await shadowMeshHook.read.poolManager();
  const deployedKeeper = await shadowMeshHook.read.authorizedKeeper();
  const deployedOwner = await shadowMeshHook.read.owner();

  if (
    getAddress(deployedPoolManager) !== poolManager
    || getAddress(deployedKeeper) !== keeper
    || getAddress(deployedOwner) !== getAddress(owner)
  ) {
    throw new Error("Deployed ShadowMeshHook constructor state mismatch");
  }

  parameters.ShadowMeshModule = {
    ...moduleParameters,
    shadowMeshHook: hookAddress,
  };

  await writeFile(parametersPath, `${JSON.stringify(parameters, null, 2)}\n`);

  console.log("Create2Deployer:", create2Deployer.address);
  console.log("ShadowMeshHook:", hookAddress);
  console.log("Salt:", salt);
  console.log("Updated ignition/parameters.json");
}

await main();
