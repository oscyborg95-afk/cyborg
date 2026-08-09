"use client";

import { useState } from "react";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!password || (mode === "signup" && (!email || !businessName)) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(mode === "signup" ? "/api/signup" : "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, businessName }),
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
        <h1 className="font-display text-2xl font-extrabold text-ink">🔐 WhatsApp Command Center</h1>
        <p className="mt-1 font-display text-sm font-bold text-ink-soft">
          {mode === "login" ? "Sign in to your business workspace." : "Create an isolated business workspace."}
        </p>
        {mode === "signup" && (
          <input
            className="mt-4 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-sm font-bold text-ink outline-none focus:border-frog"
            placeholder="Business name"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
          />
        )}
        <input
          type="email"
          autoFocus
          className={`${mode === "signup" ? "mt-2" : "mt-4"} w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-sm font-bold text-ink outline-none focus:border-frog`}
          placeholder={mode === "login" ? "Email (legacy account: leave blank)" : "Email"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          className="mt-2 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-sm font-bold text-ink outline-none focus:border-frog"
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
          disabled={busy || !password || (mode === "signup" && (!email || !businessName))}
          className="mt-4 w-full !py-3"
        >
          {busy ? "Working…" : mode === "login" ? "Sign in 🐸" : "Create workspace 🐸"}
        </Button>
        <button
          type="button"
          className="mt-3 font-display text-xs font-bold text-ink-soft underline"
          onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null); }}
        >
          {mode === "login" ? "Create a new business account" : "I already have an account"}
        </button>
      </Card>
    </div>
  );
}
