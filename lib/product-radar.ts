import { createHash, randomUUID } from "crypto";
import { googleGenerateContentRequest } from "./google-genai.ts";
import { queryDatabase, usingSupabase } from "./db.ts";

export type RadarStage = "emerging" | "validated" | "scaling" | "saturated" | "watch";
export type RadarPlatform = "tiktok" | "meta";

export interface RadarEvidence {
  id: string;
  productKey: string;
  platform: RadarPlatform;
  sourceId: string;
  advertiser: string;
  title: string;
  copy: string;
  cta: string;
  adUrl: string;
  landingUrl: string;
  mediaUrl: string;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
  platforms: string[];
  offer: string;
  country: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  raw: Record<string, unknown>;
}

export interface RadarProduct {
  id: string;
  key: string;
  name: string;
  score: number;
  stage: RadarStage;
  competitorCount: number;
  activeAdCount: number;
  creativeVariants: number;
  oldestActiveDays: number;
  momentum: number;
  localPresence: boolean;
  platforms: RadarPlatform[];
  reasons: string[];
  risks: string[];
  thumbnailUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  scanAt: string;
  evidence: RadarEvidence[];
}

export interface RadarRun {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  tiktokAds: number;
  candidates: number;
  metaAds: number;
  error: string;
}

export interface RadarDashboard {
  dataMode: "live" | "demo" | "empty";
  configured: boolean;
  configurationMessage: string;
  focus: {
    marketCountry: string;
    category: string;
    includeTikTok: boolean;
  };
  lastRun: RadarRun | null;
  nextScan: string;
  summary: {
    candidates: number;
    advertisers: number;
    activeCreatives: number;
    emergingPicks: number;
  };
  products: RadarProduct[];
}

type Loose = Record<string, unknown>;

const g = globalThis as unknown as {
  __radarRuns?: RadarRun[];
  __radarProducts?: Map<string, RadarProduct>;
  __radarEvidence?: Map<string, RadarEvidence>;
  __radarScanRunning?: boolean;
  __radarSchemaReady?: boolean;
  __radarDatabaseRetryAt?: number;
};
const memoryRuns = (g.__radarRuns ??= []);
const memoryProducts = (g.__radarProducts ??= new Map());
const memoryEvidence = (g.__radarEvidence ??= new Map());

const asObject = (value: unknown): Loose =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
};
const number = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};
const date = (...values: unknown[]): string | null => {
  const value = text(...values);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
const boundedRaw = (value: unknown): Loose => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 12_000) return asObject(value);
    return { truncated: true, preview: serialized.slice(0, 11_900) };
  } catch {
    return { unreadable: true };
  }
};
const stableId = (...parts: string[]) =>
  createHash("sha256").update(parts.join("|").toLowerCase()).digest("hex").slice(0, 24);

export function productKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|new|best|sale|offer|official|shop|buy)\b/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 100);
}

export function evidenceKey(platform: RadarPlatform, sourceId: string): string {
  return `${platform}:${sourceId}`;
}

function nested(item: Loose, ...keys: string[]): Loose {
  for (const key of keys) {
    const found = asObject(item[key]);
    if (Object.keys(found).length) return found;
  }
  return {};
}

export function normalizeTikTokAd(input: unknown, country = ""): RadarEvidence {
  const item = asObject(input);
  const ad = nested(item, "ad", "data", "creative");
  const stats = nested(item, "metrics", "stats", "performance");
  const page = nested(item, "advertiser", "brand", "account");
  const sourceId = text(item.id, item.adId, item.ad_id, item.materialId, ad.id) ||
    stableId(text(item.title, ad.title, item.description), text(item.adUrl, item.url));
  const title = text(item.title, item.adTitle, item.ad_title, ad.title, item.description, ad.description);
  const media = nested(item, "video", "media", "image");
  const observed = new Date().toISOString();
  return {
    id: evidenceKey("tiktok", sourceId),
    productKey: "",
    platform: "tiktok",
    sourceId,
    advertiser: text(item.brandName, item.brand_name, item.advertiserName, item.advertiser_name, page.name, page.title, item.author),
    title,
    copy: text(item.description, item.adText, item.ad_text, item.caption, ad.description, ad.text),
    cta: text(item.cta, item.callToAction, item.call_to_action, ad.cta),
    adUrl: text(item.adUrl, item.ad_url, item.shareUrl, item.source_url, item.url, ad.url),
    landingUrl: text(item.landingPage, item.landing_page, item.landingPageUrl, item.landing_page_url, item.destinationUrl, ad.landingUrl),
    mediaUrl: text(item.thumbnailUrl, item.coverUrl, item.cover_url, item.imageUrl, item.video_url_hd, item.video_url, media.url, ad.thumbnailUrl),
    startDate: date(item.firstSeen, item.firstSeenAt, item.first_seen_at, item.createTime, item.startDate, item.scraped_at),
    endDate: null,
    active: item.active !== false,
    platforms: ["TikTok"],
    offer: extractOffer(`${title} ${text(item.description, item.adText, item.caption)}`),
    country: text(item.country, item.countryCode, item.country_code, asArray(item.countries)[0], country),
    firstSeenAt: date(item.firstSeen, item.firstSeenAt, item.first_seen_at, item.createTime, item.scraped_at) || observed,
    lastSeenAt: observed,
    observationCount: 1,
    raw: boundedRaw({ ...item, _radar: { likes: number(item.likes, stats.likes), ctr: text(item.ctr, item.ctrTier, item.ctr_tier, stats.ctr), industry: text(item.industry, item.industry_key, ad.industry) } }),
  };
}

