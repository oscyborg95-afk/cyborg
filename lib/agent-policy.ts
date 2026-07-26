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

export function shouldPauseCustomer(
  decision: Pick<AgentDecision, "action" | "intent" | "handoff_reason">
): boolean {
  if (decision.action !== "handoff") return false;
  if (decision.intent === "complaint") return true;

  // The planner writes handoff reasons in English even when the customer is
  // chatting in Sinhala or Tamil. Only explicit safety/support escalations
  // pause the conversation; ordinary uncertainty remains a reviewable draft.
  return /\b(refund|fraud|scam|unsafe|legal|police|human (?:agent|support)|speak to (?:a )?(?:human|person|manager))\b/i.test(
    decision.handoff_reason
  );
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
