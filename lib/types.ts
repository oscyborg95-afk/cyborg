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

export interface ParsedAddress {
  name: string;
  phone: string;
  phone_2: string; // "" when only one number was given
  address: string;
  city: string;
  district: string;
}

export type NewOrder = Omit<Order, "id" | "created_at" | "order_status" | "remitted_at">;

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
  | "deliveredThanks"
  | "returnedApology";

export type MessageTemplates = Partial<Record<TemplateKey, string>>;

export interface BusinessSettings {
  bank_cash: number;
  stock_units: number;
  stock_unit_cost: number;
  // Printed on invoices.
  business_name: string;
  business_address: string;
  business_phone_1: string;
  business_phone_2: string;
  // Operator-customized WhatsApp templates ({{placeholders}} substituted at send).
  templates: MessageTemplates;
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
}
