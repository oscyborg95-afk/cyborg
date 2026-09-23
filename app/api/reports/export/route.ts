import { NextRequest } from "next/server";
import {
  listAllDeliveryAttempts,
  listAllOrders,
  listManifests,
  listSalesAccounts,
} from "@/lib/db";
import {
  buildDeliveryReport,
  buildOrdersReport,
  reportToCsv,
  validReportDate,
} from "@/lib/report-export";
import { reportToPdf } from "@/lib/report-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const kind = params.get("type") || "";
  const format = params.get("format") || "";
  const seller = params.get("seller") || "all";
  const from = params.get("from") || "";
  const to = params.get("to") || "";

  if (kind !== "orders" && kind !== "delivery") return badRequest("Choose an orders or delivery report");
  if (format !== "csv" && format !== "pdf") return badRequest("Choose CSV or PDF format");
  if ((from && !validReportDate(from)) || (to && !validReportDate(to))) {
    return badRequest("Dates must use YYYY-MM-DD format");
  }
  if (from && to && from > to) return badRequest("From date must not be after To date");

  try {
    const [accounts, orders, manifests] = await Promise.all([
      listSalesAccounts(false), listAllOrders(), listManifests(),
    ]);
    if (seller !== "all" && !accounts.some((account) => account.id === seller)) {
      return badRequest("Seller not found");
    }
    const filters = { seller, from, to };
    const report = kind === "orders"
      ? buildOrdersReport(orders, manifests, accounts, filters)
      : buildDeliveryReport(
          await listAllDeliveryAttempts(), orders, manifests, accounts, filters
        );
    const filename = `${kind}-report-${new Date().toISOString().slice(0, 10)}.${format}`;
    const headers = {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };

    if (format === "csv") {
      return new Response(`\uFEFF${reportToCsv(report)}`, {
        headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
      });
    }
    const pdf = await reportToPdf(report);
    return new Response(new Uint8Array(pdf), {
      headers: { ...headers, "Content-Type": "application/pdf" },
    });
  } catch (error) {
    console.error("Report export failed", error);
    return Response.json({ error: "Report could not be generated. Please try again." }, { status: 500 });
  }
}
