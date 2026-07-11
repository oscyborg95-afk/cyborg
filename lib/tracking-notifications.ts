import {
  claimDueTrackingNotifications,
  finishTrackingNotification,
  recordCustomerAlert,
} from "./db";
import { sendWhatsAppMessage } from "./wa";

let running: Promise<{ sent: number; failed: number }> | null = null;

export function processTrackingNotificationQueue(limit = 20) {
  if (running) return running;
  running = (async () => {
    let sent = 0;
    let failed = 0;
    const jobs = await claimDueTrackingNotifications(limit);
    for (const job of jobs) {
      try {
        await sendWhatsAppMessage(job.chat_id, job.body);
        await finishTrackingNotification(job.id);
        if (job.recipient === "customer" && job.alert_kind) {
          await recordCustomerAlert(job.order_id, job.alert_kind, job.body, "sent");
        }
        sent++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "WhatsApp send failed";
        await finishTrackingNotification(job.id, message);
        if (job.recipient === "customer" && job.alert_kind) {
          await recordCustomerAlert(job.order_id, job.alert_kind, job.body, "failed").catch(() => {});
        }
        failed++;
      }
    }
    return { sent, failed };
  })().finally(() => {
    running = null;
  });
  return running;
}
