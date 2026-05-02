import "dotenv/config";
import axios from "axios";
import { GoogleGenAI, Type } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { parseUnits, encodeAbiParameters, createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY in .env");
}

interface MovePayload {
  role: string;
  message: string;
  data?: AgreementData;
}

type PoolStatus = "idle" | "negotiating" | "agreed" | "failed";

interface AgreementData {
  status: PoolStatus;
  agreedAmountWETH?: number;
  agreedAmountUSDC?: number;
  reasoning: string;
}

interface DarkPoolState {
  status: string;
  turn: number;
  history: MovePayload[];
  finalAgreement?: AgreementData | null;
  /** Wire-format intent (bigint fields as decimal strings) — safe for JSON.stringify over AXL */
  intent?: WireDarkPoolIntent;
  buyerSettlementSig?: string;
  sellerSettlementSig?: string;
}

/** JSON-safe mirror of DarkPoolIntentArg for mesh transport (no bigint) */
interface WireDarkPoolIntent {
  tokenIn:     `0x${string}`;
  tokenOut:    `0x${string}`;
  fee:         number;
  tickSpacing: number;
  amountIn:    string;
  amountOut:   string;
  buyer:       `0x${string}`;
  seller:      `0x${string}`;
  buyerNonce:  string;
  sellerNonce: string;
  deadline:    string;
}

// On-chain DarkPoolIntent struct (must match ShadowMeshHook.sol field order exactly)
interface DarkPoolIntentArg {
  tokenIn:     `0x${string}`;
  tokenOut:    `0x${string}`;
  fee:         number;   // uint24 — viem accepts JS number for sub-32-bit ints
  tickSpacing: number;   // int24
  amountIn:    bigint;
  amountOut:   bigint;
  buyer:       `0x${string}`;
  seller:      `0x${string}`;
  buyerNonce:  bigint;
  sellerNonce: bigint;
  deadline:    bigint;
}

type AgentResponse = AgreementData;

interface ParsedGenAIError {
  statusCode?: number;
  retryDelayMs?: number;
  isTransient: boolean;
}

async function fetchLiveWethPrice(): Promise<number> {
  try {
    const feedId = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"; // WETH/USD
    const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;
    const response = await axios.get(url, { timeout: 10_000 });
    const parsed0 = response.data?.parsed?.[0];
    const priceData = parsed0?.price;
    if (!priceData || priceData.price === undefined || priceData.expo === undefined) {
      throw new Error("Unexpected Hermes response shape");
    }
    const price = Number(priceData.price);
    const expo = Number(priceData.expo);
    const actualPrice = price * 10 ** expo;
    console.log(`📈 Live Pyth WETH Price: $${actualPrice.toFixed(2)}`);
    return actualPrice;
  } catch (e) {
    console.error("⚠️ Pyth Oracle fetch failed, falling back to 3000", e);
    return 3000;
  }
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const keeperHubClient = new Client(
  { name: "shadowmesh-buyer", version: "1.0.0" },
  { capabilities: {} }
);

// ==========================================
// GENSYN AXL: P2P Network Configuration
// ==========================================
const AXL_PORT = process.env.AXL_PORT || "9001";
const TARGET_PUBKEY = process.env.TARGET_PUBKEY?.trim();

if (!TARGET_PUBKEY) {
  console.warn("⚠️ TARGET_PUBKEY is missing. AXL requires a peer public key to route messages.");
}

const AXL_BASE_URL = `http://127.0.0.1:${AXL_PORT}`;
const axlHttp = axios.create({
  baseURL: AXL_BASE_URL,
  timeout: 10_000,
  validateStatus: (s) => (s >= 200 && s < 300) || s === 204 || s === 404,
});

let localPoolState: DarkPoolState = {
  status: "idle",
  turn: 0,
  history: [],
  finalAgreement: null,
};

function normalizePrivateKey(raw: string): `0x${string}` {
  const normalized = raw.trim().replace(/^["']|["']$/g, "");
  const hex = normalized.startsWith("0x") ? normalized.slice(2) : normalized;
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error("Invalid private key format. Expected 64 hex chars (with or without 0x prefix).");
  }
  return `0x${hex}`;
}

const signerPrivateKey = process.env.AGENT_A_PRIVATE_KEY
  ? normalizePrivateKey(process.env.AGENT_A_PRIVATE_KEY)
  : process.env.PRIVATE_KEY
    ? normalizePrivateKey(process.env.PRIVATE_KEY)
    : generatePrivateKey();

const account = privateKeyToAccount(signerPrivateKey);

// ==========================================
// Settlement: EIP-712 Domain & Types
// Matches ShadowMeshHook: EIP712("ShadowMesh", "1") + OZ address(this) in digest
// ==========================================
const HOOK_ADDRESS = "0xb76306D31e12336F0D8C62497190ae49f06Bc080" as const;

const SETTLEMENT_DOMAIN = {
  name: "ShadowMesh",
  version: "1",
  chainId: 11155111,
  verifyingContract: HOOK_ADDRESS, // OZ EIP712 includes contract address in domain separator
} as const;

const DARK_POOL_INTENT_TYPES = {
  DarkPoolIntent: [
    { name: "tokenIn",     type: "address" },
    { name: "tokenOut",    type: "address" },
    { name: "fee",         type: "uint24"  },
    { name: "tickSpacing", type: "int24"   },
    { name: "amountIn",    type: "uint256" },
    { name: "amountOut",   type: "uint256" },
    { name: "buyer",       type: "address" },
    { name: "seller",      type: "address" },
    { name: "buyerNonce",  type: "uint256" },
    { name: "sellerNonce", type: "uint256" },
    { name: "deadline",    type: "uint256" },
  ],
} as const;

// ==========================================
// Uniswap v4: Price Limits & ABIs
// ==========================================

// TickMath.MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1 (prevent out-of-range revert)
const MIN_PRICE_LIMIT = 4295128740n;
const MAX_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341n;

// Minimal inline ABI — only the nonces(address) read function is needed
const NONCES_ABI = [
  {
    name: "nonces",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "owner", type: "address" }],
    outputs: [{ name: "",      type: "uint256" }],
  },
] as const;

