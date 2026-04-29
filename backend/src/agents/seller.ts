import "dotenv/config";
import { io } from "socket.io-client";
import { GoogleGenAI, Type } from "@google/genai";

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY in .env");
}

interface MovePayload {
  role: string;
  message: string;
}

interface DarkPoolState {
  status: string;
  turn: number;
  history: MovePayload[];
}

interface AgentResponse {
  status: string;
  agreedAmountWETH?: number;
  agreedAmountUSDC?: number;
  reasoning: string;
}

interface ParsedGenAIError {
  statusCode?: number;
  retryDelayMs?: number;
  isTransient: boolean;
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const brokerPort = process.env.PORT || "5001";
const socket = io(`http://localhost:${brokerPort}`, {
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5_000,
  timeout: 10_000,
});

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    status: { 
      type: Type.STRING,
      enum: ["negotiating", "agreed", "failed"],
      description: "The current state of the negotiation."
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
  if (typeof value.status !== "string") return false;
  if (typeof value.reasoning !== "string") return false;

  if (
    value.agreedAmountWETH !== undefined &&
    !isFiniteNumber(value.agreedAmountWETH)
  ) {
    return false;
  }

  if (
    value.agreedAmountUSDC !== undefined &&
    !isFiniteNumber(value.agreedAmountUSDC)
  ) {
    return false;
  }

  return true;
}

console.log("🔴 Agent B (Seller) Booting Up...");

socket.on("connect", () => {
  console.log(`Agent B connected with socket ID: ${socket.id}`);
  lastCompletedTurn = -1;
  inFlightTurn = null;
});

socket.on("connect_error", (error: Error) => {
  console.error("Seller socket connection error:", error.message);
});

socket.on("disconnect", (reason: string) => {
  console.log(`Seller disconnected: ${reason}`);
});

socket.on("state_update", async (incoming: unknown) => {
  if (!isDarkPoolState(incoming)) {
    console.error("Seller received malformed state_update payload.");
    return;
  }

  const state = incoming;

  if (state.status === "agreed" || state.status === "failed") {
    return;
  }

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
If you reach a mutually beneficial agreement, set status to 'agreed' and output the final amounts.
Keep your reasoning concise (1-2 sentences max).

${historyPrompt}`;

    const rawText = await generateNegotiationMove(systemPrompt);
    const parsedUnknown = JSON.parse(rawText) as unknown;

    if (!isAgentResponse(parsedUnknown)) {
      console.error("Seller model response failed schema validation:", parsedUnknown);
      return;
    }

    socket.emit("submit_move", {
      role: "seller",
      message: parsedUnknown.reasoning,
      data: parsedUnknown,
    });

    lastCompletedTurn = state.turn;
  } catch (error: unknown) {
    console.error("Seller AI Generation Error:", error);
  } finally {
    if (inFlightTurn === state.turn) inFlightTurn = null;
  }
});
