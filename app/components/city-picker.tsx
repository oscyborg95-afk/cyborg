"use client";

import { useEffect, useRef, useState } from "react";
import type { CityOption } from "@/lib/cities-fallback";

// One fetch per session, shared across every picker instance.
let cache: CityOption[] | null = null;
let inflight: Promise<CityOption[]> | null = null;
function loadCities(): Promise<CityOption[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/couriers/cities")
      .then((r) => r.json())
      .then((d) => (cache = (d.cities ?? []) as CityOption[]))
      .catch(() => (cache = []));
  }
  return inflight;
}

/**
 * Searchable city picker backed by the courier's canonical city list. Typing
 * filters the list; picking a city hands back its exact id (for exact booking).
 * Editing the text freely clears the id, so booking falls back to name matching.
 * With no list available it behaves as a plain text input.
 */
export function CityPicker({
  value,
  onChange,
  className = "",
  placeholder = "e.g. Nugegoda",
}: {
  value: string;
  onChange: (city: string, cityId: number | null) => void;
  className?: string;
  placeholder?: string;
}) {
  const [cities, setCities] = useState<CityOption[]>(cache ?? []);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    loadCities().then((c) => alive && setCities(c));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = value.trim().toLowerCase();
  const matches = (
    q ? cities.filter((c) => c.text.toLowerCase().includes(q)) : cities
  ).slice(0, 8);
  const exact = cities.some((c) => c.text.toLowerCase() === q);

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <input
          className={className}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value, null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
        {exact && value && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-frog-dark">
            ✓
          </span>
        )}
      </div>
      {open && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border-2 border-cardline bg-white shadow-lg">
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c.text, c.id);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left font-display text-sm font-bold text-ink hover:bg-pond"
              >
                {c.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
