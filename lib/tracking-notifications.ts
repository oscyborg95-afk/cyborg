import {
  claimDueTrackingNotifications,
  finishTrackingNotification,
  getDeliveryAttempt,
  recordCustomerAlert,
  skipTrackingNotification,
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
        if (
          job.delivery_attempt_id &&
          ["owner_call_reminder", "owner_morning_reminder"].includes(job.notification_type ?? "")
        ) {
          const attempt = await getDeliveryAttempt(job.delivery_attempt_id);
          if (
            !attempt ||
            ["called_confirmed", "resolved"].includes(attempt.call_status)
          ) {
            await skipTrackingNotification(job.id, "Call task already handled");
            continue;
          }
        }
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
