"use client";

import { useState } from "react";

export function LogoutButton() {
  const [busy, setBusy] = useState(false);

  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/logout", { method: "POST" });
      if (!response.ok) throw new Error("Logout failed");
      window.location.href = "/login";
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={busy}
      title="Log out of this workspace"
      aria-label="Log out of this workspace"
      className="flex h-9 items-center gap-1.5 rounded-xl border-2 border-cardline bg-surface px-2.5 font-display text-xs font-extrabold text-ink-soft transition hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-frog disabled:opacity-60"
    >
      <span aria-hidden="true">↩</span>
      <span className="hidden xl:inline">{busy ? "Logging out…" : "Log out"}</span>
    </button>
  );
}
