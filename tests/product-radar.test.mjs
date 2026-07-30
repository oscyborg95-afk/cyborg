import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildProduct,
  buildSriLankaMetaAdLibraryUrl,
  evidenceKey,
  fallbackProductName,
  normalizeMetaAd,
  normalizeTikTokAd,
  productKey,
  radarConfiguration,
  radarRunFromRow,
  scoreOpportunity,
  validateRadarKeyword,
} from "../lib/product-radar.ts";
import { parseRadarScanPayload } from "../lib/radar-keyword.ts";

test("normalizes representative nested TikTok payloads", () => {
  const ad = normalizeTikTokAd({
    ad_id: "tt-1",
    ad: { title: "Rechargeable Mini Food Sealer", description: "Keep snacks fresh" },
    advertiser: { name: "Kitchen Lab" },
    video: { url: "https://example.com/cover.jpg" },
    landingPageUrl: "https://shop.example/sealer",
    metrics: { likes: 900, ctr: "top 10%" },
  }, "SG");
  assert.equal(ad.sourceId, "tt-1");
  assert.equal(ad.title, "Rechargeable Mini Food Sealer");
  assert.equal(ad.advertiser, "Kitchen Lab");
  assert.equal(ad.country, "SG");
  assert.equal(ad.platform, "tiktok");
});

test("normalizes the current TikTok Actor snake_case output", () => {
  const ad = normalizeTikTokAd({
    ad_id: "tt-current-1",
    brand_name: "smart_home_shop",
    ad_title: "Rechargeable handheld fabric cleaner",
    cover_url: "https://example.com/cover.jpg",
    video_url: "https://example.com/video.mp4",
    ctr_tier: "top_10%",
    industry_key: "label_ecommerce",
    countries: ["US", "GB"],
    scraped_at: "2026-07-30T10:00:00Z",
  });
  assert.equal(ad.title, "Rechargeable handheld fabric cleaner");
  assert.equal(ad.advertiser, "smart_home_shop");
  assert.equal(ad.mediaUrl, "https://example.com/cover.jpg");
  assert.equal(ad.country, "US");
  assert.equal(ad.raw._radar.ctr, "top_10%");
});

test("normalizes Meta aliases and preserves offer hints", () => {
  const ad = normalizeMetaAd({
    adArchiveID: "meta-1",
    page: { name: "Home Finds LK" },
    snapshot: { title: "Fabric cleaner", body: "Now Rs. 2,990 with free delivery" },
    publisherPlatforms: ["Facebook", "Instagram"],
    start_date: "2026-07-01",
  }, "Fabric Stain Cleaner", "LK");
  assert.equal(ad.sourceId, "meta-1");
  assert.equal(ad.advertiser, "Home Finds LK");
  assert.match(ad.offer, /2,990/);
  assert.deepEqual(ad.platforms, ["Facebook", "Instagram"]);
});

test("validates and normalizes one Radar search phrase", () => {
  assert.deepEqual(validateRadarKeyword("  face serum  "), { ok: true, keyword: "face serum" });
  assert.deepEqual(validateRadarKeyword("kitchen, gadgets"), { ok: true, keyword: "kitchen, gadgets" });
  assert.equal(validateRadarKeyword("").ok, false);
  assert.equal(validateRadarKeyword("x").ok, false);
  assert.equal(validateRadarKeyword("x".repeat(81)).ok, false);
  assert.equal(validateRadarKeyword("face\nserum").ok, false);
  assert.equal(validateRadarKeyword("\nface serum").ok, false);
});

test("scan payload validation rejects malformed input and country overrides", () => {
  assert.equal(parseRadarScanPayload(null).ok, false);
  assert.equal(parseRadarScanPayload({}).ok, false);
  assert.equal(parseRadarScanPayload({ keyword: "hair growth oil", country: "US" }).ok, false);
  assert.deepEqual(
    parseRadarScanPayload({ keyword: "  hair growth oil  " }),
    { ok: true, keyword: "hair growth oil" }
  );
});

