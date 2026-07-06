"use client";

// Multi-product line-item editor used by both dispatch forms.
// Tap a product chip to add it (tap again = +1 qty), tweak qty/price inline,
// or add a free-typed custom line. The subtotal feeds the COD total live.

import { useState } from "react";
import type { OrderItem, Product } from "@/lib/types";
import { itemsSubtotal } from "@/lib/items";

const inputCls =
  "rounded-lg border-2 border-cardline bg-white px-2 py-1 font-display text-xs font-bold text-ink outline-none focus:border-frog";

export function ItemsEditor({
  products,
  items,
  onChange,
}: {
  products: Product[];
  items: OrderItem[];
  onChange: (items: OrderItem[]) => void;
}) {
  const [custom, setCustom] = useState({ name: "", price: "" });

  function addProduct(p: Product) {
    const idx = items.findIndex((i) => i.product_id === p.id);
    if (idx >= 0) {
      onChange(items.map((i, j) => (j === idx ? { ...i, qty: i.qty + 1 } : i)));
    } else {
      onChange([...items, { product_id: p.id, name: p.name, qty: 1, price: p.price }]);
    }
  }

  function addCustom() {
    const name = custom.name.trim();
    if (!name) return;
    onChange([...items, { product_id: null, name, qty: 1, price: Number(custom.price || 0) }]);
    setCustom({ name: "", price: "" });
  }

  function patch(idx: number, patch: Partial<OrderItem>) {
    onChange(items.map((i, j) => (j === idx ? { ...i, ...patch } : i)));
  }

  function bumpQty(idx: number, d: number) {
    const next = items[idx].qty + d;
    if (next <= 0) onChange(items.filter((_, j) => j !== idx));
    else patch(idx, { qty: next });
  }

  return (
    <div className="space-y-2">
      {products.length > 0 && (
        <div>
          <p className="mb-1 font-display text-xs font-bold text-ink-soft">
            Products <span className="font-normal">(tap to add · tap again for +1)</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {products.map((p) => {
              const inCart = items.find((i) => i.product_id === p.id);
              const out = p.stock_units <= 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addProduct(p)}
                  className={
                    "rounded-full px-2.5 py-1 font-display text-xs font-bold transition active:scale-95 " +
                    (inCart
                      ? "bg-frog text-white"
                      : "bg-[#f2ede3] text-ink hover:bg-pond hover:text-frog-dark")
                  }
                >
                  {inCart && <span className="mr-1 rounded-full bg-white/25 px-1.5">{inCart.qty}</span>}
                  {p.name} · Rs. {p.price}{" "}
                  <span className={out ? "text-[#c04545]" : inCart ? "text-white/80" : "text-ink-soft"}>
                    ({out ? "out of stock!" : `${p.stock_units} left`})
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="space-y-1.5 rounded-xl bg-cream/70 p-2">
          {items.map((item, idx) => (
            <div key={idx} className="flex animate-pop items-center gap-1.5">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => bumpQty(idx, -1)}
                  className="h-7 w-7 rounded-lg bg-[#f2ede3] font-display text-sm font-extrabold text-ink hover:bg-flame-tint"
                >
                  −
                </button>
                <span className="min-w-6 text-center font-display text-sm font-extrabold text-ink">
                  {item.qty}
                </span>
                <button
                  type="button"
                  onClick={() => bumpQty(idx, 1)}
                  className="h-7 w-7 rounded-lg bg-[#f2ede3] font-display text-sm font-extrabold text-ink hover:bg-pond"
                >
                  +
                </button>
              </div>
              <span className="min-w-0 flex-1 truncate font-display text-xs font-extrabold text-ink">
                {item.name}
              </span>
              <input
                type="number"
                className={`${inputCls} w-20 text-right`}
                value={item.price}
                onChange={(e) => patch(idx, { price: Number(e.target.value) })}
                title="Price per unit (Rs.)"
              />
              <span className="w-16 text-right font-display text-xs font-extrabold text-ink-soft">
                Rs. {Math.round(item.qty * item.price)}
              </span>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== idx))}
                className="h-7 w-7 rounded-lg font-display text-xs font-extrabold text-ink-soft hover:bg-flame-tint hover:text-[#c04545]"
                title="Remove line"
              >
                ✕
              </button>
            </div>
          ))}
          <div className="flex justify-between border-t-2 border-cardline/70 pt-1.5 font-display text-xs font-extrabold text-ink">
            <span>Products subtotal</span>
            <span>Rs. {Math.round(itemsSubtotal(items))}</span>
          </div>
        </div>
      )}

      <div className="flex gap-1.5">
        <input
          className={`${inputCls} min-w-0 flex-1`}
          placeholder="Custom item…"
          value={custom.name}
          onChange={(e) => setCustom({ ...custom, name: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
        />
        <input
          type="number"
          className={`${inputCls} w-20`}
          placeholder="Rs."
          value={custom.price}
          onChange={(e) => setCustom({ ...custom, price: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={!custom.name.trim()}
          className="rounded-lg bg-[#f2ede3] px-2.5 font-display text-xs font-extrabold text-ink transition hover:bg-pond disabled:opacity-40"
        >
          + Add
        </button>
      </div>
    </div>
  );
}
