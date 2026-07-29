"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Button } from "./components/ui";

const WORKER_URL =
  process.env.NEXT_PUBLIC_WA_WORKER_URL || "http://localhost:3001";

type ConnectionState = "checking" | "connected" | "unlinked" | "offline";

export function WhatsAppAccountControl() {
  const router = useRouter();
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/whatsapp/status", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Worker unavailable");
      const data = (await response.json()) as { ready?: boolean };
      setConnection(data.ready ? "connected" : "unlinked");
    } catch {
      setConnection("offline");
    }
  }, []);

  useEffect(() => {
    const initialStatusTimer = window.setTimeout(loadStatus, 0);
    const statusPoll = window.setInterval(loadStatus, 15_000);
    const socket: Socket = io(WORKER_URL, {
      transports: ["websocket", "polling"],
    });
    socket.on("connect", loadStatus);
    socket.on("disconnect", () => setConnection("offline"));
    socket.on("wa:status", ({ ready }: { ready: boolean }) =>
      setConnection(ready ? "connected" : "unlinked")
    );
    return () => {
      window.clearTimeout(initialStatusTimer);
      window.clearInterval(statusPoll);
      socket.disconnect();
    };
  }, [loadStatus]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, submitting]);

  const closeDialog = () => {
    if (submitting) return;
    setOpen(false);
    setError(null);
    triggerRef.current?.focus();
  };

  const switchAccount = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/whatsapp/logout", {
        method: "POST",
        cache: "no-store",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Could not log out this WhatsApp account.");
      }
      setConnection("unlinked");
      setOpen(false);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not log out this WhatsApp account. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const connected = connection === "connected";
  const stateLabel =
    connection === "checking"
      ? "Checking WhatsApp"
      : connected
        ? "WhatsApp connected"
        : connection === "offline"
          ? "WhatsApp offline"
          : "WhatsApp not linked";

  return (
    <>
      <div
        className="flex h-9 min-w-0 items-stretch overflow-hidden rounded-xl border-2 border-cardline bg-surface"
        aria-label={stateLabel}
      >
        <span className="flex min-w-0 items-center gap-2 px-2.5">
          <span
            aria-hidden="true"
            className={
              "h-2.5 w-2.5 shrink-0 rounded-full border-2 border-surface shadow-[0_0_0_1px_var(--color-cardline)] " +
              (connected
                ? "bg-frog shadow-[0_0_0_1px_var(--color-frog-dark),0_0_8px_rgba(88,204,2,0.55)]"
                : connection === "checking"
                  ? "animate-pulse bg-gold"
                  : "bg-ink-soft")
            }
          />
          <span className="hidden whitespace-nowrap font-display text-xs font-extrabold text-ink lg:inline">
            {stateLabel}
          </span>
        </span>
        <button
          ref={triggerRef}
          type="button"
          disabled={!connected}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          aria-label={
            connected
              ? "Switch WhatsApp account"
              : `${stateLabel}; account switching is unavailable`
          }
          title={connected ? "Switch WhatsApp account" : stateLabel}
          className="border-l-2 border-cardline px-2.5 font-display text-xs font-extrabold text-frog-dark transition hover:bg-pond focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-frog disabled:cursor-not-allowed disabled:text-ink-soft disabled:opacity-70"
        >
          <span className="hidden xl:inline">Switch account</span>
          <span className="text-base leading-none xl:hidden" aria-hidden="true">
            ↪
          </span>
        </button>
      </div>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4 backdrop-blur-[2px]"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeDialog();
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="switch-whatsapp-title"
              aria-describedby="switch-whatsapp-description"
              className="card3d w-full max-w-md animate-pop bg-surface p-5 shadow-[0_24px_70px_rgba(63,58,52,0.28)] sm:p-6"
            >
              <div className="mb-4 flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border-2 border-flame bg-flame-tint text-xl"
                >
                  ↪
                </span>
                <div>
                  <h2
                    id="switch-whatsapp-title"
                    className="font-display text-xl font-extrabold leading-tight text-ink"
                  >
                    Switch WhatsApp account?
                  </h2>
                  <p
                    id="switch-whatsapp-description"
                    className="mt-1.5 text-sm font-semibold leading-relaxed text-ink-soft"
                  >
                    This logs out the current linked device. The QR linking
                    screen appears next so you can connect another account.
                    Saved orders, customers, and chat history stay in this
                    dashboard.
                  </p>
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="mb-4 rounded-xl border-2 border-danger-line bg-danger-bg px-3 py-2.5 text-sm font-bold text-danger-ink"
                >
                  {error}
                </p>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  ref={cancelRef}
                  type="button"
                  tone="ghost"
                  disabled={submitting}
                  onClick={closeDialog}
                  className="w-full sm:w-auto"
                >
                  Keep current account
                </Button>
                <Button
                  type="button"
                  tone="flame"
                  disabled={submitting}
                  onClick={switchAccount}
                  className="w-full sm:w-auto"
                >
                  {submitting ? "Logging out…" : "Log out & switch"}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
