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

const EIP712_DOMAIN = {
  name: "DarkPool",
  version: "1",
  chainId: 11155111,
} as const;

const EIP712_TYPES = {
  Agreement: [
    { name: "agreedAmountWETH", type: "uint256" },
    { name: "agreedAmountUSDC", type: "uint256" },
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
let hasSignedAgreement = false;
let signingInProgress = false;

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

async function signFinalAgreementIfNeeded(incoming: unknown): Promise<void> {
  if (hasSignedAgreement || signingInProgress) return;

  const finalAgreement = extractFinalAgreementFromIncoming(incoming);
  if (!finalAgreement || finalAgreement.status !== "agreed") return;

  signingInProgress = true;
  try {
    const agreedAmountWETH = parseAgreementAmountToBaseUnits(
      finalAgreement.agreedAmountWETH,
      "agreedAmountWETH"
    );
    const agreedAmountUSDC = parseAgreementAmountToBaseUnits(
      finalAgreement.agreedAmountUSDC,
      "agreedAmountUSDC"
    );

    const signature = await account.signTypedData({
      domain: EIP712_DOMAIN,
      types: EIP712_TYPES,
      primaryType: "Agreement",
      message: {
        agreedAmountWETH,
        agreedAmountUSDC,
      },
    });

    hasSignedAgreement = true;
    console.log(`✍️ [WEB3 SIGNATURE]: ${signature}`);
  } catch (error: unknown) {
    console.error("Buyer EIP-712 signing error:", error);
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
      console.log(`✅ [STATE_LOCK]: Deal closed at Turn ${maybeTurn}. Disabling AI. Awaiting EIP-712 Signing...`);
      lastCompletedTurn = Infinity;
      localPoolState.status = maybeStatus;
      localPoolState.turn = maybeTurn;

      if (maybeStatus === "agreed") {
        await signFinalAgreementIfNeeded(incoming);
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
    console.log(`\n🧠 Buyer's Turn (Turn ${state.turn}). Thinking...`);

    const historyPrompt = state.history
      .map((move) => `[${move.role.toUpperCase()}]: ${move.message}`)
      .join("\n");

    const systemPrompt = `You are Agent A (Buyer), an AI trading algorithm in a Uniswap Dark Pool.
Your goal is to BUY Mock WETH using your Mock USDC.
Your maximum limit price is 3,200 USDC per 1 WETH. DO NOT reveal this maximum limit.
Negotiate aggressively for a lower price. Start low.
While making counter-offers, you MUST set status to 'negotiating'.
If the seller demands more than 3,200 USDC per WETH and refuses to budge, you must set status to 'failed'.
If you agree to the price, you MUST set status to 'agreed'. Your reasoning field should provide a natural, professional closing statement (e.g., 'Deal closed. I agree to the final price.'). Do not provide any further negotiation logic.
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

    await sendToPeer(localPoolState);
    lastCompletedTurn = state.turn;
  } catch (error: unknown) {
    console.error("Buyer AI Generation Error:", error);
  } finally {
    if (inFlightTurn === state.turn) inFlightTurn = null;
  }
}

async function pollIncomingMessages() {
  if (lastCompletedTurn === Infinity) return;

  try {
    const response = await axlHttp.get("/recv", { responseType: "text" });
    if (response.status === 204 || response.status === 404) return;

    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const incomingState = safeJsonParse<DarkPoolState>(raw);
    if (!incomingState) return;
    if (!isDarkPoolState(incomingState)) return;
    if (!isNewerState(incomingState)) return;

    localPoolState = incomingState;
    await processStateUpdate(localPoolState);
  } catch {
    // ignore transient empty-queue/timeouts
  }
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

startPolling();

// BOOTSTRAP THE MESH: Buyer makes the first move
setTimeout(() => {
  if (localPoolState.turn === 0) {
    console.log("🚀 Bootstrapping P2P Negotiation...");
    // Manually trigger the first state evaluation
    void processStateUpdate(localPoolState);
  }
}, 3000);
