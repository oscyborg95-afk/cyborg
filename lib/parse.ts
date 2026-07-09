import { z } from "zod";
import { DISTRICTS } from "./districts";
import type { ParsedAddress } from "./types";

// AI address parsing. Provider is picked by which key is set (checked in this order):
//   1. Gemini key(s)     — from Settings (business_settings.gemini_api_key) first,
//                          else the GEMINI_API_KEY env var. Google AI Studio, free
//                          tier (https://aistudio.google.com/apikey).
//   2. ANTHROPIC_API_KEY — Claude fallback for anyone who already has one
// Both are forced into the same JSON schema, so the rest of the app doesn't care.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const ParsedAddressSchema = z.object({
  name: z.string(),
  phone: z.string(),
  phone_2: z.string(),
  address: z.string(),
  city: z.string(),
  district: z.enum(DISTRICTS),
});

const SYSTEM_PROMPT = `You are a Sri Lankan address parsing engine for a cash-on-delivery e-commerce business.
The input is a raw message block copied from a WhatsApp chat. It may mix Sinhala, Tamil, and English, contain typos, emoji, and irrelevant chat text.
The input may also include voice notes (transcribe them — customers often speak their address in Sinhala) and photos (often a handwritten address — read it). Combine every source into one set of delivery details, preferring the most recent/most complete information.

Extract the delivery details:
- name: the customer's name.
- phone: the primary phone number, normalized to local 10-digit format (e.g. +94 77 123 4567 → 0771234567). If two numbers are given, this is the mobile number.
- phone_2: the second phone number if the customer gave two, normalized the same way. Empty string if only one number was given.
- address: the street address only, cleaned and formatted on one line. Do not include the name, phone, city, or district in it.
- city: the delivery town/city used for courier routing (e.g. Nugegoda, Maharagama, Kandy). This is the local town, not the district. Correct spelling. If only a district is given, use the district's main town.
- district: the Sri Lankan district. Infer it from the town if not stated explicitly, and correct spelling to the official district name.`;

// A voice note or photo pulled from the WhatsApp worker, base64-encoded.
export interface MediaAttachment {
  mime: string;
  data: string;
}

export interface ParseOptions {
  // One or more Gemini API keys from Settings, newline/comma/space separated.
  // When present these win over the GEMINI_API_KEY env var.
  geminiApiKey?: string;
}

// Split a stored key blob into a de-duplicated list of individual keys.
function splitKeys(raw?: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean))];
}

export async function parseRawAddress(
  rawText: string,
  media: MediaAttachment[] = [],
  opts: ParseOptions = {}
): Promise<ParsedAddress> {
  // Operator-configured keys take priority; fall back to the env var.
  const geminiKeys = splitKeys(opts.geminiApiKey);
  if (geminiKeys.length === 0 && process.env.GEMINI_API_KEY) {
    geminiKeys.push(process.env.GEMINI_API_KEY);
  }
  if (geminiKeys.length) return parseWithGemini(rawText, media, geminiKeys);
  if (process.env.ANTHROPIC_API_KEY) return parseWithClaude(rawText, media);
  throw new Error(
    "No AI key configured. Add a Gemini API key in Settings (free at https://aistudio.google.com/apikey), or set GEMINI_API_KEY."
  );
}

// --- Gemini (default, free tier) ---------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function parseWithGemini(
  rawText: string,
  media: MediaAttachment[],
  apiKeys: string[]
): Promise<ParsedAddress> {
  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: rawText || "Extract the delivery details from the attached message(s)." },
          ...media.map((m) => ({ inline_data: { mime_type: m.mime, data: m.data } })),
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Customer full name" },
          phone: {
            type: "STRING",
            description: "Primary Sri Lankan phone number in local format, e.g. 0771234567",
          },
          phone_2: {
            type: "STRING",
            description:
              "Second phone number in local format if the customer gave two, else empty string",
          },
          address: {
            type: "STRING",
            description:
              "Cleaned, courier-ready street address (no name, no phone, no city, no district)",
          },
          city: {
            type: "STRING",
            description: "The delivery town/city for courier routing, spelling corrected",
          },
          district: { type: "STRING", enum: [...DISTRICTS] },
        },
        required: ["name", "phone", "phone_2", "address", "city", "district"],
      },
    },
  });

  // One request for a single key. Gemini occasionally returns 503 (UNAVAILABLE /
  // "high demand") — a transient spike, not a real failure — so retry a few
  // times with backoff, so the operator never sees a blip from clicking Parse.
  const callOnce = async (apiKey: string): Promise<Response> => {
    let res: Response | null = null;
    const backoffMs = [600, 1200, 2500];
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: requestBody,
        }
      );
      if (res.status !== 503 || attempt === backoffMs.length) break;
      await sleep(backoffMs[attempt]);
    }
    if (!res) throw new Error("Gemini request failed to start.");
    return res;
  };

  // Try each configured key in turn: a rate-limited (429) key rotates to the
  // next, so a single exhausted free-tier key doesn't block parsing when the
  // operator has added spares in Settings.
  let res: Response | null = null;
  for (let i = 0; i < apiKeys.length; i++) {
    res = await callOnce(apiKeys[i]);
    if (res.status === 429 && i < apiKeys.length - 1) continue;
    break;
  }
  if (!res) throw new Error("Gemini request failed to start.");

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 429) {
      throw new Error(
        apiKeys.length > 1
          ? "All Gemini keys are rate-limited right now — wait a minute, or add another key in Settings."
          : "Gemini free-tier rate limit hit — wait a minute, or add another key in Settings."
      );
    }
    if (res.status === 503) {
      throw new Error("Gemini is busy right now (high demand) — please tap Parse again.");
    }
    throw new Error(`Gemini request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("The model could not extract address details from that text.");
  }

  const parsed = ParsedAddressSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error("The model returned an unexpected format — try again or edit manually.");
  }
  return parsed.data;
}

// --- Claude (fallback if you have a key) --------------------------------------

async function parseWithClaude(
  rawText: string,
  media: MediaAttachment[]
): Promise<ParsedAddress> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic();

  // Claude reads images but not audio — voice notes need the Gemini path.
  const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
  type ImageMime = (typeof IMAGE_MIMES)[number];
  const images = media.filter((m): m is MediaAttachment & { mime: ImageMime } =>
    (IMAGE_MIMES as readonly string[]).includes(m.mime)
  );
  const content = [
    {
      type: "text" as const,
      text: rawText || "Extract the delivery details from the attached image(s).",
    },
    ...images.map((m) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: m.mime, data: m.data },
    })),
  ];

  const response = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(ParsedAddressSchema) },
  });

  if (!response.parsed_output) {
    throw new Error("The model could not extract address details from that text.");
  }
  return response.parsed_output;
}
