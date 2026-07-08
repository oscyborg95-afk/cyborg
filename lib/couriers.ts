import type { Order } from "./types";

// Trans Express courier integration (https://portal.transexpress.lk/api).
//
// Auth is email + password → bearer token (NOT a static API key):
//   1. POST /login/client { email, password } -> { token, status }
//   2. POST /orders/upload/single-auto  (Bearer token) -> { order: { waybill_id } }
//
// Runs in mock mode (fake waybill IDs) until COURIER_EMAIL + COURIER_PASSWORD
// are set, so the full dashboard flow works before production credentials arrive.

export interface BookingResult {
  courier_name: string;
  tracking_id: string;
  pdf_label_url: string | null;
}

const COURIER_NAME = process.env.COURIER_NAME || "Trans Express";
const API_BASE = (process.env.COURIER_API_URL || "https://portal.transexpress.lk/api").replace(
  /\/+$/,
  ""
);
const COURIER_EMAIL = process.env.COURIER_EMAIL;
const COURIER_PASSWORD = process.env.COURIER_PASSWORD;
// Trans Express requires a per-parcel item description; customise per business.
const ITEM_DESCRIPTION = process.env.COURIER_ITEM_DESCRIPTION || "Merchandise";

const isConfigured = Boolean(COURIER_EMAIL && COURIER_PASSWORD);

// Cache the auth token, the raw city list, and the city name→id map across hot
// reloads / requests.
const g = globalThis as unknown as {
  __txToken?: string | null;
  __txCities?: Map<string, number>;
  __txCityList?: Array<{ id: number; text: string }>;
};

/** Whether real courier credentials are set (vs. mock booking). */
export function isCourierConfigured(): boolean {
  return isConfigured;
}

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/login/client`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: COURIER_EMAIL, password: COURIER_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Trans Express login failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { token?: string; status?: string };
  if (!data.token) {
    throw new Error(`Trans Express login returned no token: ${JSON.stringify(data).slice(0, 200)}`);
  }
  g.__txToken = data.token;
  return data.token;
}

async function getToken(): Promise<string> {
  return g.__txToken || (await login());
}

/** Normalise a city name for tolerant matching (case/space/punctuation-insensitive). */
function normCity(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Fetch and cache Trans Express's full city list ({ id, text }). */
async function fetchCityList(token: string): Promise<Array<{ id: number; text: string }>> {
  if (g.__txCityList) return g.__txCityList;
  const res = await fetch(`${API_BASE}/cities`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Trans Express /cities failed (${res.status})`);
  }
  const cities = (await res.json()) as Array<{ id: number; text: string }>;
  g.__txCityList = cities;
  return cities;
}

/** Fetch and cache Trans Express's city list, returning a normalised-name → id map. */
async function getCityMap(token: string): Promise<Map<string, number>> {
  if (g.__txCities) return g.__txCities;
  const cities = await fetchCityList(token);
  const map = new Map<string, number>();
  for (const c of cities) map.set(normCity(c.text), c.id);
  g.__txCities = map;
  return map;
}

/**
 * The courier's canonical city list for the UI picker. Returns [] when the
 * courier isn't configured (the caller substitutes a fallback list).
 */
export async function listCourierCities(): Promise<Array<{ id: number; text: string }>> {
  if (!isConfigured) return [];
  const token = await getToken();
  return fetchCityList(token);
}