// Explicit PoolSwapTest ABI passed to KeeperHub — avoids relying on auto-fetch from
// block explorer (test helper contracts may not be verified).
const POOL_SWAP_TEST_ABI = JSON.stringify([
  {
    name: "swap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0",   type: "address" },
          { name: "currency1",   type: "address" },
          { name: "fee",         type: "uint24"  },
          { name: "tickSpacing", type: "int24"   },
          { name: "hooks",       type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne",        type: "bool"    },
          { name: "amountSpecified",   type: "int256"  },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      {
        name: "testSettings",
        type: "tuple",
        components: [
          { name: "takeClaims",      type: "bool" },
          { name: "settleUsingBurn", type: "bool" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "delta", type: "int256" }],
  },
]);

// Typed params for encodeAbiParameters — mirrors DarkPoolIntent struct field order
const HOOK_DATA_ENCODE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "tokenIn",     type: "address" },
      { name: "tokenOut",    type: "address" },
      { name: "fee",         type: "uint24"  },
      { name: "tickSpacing", type: "int24"   },
      { name: "amountIn",    type: "uint256" },
      { name: "amountOut",   type: "uint256" },
      { name: "buyer",       type: "address" },
      { name: "seller",      type: "address" },
      { name: "buyerNonce",  type: "uint256" },
      { name: "sellerNonce", type: "uint256" },
      { name: "deadline",    type: "uint256" },
    ],
  },
  { type: "bytes" },
  { type: "bytes" },
] as const;

// ==========================================
// Viem Public Client — Sepolia on-chain reads
// ==========================================
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org"),
});

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    status: {
      type: Type.STRING,
      enum: ["negotiating", "agreed", "failed"],
      description: "The current state of the negotiation.",
    },
    agreedAmountWETH: { type: Type.NUMBER },
    agreedAmountUSDC: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
  required: ["status", "reasoning"],
};

const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 750;
const MAX_BACKOFF_MS = 20_000;
const GENERATION_TIMEOUT_MS = 30_000;

let inFlightTurn: number | null = null;
let lastCompletedTurn = -1;
let signingInProgress = false;
let hasSubmittedSettlement = false;
/** Heartbeat re-broadcast of Phase 1 if AXL send was lost (sendToPeer swallows errors) */
const SETTLEMENT_REBROADCAST_INTERVAL_MS = 10_000;
let lastSettlementBroadcastAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function parseRetryDelayMs(value: string): number | undefined {
  const trimmed = value.trim();
  const secondsMatch = /^(\d+(?:\.\d+)?)s$/i.exec(trimmed);
  if (secondsMatch) return Math.ceil(Number(secondsMatch[1]) * 1000);

  const msMatch = /^(\d+)ms$/i.exec(trimmed);
  if (msMatch) return Number(msMatch[1]);

  return undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;

  if (typeof record.status === "number") return record.status;
  if (typeof record.code === "number") return record.code;

  const nestedError = record.error;
  if (typeof nestedError === "object" && nestedError !== null) {
    const nestedRecord = nestedError as Record<string, unknown>;
    if (typeof nestedRecord.code === "number") return nestedRecord.code;
  }

  return undefined;
}

