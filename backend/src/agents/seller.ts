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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const brokerPort = process.env.PORT || "5001";
const socket = io(`http://localhost:${brokerPort}`);

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

  if (state.turn % 2 !== 0) {
    console.log(`\n🧠 Seller's Turn (Turn ${state.turn}). Thinking...`);

    const historyPrompt = state.history
      .map((move) => `[${move.role.toUpperCase()}]: ${move.message}`)
      .join("\n");

      const systemPrompt = `You are Agent A (Buyer), an AI trading algorithm in a Uniswap Dark Pool.
      Your goal is to BUY Mock WETH using your Mock USDC.
      Your maximum limit price is 3,200 USDC per 1 WETH. DO NOT reveal this maximum limit.
      Negotiate aggressively for a lower price. Start low.
      While making counter-offers, you MUST set status to 'negotiating'.
      If the seller demands more than 3,200 USDC per WETH and refuses to budge, you must set status to 'failed'.
      If you reach a mutually beneficial agreement, set status to 'agreed' and output the final amounts.
      Keep your reasoning concise (1-2 sentences max).
      
      ${historyPrompt}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: systemPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.7,
        },
      });

      const rawText = response.text;
      if (!rawText) {
        console.error("Seller model returned empty response text.");
        return;
      }

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
    } catch (error: unknown) {
      console.error("Seller AI Generation Error:", error);
    }
  }
});
