export type InvoiceCell = string | number | boolean | Date | null;

export interface CourierInvoiceLine {
  order_date: string;
  waybill_id: string;
  invoice_no: string;
  order_no: string;
  vat_rate: number;
  commission_rate: number;
  cod: number;
  collected_cod: number;
  vat: number;
  commission: number;
  delivery_charge: number;
  payable: number;
  weight_kg: number;
  status: string;
}

export interface ParsedCourierInvoice {
  invoice_no: string;
  lines: CourierInvoiceLine[];
  gross_cod: number;
  collected_cod: number;
  vat: number;
  commission: number;
  delivery_charges: number;
  payable: number;
}

const REQUIRED_HEADERS = [
  "WAYBILL ID",
  "INVOICE NO",
  "ORDER NO",
  "COD",
  "COLLECTED COD",
  "DELIVERY CHARGE",
  "PAYABLE",
] as const;

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const asText = (value: InvoiceCell | undefined) => String(value ?? "").trim();
const asNumber = (value: InvoiceCell | undefined, label: string, row: number) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a number on invoice row ${row}`);
  return parsed;
};

export function parseCourierInvoiceRows(rows: InvoiceCell[][]): ParsedCourierInvoice {
  if (rows.length < 2) throw new Error("The invoice workbook has no delivery rows");
  const headers = rows[0].map((value) => asText(value).toUpperCase().replace(/\s+/g, " "));
  const column = new Map(headers.map((header, index) => [header, index]));
  for (const required of REQUIRED_HEADERS) {
    if (!column.has(required)) throw new Error(`Missing required invoice column: ${required}`);
  }
  const at = (row: InvoiceCell[], name: string) => row[column.get(name) ?? -1];
  const lines: CourierInvoiceLine[] = [];

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.every((value) => value === null || asText(value) === "")) continue;
    const rowNo = index + 1;
    const cod = asNumber(at(row, "COD"), "COD", rowNo);
    const collected = asNumber(at(row, "COLLECTED COD"), "Collected COD", rowNo);
    const vat = asNumber(at(row, "TOTAL VAT"), "VAT", rowNo);
    const delivery = asNumber(at(row, "DELIVERY CHARGE"), "Delivery charge", rowNo);
    const payable = asNumber(at(row, "PAYABLE"), "Payable", rowNo);
    const explicitCommission = asNumber(at(row, "TOTAL COMMISSION"), "Commission", rowNo);
    // The supplied Trans Express invoice reports TOTAL COMMISSION as zero even
    // though PAYABLE includes the percentage in COMMISSION. Reconcile the row
    // from its cash equation when the explicit total is absent.
    const derivedCommission = Math.max(0, collected - vat - delivery - payable);
    const commission = explicitCommission > 0 ? explicitCommission : derivedCommission;
    const invoiceNo = asText(at(row, "INVOICE NO"));
    const waybill = asText(at(row, "WAYBILL ID"));
    if (!invoiceNo || !waybill) throw new Error(`Invoice number and waybill are required on row ${rowNo}`);
    lines.push({
      order_date: asText(at(row, "ORDER DATE")),
      waybill_id: waybill,
      invoice_no: invoiceNo,
      order_no: asText(at(row, "ORDER NO")),
      vat_rate: asNumber(at(row, "VAT %"), "VAT rate", rowNo),
      commission_rate: asNumber(at(row, "COMMISSION"), "Commission rate", rowNo),
      cod: roundMoney(cod),
      collected_cod: roundMoney(collected),
      vat: roundMoney(vat),
      commission: roundMoney(commission),
      delivery_charge: roundMoney(delivery),
      payable: roundMoney(payable),
      weight_kg: asNumber(at(row, "WEIGHT (KG)"), "Weight", rowNo),
      status: asText(at(row, "STATUS")),
    });
  }

  if (lines.length === 0) throw new Error("The invoice workbook has no usable delivery rows");
  const invoiceNumbers = new Set(lines.map((line) => line.invoice_no));
  if (invoiceNumbers.size !== 1) throw new Error("The workbook contains more than one invoice number");
  const sum = (key: keyof CourierInvoiceLine) =>
    roundMoney(lines.reduce((total, line) => total + Number(line[key]), 0));
  return {
    invoice_no: lines[0].invoice_no,
    lines,
    gross_cod: sum("cod"),
    collected_cod: sum("collected_cod"),
    vat: sum("vat"),
    commission: sum("commission"),
    delivery_charges: sum("delivery_charge"),
    payable: sum("payable"),
  };
}
