import "dotenv/config";
import express, { type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";

type PoolStatus = "idle" | "negotiating" | "agreed" | "failed";
type AgentRole = "buyer" | "seller" | "system";

interface AgreementData {
  status: PoolStatus;
  agreedAmountWETH?: number;
  agreedAmountUSDC?: number;
  reasoning: string;
}

interface MovePayload {
  role: AgentRole;
  message: string;
  data?: AgreementData;
}

interface DarkPoolState {
  status: PoolStatus;
  turn: number;
  history: MovePayload[];
  finalAgreement: AgreementData | null;
}

function getInitialState(): DarkPoolState {
  return {
    status: "idle",
    turn: 0,
    history: [],
    finalAgreement: null,
  };
}

let currentPoolState: DarkPoolState = getInitialState();

const app = express();
app.use(express.json());

app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

const httpServer: HttpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const MAX_TURNS = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPoolStatus(value: unknown): value is PoolStatus {
  return value === "idle" || value === "negotiating" || value === "agreed" || value === "failed";
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === "buyer" || value === "seller" || value === "system";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAgreementData(value: unknown): value is AgreementData {
  if (!isRecord(value)) return false;
  if (!isPoolStatus(value.status)) return false;
  if (typeof value.reasoning !== "string") return false;

  if (value.agreedAmountWETH !== undefined && !isFiniteNumber(value.agreedAmountWETH)) return false;
  if (value.agreedAmountUSDC !== undefined && !isFiniteNumber(value.agreedAmountUSDC)) return false;

  return true;
}

function isMovePayload(value: unknown): value is MovePayload {
  if (!isRecord(value)) return false;
  if (!isAgentRole(value.role)) return false;
  if (typeof value.message !== "string" || value.message.trim().length === 0) return false;
  if (value.data !== undefined && !isAgreementData(value.data)) return false;
  return true;
}

function broadcastStateUpdate(): void {
  io.emit("state_update", currentPoolState);
}

io.on("connection", (socket: Socket) => {
  console.log(`[${nowIso()}] socket connected: ${socket.id}`);
  socket.emit("state_update", currentPoolState);

  socket.on("submit_move", (payload: unknown) => {
    if (!isMovePayload(payload)) return;
    if (currentPoolState.status === "agreed" || currentPoolState.status === "failed") return;

    currentPoolState.history.push(payload);
    currentPoolState.turn += 1;

    if (currentPoolState.status === "idle") {
      currentPoolState.status = "negotiating";
    }

    if (currentPoolState.turn >= MAX_TURNS) {
      currentPoolState.status = "failed";
      currentPoolState.finalAgreement = {
        status: "failed",
        reasoning: `Negotiation failed: reached max turn limit (${MAX_TURNS}).`,
      };
      broadcastStateUpdate();
      return;
    }

    if (payload.data && (payload.data.status === "agreed" || payload.data.status === "failed")) {
      currentPoolState.status = payload.data.status;
      currentPoolState.finalAgreement = payload.data;
    }

    broadcastStateUpdate();
  });

  socket.on("reset_pool", () => {
    currentPoolState = getInitialState();
    broadcastStateUpdate();
  });

  socket.on("disconnect", (reason: string) => {
    console.log(`[${nowIso()}] socket disconnected: ${socket.id} (${reason})`);
  });
});

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, () => {
  console.log(`[${nowIso()}] Central Broker listening on port ${port}`);
});

let shuttingDown = false;

function gracefulShutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[${nowIso()}] ${signal} received, starting graceful shutdown...`);

  io.close(() => {
    httpServer.close((err?: Error) => {
      if (err) {
        console.error(`[${nowIso()}] HTTP close error:`, err);
        process.exit(1);
      }

      console.log(`[${nowIso()}] Graceful shutdown complete.`);
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.error(`[${nowIso()}] Shutdown timeout exceeded, forcing exit.`);
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