export function normalizeMetaAd(input: unknown, product = "", country = "LK"): RadarEvidence {
  const item = asObject(input);
  const snapshot = nested(item, "snapshot", "adArchive", "ad");
  const page = nested(item, "page", "advertiser", "pageInfo");
  const creative = nested(item, "creative", "media");
  const sourceId = text(item.adArchiveID, item.adArchiveId, item.ad_id, item.adId, item.id, snapshot.id) ||
    stableId(text(page.name, item.pageName), text(item.adCopy, item.body, snapshot.body));
  const copy = text(item.adCopy, item.body, item.text, item.description, snapshot.body, snapshot.text);
  const title = text(item.headline, item.title, snapshot.title, creative.title);
  const platformValues = asArray(item.publisherPlatforms ?? item.platforms ?? snapshot.platforms)
    .map((entry) => text(entry))
    .filter(Boolean);
  const observed = new Date().toISOString();
  const start = date(item.startDate, item.start_date, item.adDeliveryStartTime, snapshot.startDate);
  const end = date(item.endDate, item.end_date, item.adDeliveryStopTime, snapshot.endDate);
  return {
    id: evidenceKey("meta", sourceId),
    productKey: productKey(product),
    platform: "meta",
    sourceId,
    advertiser: text(item.pageName, item.page_name, page.name, page.title, item.advertiser),
    title,
    copy,
    cta: text(item.cta, item.callToAction, item.call_to_action, snapshot.cta),
    adUrl: text(item.adLibraryUrl, item.adUrl, item.url, item.snapshotUrl, snapshot.url),
    landingUrl: text(item.linkUrl, item.landingPageUrl, item.destinationUrl, snapshot.linkUrl),
    mediaUrl: text(item.imageUrl, item.videoThumbnail, item.thumbnailUrl, creative.url, snapshot.imageUrl),
    startDate: start,
    endDate: end,
    active: item.isActive !== false && item.active !== false && (!end || new Date(end) > new Date()),
    platforms: platformValues.length ? platformValues : ["Facebook"],
    offer: extractOffer(`${title} ${copy}`),
    country: text(item.country, item.countryCode, country),
    firstSeenAt: start || observed,
    lastSeenAt: observed,
    observationCount: 1,
    raw: boundedRaw(item),
  };
}

export function extractOffer(value: string): string {
  const matches = value.match(/(?:rs\.?|lkr|\$|£|€)\s?[\d,.]+|\d{1,3}%\s*off|buy\s+\d+\s+get\s+\d+|free\s+(?:delivery|shipping|gift)|cash\s+on\s+delivery/gi);
  return matches?.slice(0, 2).join(" · ") || "";
}

const STOP_WORDS = new Set([
  "this", "that", "with", "your", "from", "have", "more", "shop", "official", "video",
  "today", "only", "free", "shipping", "delivery", "sale", "best", "product", "products",
  "discover", "introducing", "order", "online", "store", "viral", "amazon", "tiktok",
]);

