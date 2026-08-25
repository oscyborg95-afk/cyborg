import {
  claimDueTrackingNotifications,
  finishTrackingNotification,
  getDeliveryAttempt,
  getOrder,
  recordCustomerAlert,
  skipTrackingNotification,
} from "./db.ts";
import { getTenantSession } from "./tenant-context.ts";
import { sendWhatsAppMessage } from "./wa.ts";

// One drain per tenant at a time. This used to be a single module-level
// promise: during the cron's tenant loop, a webhook draining tenant A's queue
// made tenant B's call return A's promise, so B's queue was skipped entirely.
const running = new Map<string, Promise<{ sent: number; failed: number }>>();

export async function processTrackingNotificationQueue(limit = 20, dedupePrefix?: string) {
  // Falls back to a single local lane when auth is not configured (dev against
  // the in-memory store), rather than refusing to drain the queue at all.
  const tenantId = (await getTenantSession())?.tenantId ?? "local";
  const laneKey = dedupePrefix ? `${tenantId}::${dedupePrefix}` : tenantId;
  const active = running.get(laneKey);
  if (active) return active;

  const run = (async () => {
    let sent = 0;
    let failed = 0;
    const jobs = await claimDueTrackingNotifications(limit, dedupePrefix);
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
        // An announcement written for parcels in flight must not reach someone
        // whose parcel landed (or came back) while the operator was typing.
        // The order is re-checked at send time, never at compose time.
        if (job.notification_type === "announcement") {
          const order = await getOrder(job.order_id);
          if (!order || order.archived_at || !["pending", "booked"].includes(order.order_status)) {
            await skipTrackingNotification(
              job.id,
              order ? `Order is now ${order.archived_at ? "archived" : order.order_status}` : "Order no longer exists"
            );
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
    running.delete(laneKey);
  });

  running.set(laneKey, run);
  return run;
}