function extractRetryDelayFromDetails(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  const retryInfo = details.find((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const typed = entry as Record<string, unknown>;
    return typed["@type"] === "type.googleapis.com/google.rpc.RetryInfo";
  });

  if (!retryInfo || typeof retryInfo !== "object") return undefined;
  const retryInfoRecord = retryInfo as Record<string, unknown>;
  if (typeof retryInfoRecord.retryDelay !== "string") return undefined;
  return parseRetryDelayMs(retryInfoRecord.retryDelay);
}

function parseGenAIError(error: unknown): ParsedGenAIError {
  let statusCode = extractStatusCode(error);
  let retryDelayMs: number | undefined;

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      try {
        const parsed = JSON.parse(record.message) as { error?: { code?: number; details?: unknown } };
        if (typeof parsed.error?.code === "number" && statusCode === undefined) {
          statusCode = parsed.error.code;
        }
        retryDelayMs = extractRetryDelayFromDetails(parsed.error?.details);
      } catch {
        const delayMatch = record.message.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
        if (delayMatch) retryDelayMs = Math.ceil(Number(delayMatch[1]) * 1000);
      }
    }
  }

  const isTransient = statusCode === 429 || statusCode === 500 || statusCode === 503;
  return { statusCode, retryDelayMs, isTransient };
}

function computeBackoffWithJitter(attempt: number, serverRetryMs?: number): number {
  const exponentialBase = BASE_BACKOFF_MS * (2 ** attempt);
  const delayWithJitter = exponentialBase + Math.floor(Math.random() * 1000);
  const cappedDelay = Math.min(MAX_BACKOFF_MS, delayWithJitter);

  if (typeof serverRetryMs === "number" && Number.isFinite(serverRetryMs)) {
    return Math.max(cappedDelay, serverRetryMs);
  }
  return cappedDelay;
}