export function fallbackProductName(ad: RadarEvidence): string | null {
  const source = `${ad.title} ${ad.copy}`.replace(/https?:\/\/\S+/g, " ");
  const words = source.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
  const cleaned = words.filter((word) => !STOP_WORDS.has(word.toLowerCase())).slice(0, 5);
  if (cleaned.length < 2) return null;
  return cleaned.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

export interface ScoreInput {
  competitorCount: number;
  activeAdCount: number;
  creativeVariants: number;
  oldestActiveDays: number;
  crossPlatform: boolean;
  momentum: number;
  localPresence: boolean;
}

export function scoreOpportunity(input: ScoreInput): { score: number; stage: RadarStage } {
  const validation = Math.min(25, input.activeAdCount * 3 + Math.min(10, input.oldestActiveDays / 3));
  const competition = Math.min(20, input.competitorCount * 4);
  const creativity = Math.min(20, input.creativeVariants * 3);
  const momentum = Math.min(15, Math.max(0, input.momentum));
  const reach = (input.crossPlatform ? 10 : 0) + (input.localPresence ? 10 : 0);
  const saturationPenalty = input.competitorCount > 10 ? Math.min(20, (input.competitorCount - 10) * 2) : 0;
  const score = Math.round(Math.max(0, Math.min(100, validation + competition + creativity + momentum + reach - saturationPenalty)));
  let stage: RadarStage = "watch";
  if (input.competitorCount > 10 || input.activeAdCount > 30) stage = "saturated";
  else if (input.momentum >= 11 && input.creativeVariants >= 4) stage = "scaling";
  else if (input.competitorCount >= 3 && input.oldestActiveDays >= 14) stage = "validated";
  else if (input.localPresence && input.competitorCount <= 3 && input.activeAdCount >= 2) stage = "emerging";
  return { score, stage };
}

function ageDays(value: string | null): number {
  if (!value) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
}

export function buildProduct(name: string, evidence: RadarEvidence[], scanAt = new Date().toISOString()): RadarProduct {
  const key = productKey(name);
  const deduped = [...new Map(evidence.map((item) => [evidenceKey(item.platform, item.sourceId), item])).values()]
    .map((item) => ({ ...item, productKey: key }));
  const meta = deduped.filter((item) => item.platform === "meta");
  const active = meta.filter((item) => item.active);
  const advertisers = new Set(meta.map((item) => item.advertiser.toLowerCase()).filter(Boolean));
  const variants = new Set(meta.map((item) => stableId(item.title, item.copy, item.mediaUrl)));
  const oldestActiveDays = Math.max(0, ...active.map((item) => ageDays(item.startDate)));
  const crossPlatform = new Set(deduped.map((item) => item.platform)).size > 1;
  const momentum = Math.min(15, active.filter((item) => ageDays(item.startDate) <= 14).length * 3);
  const scoreData = {
    competitorCount: advertisers.size,
    activeAdCount: active.length,
    creativeVariants: variants.size,
    oldestActiveDays,
    crossPlatform,
    momentum,
    localPresence: meta.some((item) => item.country === (process.env.RADAR_MARKET_COUNTRY || "LK")),
  };
  const { score, stage } = scoreOpportunity(scoreData);
  const reasons = [
    `${active.length} active Meta creative${active.length === 1 ? "" : "s"} found`,
    advertisers.size ? `${advertisers.size} independent advertiser${advertisers.size === 1 ? "" : "s"}` : "Early paid-ad signal; local validation is thin",
    oldestActiveDays ? `Oldest active ad has run for ${oldestActiveDays} days` : `${momentum ? "Fresh creative momentum" : "Needs another scan for momentum"}`,
  ];
  const risks = [
    ...(advertisers.size > 10 ? ["Crowded local competitor field"] : []),
    ...(active.length === 0 ? ["No active Meta evidence found in the target market"] : []),
    ...(oldestActiveDays < 7 ? ["Signal is young and may fade quickly"] : []),
  ].slice(0, 3);
  return {
    id: key,
    key,
    name,
    score,
    stage,
    ...scoreData,
    platforms: [...new Set(deduped.map((item) => item.platform))],
    reasons,
    risks,
    thumbnailUrl: deduped.find((item) => item.mediaUrl)?.mediaUrl || "",
    firstSeenAt: deduped.map((item) => item.firstSeenAt).sort()[0] || scanAt,
    lastSeenAt: scanAt,
    scanAt,
    evidence: deduped,
  };
}

function config() {
  const max = Number.parseInt(process.env.RADAR_MAX_CANDIDATES || "8", 10);
  const timeoutSeconds = Number.parseInt(process.env.RADAR_APIFY_TIMEOUT_SECONDS || "130", 10);
  const localSeedKeywords = (
    process.env.RADAR_META_SEED_KEYWORDS ||
    "cosmetics,skincare,face serum,skin cream,makeup,hair care,beauty products"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    token: process.env.APIFY_TOKEN?.trim() || "",
    metaActor: process.env.APIFY_META_ACTOR_ID?.trim() || "curious_coder~facebook-ads-library-scraper",
    tiktokActor: process.env.APIFY_TIKTOK_ACTOR_ID?.trim() || "khadinakbar~tiktok-ads-scraper",
    countries: (process.env.RADAR_DISCOVERY_COUNTRIES || "US,GB,AU,SG,AE").split(",").map((v) => v.trim().toUpperCase()).filter(Boolean),
    market: (process.env.RADAR_MARKET_COUNTRY || "LK").trim().toUpperCase(),
    category: process.env.RADAR_CATEGORY?.trim() || "Cosmetics & skincare",
    localSeedKeywords,
    includeTikTok: process.env.RADAR_INCLUDE_TIKTOK?.trim().toLowerCase() === "true",
    maxCandidates: Number.isFinite(max) ? Math.max(1, Math.min(25, max)) : 8,
    actorTimeoutMs: (Number.isFinite(timeoutSeconds)
      ? Math.max(30, Math.min(240, timeoutSeconds))
      : 130) * 1_000,
  };
}

export function radarConfiguration() {
  const value = config();
  return {
    configured: Boolean(value.token),
    discoveryCountries: value.countries,
    marketCountry: value.market,
    category: value.category,
    localSeedKeywords: value.localSeedKeywords,
    includeTikTok: value.includeTikTok,
    maxCandidates: value.maxCandidates,
    message: value.token ? "" : "Add APIFY_TOKEN to enable live daily scans.",
  };
}

async function callActor(
  actorId: string,
  input: Loose,
  token: string,
  timeoutMs: number
): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?clean=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
        signal: controller.signal,
        cache: "no-store",
      }
    );
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`Apify actor ${actorId} failed (${response.status}): ${body || response.statusText}`);
    }
    const payload = await response.json();
    return Array.isArray(payload) ? payload : asArray(asObject(payload).items ?? asObject(payload).data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const timeout = new Error(
        `Apify actor ${actorId} timed out after ${Math.round(timeoutMs / 1_000)} seconds`
      );
      timeout.name = "RadarProviderTimeout";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function extractCandidatesWithGemini(ads: RadarEvidence[]): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return [];
  const request = googleGenerateContentRequest(apiKey, process.env.GEMINI_MODEL || "gemini-2.5-flash-lite");
  const payload = ads.slice(0, 80).map((ad) => ({ title: ad.title, copy: ad.copy.slice(0, 400), advertiser: ad.advertiser }));
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `Extract only specific physical products explicitly present in these ads. Return JSON {"products":["Product name"]}. No services, brands alone, categories, or inventions. Deduplicate. Ads: ${JSON.stringify(payload)}` }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    }),
  });
  if (!response.ok) throw new Error(`Gemini candidate extraction failed (${response.status})`);
  const body = asObject(await response.json());
  const candidate = asArray(body.candidates)[0];
  const content = asObject(asObject(candidate).content);
  const resultText = text(asObject(asArray(content.parts)[0]).text);
  const parsed = asObject(JSON.parse(resultText));
  return asArray(parsed.products).map((value) => text(value)).filter(Boolean);
}

