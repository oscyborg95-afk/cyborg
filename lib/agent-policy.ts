import type { AgentDecision } from "./types";

export function insideQuietHours(
  config: { quiet_hours_start: string; quiet_hours_end: string },
  date = new Date()
): boolean {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const start = config.quiet_hours_start;
  const end = config.quiet_hours_end;
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function needsAgentHandoff(
  action: "reply" | "handoff" | "skip",
  confidence: number,
  minimumConfidence: number
): boolean {
  return action === "handoff" || confidence < minimumConfidence;
}

export function canAutoSendDecision(
  decision: Pick<AgentDecision, "intent" | "sales_stage" | "language_confidence">
): boolean {
  const safeIntent = [
    "greeting",
    "product_question",
    "price_question",
    "availability",
  ].includes(decision.intent);
  return (
    safeIntent &&
    ["discovery", "consideration"].includes(decision.sales_stage) &&
    decision.language_confidence >= 0.9
  );
}
