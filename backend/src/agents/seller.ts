import "dotenv/config";
import axios from "axios";
import { GoogleGenAI, Type } from "@google/genai";
import { parseUnits } from "viem";
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
  intent?: WireDarkPoolIntent;
  buyerSettlementSig?: string;
  sellerSettlementSig?: string;
}

/** JSON-safe mirror of DarkPoolIntentArg for mesh transport */
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

interface DarkPoolIntentArg {
  tokenIn:     `0x${string}`;
  tokenOut:    `0x${string}`;
  fee:         number;
  tickSpacing: number;
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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// GENSYN AXL: P2P Network Configuration
// ==========================================
const AXL_PORT = process.env.AXL_PORT || "9002";
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

const signerPrivateKey = process.env.AGENT_B_PRIVATE_KEY
  ? normalizePrivateKey(process.env.AGENT_B_PRIVATE_KEY)
  : process.env.PRIVATE_KEY
    ? normalizePrivateKey(process.env.PRIVATE_KEY)
    : generatePrivateKey();

const account = privateKeyToAccount(signerPrivateKey);

// Settlement EIP-712 — must match ShadowMeshHook + buyer.ts exactly
const HOOK_ADDRESS = "0xb76306D31e12336F0D8C62497190ae49f06Bc080" as const;

const SETTLEMENT_DOMAIN = {
  name: "ShadowMesh",
  version: "1",
  chainId: 11155111,
  verifyingContract: HOOK_ADDRESS,
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
let hasSellerSettlementSig = false;

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
      "Seller generation"
    );