async function ensureSchema() {
  if (!usingSupabase || g.__radarSchemaReady) return;
  await queryDatabase(`create table if not exists radar_scan_runs (
    id uuid primary key, status varchar not null, started_at timestamptz not null,
    completed_at timestamptz, tiktok_ads int not null default 0, candidates int not null default 0,
    meta_ads int not null default 0, error text not null default ''
  )`);
  await queryDatabase(`create table if not exists radar_products (
    product_key varchar primary key, name varchar not null, score int not null, stage varchar not null,
    metrics jsonb not null default '{}'::jsonb, reasons jsonb not null default '[]'::jsonb,
    risks jsonb not null default '[]'::jsonb, thumbnail_url text not null default '',
    first_seen_at timestamptz not null, last_seen_at timestamptz not null, scan_at timestamptz not null
  )`);
  await queryDatabase(`create table if not exists radar_ads (
    evidence_key varchar primary key, product_key varchar not null references radar_products(product_key) on delete cascade,
    platform varchar not null, source_ad_id varchar not null, advertiser text not null default '',
    creative jsonb not null default '{}'::jsonb, first_seen_at timestamptz not null,
    last_seen_at timestamptz not null, observation_count int not null default 1, raw_payload jsonb not null default '{}'::jsonb
  )`);
  await queryDatabase("create index if not exists idx_radar_products_score on radar_products(score desc)");
  await queryDatabase("create index if not exists idx_radar_ads_product on radar_ads(product_key, platform)");
  g.__radarSchemaReady = true;
}

