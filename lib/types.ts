export type OrderStatus = "pending" | "booked" | "delivered" | "returned";

// One line of a multi-product order. `product_id` links back to stock when the
// line came from a preset chip; free-typed lines carry null.
export interface OrderItem {
  product_id: string | null;
  name: string;
  qty: number;
  price: number; // per unit (Rs.)
}

export interface Order {
  id: string;
  // Short, human-friendly reference (e.g. "DC-1001") assigned on creation and
  // sent to the courier instead of the raw UUID. null on legacy orders.
  order_no?: string | null;
  customer_name: string;
  phone_number: string;
  phone_2: string; // second contact number, "" when the customer gave only one
  raw_address: string;
  parsed_address: string;
  city: string;
  city_id: number | null; // exact courier city id picked in the UI; null → resolve by name
  district: string;
  product_id: string | null;
  item_name: string;
  items: OrderItem[] | null; // line items; null/[] = legacy single-item order
  product_price: number;
  shipping_fee: number;
  discount: number;
  total_cod: number;
  order_status: OrderStatus;
  // When the courier's COD payout for this delivered order was received.
  // null/undefined = delivered cash still with the courier ("awaiting payout").
  remitted_at?: string | null;
  remittance_id?: string | null;
  // Stable key supplied by the dispatch UI so retries return the original
  // order instead of creating and booking a duplicate.
  idempotency_key?: string | null;
  // Archived orders disappear from operational lists but remain available to
  // financial reporting and audit history. No stock or cash is changed.
  archived_at?: string | null;
  created_at: string;
}

export interface ShippingManifest {
  id: string;
  order_id: string;
  courier_name: string;
  tracking_id: string;
  pdf_label_url: string | null;
  last_checkpoint: string | null;
  created_at: string;
}

// One courier status change, appended as tracking progresses. Builds the
// per-order timeline shown on the Orders page.
export interface TrackingEvent {
  id: string;
  order_id: string;
  checkpoint: string; // human-readable status line from the courier
  outcome: string; // booked | in_transit | delivered | returned
  created_at: string;
}

export type TrackingNotificationStatus = "pending" | "processing" | "sent" | "failed";

export interface TrackingNotificationJob {
  id: string;
  webhook_event_id: string | null;
  order_id: string;
  recipient: "customer" | "owner";
  alert_kind: AlertKind | null;
  chat_id: string;
  body: string;
  status: TrackingNotificationStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string;
  created_at: string;
  sent_at: string | null;
}

export interface CourierWebhookEvent {
  id: string;
  fingerprint: string;
  tracking_id: string;
  order_id: string;
  status: string;
  checkpoint: string;
  payload: Record<string, unknown>;
  received_at: string;
  processed_at: string | null;
  processing_error: string;
}

export interface TrackingProblem {
  order_id: string;
  order_no: string | null;
  customer_name: string;
  phone_number: string;
  tracking_id: string;
  checkpoint: string;
  status: string;
  attempt: number | null;
  occurred_at: string;
  notification_status: TrackingNotificationStatus | null;
}

export interface TrackingHealth {
  last_webhook_at: string | null;
  last_notification_at: string | null;
  queue_pending: number;
  queue_failed: number;
  stale_in_flight: number;
  problems: TrackingProblem[];
}

// Automated tracking-driven customer WhatsApp alerts. One row per (order, kind)
// that was actually sent, so the same alert is never sent twice and failures
// stay visible. See lib/db.ts customer_alerts.
export type AlertKind = "out_for_delivery" | "delivered" | "returned";
export const ALERT_KINDS: AlertKind[] = ["out_for_delivery", "delivered", "returned"];

export interface CustomerAlert {
  id: string;
  order_id: string;
  kind: AlertKind;
  body: string; // the exact message text sent
  status: "sent" | "failed";
  created_at: string;
}

