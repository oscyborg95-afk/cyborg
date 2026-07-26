import { runSalesAgent } from "./agent-runtime";
import { getAgentRun } from "./crm-db";
import { workerFetch } from "./wa";
import type { WaMessage } from "./types";

export async function retryAgentRun(runId: string) {
  const run = await getAgentRun(runId);
  if (!run || run.status !== "failed") {
    throw new Error("Only failed agent runs can be retried.");
  }
  const messages = await workerFetch<WaMessage[]>(
    `/messages/${encodeURIComponent(run.chat_id)}?peek=1`
  );
  const trigger = messages.find((message) => message.id === run.trigger_message_id);
  if (!trigger) {
    throw new Error("The original customer message is no longer available for retry.");
  }
  const latest = messages[messages.length - 1];
  if (!latest || latest.id !== trigger.id || latest.fromMe) {
    throw new Error("A newer message superseded this run; retry the latest conversation instead.");
  }
  return runSalesAgent({
    id: trigger.id,
    chatId: trigger.chatId,
    body: trigger.body,
    fromMe: trigger.fromMe,
    timestamp: trigger.timestamp,
    senderName: trigger.senderName,
  });
}
