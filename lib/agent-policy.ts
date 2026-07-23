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
