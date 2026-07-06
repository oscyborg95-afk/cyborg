"use client";

import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

// Code-128 barcode rendered as SVG (scannable by courier handhelds).
export function Barcode({ value, className = "" }: { value: string; className?: string }) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format: "CODE128",
        displayValue: false,
        margin: 0,
        height: 40,
        width: 2,
      });
    } catch {
      // Invalid value — leave the SVG empty rather than crashing the sheet.
    }
  }, [value]);

  return <svg ref={ref} className={className} />;
}
