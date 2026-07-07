"use client";

import { useState } from "react";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Login failed");
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-6">
      <Froggy mood={error ? "thinking" : "happy"} size={100} />
      <Card className="w-full max-w-sm p-6 text-center">
        <h1 className="font-display text-2xl font-extrabold text-ink">🔐 Daily Cart</h1>
        <p className="mt-1 font-display text-sm font-bold text-ink-soft">
          Enter the operator password to open the command center.
        </p>
        <input
          type="password"
          autoFocus
          className="mt-4 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 text-center font-display text-base font-bold text-ink outline-none focus:border-frog"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && (
          <p className="mt-2 font-display text-xs font-bold text-[#c04545]">{error}</p>
        )}
        <Button
          tone="frog"
          onClick={submit}
          disabled={busy || !password}
          className="mt-4 w-full !py-3"
        >
          {busy ? "Checking…" : "Let me in 🐸"}
        </Button>
      </Card>
    </div>
  );
}