    const rawText = response.text;
    if (!rawText) throw new Error("Seller model returned empty response text.");
    return rawText;
  } catch (error: unknown) {
    const parsed = parseGenAIError(error);
    const canRetry = parsed.isTransient && attempt < MAX_RETRIES;
    if (!canRetry) throw error;

    const delayMs = computeBackoffWithJitter(attempt, parsed.retryDelayMs);
    console.warn(
      `Seller transient GenAI error (status: ${parsed.statusCode ?? "unknown"}). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES}).`
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

/** Parse Buyer's wire intent back to bigint struct for EIP-712 signing */
function parseBuyerIntent(wire: unknown): DarkPoolIntentArg | null {
  if (!isObject(wire)) return null;
  const w = wire as Record<string, unknown>;
  try {
    const tokenIn  = typeof w.tokenIn === "string" ? (w.tokenIn as `0x${string}`) : null;
    const tokenOut = typeof w.tokenOut === "string" ? (w.tokenOut as `0x${string}`) : null;
    const buyer    = typeof w.buyer === "string" ? (w.buyer as `0x${string}`) : null;
    const seller   = typeof w.seller === "string" ? (w.seller as `0x${string}`) : null;
    const fee =
      typeof w.fee === "number" ? w.fee : typeof w.fee === "string" ? parseInt(String(w.fee), 10) : NaN;
    const tickSpacing =
      typeof w.tickSpacing === "number"
        ? w.tickSpacing
        : typeof w.tickSpacing === "string"
          ? parseInt(String(w.tickSpacing), 10)
          : NaN;

    if (!tokenIn || !tokenOut || !buyer || !seller || !Number.isFinite(fee) || !Number.isFinite(tickSpacing)) {
      return null;
    }

    return {
      tokenIn,
      tokenOut,
      fee,
      tickSpacing,
      buyer,
      seller,
      amountIn: BigInt(String(w.amountIn)),
      amountOut: BigInt(String(w.amountOut)),
      buyerNonce: BigInt(String(w.buyerNonce)),
      sellerNonce: BigInt(String(w.sellerNonce)),
      deadline: BigInt(String(w.deadline)),
    };
  } catch {
    return null;
  }
}

async function signDarkPoolIntent(intent: DarkPoolIntentArg): Promise<`0x${string}`> {
  return account.signTypedData({
    domain: SETTLEMENT_DOMAIN,
    types: DARK_POOL_INTENT_TYPES,
    primaryType: "DarkPoolIntent",
    message: intent,
  });
}

async function handleSellerSettlement(incoming: unknown): Promise<void> {
  if (hasSellerSettlementSig) return;
  if (signingInProgress) return;
  if (!isObject(incoming)) return;

  const buyerSig = incoming.buyerSettlementSig;
  if (typeof buyerSig !== "string" || !buyerSig.startsWith("0x")) {
    console.warn("Settlement: buyerSettlementSig missing — waiting for Buyer Phase 1 broadcast.");
    return;
  }

  const intent = parseBuyerIntent(incoming.intent);
  if (!intent) {
    console.error("Settlement: missing or malformed wire intent from Buyer.");
    return;
  }

  if (intent.seller.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`Settlement: intent.seller (${intent.seller}) ≠ this wallet (${account.address}).`);
    return;
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (intent.deadline <= nowSec) {
    console.error(`Settlement: intent deadline expired (${intent.deadline} ≤ ${nowSec}).`);
    return;
  }

  const agreed = localPoolState.finalAgreement;
  if (agreed?.status === "agreed") {
    const expectIn = parseAgreementAmountToBaseUnits(agreed.agreedAmountUSDC, "agreedAmountUSDC");
    const expectOut = parseAgreementAmountToBaseUnits(agreed.agreedAmountWETH, "agreedAmountWETH");
    if (intent.amountIn !== expectIn || intent.amountOut !== expectOut) {
      console.error("Settlement: intent amounts mismatch negotiated finalAgreement — refusing to sign.");
      return;
    }
  }

  signingInProgress = true;
  try {
    const sellerSig = await signDarkPoolIntent(intent);
    console.log(`✍️ [SELLER SETTLEMENT SIG]: ${sellerSig}`);

    localPoolState.sellerSettlementSig = sellerSig;
    localPoolState.buyerSettlementSig = buyerSig;
    if (incoming.intent && isObject(incoming.intent)) {
      localPoolState.intent = incoming.intent as unknown as WireDarkPoolIntent;
    }

    await sendToPeer(localPoolState);
    hasSellerSettlementSig = true;
    console.log("📡 Seller settlement sig sent to Buyer.");
  } catch (e) {
    console.error("❌ Seller settlement error:", e);
    localPoolState.sellerSettlementSig = undefined;
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
        await handleSellerSettlement(incoming);
      }
      return;
    }
  }

  if (!isDarkPoolState(incoming)) {
    console.error("Seller received malformed state_update payload.");
    return;
  }

  const state = incoming;

  if (state.turn % 2 === 0) return;
  if (state.turn <= lastCompletedTurn) return;
  if (inFlightTurn === state.turn) return;
  if (inFlightTurn !== null && inFlightTurn > state.turn) return;

  inFlightTurn = state.turn;

  try {
    console.log(`\n🧠 Seller's Turn (Turn ${state.turn}). Thinking...`);

    const historyPrompt = state.history
      .map((move) => `[${move.role.toUpperCase()}]: ${move.message}`)
      .join("\n");

    const systemPrompt = `You are Agent B (Seller), an AI trading algorithm in a Uniswap Dark Pool.
Your goal is to SELL Mock WETH for Mock USDC.
Your minimum reserve price is 2,900 USDC per 1 WETH. DO NOT reveal this minimum limit.
Negotiate aggressively for a higher price. Start high.
While making counter-offers, you MUST set status to 'negotiating'.
If the buyer refuses to pay at least 2,900 USDC per WETH, you must set status to 'failed'.
If you agree to the price, you MUST set status to 'agreed'. Your reasoning field should provide a natural, professional closing statement (e.g., 'Deal closed. I agree to the final price.'). Do not provide any further negotiation logic.
Keep your reasoning concise (1-2 sentences max).

${historyPrompt}`;

    const rawText = await generateNegotiationMove(systemPrompt);
    const parsedUnknown = JSON.parse(rawText) as unknown;

    if (!isAgentResponse(parsedUnknown)) {
      console.error("Seller model response failed schema validation:", parsedUnknown);
      return;
    }

    const newPayload: MovePayload & { data: AgentResponse } = {
      role: "seller",
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

    await sendToPeer(localPoolState);
    lastCompletedTurn = parsedUnknown.status === "agreed" ? Infinity : state.turn;
  } catch (error: unknown) {
    console.error("Seller AI Generation Error:", error);
  } finally {
    if (inFlightTurn === state.turn) inFlightTurn = null;
  }
}

async function pollIncomingMessages() {
  if (hasSellerSettlementSig) return;

  try {
    const response = await axlHttp.get("/recv", { responseType: "text" });
    if (response.status === 204 || response.status === 404) return;

    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const incomingState = safeJsonParse<DarkPoolState>(raw);
    if (!incomingState) return;
    if (!isDarkPoolState(incomingState)) return;

    // Buyer's Phase 1 broadcast has the same turn as locked state — bypass isNewerState
    const incomingIsAgreed = isObject(incomingState) && incomingState.status === "agreed";
    if ((localPoolState.status === "agreed" || incomingIsAgreed) && !hasSellerSettlementSig) {
      if (!localPoolState.finalAgreement && incomingState.finalAgreement) {
        localPoolState.finalAgreement = incomingState.finalAgreement;
      }
      localPoolState.status = "agreed";
      lastCompletedTurn = Infinity;
      await handleSellerSettlement(incomingState);
      return;
    }

    if (!isNewerState(incomingState)) return;

    localPoolState = incomingState;
    await processStateUpdate(localPoolState);
  } catch {
    // ignore transient empty-queue/timeouts
  }
}

console.log("🔴 Agent B (Seller) Booting Up...");
console.log(`🧾 Agent B wallet: ${account.address}`);

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

startPolling();
