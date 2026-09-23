import type { DeliveryAttempt, Order, SalesAccount, ShippingManifest } from "./types.ts";
import { orderValue, paymentMethodOf } from "./payments.ts";

export type ReportKind = "orders" | "delivery";
export type ReportFormat = "csv" | "pdf";

export interface ReportFilters {
  seller: string;
  from: string;
  to: string;
}

export interface ReportRow {
  cells: string[];
  heading: string;
  details: string[];
}

export interface ReportData {
  kind: ReportKind;
  title: string;
  sellerLabel: string;
  periodLabel: string;
  columns: string[];
  rows: ReportRow[];
  summary: string[];
}

const colomboDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Colombo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function reportDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = colomboDate.formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function validReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function inPeriod(iso: string, filters: ReportFilters): boolean {
  const day = reportDay(iso);
  return Boolean(day) && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
}

function asText(value: unknown): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function formatAmount(value: number): string {
  return Number(value || 0).toLocaleString("en-LK", { maximumFractionDigits: 2 });
}

function sellerName(order: Order, names: Map<string, string>): string {
  return names.get(order.sales_account_id) ?? "My business";
}

function reportBase(
  kind: ReportKind,
  filters: ReportFilters,
  accounts: SalesAccount[]
): Pick<ReportData, "kind" | "title" | "sellerLabel" | "periodLabel"> {
  return {
    kind,
    title: kind === "orders" ? "Orders report" : "Delivery report",
    sellerLabel: filters.seller === "all"
      ? "All sellers"
      : accounts.find((account) => account.id === filters.seller)?.name ?? "Unknown seller",
    periodLabel: filters.from || filters.to
      ? `${filters.from || "Beginning"} to ${filters.to || "Today"}`
      : "All dates",
  };
}

export function buildOrdersReport(
  orders: Order[],
  manifests: ShippingManifest[],
  accounts: SalesAccount[],
  filters: ReportFilters
): ReportData {
  const names = new Map(accounts.map((account) => [account.id, account.name]));
  const manifestByOrder = new Map(manifests.map((manifest) => [manifest.order_id, manifest]));
  const selected = orders
    .filter((order) =>
      (filters.seller === "all" || order.sales_account_id === filters.seller) &&
      inPeriod(order.created_at, filters)
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const rows = selected.map((order): ReportRow => {
    const manifest = manifestByOrder.get(order.id);
    const seller = sellerName(order, names);
    const itemText = order.items?.length
      ? order.items.map((item) => `${item.qty}x ${item.name}`).join("; ")
      : order.item_name;
    const orderNo = asText(order.order_no || order.id);
    const date = reportDay(order.created_at);
    const status = asText(order.order_status);
    const tracking = asText(manifest?.tracking_id);
    return {
      cells: [
        date, orderNo, seller, asText(order.customer_name), asText(order.phone_number),
        asText(order.parsed_address), asText(order.city), asText(order.district),
        asText(itemText), String(order.product_price), String(order.shipping_fee),
        String(order.discount), String(order.total_cod), paymentMethodOf(order),
        String(orderValue(order)), status, tracking, asText(manifest?.courier_name),
        asText(order.remitted_at ? reportDay(order.remitted_at) : ""),
      ],
      heading: `${orderNo}  |  ${asText(order.customer_name)}`,
      details: [
        `${date}  |  ${seller}  |  ${status}  |  COD Rs. ${formatAmount(Number(order.total_cod))}`,
        `${asText(itemText)}${tracking ? `  |  Tracking ${tracking}` : ""}`,
      ],
    };
  });
  const totalCod = selected.reduce((total, order) => total + Number(order.total_cod || 0), 0);
  return {
    ...reportBase("orders", filters, accounts),
    columns: [
      "Order date", "Order no", "Seller", "Customer", "Phone", "Address", "City",
      "District", "Items", "Product total", "Shipping fee", "Discount", "Total COD",
      "Payment method", "Order value", "Order status", "Tracking ID", "Courier", "Remitted date",
    ],
    rows,
    summary: [`${rows.length} orders`, `Total COD Rs. ${formatAmount(totalCod)}`],
  };
}

export function buildDeliveryReport(
  attempts: DeliveryAttempt[],
  orders: Order[],
  manifests: ShippingManifest[],
  accounts: SalesAccount[],
  filters: ReportFilters
): ReportData {
  const names = new Map(accounts.map((account) => [account.id, account.name]));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const manifestByOrder = new Map(manifests.map((manifest) => [manifest.order_id, manifest]));
  const selected = attempts
    .filter((attempt) => {
      const order = orderById.get(attempt.order_id);
      return Boolean(order) &&
        (filters.seller === "all" || order?.sales_account_id === filters.seller) &&
        inPeriod(attempt.last_event_at, filters);
    })
    .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));

  const rows = selected.map((attempt): ReportRow => {
    const order = orderById.get(attempt.order_id)!;
    const manifest = manifestByOrder.get(order.id);
    const seller = sellerName(order, names);
    const orderNo = asText(order.order_no || order.id);
    const eventDate = reportDay(attempt.last_event_at);
    const status = attempt.status.replaceAll("_", " ");
    const callStatus = attempt.call_status.replaceAll("_", " ");
    const reason = asText(attempt.reason);
    return {
      cells: [
        eventDate, orderNo, seller, asText(order.customer_name), asText(order.phone_number),
        asText(attempt.tracking_id), asText(manifest?.courier_name),
        String(attempt.attempt_no), status, reason,
        asText(attempt.next_delivery_date), callStatus,
        asText(attempt.called_at ? reportDay(attempt.called_at) : ""),
        asText(attempt.call_notes),
      ],
      heading: `${orderNo}  |  ${asText(order.customer_name)}`,
      details: [
        `${eventDate}  |  ${seller}  |  Attempt ${attempt.attempt_no}  |  ${status}`,
        `${reason || "No courier reason"}  |  Call: ${callStatus}${attempt.next_delivery_date ? `  |  Next ${attempt.next_delivery_date}` : ""}`,
      ],
    };
  });
  const uniqueOrders = new Set(selected.map((attempt) => attempt.order_id)).size;
  return {
    ...reportBase("delivery", filters, accounts),
    columns: [
      "Last event date", "Order no", "Seller", "Customer", "Phone", "Tracking ID",
      "Courier", "Attempt", "Delivery status", "Reason", "Next delivery date",
      "Call status", "Called date", "Call notes",
    ],
    rows,
    summary: [`${rows.length} delivery attempts`, `${uniqueOrders} orders`],
  };
}

function safeCsvCell(value: string): string {
  // Spreadsheet apps otherwise interpret customer-entered text as formulas.
  const valueForSheet = /^[=+@\-]/.test(value) ? `'${value}` : value;
  return `"${valueForSheet.replaceAll('"', '""')}"`;
}

export function reportToCsv(report: ReportData): string {
  return [report.columns, ...report.rows.map((row) => row.cells)]
    .map((cells) => cells.map(safeCsvCell).join(","))
    .join("\r\n");
}