export interface CourierRemittance {
  id: string;
  invoice_no: string;
  paid_at: string;
  source_filename: string;
  line_count: number;
  matched_count: number;
  gross_cod: number;
  collected_cod: number;
  delivery_charges: number;
  commission: number;
  invoice_vat: number;
  additional_tax: number;
  other_deductions: number;
  invoice_payable: number;
  expected_net: number;
  amount_received: number;
  variance: number;
  cash_applied: boolean;
  notes: string;
  created_at: string;
}

export interface ParsedAddress {
  name: string;
  phone: string;
  phone_2: string; // "" when only one number was given
  address: string;
  city: string;
  district: string;
}

export type NewOrder = Omit<
  Order,
  | "id"
  | "created_at"
  | "order_status"
  | "remitted_at"
  | "remittance_id"
  | "order_no"
  | "idempotency_key"
  | "archived_at"
>;

// One day's Meta/Facebook ad spend, entered manually on the Quest page.
// day is YYYY-MM-DD (Asia/Colombo civil date).
export interface AdSpend {
  day: string;
  amount: number;
}

// A sellable product preset. stock_units tracks physical units in the shed:
// booking an order takes one out, a courier return puts one back.
export interface Product {
  id: string;
  name: string;
  price: number; // default selling price (Rs.)
  unit_cost: number; // what one unit cost you (Rs.) — feeds net-worth stock value
  stock_units: number;
  created_at: string;
}

export type NewProduct = Omit<Product, "id" | "created_at">;

export const CHAT_STATES = [
  "NEW",
  "AWAITING_ADDRESS",
  "AWAITING_CONFIRMATION",
  "CONFIRMED",
  "SHIPPED",
] as const;

export type ChatStateValue = (typeof CHAT_STATES)[number];

export interface ChatState {
  phone_number: string;
  chat_id: string;
  display_name: string | null;
  state: ChatStateValue;
  updated_at: string;
}

// Editable WhatsApp message templates. Keys match lib/templates.ts defaults;
// a missing key means "use the built-in default".
export type TemplateKey =
  | "askAddress"
  | "codConfirm"
  | "shippedConfirmation"
  | "trackingAlert"
  | "delayBonus"
  | "followUpAddress"
  | "followUpConfirm"
  | "outForDelivery"
  | "rescheduledDelivery"
  | "deliveredThanks"
  | "returnedApology";

export type MessageTemplates = Partial<Record<TemplateKey, string>>;

// What the courier charges YOU per delivered parcel, by district. A district
// with no entry falls back to courier_cost_base. Mirrors the shipping-fee
// override pattern in lib/districts.ts.
export type CourierCostOverrides = Partial<Record<string, number>>;

export interface BusinessSettings {
  bank_cash: number;
  stock_units: number;
  stock_unit_cost: number;
  // Printed on invoices.
  business_name: string;
  business_address: string;
  business_phone_1: string;
  business_phone_2: string;
  // Prefix for the short order reference (e.g. "DC" → DC-1001) sent to the courier.
  order_prefix: string;
  // Operator-customized WhatsApp templates ({{placeholders}} substituted at send).
  templates: MessageTemplates;
  // Courier's fee to you (feeds the real profit numbers, not the customer's
  // shipping_fee). Base delivered fee + per-district overrides, plus the flat
  // fee lost on a returned parcel (the round-trip cost).
  courier_cost_base: number;
  courier_return_cost: number;
  courier_cost_overrides: CourierCostOverrides;
  // Operator's own Gemini API key(s) for AI address parsing, one per line.
  // When set, overrides the GEMINI_API_KEY env var; the parser rotates to the
  // next key on a rate-limit (429). Empty string = fall back to the env key.
  gemini_api_key: string;
}

export interface WaChat {
  id: string;
  name: string;
  lastMessage: string;
  timestamp: number;
  unreadCount: number;
}

export interface WaMessage {
  id: string;
  chatId: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  senderName: string;
  // Delivery state for fromMe messages (WhatsApp ack levels):
  // 0 error · 1 pending · 2 sent ✓ · 3 delivered ✓✓ · 4 read · 5 played
  status?: number;
  // Media kind when the message carries bytes the worker captured
  // ("image" | "audio" | "sticker"), "" / undefined for plain text.
  media?: string;
}
