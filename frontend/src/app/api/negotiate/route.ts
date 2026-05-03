import { spawn } from "child_process";
import type { NextRequest } from "next/server";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const body = parsed as { amount?: unknown };
  const amount = Number(body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json(
      { error: "Missing or invalid amount — must be a positive number" },
      { status: 400 }
    );
  }

  const backendRoot = path.join(process.cwd(), "..", "backend");
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const safeEnqueue = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          safeClose();
        }
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("npx", ["dotenv", "-e", ".env.buyer", "--", "tsx", "src/agents/buyer.ts"], {
          cwd: backendRoot,
          shell: true,
          stdio: "pipe",
          env: { ...process.env, TRADE_AMOUNT: String(amount) },
        });
      } catch (err) {
        safeEnqueue(
          `[spawn error] ${err instanceof Error ? err.message : String(err)}\n`
        );
        safeClose();
        return;
      }

      const { stdout, stderr } = child;

      if (!stdout || !stderr) {
        safeEnqueue("[internal error] child stdio unavailable\n");
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        safeClose();
        return;
      }

      const onAbort = () => {
        safeEnqueue("\n[client disconnected — terminating buyer process]\n");
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener("abort", onAbort);

      const cleanup = (suffix: string) => {
        req.signal.removeEventListener("abort", onAbort);
        safeEnqueue(suffix);
        safeClose();
      };

      stdout.setEncoding("utf8");
      stderr.setEncoding("utf8");

      stdout.on("data", (chunk: string) => safeEnqueue(chunk));
      stderr.on("data", (chunk: string) => safeEnqueue(chunk));

      child.on("error", (err) => {
        cleanup(`\n[process error] ${err.message}\n`);
      });

      child.on("close", (code, signal) => {
        const sig = signal ? ` signal=${signal}` : "";
        cleanup(`\n[process exited code=${code ?? "null"}${sig}]\n`);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
