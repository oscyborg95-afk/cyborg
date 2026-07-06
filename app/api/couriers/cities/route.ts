import { NextResponse } from "next/server";
import { isCourierConfigured, listCourierCities } from "@/lib/couriers";
import { FALLBACK_CITIES } from "@/lib/cities-fallback";

// Serves the courier's canonical city list for the searchable picker.
// Degrades to a built-in fallback list when the courier isn't configured or is
// unreachable — the picker must never break the dispatch form.
export async function GET() {
  if (!isCourierConfigured()) {
    return NextResponse.json({ configured: false, cities: FALLBACK_CITIES });
  }
  try {
    const cities = await listCourierCities();
    return NextResponse.json({ configured: true, cities });
  } catch (err) {
    const message = err instanceof Error ? err.message : "cities unavailable";
    return NextResponse.json({ configured: false, cities: FALLBACK_CITIES, error: message });
  }
}
