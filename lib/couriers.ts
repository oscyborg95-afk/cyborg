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

// Cache the auth token and the city name→id map across hot reloads / requests.
const g = globalThis as unknown as {
  __txToken?: string | null;
  __txCities?: Map<string, number>;
};

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

/** Fetch and cache Trans Express's city list, returning a normalised-name → id map. */
async function getCityMap(token: string): Promise<Map<string, number>> {
  if (g.__txCities) return g.__txCities;
  const res = await fetch(`${API_BASE}/cities`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Trans Express /cities failed (${res.status})`);
  }
  const cities = (await res.json()) as Array<{ id: number; text: string }>;
  const map = new Map<string, number>();
  for (const c of cities) map.set(normCity(c.text), c.id);
  g.__txCities = map;
  return map;
}

export async function bookCourierOrder(order: Order): Promise<BookingResult> {
  if (!isConfigured) {
    return mockBooking();
  }

  const doBook = async (): Promise<Response> => {
    const token = await getToken();

    // Prefer booking with a resolved city_id (most reliable routing); fall back
    // to the "without-city" endpoint which lets Trans Express match by name.
    const cityMap = await getCityMap(token).catch(() => null);
    const cityId = order.city ? cityMap?.get(normCity(order.city)) : undefined;

    const base = {
      order_no: order.id,
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

// Trans Express client-portal status endpoint. If your account's API differs,
// set COURIER_TRACKING_URL with {waybill} as a placeholder, e.g.
//   COURIER_TRACKING_URL=https://portal.transexpress.lk/api/orders/track/{waybill}
const TRACKING_URL =
  process.env.COURIER_TRACKING_URL || `${API_BASE}/orders/track/{waybill}`;

/** Map a courier status line to our order outcome. */
function classifyStatus(text: string): TrackingResult["outcome"] {
  const t = text.toLowerCase();
  if (t.includes("deliver") && !t.includes("out for deliver")) return "delivered";
  if (t.includes("return") || t.includes("reject") || t.includes("refus")) return "returned";
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
    return fetch(TRACKING_URL.replace("{waybill}", encodeURIComponent(trackingId)), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  };

  let res = await doTrack();
  if (res.status === 401) {
    g.__txToken = null;
    res = await doTrack();
  }
  if (!res.ok) {
    throw new Error(`Tracking failed for ${trackingId} (${res.status})`);
  }

  const status = extractStatus(await res.json());
  if (!status) {
    // Unknown response shape — leave the order alone rather than guessing.
    return { outcome: "in_transit", checkpoint: "status unavailable" };
  }
  return { outcome: classifyStatus(status), checkpoint: status };
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