function logDatabaseFallback(operation: string, error: unknown) {
  g.__radarDatabaseRetryAt = Date.now() + 60_000;
  console.error(`[product-radar] Database ${operation} failed; using in-memory fallback.`, error);
}

function canUseDatabase() {
  return usingSupabase && Date.now() >= (g.__radarDatabaseRetryAt || 0);
}

function saveRunInMemory(run: RadarRun) {
  const index = memoryRuns.findIndex((item) => item.id === run.id);
  if (index >= 0) memoryRuns[index] = run; else memoryRuns.unshift(run);
}

async function saveRun(run: RadarRun) {
  if (!canUseDatabase()) {
    saveRunInMemory(run);
    return;
  }
  try {
    await ensureSchema();
    await queryDatabase(
      `insert into radar_scan_runs (id,status,started_at,completed_at,tiktok_ads,candidates,meta_ads,error)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set status=excluded.status, completed_at=excluded.completed_at,
       tiktok_ads=excluded.tiktok_ads,candidates=excluded.candidates,meta_ads=excluded.meta_ads,error=excluded.error`,
      [run.id, run.status, run.startedAt, run.completedAt, run.tiktokAds, run.candidates, run.metaAds, run.error]
    );
  } catch (error) {
    logDatabaseFallback("run write", error);
    saveRunInMemory(run);
  }
}

function saveProductInMemory(product: RadarProduct) {
  const previous = memoryProducts.get(product.key);
  memoryProducts.set(product.key, { ...product, firstSeenAt: previous?.firstSeenAt || product.firstSeenAt });
  for (const evidence of product.evidence) {
    const old = memoryEvidence.get(evidence.id);
    memoryEvidence.set(evidence.id, { ...evidence, firstSeenAt: old?.firstSeenAt || evidence.firstSeenAt, observationCount: (old?.observationCount || 0) + 1 });
  }
}

async function saveProduct(product: RadarProduct) {
  if (!canUseDatabase()) {
    saveProductInMemory(product);
    return;
  }
  try {
    await ensureSchema();
    const metrics = {
      competitorCount: product.competitorCount, activeAdCount: product.activeAdCount,
      creativeVariants: product.creativeVariants, oldestActiveDays: product.oldestActiveDays,
      momentum: product.momentum, localPresence: product.localPresence, platforms: product.platforms,
    };
    await queryDatabase(
      `insert into radar_products (product_key,name,score,stage,metrics,reasons,risks,thumbnail_url,first_seen_at,last_seen_at,scan_at)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
       on conflict (product_key) do update set name=excluded.name,score=excluded.score,stage=excluded.stage,
       metrics=excluded.metrics,reasons=excluded.reasons,risks=excluded.risks,thumbnail_url=excluded.thumbnail_url,
       last_seen_at=excluded.last_seen_at,scan_at=excluded.scan_at`,
      [product.key, product.name, product.score, product.stage, JSON.stringify(metrics), JSON.stringify(product.reasons), JSON.stringify(product.risks), product.thumbnailUrl, product.firstSeenAt, product.lastSeenAt, product.scanAt]
    );
    for (const evidence of product.evidence) {
      const creative = { title: evidence.title, copy: evidence.copy, cta: evidence.cta, adUrl: evidence.adUrl, landingUrl: evidence.landingUrl, mediaUrl: evidence.mediaUrl, startDate: evidence.startDate, endDate: evidence.endDate, active: evidence.active, platforms: evidence.platforms, offer: evidence.offer, country: evidence.country };
      await queryDatabase(
        `insert into radar_ads (evidence_key,product_key,platform,source_ad_id,advertiser,creative,first_seen_at,last_seen_at,observation_count,raw_payload)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,1,$9::jsonb)
         on conflict (evidence_key) do update set product_key=excluded.product_key,advertiser=excluded.advertiser,
         creative=excluded.creative,last_seen_at=excluded.last_seen_at,observation_count=radar_ads.observation_count+1,raw_payload=excluded.raw_payload`,
        [evidence.id, product.key, evidence.platform, evidence.sourceId, evidence.advertiser, JSON.stringify(creative), evidence.firstSeenAt, evidence.lastSeenAt, JSON.stringify(evidence.raw)]
      );
    }
  } catch (error) {
    logDatabaseFallback("product write", error);
    saveProductInMemory(product);
  }
}

