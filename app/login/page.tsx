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
    <main className="flex min-h-dvh w-full flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:gap-5 sm:p-6">
      <Froggy mood={error ? "thinking" : "happy"} size={88} />
      <Card className="w-full max-w-sm p-5 text-center sm:p-6">
        <h1 className="font-display text-2xl font-extrabold text-ink">🔐 WhatsApp Command Center</h1>
        <p className="mt-1 font-display text-sm font-bold text-ink-soft">
          {mode === "login" ? "Sign in to your business workspace." : "Create an isolated business workspace."}
        </p>
        <form aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit(); }} className="mt-4 space-y-3">
        {mode === "signup" && (
          <label className="block text-left">
            <span className="sr-only">Business name</span>
          <input
            className="min-h-12 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-base font-bold text-ink outline-none focus:border-frog focus:ring-2 focus:ring-frog/20"
            placeholder="Business name"
            autoComplete="organization"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
          />
          </label>
        )}
        <label className="block text-left">
          <span className="sr-only">Email address</span>
        <input
          type="email"
          autoFocus
          autoComplete="email"
          className="min-h-12 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-base font-bold text-ink outline-none focus:border-frog focus:ring-2 focus:ring-frog/20"
          placeholder={mode === "login" ? "Email (legacy account: leave blank)" : "Email"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        </label>
        <label className="block text-left">
          <span className="sr-only">Password</span>
        <input
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          className="min-h-12 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-base font-bold text-ink outline-none focus:border-frog focus:ring-2 focus:ring-frog/20"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        </label>
        {error && (
          <p role="alert" className="rounded-xl border-2 border-danger-line bg-danger-bg p-3 text-left font-display text-sm font-bold text-danger-ink">{error}</p>
        )}
        <Button
          type="submit"
          tone="frog"
          disabled={busy || !password || (mode === "signup" && (!email || !businessName))}
          className="min-h-12 w-full !py-3"
        >
          {busy ? "Working…" : mode === "login" ? "Sign in 🐸" : "Create workspace 🐸"}
        </Button>
        </form>
        <button
          type="button"
          className="mt-3 min-h-11 rounded-xl px-3 font-display text-sm font-bold text-ink-soft underline focus:outline-none focus:ring-2 focus:ring-frog"
          onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null); }}
        >
          {mode === "login" ? "Create a new business account" : "I already have an account"}
        </button>
      </Card>
    </main>
  );
}
