import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLanguageHeuristic,
  validateReplyScript,
} from "../lib/language.ts";

test("Sinhala and Tamil scripts are detected without an LLM guess", () => {
  assert.deepEqual(
    detectLanguageHeuristic("මේකේ මිල කීයද?")?.language,
    "si"
  );
  assert.equal(
    detectLanguageHeuristic("இந்த பொருள் விலை என்ன?")?.language,
    "ta"
  );
});

test("multiple romanized markers identify Singlish while short text stays ambiguous", () => {
  const singlish = detectLanguageHeuristic("mata me eka ganna ona");
  assert.equal(singlish?.language, "si");
  assert.equal(singlish?.style, "si_latin");
  assert.equal(detectLanguageHeuristic("ok"), null);
  assert.equal(detectLanguageHeuristic("price?"), null);
});

test("a conventional English greeting can be answered autonomously", () => {
  const greeting = detectLanguageHeuristic("hi");
  assert.equal(greeting?.language, "en");
  assert.equal(greeting?.style, "en");
  assert.ok(greeting?.confidence >= 0.9);
});

test("a manually selected language is authoritative without forcing the wrong script", () => {
  const selected = detectLanguageHeuristic("price kiyanna", "si");
  assert.equal(selected?.language, "si");
  assert.equal(selected?.style, "si_latin");
  assert.equal(selected?.confidence, 1);
});

test("reply script validation blocks accidental English and script switching", () => {
  assert.equal(validateReplyScript("Yes, it is available.", "si_native").valid, false);
  assert.equal(validateReplyScript("ඔව්, මේක තියෙනවා.", "si_native").valid, true);
  assert.equal(validateReplyScript("ඔව්, තියෙනවා.", "si_latin").valid, false);
  assert.equal(validateReplyScript("Ow, meka thiyenawa.", "si_latin").valid, true);
});