async function pruneProducts(activeKeys: string[]) {
  const keep = new Set(activeKeys);
  for (const key of memoryProducts.keys()) {
    if (!keep.has(key)) memoryProducts.delete(key);
  }
  for (const [key, evidence] of memoryEvidence) {
    if (!keep.has(evidence.productKey)) memoryEvidence.delete(key);
  }
  if (!canUseDatabase()) return;
  try {
    await ensureSchema();
    await queryDatabase(
      "delete from radar_products where not (product_key = any($1::varchar[]))",
      [activeKeys]
    );
  } catch (error) {
    logDatabaseFallback("product pruning", error);
  }
}

function demoProducts(): RadarProduct[] {
  const now = new Date().toISOString();
  const make = (name: string, advertisers: string[], age: number, scoreBoost = 0) => {
    const evidence = advertisers.map((advertiser) => normalizeMetaAd({
      id: stableId(name, advertiser), pageName: advertiser, headline: name,
      body: `${name} — cash on delivery available`, startDate: new Date(Date.now() - age * 86_400_000).toISOString(),
      active: true, publisherPlatforms: ["Facebook", "Instagram"],
    }, name));
    const product = buildProduct(name, evidence, now);
    return { ...product, score: Math.min(100, product.score + scoreBoost) };
  };
  return [
    make("Vitamin C face serum", ["Glow Beauty LK", "Skin House Colombo", "Daily Beauty Lanka"], 24, 10),
    make("Rosemary hair growth oil", ["Hair Care LK", "Beauty Harbor"], 11, 8),
    make("Waterproof cushion foundation", ["Cosmetics Colombo"], 6, 5),
  ].sort((a, b) => b.score - a.score);
}

