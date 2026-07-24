type CourierOutcome = "delivered" | "returned" | "in_transit";

// Trans Express uses "Returned to Branch Rescheduled" for a parcel waiting for
// another delivery attempt. It is still with the courier, not a completed COD
// return, despite the word "returned".
export function isTemporaryCourierReturn(text: string | null | undefined): boolean {
  const status = text?.toLowerCase() ?? "";
  return status.includes("reschedul") && status.includes("return");
}

// Historical tracking events are append-only. A false intermediate return can
// therefore remain in the timeline even after the parcel is delivered.
export function isTerminalCourierReturn(
  orderStatus: string | null | undefined,
  checkpoint: string | null | undefined
): boolean {
  return orderStatus === "returned" && !isTemporaryCourierReturn(checkpoint);
}

/** Map a courier status line to the business-level delivery outcome. */
export function classifyCourierStatus(text: string): CourierOutcome {
  const status = text.toLowerCase();

  // Check non-terminal delivery states first: both phrases contain words that
  // would otherwise be mistaken for a completed delivery or return.
  if (status.includes("reschedul") || status.includes("out for deliver")) {
    return "in_transit";
  }
  if (status.includes("deliver")) return "delivered";

  // Canceled parcels never leave (or come back) — either way the unit is
  // physically back in the shed, which is what "returned" means to stock.
  if (
    status.includes("return") ||
    status.includes("reject") ||
    status.includes("refus") ||
    status.includes("cancel")
  ) {
    return "returned";
  }
  return "in_transit";
}
