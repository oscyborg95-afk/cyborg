import {
  claimDueTrackingNotifications,
  finishTrackingNotification,
  getDeliveryAttempt,
  recordCustomerAlert,
  skipTrackingNotification,
} from "./db.ts";
import { getTenantSession } from "./tenant-context.ts";
import { sendWhatsAppMessage } from "./wa.ts";

// One drain per tenant at a time. This used to be a single module-level
// promise: during the cron's tenant loop, a webhook draining tenant A's queue
// made tenant B's call return A's promise, so B's queue was skipped entirely.
const running = new Map<string, Promise<{ sent: number; failed: number }>>();

export async function processTrackingNotificationQueue(limit = 20) {
  // Falls back to a single local lane when auth is not configured (dev against
  // the in-memory store), rather than refusing to drain the queue at all.
  const tenantId = (await getTenantSession())?.tenantId ?? "local";
  const active = running.get(tenantId);
  if (active) return active;

  const run = (async () => {
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
        // The job id doubles as the idempotency key: if the worker accepted the
        // message but our HTTP call timed out, the retry is answered from the
        // worker's ledger instead of sending the customer a second copy.
        await sendWhatsAppMessage(job.chat_id, job.body, undefined, undefined, undefined, job.id);
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
    running.delete(tenantId);
  });

  running.set(tenantId, run);
  return run;
}