export async function bookCourierOrder(
  order: Order,
  cityIdOverride?: number | null
): Promise<BookingResult> {
  if (!isConfigured) {
    return mockBooking();
  }

  const doBook = async (): Promise<Response> => {
    const token = await getToken();

    // Prefer an explicit city_id picked in the UI (exact match). Otherwise
    // resolve it from the city name, and finally fall back to the "without-city"
    // endpoint which lets Trans Express match by name.
    const cityMap = await getCityMap(token).catch(() => null);
    const cityId =
      (cityIdOverride && cityIdOverride > 0 ? cityIdOverride : undefined) ??
      (order.city ? cityMap?.get(normCity(order.city)) : undefined);

    const base = {
      // Short human reference (DC-1001); fall back to the UUID for legacy orders.
      order_no: order.order_no || order.id,
      customer_name: order.customer_name,
      address: order.parsed_address,
      description: order.item_name || ITEM_DESCRIPTION,
      phone_no: order.phone_number,
      cod: order.total_cod,
      // No dedicated field for a second number — ride it on the parcel note.
      note: order.phone_2 ? `2nd phone: ${order.phone_2}` : "",
    };

    const [endpoint, payload] = cityId
      ? ["/orders/upload/single-auto", { ...base, city_id: cityId }]
      : ["/orders/upload/single-auto-without-city", { ...base, city: order.city || order.district }];

    return fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  };

  let res = await doBook();
  // Token expired/invalid → re-authenticate once and retry.
  if (res.status === 401) {
    g.__txToken = null;
    res = await doBook();
  }

  if (!res.ok) {
    throw new Error(`Trans Express booking failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as { order?: { waybill_id?: string } };
  const trackingId = data.order?.waybill_id;
  if (!trackingId) {
    throw new Error(
      `Trans Express returned no waybill_id: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return { courier_name: COURIER_NAME, tracking_id: trackingId, pdf_label_url: null };
}

function mockBooking(): BookingResult {
  const id = `TX-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 100)}`;
  return { courier_name: `${COURIER_NAME} (mock)`, tracking_id: id, pdf_label_url: null };
}

// --- Tracking ----------------------------------------------------------------

export interface TrackingResult {
  outcome: "delivered" | "returned" | "in_transit";
  checkpoint: string; // human-readable latest status line
}

// Trans Express single-order tracking (per their API docs):
//   POST /tracking  { waybill_id }  (Bearer token)
//   → { data: { current_status, status_history: [{ name, remarks, added_date }, …] } }
// status_history is newest-first. COURIER_TRACKING_URL overrides the endpoint.
const TRACKING_URL = process.env.COURIER_TRACKING_URL || `${API_BASE}/tracking`;

interface TxTrackingResponse {
  data?: {
    current_status?: string;
    status_history?: Array<{ name?: string; remarks?: string; added_date?: string }>;
  };
}

/** Map a courier status line to our order outcome. */
function classifyStatus(text: string): TrackingResult["outcome"] {
  const t = text.toLowerCase();
  if (t.includes("deliver") && !t.includes("out for deliver")) return "delivered";
  // Canceled parcels never leave (or come back) — either way the unit is
  // physically back in the shed, which is what "returned" means to stock.
  if (t.includes("return") || t.includes("reject") || t.includes("refus") || t.includes("cancel"))
    return "returned";
  return "in_transit";
}

/** Pull the most recent status string out of whatever shape the API returns. */
function extractStatus(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return extractStatus(data[data.length - 1]);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["current_status", "delivery_status", "status", "state", "tracking"]) {
      if (key in obj) {
        const found = extractStatus(obj[key]);
        if (found) return found;
      }
    }
  }
  return null;
}

export async function getTrackingStatus(
  trackingId: string,
  bookedAt: string
): Promise<TrackingResult> {
  if (!isConfigured) {
    return mockTracking(trackingId, bookedAt);
  }

  const doTrack = async (): Promise<Response> => {
    const token = await getToken();
    return fetch(TRACKING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ waybill_id: trackingId }),
    });
  };

  let res = await doTrack();
  if (res.status === 401) {
    g.__txToken = null;
    res = await doTrack();
  }
  if (!res.ok) {
    throw new Error(
      `Tracking failed for ${trackingId} (${res.status}): ${(await res.text()).slice(0, 200)}`
    );
  }

  const payload = (await res.json()) as TxTrackingResponse;
  const latest = payload.data?.status_history?.[0] ?? null;
  const status = payload.data?.current_status || latest?.name || extractStatus(payload);
  if (!status) {
    // Unknown response shape — leave the order alone rather than guessing.
    return { outcome: "in_transit", checkpoint: "status unavailable" };
  }
  // "Out for Delivery — Handed to rider R. Perera" beats a bare status word,
  // and a remark change re-triggers the timeline + customer alert correctly.
  const checkpoint =
    latest?.remarks && latest.name === status ? `${status} — ${latest.remarks}` : status;
  return { outcome: classifyStatus(status), checkpoint };
}

// Mock tracking so the whole loop works before credentials arrive:
// parcels "arrive" ~2 days after booking; a deterministic ~1 in 6 comes back
// as a return (based on the tracking ID, so re-syncing never flip-flops).
const MOCK_DELIVERY_MS = 2 * 24 * 60 * 60 * 1000;

function mockTracking(trackingId: string, bookedAt: string): TrackingResult {
  const ageMs = Date.now() - new Date(bookedAt).getTime();
  const fastForward = process.env.COURIER_MOCK_FAST === "true"; // for demos/tests
  if (ageMs < MOCK_DELIVERY_MS && !fastForward) {
    return { outcome: "in_transit", checkpoint: "In transit to delivery hub (mock)" };
  }
  const hash = [...trackingId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7);
  return hash % 6 === 0
    ? { outcome: "returned", checkpoint: "Returned to client (mock)" }
    : { outcome: "delivered", checkpoint: "Delivered (mock)" };
}
