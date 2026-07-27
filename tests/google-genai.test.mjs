import assert from "node:assert/strict";
import test from "node:test";
import { googleGenerateContentRequest } from "../lib/google-genai.ts";

test("AI Studio keys use the Gemini Developer API", () => {
  const request = googleGenerateContentRequest("AIza-test", "gemini-test");
  assert.equal(request.provider, "gemini-developer-api");
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
  );
  assert.equal(request.headers["x-goog-api-key"], "AIza-test");
});

test("Agent Platform keys use the configured Cloud project and location", () => {
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  const previousLocation = process.env.GOOGLE_CLOUD_LOCATION;
  process.env.GOOGLE_CLOUD_PROJECT = "example-project";
  process.env.GOOGLE_CLOUD_LOCATION = "global";
  try {
    const request = googleGenerateContentRequest("AQ.test", "gemini-test");
    assert.equal(request.provider, "google-cloud-agent-platform");
    assert.equal(
      request.url,
      "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-test:generateContent"
    );
    assert.equal(request.headers["x-goog-api-key"], "AQ.test");
  } finally {
    if (previousProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    if (previousLocation === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
    else process.env.GOOGLE_CLOUD_LOCATION = previousLocation;
  }
});

test("Agent Platform keys fail clearly when the Cloud project is missing", () => {
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  try {
    assert.throws(
      () => googleGenerateContentRequest("AQ.test", "gemini-test"),
      /GOOGLE_CLOUD_PROJECT/
    );
  } finally {
    if (previousProject !== undefined) process.env.GOOGLE_CLOUD_PROJECT = previousProject;
  }
});