export async function getRadarDashboard(): Promise<RadarDashboard> {
  const configured = radarConfiguration();
  let products: RadarProduct[] = [];
  let lastRun: RadarRun | null = null;
  if (!canUseDatabase()) {
    products = [...memoryProducts.values()].map((product) => ({
      ...product,
      evidence: [...memoryEvidence.values()].filter((item) => item.productKey === product.key),
    })).sort((a, b) => b.score - a.score);
    lastRun = memoryRuns[0] || null;
  } else {
    try {
      await ensureSchema();
      const [productRows, evidenceRows, runRows] = await Promise.all([
        queryDatabase<Loose>("select * from radar_products order by score desc limit 50"),
        queryDatabase<Loose>("select * from radar_ads order by last_seen_at desc limit 500"),
        queryDatabase<Loose>("select * from radar_scan_runs order by started_at desc limit 1"),
      ]);
      const evidence = evidenceRows.rows.map((row) => {
      const creative = asObject(row.creative);
      return {
        id: text(row.evidence_key), productKey: text(row.product_key), platform: text(row.platform) as RadarPlatform,
        sourceId: text(row.source_ad_id), advertiser: text(row.advertiser), title: text(creative.title), copy: text(creative.copy),
        cta: text(creative.cta), adUrl: text(creative.adUrl), landingUrl: text(creative.landingUrl), mediaUrl: text(creative.mediaUrl),
        startDate: date(creative.startDate), endDate: date(creative.endDate), active: creative.active !== false,
        platforms: asArray(creative.platforms).map((v) => text(v)).filter(Boolean), offer: text(creative.offer), country: text(creative.country),
        firstSeenAt: text(row.first_seen_at), lastSeenAt: text(row.last_seen_at), observationCount: number(row.observation_count), raw: asObject(row.raw_payload),
      } satisfies RadarEvidence;
      });
      products = productRows.rows.map((row) => {
        const metrics = asObject(row.metrics);
        return {
        id: text(row.product_key), key: text(row.product_key), name: text(row.name), score: number(row.score), stage: text(row.stage) as RadarStage,
        competitorCount: number(metrics.competitorCount), activeAdCount: number(metrics.activeAdCount), creativeVariants: number(metrics.creativeVariants),
        oldestActiveDays: number(metrics.oldestActiveDays), momentum: number(metrics.momentum), localPresence: metrics.localPresence === true,
        platforms: asArray(metrics.platforms).map((v) => text(v) as RadarPlatform), reasons: asArray(row.reasons).map((v) => text(v)),
        risks: asArray(row.risks).map((v) => text(v)), thumbnailUrl: text(row.thumbnail_url), firstSeenAt: text(row.first_seen_at),
        lastSeenAt: text(row.last_seen_at), scanAt: text(row.scan_at), evidence: evidence.filter((item) => item.productKey === row.product_key),
        };
      });
      const row = runRows.rows[0];
      if (row) lastRun = { id: text(row.id), status: text(row.status) as RadarRun["status"], startedAt: text(row.started_at), completedAt: text(row.completed_at) || null, tiktokAds: number(row.tiktok_ads), candidates: number(row.candidates), metaAds: number(row.meta_ads), error: text(row.error) };
    } catch (error) {
      logDatabaseFallback("dashboard read", error);
      products = [...memoryProducts.values()].map((product) => ({
        ...product,
        evidence: [...memoryEvidence.values()].filter((item) => item.productKey === product.key),
      })).sort((a, b) => b.score - a.score);
      lastRun = memoryRuns[0] || null;
    }
  }
  const live = Boolean(lastRun?.status === "completed" && products.length);
  const shown = products.length ? products : (!configured.configured ? demoProducts() : []);
  const advertisers = new Set(shown.flatMap((product) => product.evidence.map((item) => item.advertiser).filter(Boolean)));
  return {
    dataMode: live || products.length ? "live" : !configured.configured ? "demo" : "empty",
    configured: configured.configured,
    configurationMessage: configured.message,
    focus: {
      marketCountry: configured.marketCountry,
      category: configured.category,
      includeTikTok: configured.includeTikTok,
    },
    lastRun,
    nextScan: "Daily at 5:30 AM Colombo time",
    summary: {
      candidates: shown.length, advertisers: advertisers.size,
      activeCreatives: shown.reduce((sum, product) => sum + product.activeAdCount, 0),
      emergingPicks: shown.filter((product) => product.stage === "emerging").length,
    },
    products: shown,
  };
}

