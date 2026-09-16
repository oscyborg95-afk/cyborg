export interface GoogleGenerateContentRequest {
  provider: "gemini-developer-api" | "google-cloud-agent-platform";
  url: string;
  headers: Record<string, string>;
}

function useVertexAi(): boolean {
  return process.env.GOOGLE_GENAI_USE_VERTEXAI?.trim().toLowerCase() === "true";
}

function requiredCloudProject(): string {
  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!project) {
    throw new Error(
      "This Google Cloud Agent Platform key requires GOOGLE_CLOUD_PROJECT to be configured."
    );
  }
  return project;
}

export function googleGenerateContentRequest(
  apiKey: string,
  model: string
): GoogleGenerateContentRequest {
  // AI Studio now issues `AQ...` authorization keys as well as legacy `AIza...`
  // keys. The key prefix therefore cannot identify Vertex AI. Keep the Gemini
  // Developer API as the default and require an explicit opt-in for Vertex AI.
  if (useVertexAi()) {
    const project = requiredCloudProject();
    const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || "global";
    return {
      provider: "google-cloud-agent-platform",
      url:
        `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}` +
        `/locations/${encodeURIComponent(location)}/publishers/google/models/` +
        `${encodeURIComponent(model)}:generateContent`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    };
  }

  return {
    provider: "gemini-developer-api",
    url:
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(model)}:generateContent`,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  };
}

export function googlePermissionError(status: number, provider: string): string | null {
  if (status !== 401 && status !== 403) return null;
  return provider === "google-cloud-agent-platform"
    ? "Google Cloud rejected this Agent Platform key. Check the key restriction, project ID, billing, and Agent Platform API access."
    : "Google rejected this Gemini key. Use a Gemini API key created in Google AI Studio, or add a Google Cloud Agent Platform key with its project configured.";
}
