"use client";

import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [blockSize, setBlockSize] = useState(50);
  const [logs, setLogs] = useState("");
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminalRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = terminalRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function initiateProtocol() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setLogs("");
    setIsDeploying(true);

    try {
      const res = await fetch("/api/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: blockSize }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body to stream.");

      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) setLogs((prev) => prev + decoder.decode(value, { stream: true }));
      }
      setLogs((prev) => prev + decoder.decode());
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsDeploying(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-black font-mono text-emerald-400">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,rgba(16,185,129,0.14)_0%,transparent_55%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-80 [background-image:linear-gradient(rgba(16,185,129,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.06)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-20 mix-blend-overlay [background-image:repeating-linear-gradient(0deg,rgba(0,0,0,0.25)_0px,rgba(0,0,0,0.25)_1px,transparent_2px,transparent_4px)]"
        aria-hidden
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-8">

        <header className="flex flex-col gap-4 border-b border-emerald-900/40 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.35em] text-emerald-700/80">
              classified // mesh uplink active
            </p>
            <h1 className="mt-1 text-lg font-bold tracking-tight text-emerald-300 [text-shadow:_0_0_20px_rgb(52_211_153_/_0.6)] sm:text-xl">
              SHADOWMESH // KEEPERHUB MEV-PROTECTED DARK POOL
            </h1>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            {[
              ["LATENCY", "12ms"],
              ["NETWORK", "SEPOLIA"],
              ["SESSION", "LIVE"],
              ["PROTOCOL", "v2.1"],
            ].map(([label, val]) => (
              <span
                key={label}
                className="rounded border border-emerald-800/50 bg-zinc-950/80 px-2 py-1 text-emerald-500/90"
              >
                {label}:{" "}
                <span className="text-emerald-300 [text-shadow:_0_0_8px_rgb(52_211_153_/_0.5)]">
                  {val}
                </span>
              </span>
            ))}
          </div>
        </header>

        <div className="grid flex-1 gap-6 lg:grid-cols-[360px_1fr] lg:items-start">

          <section className="rounded-lg border border-green-900/50 bg-zinc-950/90 p-5 shadow-[0_0_40px_rgba(6,78,59,0.25)] backdrop-blur-sm">
            <p className="text-[9px] uppercase tracking-[0.3em] text-emerald-700/80">
              control module // negotiation ingress
            </p>
            <h2 className="mt-2 text-sm font-semibold text-emerald-200 [text-shadow:_0_0_12px_rgb(52_211_153_/_0.4)]">
              Dark Pool Parameters
            </h2>

            <div className="mt-6">
              <label className="block text-[10px] uppercase tracking-widest text-emerald-600/80">
                Target WETH Block Size
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={blockSize}
                disabled={isDeploying}
                onChange={(e) => setBlockSize(Number(e.target.value))}
                className="mt-2 w-full rounded border border-emerald-800/50 bg-black px-3 py-2 text-sm text-emerald-300 outline-none placeholder:text-emerald-900 focus:border-emerald-600/70 focus:[box-shadow:0_0_0_1px_rgba(16,185,129,0.3),0_0_20px_rgba(16,185,129,0.1)] disabled:opacity-50"
              />
            </div>

            <button
              type="button"
              disabled={isDeploying}
              onClick={() => void initiateProtocol()}
              className="mt-6 w-full rounded border border-emerald-600/40 bg-emerald-950/40 py-3 text-sm font-bold uppercase tracking-[0.22em] text-emerald-200 transition-all duration-200 hover:border-emerald-400/60 hover:bg-emerald-900/30 hover:[box-shadow:0_0_25px_rgba(16,185,129,0.2)] hover:[text-shadow:_0_0_14px_rgb(167_243_208_/_0.9)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className={isDeploying ? "inline-block animate-pulse" : undefined}>
                {isDeploying ? "▶ NEGOTIATING..." : "⚡ INITIATE PROTOCOL"}
              </span>
            </button>

            {error ? (
              <div className="mt-4 rounded border border-red-900/50 bg-red-950/30 p-3">
                <p className="text-[11px] text-red-400 [text-shadow:_0_0_8px_rgb(248_113_113_/_0.5)]">
                  [ERROR] {error}
                </p>
              </div>
            ) : null}

            <div className="mt-8 space-y-2 border-t border-emerald-900/30 pt-4 text-[10px] text-emerald-700/70">
              <p>ORACLE: PYTH HERMES PRICE FEEDS</p>
              <p>HOOK: SHADOWMESH V4 HOOK</p>
              <p>NETWORK: SEPOLIA TESTNET</p>
              <p>AGENTS: GEMINI AI · BUYER ↔ SELLER</p>
            </div>
          </section>

          <section className="flex min-h-[65vh] flex-1 flex-col rounded-lg border border-emerald-900/35 bg-black/90 shadow-[inset_0_0_100px_rgba(16,185,129,0.05),0_0_60px_rgba(6,78,59,0.3)]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-emerald-900/30 bg-zinc-950/90 px-4 py-2 text-[10px] uppercase tracking-[0.15em] text-emerald-600/90">
              <span className="text-emerald-400 [text-shadow:_0_0_8px_rgb(52_211_153_/_0.6)]">
                [ SYSTEM: ONLINE ]
              </span>
              <span className="text-emerald-800">|</span>
              <span>[ ORACLE: PYTH HERMES ]</span>
              <span className="text-emerald-800">|</span>
              <span>[ MESH: GENSYN AXL ]</span>
              <span className="text-emerald-800">|</span>
              <span className={isDeploying ? "animate-pulse text-emerald-300" : ""}>
                [ {isDeploying ? "STREAMING..." : "READY"} ]
              </span>
            </div>

            <pre
              ref={terminalRef}
              className="flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-black px-5 py-4 text-[12.5px] leading-relaxed text-emerald-400 [scrollbar-width:none] [-ms-overflow-style:none] [text-shadow:_0_0_8px_rgb(52_211_153_/_0.4)] [&::-webkit-scrollbar]:hidden"
            >
              {logs || (
                <span className="text-emerald-800/60">
                  {`// ShadowMesh Command Center ready.\n// Set a target WETH block size and click INITIATE PROTOCOL to begin AI negotiation.\n`}
                </span>
              )}
              <span
                className="inline-block w-[0.55ch] animate-pulse align-text-bottom text-emerald-300 [text-shadow:_0_0_10px_rgb(52_211_153_/_0.9)]"
              >
                █
              </span>
            </pre>
          </section>
        </div>

        <footer className="border-t border-emerald-950/50 pt-4 text-center text-[9px] uppercase tracking-[0.4em] text-emerald-900/70">
          shadowmesh // no public order flow // ai-to-ai settlement // keeperhub
        </footer>
      </div>
    </div>
  );
}
