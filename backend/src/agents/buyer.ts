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

const socket = io(`http://localhost:${process.env.PORT || 5001}`);

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING },
    agreedAmountWETH: { type: Type.NUMBER },
    agreedAmountUSDC: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
  required: ["status", "reasoning"],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    typeof value.turn === "number" &&
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
    typeof value.agreedAmountWETH !== "number"
  ) {
    return false;
  }

  if (
    value.agreedAmountUSDC !== undefined &&
    typeof value.agreedAmountUSDC !== "number"
  ) {
    return false;
  }

  return true;
}

console.log("🟢 Agent A (Buyer) Booting Up...");

socket.on("connect", () => {
  console.log(`Agent A connected with socket ID: ${socket.id}`);
});

socket.on("connect_error", (error: Error) => {
  console.error("Buyer socket connection error:", error.message);
});

socket.on("disconnect", (reason: string) => {
  console.log(`Buyer disconnected: ${reason}`);
});

socket.on("state_update", async (incoming: unknown) => {
  if (!isDarkPoolState(incoming)) {
    console.error("Received malformed state_update payload.");
    return;
  }

  const state = incoming;

  if (state.status === "agreed" || state.status === "failed") {
    return;
  }

  if (state.turn % 2 === 0) {
    console.log(`\n🧠 Buyer's Turn (Turn ${state.turn}). Thinking...`);

    const historyPrompt = state.history
      .map((move) => `[${move.role.toUpperCase()}]: ${move.message}`)
      .join("\n");

    const systemPrompt = `You are Agent A (Buyer), an AI trading algorithm in a Uniswap Dark Pool.
Your goal is to BUY Mock WETH using your Mock USDC.
Your maximum limit price is 3,200 USDC per 1 WETH. DO NOT reveal this maximum limit.
Negotiate aggressively for a lower price. Start low.
If the seller demands more than 3,200 USDC per WETH and refuses to budge, you must set status to 'failed'.
If you reach a mutually beneficial agreement, set status to 'agreed' and output the final amounts.
Keep your reasoning concise (1-2 sentences max).

${historyPrompt}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        contents: systemPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.7,
        },
      });

      const rawText = response.text;
      if (!rawText) {
        console.error("Buyer model returned empty response text.");
        return;
      }

      const parsedUnknown = JSON.parse(rawText) as unknown;

      if (!isAgentResponse(parsedUnknown)) {
        console.error("Buyer model response failed schema validation:", parsedUnknown);
        return;
      }

      socket.emit("submit_move", {
        role: "buyer",
        message: parsedUnknown.reasoning,
        data: parsedUnknown,
      });
    } catch (error: unknown) {
      console.error("Buyer AI Generation Error:", error);
    }
  }
});