async function generateNegotiationMove(systemPrompt: string, attempt = 0): Promise<string> {
  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: systemPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.7,
        },
      }),
      GENERATION_TIMEOUT_MS,
      "Buyer generation"
    );

    const rawText = response.text;
    if (!rawText) throw new Error("Buyer model returned empty response text.");
    return rawText;
  } catch (error: unknown) {
    const parsed = parseGenAIError(error);
    const canRetry = parsed.isTransient && attempt < MAX_RETRIES;
    if (!canRetry) throw error;

    const delayMs = computeBackoffWithJitter(attempt, parsed.retryDelayMs);
    console.warn(
      `Buyer transient GenAI error (status: ${parsed.statusCode ?? "unknown"}). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES}).`
    );
    await sleep(delayMs);
    return generateNegotiationMove(systemPrompt, attempt + 1);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoolStatus(value: unknown): value is PoolStatus {
  return value === "idle" || value === "negotiating" || value === "agreed" || value === "failed";
}

function isMovePayload(value: unknown): value is MovePayload {
  return (
    isObject(value) &&
    typeof value.role === "string" &&
    typeof value.message === "string"
  );
}

function isDarkPoolState(value: unknown): value is DarkPoolState {
  return (
    isObject(value) &&
    typeof value.status === "string" &&
    isFiniteNumber(value.turn) &&
    Array.isArray(value.history) &&
    value.history.every(isMovePayload)
  );
}

function isAgentResponse(value: unknown): value is AgentResponse {
  if (!isObject(value)) return false;
  if (!isPoolStatus(value.status)) return false;
  if (typeof value.reasoning !== "string") return false;

  if (value.agreedAmountWETH !== undefined && !isFiniteNumber(value.agreedAmountWETH)) {
    return false;
  }

  if (value.agreedAmountUSDC !== undefined && !isFiniteNumber(value.agreedAmountUSDC)) {
    return false;
  }

  return true;
}

function parseAgreementAmountToBaseUnits(
  value: number | string | undefined,
  field: "agreedAmountWETH" | "agreedAmountUSDC"
): bigint {
  if (value === undefined) {
    throw new Error(`Missing ${field}.`);
  }

  const normalized = typeof value === "number" ? value.toString() : value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid ${field}: expected a non-negative decimal amount.`);
  }

  return parseUnits(normalized, 18);
}

function extractFinalAgreementFromIncoming(incoming: unknown): AgreementData | null {
  if (!isObject(incoming)) return null;
  const candidate = incoming.finalAgreement;
  if (candidate === null || candidate === undefined) return null;
  if (!isAgentResponse(candidate)) return null;
  return candidate;
}

// ==========================================
// Settlement: Nonce Fetch
// ==========================================

/**
 * Fetches the live on-chain nonces for buyer and seller from ShadowMeshHook.
 * Must be called before building the DarkPoolIntent — _useCheckedNonce() will
 * revert with InvalidAccountNonce if the value in the intent doesn't match.
 */
async function fetchNonces(
  buyer: `0x${string}`,
  seller: `0x${string}`,
): Promise<{ buyerNonce: bigint; sellerNonce: bigint }> {
  const [buyerNonce, sellerNonce] = await Promise.all([
    publicClient.readContract({
      address: HOOK_ADDRESS,
      abi: NONCES_ABI,
      functionName: "nonces",
      args: [buyer],
    }),
    publicClient.readContract({
      address: HOOK_ADDRESS,
      abi: NONCES_ABI,
      functionName: "nonces",
      args: [seller],
    }),
  ]);
  console.log(`🔢 On-chain nonces — Buyer: ${buyerNonce}, Seller: ${sellerNonce}`);
  return { buyerNonce, sellerNonce };
}

// ==========================================
// Settlement: Intent Construction & Signing
// ==========================================

function buildDarkPoolIntent(
  finalAgreement: AgreementData,
  buyerNonce: bigint,
  sellerNonce: bigint,
): DarkPoolIntentArg {
  const tokenIn        = process.env.TOKEN_IN?.trim() as `0x${string}` | undefined;
  const tokenOut       = process.env.TOKEN_OUT?.trim() as `0x${string}` | undefined;
  const sellerAddress  = process.env.SELLER_ADDRESS?.trim() as `0x${string}` | undefined;
  const poolFee        = process.env.POOL_FEE ? parseInt(process.env.POOL_FEE, 10) : undefined;
  const poolTickSpacing = process.env.POOL_TICK_SPACING
    ? parseInt(process.env.POOL_TICK_SPACING, 10)
    : undefined;

  if (!tokenIn || !tokenOut || !sellerAddress || poolFee === undefined || poolTickSpacing === undefined) {
    throw new Error(
      "Missing env vars required for settlement: TOKEN_IN, TOKEN_OUT, SELLER_ADDRESS, POOL_FEE, POOL_TICK_SPACING"
    );
  }

  // Buyer pays amountIn (USDC), receives amountOut (WETH)
  const amountIn  = parseAgreementAmountToBaseUnits(finalAgreement.agreedAmountUSDC, "agreedAmountUSDC");
  const amountOut = parseAgreementAmountToBaseUnits(finalAgreement.agreedAmountWETH, "agreedAmountWETH");

  return {
    tokenIn,
    tokenOut,
    fee: poolFee,
    tickSpacing: poolTickSpacing,
    amountIn,
    amountOut,
    buyer:       account.address,
    seller:      sellerAddress,
    buyerNonce,
    sellerNonce,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300), // 5-minute window
  };
}

async function signDarkPoolIntent(intent: DarkPoolIntentArg): Promise<`0x${string}`> {
  return account.signTypedData({
    domain: SETTLEMENT_DOMAIN,
    types:  DARK_POOL_INTENT_TYPES,
    primaryType: "DarkPoolIntent",
    message: intent,
  });
}

function toWireIntent(i: DarkPoolIntentArg): WireDarkPoolIntent {
  return {
    tokenIn: i.tokenIn,
    tokenOut: i.tokenOut,
    fee: i.fee,
    tickSpacing: i.tickSpacing,
    amountIn: i.amountIn.toString(),
    amountOut: i.amountOut.toString(),
    buyer: i.buyer,
    seller: i.seller,
    buyerNonce: i.buyerNonce.toString(),
    sellerNonce: i.sellerNonce.toString(),
    deadline: i.deadline.toString(),
  };
}

function fromWireIntent(w: WireDarkPoolIntent): DarkPoolIntentArg | null {
  try {
    return {
      tokenIn: w.tokenIn,
      tokenOut: w.tokenOut,
      fee: w.fee,
      tickSpacing: w.tickSpacing,
      amountIn: BigInt(w.amountIn),
      amountOut: BigInt(w.amountOut),
      buyer: w.buyer,
      seller: w.seller,
      buyerNonce: BigInt(w.buyerNonce),
      sellerNonce: BigInt(w.sellerNonce),
      deadline: BigInt(w.deadline),
    };
  } catch {
    return null;
  }
}

// ==========================================
// Settlement: hookData Packing
// ==========================================

/** JSON replacer to serialise BigInt as decimal strings for KeeperHub function_args. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Packs (DarkPoolIntent, buyerSig, sellerSig) into a single ABI-encoded bytes blob.
 * Matches the abi.decode(hookData, (DarkPoolIntent, bytes, bytes)) in _beforeSwap.
 */
function packHookData(
  intent: DarkPoolIntentArg,
  buyerSig: `0x${string}`,
  sellerSig: `0x${string}`,
): Hex {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodeAbiParameters(HOOK_DATA_ENCODE_PARAMS as any, [intent, buyerSig, sellerSig]);
}

function mcpFirstText(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.content)) return "";
  for (const block of result.content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

function keeperHubExecutionLooksSuccessful(o: Record<string, unknown> | null): boolean {
  if (!o) return false;
  const st = typeof o.status === "string" ? o.status.toLowerCase() : "";
  if (st === "failed" || st === "error") return false;
  if (st === "success" || st === "completed" || st === "succeeded") return true;
  if (st === "pending" || st === "queued" || st === "running" || st === "in_progress") return false;
  const tx = o.transaction_hash ?? o.txHash ?? o.hash;
  if (typeof tx === "string" && /^0x[a-fA-F0-9]{64}$/i.test(tx)) return true;
  return false;
}

/** Polls `get_direct_execution_status` until terminal success or failure (per KeeperHub MCP tool). */
async function waitForDirectExecutionTerminal(executionId: string): Promise<string> {
  const maxWaitMs = 90_000;
  const intervalMs = 2_000;
  const deadline = Date.now() + maxWaitMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await keeperHubClient.callTool({
      name: "get_direct_execution_status",
      arguments: { execution_id: executionId },
    });
    if (isObject(r) && r.isError === true) {
      throw new Error(`get_direct_execution_status MCP error: ${mcpFirstText(r)}`);
    }
    last = mcpFirstText(r);
    const o = parseJsonObject(last);
    const st = typeof o?.status === "string" ? o.status.toLowerCase() : "";
    if (st === "failed" || st === "error") {
      throw new Error(`KeeperHub execution failed (executionId=${executionId}): ${last}`);
    }
    if (keeperHubExecutionLooksSuccessful(o)) return last;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`KeeperHub execution ${executionId} timed out waiting for terminal status. Last: ${last}`);
}

// ==========================================
// Settlement: KeeperHub Execution
// ==========================================

async function submitToKeeperHub(
  intent: DarkPoolIntentArg,
  buyerSig: `0x${string}`,
  sellerSig: `0x${string}`,
): Promise<void> {
  const router = process.env.ROUTER_ADDRESS?.trim();
  if (!router) throw new Error("Missing ROUTER_ADDRESS in .env.buyer");

  const hookData = packHookData(intent, buyerSig, sellerSig);

  // Uniswap v4 requires currency0 < currency1 by address (ascending sort)
  const [currency0, currency1] =
    intent.tokenIn.toLowerCase() < intent.tokenOut.toLowerCase()
      ? [intent.tokenIn, intent.tokenOut]
      : [intent.tokenOut, intent.tokenIn];

  const zeroForOne = intent.tokenIn.toLowerCase() === currency0.toLowerCase();

  const poolKey = {
    currency0,
    currency1,
    fee:         intent.fee,
    tickSpacing: intent.tickSpacing,
    hooks:       HOOK_ADDRESS, // must match address(this) check in _validateIntentForSwap
  };

  const swapParams = {
    zeroForOne,
    // Negative amountSpecified = exact-input swap; magnitude must equal intent.amountIn
    amountSpecified: (-intent.amountIn).toString(),
    // Use canonical price limits to avoid TickMath out-of-range revert
    sqrtPriceLimitX96: (zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT).toString(),
  };

  const testSettings = { takeClaims: false, settleUsingBurn: false };

  const functionArgs = JSON.stringify(
    [poolKey, swapParams, testSettings, hookData],
    bigintReplacer, // prevents JSON.stringify TypeError on BigInt fields
  );

  try {
    const result = await keeperHubClient.callTool({
      name: "execute_contract_call",
      arguments: {
        contract_address: router,
        network:          "11155111", // Sepolia chain ID string (canonical KeeperHub format)
        function_name:    "swap",
        function_args:    functionArgs,
        abi:              POOL_SWAP_TEST_ABI, // explicit ABI — no auto-fetch dependency
      },
    });
    if (isObject(result) && result.isError === true) {
      throw new Error(mcpFirstText(result) || "execute_contract_call returned isError");
    }
    const initialText = mcpFirstText(result);
    const initialObj = parseJsonObject(initialText);
    const executionId =
      (typeof initialObj?.executionId === "string" && initialObj.executionId) ||
      (typeof initialObj?.execution_id === "string" && initialObj.execution_id) ||
      undefined;

    if (!executionId) {
      console.log("✅ KeeperHub Execution Result:", result);
      return;
    }

    const detailText = await waitForDirectExecutionTerminal(executionId);
    console.log("✅ KeeperHub execution succeeded:", detailText);
  } catch (err) {
    console.error("❌ KeeperHub execute_contract_call failed:", err);
    throw err;
  }
}

// ==========================================
// Settlement: State-Lock Handler
// ==========================================

/**
 * Two-phase settlement (deadlock-free):
 * Phase 1 — If agreed and no buyerSettlementSig yet: fetch nonces, build+sign intent,
 *   store WireDarkPoolIntent + buyerSettlementSig on localPoolState, sendToPeer.
 * Phase 2 — If sellerSettlementSig on incoming and local wire intent + buyer sig exist:
 *   reconstruct bigint intent, submitToKeeperHub (sets hasSubmittedSettlement only on success).
 * Heartbeat — If Phase 1 done but no submission yet, re-broadcast every SETTLEMENT_REBROADCAST_INTERVAL_MS.
 */
async function handleSettlement(incoming: unknown): Promise<void> {
  if (hasSubmittedSettlement) return;

  // ── Phase 2: seller signature arrived ─────────────────────────────────────
  const incomingSellerSig =
    isObject(incoming) &&
    typeof incoming.sellerSettlementSig === "string" &&
    incoming.sellerSettlementSig.startsWith("0x")
      ? (incoming.sellerSettlementSig as `0x${string}`)
      : null;

  if (incomingSellerSig && localPoolState.buyerSettlementSig && localPoolState.intent) {
    const intent = fromWireIntent(localPoolState.intent);
    if (!intent) {
      console.error("Settlement Phase 2: cannot reconstruct intent from wire");
      return;
    }
    try {
      await submitToKeeperHub(
        intent,
        localPoolState.buyerSettlementSig as `0x${string}`,
        incomingSellerSig,
      );
      hasSubmittedSettlement = true;
      console.log("✅ Settlement submitted to KeeperHub.");
    } catch (e) {
      console.error("❌ KeeperHub submission failed, will retry on next poll:", e);
    }
    return;
  }

  // ── Phase 1 already complete: heartbeat re-broadcast ─────────────────────
  if (localPoolState.buyerSettlementSig) {
    const now = Date.now();
    if (now - lastSettlementBroadcastAt >= SETTLEMENT_REBROADCAST_INTERVAL_MS) {
      console.log("⏳ Re-broadcasting Phase 1 payload (heartbeat)...");
      await sendToPeer(localPoolState);
      lastSettlementBroadcastAt = now;
    }
    return;
  }

  // ── Phase 1: first-time initiation ───────────────────────────────────────
  if (signingInProgress || localPoolState.status !== "agreed") return;

  const finalAgreement =
    localPoolState.finalAgreement ?? extractFinalAgreementFromIncoming(incoming);
  if (!finalAgreement || finalAgreement.status !== "agreed") return;

  signingInProgress = true;
  try {
    const sellerAddr = process.env.SELLER_ADDRESS?.trim() as `0x${string}` | undefined;
    if (!sellerAddr) throw new Error("Missing SELLER_ADDRESS in .env.buyer");

    const { buyerNonce, sellerNonce } = await fetchNonces(account.address, sellerAddr);
    const intent = buildDarkPoolIntent(finalAgreement, buyerNonce, sellerNonce);
    const buyerSig = await signDarkPoolIntent(intent);

    localPoolState.intent = toWireIntent(intent);
    localPoolState.buyerSettlementSig = buyerSig;
    console.log(`✍️ [BUYER SETTLEMENT SIG]: ${buyerSig}`);

    const inlineSeller =
      isObject(incoming) &&
      typeof incoming.sellerSettlementSig === "string" &&
      incoming.sellerSettlementSig.startsWith("0x")
        ? (incoming.sellerSettlementSig as `0x${string}`)
        : null;

    if (inlineSeller) {
      try {
        await submitToKeeperHub(intent, buyerSig, inlineSeller);
        hasSubmittedSettlement = true;
        console.log("✅ Settlement submitted to KeeperHub (inline seller sig).");
      } catch (e) {
        console.error("❌ KeeperHub submission failed, will retry on next poll:", e);
      }
      return;
    }

    await sendToPeer(localPoolState);
    lastSettlementBroadcastAt = Date.now();
    console.log("📡 Phase 1 broadcast: wire intent + buyerSettlementSig.");
  } catch (error: unknown) {
    console.error("❌ Settlement Phase 1 error:", error);
    localPoolState.intent = undefined;
    localPoolState.buyerSettlementSig = undefined;
  } finally {
    signingInProgress = false;
  }
}

function safeJsonParse<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isNewerState(state: DarkPoolState): boolean {
  return state.turn > localPoolState.turn;
}

async function sendToPeer(payload: DarkPoolState) {
  if (!TARGET_PUBKEY) return;
  try {
    await axlHttp.post("/send", JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        "X-Destination-Peer-Id": TARGET_PUBKEY,
      },
    });
  } catch (error) {
    console.error("❌ AXL Send Error:", error);
  }
}

async function processStateUpdate(incoming: unknown) {
  if (isObject(incoming)) {
    const maybeStatus = incoming.status;
    const maybeTurn = incoming.turn;
    if ((maybeStatus === "agreed" || maybeStatus === "failed") && typeof maybeTurn === "number") {
      console.log(`✅ [STATE_LOCK]: Deal closed at Turn ${maybeTurn}. Disabling AI. Entering settlement...`);
      lastCompletedTurn = Infinity;
      localPoolState.status = maybeStatus;
      localPoolState.turn = maybeTurn;

      if (maybeStatus === "agreed") {
        if (!localPoolState.finalAgreement) {
          const fa = extractFinalAgreementFromIncoming(incoming);
          if (fa) localPoolState.finalAgreement = fa;
        }
        await handleSettlement(incoming);
      }
      return;
    }
  }

  if (!isDarkPoolState(incoming)) {
    console.error("Buyer received malformed state_update payload.");
    return;
  }

  const state = incoming;

  if (state.turn % 2 !== 0) return;
  if (state.turn <= lastCompletedTurn) return;
  if (inFlightTurn === state.turn) return;
  if (inFlightTurn !== null && inFlightTurn > state.turn) return;

  inFlightTurn = state.turn;

  try {
    const lastMove = state.history[state.history.length - 1];
    if (lastMove) {
      console.log(`💬 Counterparty says: "${lastMove.message}"`);
      if (lastMove.data?.agreedAmountUSDC) console.log(`💰 Proposed USDC: ${lastMove.data.agreedAmountUSDC}`);
    }
    console.log(`\n🧠 Buyer's Turn (Turn ${state.turn}). Thinking...`);

    const historyPrompt = state.history
      .map((move) => `[${move.role.toUpperCase()}]: ${move.message}`)
      .join("\n");

    const livePrice = await fetchLiveWethPrice();
    const maxLimitPrice = Math.round(livePrice * 1.01);

    const systemPrompt = `You are Agent A (Buyer), an AI trading algorithm in a Uniswap Dark Pool.
      Your goal is to BUY Mock WETH using your Mock USDC.
      The current global spot price of WETH from the Pyth Oracle is ${livePrice.toFixed(2)} USDC.
      Your absolute maximum limit price is ${maxLimitPrice} USDC per 1 WETH. DO NOT reveal this maximum limit.
      
      🚨 CRITICAL SYSTEM INSTRUCTION 🚨
      CURRENT TURN: ${state.turn}
      You MUST reach an agreement within 5 turns. 
      If the current turn is 4 or higher, you MUST aggressively compromise. If the seller's offer is at or below ${maxLimitPrice} USDC per 1 WETH, ACCEPT IT immediately.
      
      While making counter-offers, you MUST set status to 'negotiating'.
      If the seller demands more than ${maxLimitPrice} USDC per WETH and refuses to budge, you must set status to 'failed'.
      If you agree to the price, you MUST set status to 'agreed'. Your reasoning field should provide a natural, professional closing statement.
      Keep your reasoning concise (1-2 sentences max).
      
      ${historyPrompt}`;

    const rawText = await generateNegotiationMove(systemPrompt);
    const parsedUnknown = JSON.parse(rawText) as unknown;

    if (!isAgentResponse(parsedUnknown)) {
      console.error("Buyer model response failed schema validation:", parsedUnknown);
      return;
    }

    const newPayload: MovePayload & { data: AgentResponse } = {
      role: "buyer",
      message: parsedUnknown.reasoning,
      data: parsedUnknown,
    };

    if (localPoolState.status === "agreed" || localPoolState.status === "failed") {
      lastCompletedTurn = Infinity;
      return;
    }

    localPoolState.history.push(newPayload);
    localPoolState.turn += 1;
    localPoolState.status = parsedUnknown.status;
    if (parsedUnknown.status === "agreed" || parsedUnknown.status === "failed") {
      localPoolState.finalAgreement = parsedUnknown;
    }

    // Buyer-first agree: run settlement Phase 1 before mesh send so Seller never sees naked agreed
    if (parsedUnknown.status === "agreed") {
      lastCompletedTurn = Infinity;
      await handleSettlement({});
      await sendToPeer(localPoolState);
      return;
    }

    await sendToPeer(localPoolState);
    lastCompletedTurn = state.turn;
  } catch (error: unknown) {
    console.error("Buyer AI Generation Error:", error);
  } finally {
    if (inFlightTurn === state.turn) inFlightTurn = null;
  }
}

