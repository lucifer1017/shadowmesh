import { network } from "hardhat";
import { getAddress, parseAbi } from "viem";

type Address = `0x${string}`;

const ADDRESSES = {
  mockUSDC: "0xe965fABf3277b9E49C093449fB7C04401D2835d0" as Address,
  mockWETH: "0x3491AF599bAbB788E3CE550a84eFca4c9a216416" as Address,
  shadowMeshHook: "0xb76306D31e12336F0D8C62497190ae49f06Bc080" as Address,
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543" as Address,
};

const FEE = 3000;
const TICK_SPACING = 60;
const SQRT_PRICE_X96 = 79228162514264337593543950336n;

const poolManagerAbi = parseAbi([
  "function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96) external returns (int24 tick)",
]);

function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

async function main() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [walletClient] = await viem.getWalletClients();

  const mockUSDC = getAddress(ADDRESSES.mockUSDC);
  const mockWETH = getAddress(ADDRESSES.mockWETH);
  const shadowMeshHook = getAddress(ADDRESSES.shadowMeshHook);
  const poolManager = getAddress(ADDRESSES.poolManager);

  const [currency0, currency1] = sortCurrencies(mockUSDC, mockWETH);

  const poolKey = {
    currency0,
    currency1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: shadowMeshHook,
  };

  console.log("Initializing Uniswap v4 pool on Sepolia");
  console.log("PoolManager:", poolManager);
  console.log("Currency0:", currency0);
  console.log("Currency1:", currency1);
  console.log("Fee:", FEE);
  console.log("Tick spacing:", TICK_SPACING);
  console.log("Hook:", shadowMeshHook);
  console.log("sqrtPriceX96:", SQRT_PRICE_X96.toString());
  console.log("Sender:", walletClient.account.address);

  try {
    const hash = await walletClient.writeContract({
      address: poolManager,
      abi: poolManagerAbi,
      functionName: "initialize",
      args: [poolKey, SQRT_PRICE_X96],
      account: walletClient.account,
    });

    console.log("Initialize transaction sent:", hash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log("Initialize transaction mined");
    console.log("Transaction hash:", receipt.transactionHash);
    console.log("Status:", receipt.status);
    console.log("Block number:", receipt.blockNumber.toString());

    if (receipt.status !== "success") {
      throw new Error("Pool initialization transaction reverted");
    }
  } catch (error) {
    console.error("Pool initialization failed");

    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }

    process.exitCode = 1;
  }
}

await main();
