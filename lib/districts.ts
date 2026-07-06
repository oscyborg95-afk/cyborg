// All 25 Sri Lankan districts, used for parsing validation and the review form dropdown.
export const DISTRICTS = [
  "Colombo", "Gampaha", "Kalutara",
  "Kandy", "Matale", "Nuwara Eliya",
  "Galle", "Matara", "Hambantota",
  "Jaffna", "Kilinochchi", "Mannar", "Vavuniya", "Mullaitivu",
  "Batticaloa", "Ampara", "Trincomalee",
  "Kurunegala", "Puttalam",
  "Anuradhapura", "Polonnaruwa",
  "Badulla", "Monaragala",
  "Ratnapura", "Kegalle",
] as const;

export type District = (typeof DISTRICTS)[number];

export const DEFAULT_SHIPPING_FEE = 350;

// Per-district overrides — tune to your courier's rate card.
const SHIPPING_OVERRIDES: Partial<Record<District, number>> = {
  Jaffna: 400,
  Kilinochchi: 400,
  Mannar: 400,
  Vavuniya: 400,
  Mullaitivu: 400,
};

export function shippingFeeFor(district: string): number {
  return SHIPPING_OVERRIDES[district as District] ?? DEFAULT_SHIPPING_FEE;
}