export async function runRadarScan(): Promise<RadarDashboard> {
  const settings = config();
  if (!settings.token) {
    const error = new Error("APIFY_TOKEN is not configured");
    error.name = "RadarConfigurationError";
    throw error;
  }
  if (g.__radarScanRunning) {
    const error = new Error("A Product Radar scan is already running");
    error.name = "RadarScanConflict";
    throw error;
  }
  g.__radarScanRunning = true;
  const run: RadarRun = { id: randomUUID(), status: "running", startedAt: new Date().toISOString(), completedAt: null, tiktokAds: 0, candidates: 0, metaAds: 0, error: "" };
  await saveRun(run);
  try {
    const warnings: string[] = [];
    const localDiscoveryRuns = await Promise.allSettled(
      settings.localSeedKeywords.map(async (keyword) => {
        const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${encodeURIComponent(settings.market)}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered&media_type=all`;
        const rows = await callActor(settings.metaActor, {
          urls: [{ url }],
          count: 100,
          "scrapePageAds.period": "",
          "scrapePageAds.activeStatus": "active",
          "scrapePageAds.sortBy": "impressions_desc",
          "scrapePageAds.countryCode": settings.market,
        }, settings.token, settings.actorTimeoutMs);
        return rows
          .map((row) => normalizeMetaAd(row, keyword, settings.market))
          .filter((ad) => ad.title || ad.copy);
      })
    );
    const localAds: RadarEvidence[] = [];
    localDiscoveryRuns.forEach((result, index) => {
      if (result.status === "fulfilled") {
        localAds.push(...result.value);
      } else {
        const message = result.reason instanceof Error
          ? result.reason.message
          : "Unknown provider error";
        warnings.push(
          `"${settings.localSeedKeywords[index]}" Sri Lanka search failed: ${message}`
        );
      }
    });
    const dedupedLocalAds = [
      ...new Map(
        localAds.map((ad) => [evidenceKey(ad.platform, ad.sourceId), ad])
      ).values(),
    ];
    run.metaAds = dedupedLocalAds.length;

    const tiktok: RadarEvidence[] = [];
    if (settings.includeTikTok) {
      const tiktokRuns = await Promise.allSettled(
        settings.countries.map(async (country) => {
          const rows = await callActor(settings.tiktokActor, {
            period: "30", country, industry: "Beauty & Personal Care", objective: "Conversions",
            adFormat: "All Formats", orderBy: "CTR", keyword: "", maxResults: 50,
            responseFormat: "detailed", proxyConfiguration: { useApifyProxy: true },
          }, settings.token, settings.actorTimeoutMs);
          return rows
            .map((row) => normalizeTikTokAd(row, country))
            .filter((ad) => ad.title || ad.copy);
        })
      );
      tiktokRuns.forEach((result, index) => {
        if (result.status === "fulfilled") {
          tiktok.push(...result.value);
        } else {
          const message = result.reason instanceof Error
            ? result.reason.message
            : "Unknown provider error";
          warnings.push(
            `${settings.countries[index]} optional TikTok enrichment failed: ${message}`
          );
        }
      });
    }

    const discoveryEvidence = [...dedupedLocalAds, ...tiktok];
    if (!discoveryEvidence.length) {
      const error = new Error(
        warnings.length
          ? `Sri Lanka cosmetics discovery could not return any ads. ${warnings.join(" | ")}`
          : "Sri Lanka cosmetics discovery returned no usable ads."
      );
      error.name = localDiscoveryRuns.some(
        (result) => result.status === "rejected" &&
          result.reason instanceof Error &&
          result.reason.name === "RadarProviderTimeout"
      ) ? "RadarProviderTimeout" : "RadarProviderError";
      throw error;
    }
    run.tiktokAds = tiktok.length;
    let candidates: string[] = [];
    try { candidates = await extractCandidatesWithGemini(discoveryEvidence); } catch {}
    if (!candidates.length) {
      candidates = discoveryEvidence
        .map(fallbackProductName)
        .filter((name): name is string => Boolean(name));
    }
    candidates = [...new Map(candidates.map((name) => [productKey(name), name])).values()].slice(0, settings.maxCandidates);
    run.candidates = candidates.length;
    if (!candidates.length) {
      const error = new Error(
        "Sri Lankan cosmetics ads were collected, but no specific physical products could be identified."
      );
      error.name = "RadarProviderError";
      throw error;
    }
    const validationRuns = await Promise.allSettled(
      candidates.map(async (candidate) => {
        const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${encodeURIComponent(settings.market)}&q=${encodeURIComponent(candidate)}&search_type=keyword_unordered&media_type=all`;
        const rows = await callActor(settings.metaActor, {
          urls: [{ url }], count: 100, "scrapePageAds.period": "", "scrapePageAds.activeStatus": "active",
          "scrapePageAds.sortBy": "impressions_desc", "scrapePageAds.countryCode": settings.market,
        }, settings.token, settings.actorTimeoutMs);
        return { candidate, rows };
      })
    );
    for (let index = 0; index < validationRuns.length; index += 1) {
      const result = validationRuns[index];
      const candidate = candidates[index];
      const candidateWords = productKey(candidate)
        .split("-")
        .filter((word) => word.length > 2);
      const sourceMatches = discoveryEvidence.filter((ad) => {
        const haystack = `${ad.title} ${ad.copy}`.toLowerCase();
        const matches = candidateWords.filter((word) => haystack.includes(word)).length;
        return matches >= Math.max(1, Math.ceil(candidateWords.length / 2));
      });
      let meta: RadarEvidence[] = [];
      if (result.status === "fulfilled") {
        meta = result.value.rows.map(
          (row) => normalizeMetaAd(row, candidate, settings.market)
        );
        run.metaAds += meta.length;
      } else {
        const message = result.reason instanceof Error
          ? result.reason.message
          : "Unknown provider error";
        warnings.push(`${candidate} Meta validation failed: ${message}`);
      }
      await saveProduct(buildProduct(candidate, [...sourceMatches, ...meta]));
    }
    await pruneProducts(candidates.map(productKey));
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    run.error = warnings.length
      ? `Partial scan completed with ${warnings.length} provider warning${warnings.length === 1 ? "" : "s"}.`
      : "";
    await saveRun(run);
    return getRadarDashboard();
  } catch (error) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    run.error = error instanceof Error ? error.message : "Product Radar scan failed";
    await saveRun(run);
    throw error;
  } finally {
    g.__radarScanRunning = false;
  }
}
