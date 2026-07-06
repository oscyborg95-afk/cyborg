import { z } from "zod";
import { DISTRICTS } from "./districts";
import type { ParsedAddress } from "./types";

// AI address parsing. Provider is picked by which key is set (checked in this order):
//   1. GEMINI_API_KEY    — Google AI Studio, free tier (https://aistudio.google.com/apikey)
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

Extract the delivery details:
- name: the customer's name.
- phone: the primary phone number, normalized to local 10-digit format (e.g. +94 77 123 4567 → 0771234567). If two numbers are given, this is the mobile number.
- phone_2: the second phone number if the customer gave two, normalized the same way. Empty string if only one number was given.
- address: the street address only, cleaned and formatted on one line. Do not include the name, phone, city, or district in it.
- city: the delivery town/city used for courier routing (e.g. Nugegoda, Maharagama, Kandy). This is the local town, not the district. Correct spelling. If only a district is given, use the district's main town.
- district: the Sri Lankan district. Infer it from the town if not stated explicitly, and correct spelling to the official district name.`;

export async function parseRawAddress(rawText: string): Promise<ParsedAddress> {
  if (process.env.GEMINI_API_KEY) return parseWithGemini(rawText);
  if (process.env.ANTHROPIC_API_KEY) return parseWithClaude(rawText);
  throw new Error(
    "No AI key configured. Get a free key at https://aistudio.google.com/apikey and set GEMINI_API_KEY in .env.local"
  );
}

// --- Gemini (default, free tier) ---------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function parseWithGemini(rawText: string): Promise<ParsedAddress> {
  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: rawText }] }],
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

  // Gemini occasionally returns 503 (UNAVAILABLE / "high demand") — a transient
  // spike, not a real failure. Retry a few times with backoff so the operator
  // never sees a blip from clicking Parse.
  let res: Response | null = null;
  const backoffMs = [600, 1200, 2500];
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY!,
        },
        body: requestBody,
      }
    );
    if (res.status !== 503 || attempt === backoffMs.length) break;
    await sleep(backoffMs[attempt]);
  }
  if (!res) throw new Error("Gemini request failed to start.");

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 429) {
      throw new Error("Gemini free-tier rate limit hit — wait a minute and try again.");
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

async function parseWithClaude(rawText: string): Promise<ParsedAddress> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic();

  const response = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: rawText }],
    output_config: { format: zodOutputFormat(ParsedAddressSchema) },
  });

  if (!response.parsed_output) {
    throw new Error("The model could not extract address details from that text.");
  }
  return response.parsed_output;
}