test("Meta discovery is permanently scoped to Sri Lanka", () => {
  const url = new URL(buildSriLankaMetaAdLibraryUrl("car accessories, detailing"));
  assert.equal(url.searchParams.get("country"), "LK");
  assert.equal(url.searchParams.get("q"), "car accessories, detailing");
  const ad = normalizeMetaAd({ id: "foreign", country: "US", title: "Car vacuum" }, "car vacuum", "US");
  assert.equal(ad.country, "LK");
});

test("Radar run rows serialize their normalized search query", () => {
  const run = radarRunFromRow({
    id: "run-1",
    status: "completed",
    search_query: "face serum",
    started_at: "2026-07-31T01:00:00.000Z",
    completed_at: "2026-07-31T01:02:00.000Z",
    tiktok_ads: 2,
    candidates: 4,
    meta_ads: 12,
    error: "",
  });
  assert.equal(run.searchQuery, "face serum");
  assert.equal(run.status, "completed");
  assert.equal(run.metaAds, 12);
});

test("score stays bounded and stages saturation explicitly", () => {
  assert.deepEqual(scoreOpportunity({
    competitorCount: 99, activeAdCount: 200, creativeVariants: 100,
    oldestActiveDays: 365, crossPlatform: true, momentum: 100, localPresence: true,
  }).stage, "saturated");
  assert.equal(scoreOpportunity({
    competitorCount: 0, activeAdCount: 0, creativeVariants: 0,
    oldestActiveDays: 0, crossPlatform: false, momentum: -10, localPresence: false,
  }).score, 0);
});

test("stable keys deduplicate product and evidence identities", () => {
  assert.equal(productKey("The Portable  Mini-Sealer!"), productKey("portable mini sealer"));
  assert.equal(evidenceKey("meta", "123"), "meta:123");
  const one = normalizeMetaAd({ id: "same", pageName: "A", active: true }, "Mini sealer");
  const two = normalizeMetaAd({ id: "same", pageName: "A", active: true }, "Mini sealer");
  const product = buildProduct("Mini sealer", [one, two]);
  assert.equal(product.evidence.length, 1);
});

test("fallback candidate extraction is conservative and config reports missing token", () => {
  const name = fallbackProductName(normalizeTikTokAd({ title: "Rechargeable portable fabric cleaner", description: "Remove stains fast" }));
  assert.match(name || "", /Rechargeable/i);
  const previous = process.env.APIFY_TOKEN;
  const previousMarket = process.env.RADAR_MARKET_COUNTRY;
  const previousIncludeTikTok = process.env.RADAR_INCLUDE_TIKTOK;
  delete process.env.APIFY_TOKEN;
  process.env.RADAR_MARKET_COUNTRY = "US";
  delete process.env.RADAR_INCLUDE_TIKTOK;
  const configuration = radarConfiguration();
  assert.equal(configuration.configured, false);
  assert.equal(configuration.marketCountry, "LK");
  assert.equal(configuration.includeTikTok, false);
  if (previous) process.env.APIFY_TOKEN = previous;
  if (previousMarket) process.env.RADAR_MARKET_COUNTRY = previousMarket;
  else delete process.env.RADAR_MARKET_COUNTRY;
  if (previousIncludeTikTok) process.env.RADAR_INCLUDE_TIKTOK = previousIncludeTikTok;
});

test("unreachable optional database still returns a usable demo dashboard", async () => {
  const run = promisify(execFile);
  const script = `
    const { getRadarDashboard } = await import("./lib/product-radar.ts");
    const result = await getRadarDashboard();
    process.stdout.write(JSON.stringify({ mode: result.dataMode, count: result.products.length, query: result.searchQuery }));
  `;
  const { stdout } = await run(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    script,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: "postgres://user:pass@radar-db.invalid:5432/app",
      APIFY_TOKEN: "",
    },
    timeout: 12_000,
  });
  assert.deepEqual(JSON.parse(stdout), { mode: "demo", count: 3, query: "cosmetics" });
});