async function pollIncomingMessages() {
  if (hasSubmittedSettlement) return;

  try {
    const response = await axlHttp.get("/recv", { responseType: "text" });

    if (response.status === 204 || response.status === 404) {
      if (localPoolState.status === "agreed" && !hasSubmittedSettlement) {
        await handleSettlement({});
      }
      return;
    }

    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const incomingState = safeJsonParse<DarkPoolState>(raw);
    if (!incomingState) return;
    if (!isDarkPoolState(incomingState)) return;

    if (localPoolState.status === "agreed" && !hasSubmittedSettlement) {
      if (!localPoolState.finalAgreement && incomingState.finalAgreement) {
        localPoolState.finalAgreement = incomingState.finalAgreement;
      }
      await handleSettlement(incomingState);
      return;
    }

    if (!isNewerState(incomingState)) return;

    localPoolState = incomingState;
    await processStateUpdate(localPoolState);
  } catch {
    // ignore transient empty-queue/timeouts
  }
}

async function initKeeperHubMcp(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY?.replace(/['"]/g, '').trim();
  if (!apiKey) {
    throw new Error("Missing KEEPERHUB_API_KEY in environment.");
  }

  const transport = new StreamableHTTPClientTransport(new URL("https://app.keeperhub.com/mcp"), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });

  transport.onerror = (error) => {
    console.error("KeeperHub MCP transport error:", error);
  };

  transport.onclose = () => {
    console.warn("KeeperHub MCP transport closed.");
  };

  await keeperHubClient.connect(transport);
  console.log("✅ KeeperHub MCP Connected!");

  const { tools } = await keeperHubClient.listTools();
  const toolNames = tools.map((tool) => tool.name);
  console.log(
    `🛠️ KeeperHub tools loaded (${toolNames.length}): ${
      toolNames.length ? toolNames.join(", ") : "(none)"
    }`
  );
}

console.log("🟢 Agent A (Buyer) Booting Up...");
console.log(`🧾 Agent A wallet: ${account.address}`);

let pollLoopStarted = false;
let pollInFlight = false;

function startPolling() {
  if (pollLoopStarted) return;
  pollLoopStarted = true;

  const loop = async () => {
    if (!pollInFlight) {
      pollInFlight = true;
      try {
        await pollIncomingMessages();
      } finally {
        pollInFlight = false;
      }
    }
    setTimeout(loop, 2000);
  };

  void loop();
}

async function bootstrapBuyerAgent() {
  // Ensure KeeperHub MCP is online before starting the negotiation loop.
  await initKeeperHubMcp();

  startPolling();

  // BOOTSTRAP THE MESH: Buyer makes the first move
  setTimeout(() => {
    if (localPoolState.turn === 0) {
      console.log("🚀 Bootstrapping P2P Negotiation...");
      void processStateUpdate(localPoolState);
    }
  }, 3000);
}

void bootstrapBuyerAgent().catch((error) => {
  console.error("❌ Failed to bootstrap Buyer agent:", error);
  process.exit(1);
});
