import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ReportData } from "./report-export.ts";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const ink = rgb(0.20, 0.23, 0.20);
const muted = rgb(0.40, 0.43, 0.40);
const green = rgb(0.19, 0.47, 0.20);
const pale = rgb(0.95, 0.97, 0.92);
const rule = rgb(0.85, 0.88, 0.82);

function pdfText(value: string, supported: Set<number>): string {
  return Array.from(value.normalize("NFC"))
    .map((character) => {
      if (character === "\n" || character === "\r" || character === "\t") return " ";
      if (/[\u2010-\u2015]/u.test(character)) return "-";
      return supported.has(character.codePointAt(0) ?? 0) ? character : "?";
    })
    .join("");
}

function fit(value: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  const suffix = "...";
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("") + suffix;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("").trimEnd() + suffix;
}

function drawHeader(
  page: PDFPage,
  font: PDFFont,
  supported: Set<number>,
  report: ReportData,
  generatedAt: string
): number {
  page.drawRectangle({
    x: 0, y: PAGE_HEIGHT - 12, width: PAGE_WIDTH, height: 12, color: green,
  });
  page.drawText(pdfText(report.title, supported), {
    x: MARGIN, y: PAGE_HEIGHT - 55, size: 20, font, color: ink,
  });
  page.drawText("THE ACNE LAB  /  REPORTS", {
    x: MARGIN, y: PAGE_HEIGHT - 34, size: 8, font, color: green,
  });
  page.drawText(pdfText(`Seller: ${report.sellerLabel}   |   Period: ${report.periodLabel}`, supported), {
    x: MARGIN, y: PAGE_HEIGHT - 75, size: 9, font, color: muted,
  });
  page.drawText(pdfText(`Generated ${generatedAt} (Sri Lanka time)`, supported), {
    x: MARGIN, y: PAGE_HEIGHT - 91, size: 8, font, color: muted,
  });
  page.drawLine({
    start: { x: MARGIN, y: PAGE_HEIGHT - 104 },
    end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 104 },
    thickness: 1, color: rule,
  });
  const summary = report.summary.join("    |    ");
  page.drawRectangle({
    x: MARGIN, y: PAGE_HEIGHT - 149, width: CONTENT_WIDTH, height: 32,
    color: pale,
  });
  page.drawText(fit(pdfText(summary, supported), font, 10, CONTENT_WIDTH - 24), {
    x: MARGIN + 12, y: PAGE_HEIGHT - 138, size: 10, font, color: green,
  });
  return PAGE_HEIGHT - 170;
}

export async function reportToPdf(report: ReportData): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const fontBytes = await readFile(path.join(process.cwd(), "public/fonts/NotoSansSinhala.ttf"));
  const font = await document.embedFont(fontBytes);
  const supported = new Set(font.getCharacterSet());
  document.setTitle(report.title);
  document.setCreator("The Acne Lab Reports");
  const generatedAt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo", dateStyle: "medium", timeStyle: "short",
  }).format(new Date());

  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = drawHeader(page, font, supported, report, generatedAt);
  if (report.rows.length === 0) {
    page.drawText("No records match these filters.", {
      x: MARGIN + 10, y: y - 24, size: 11, font, color: muted,
    });
  }

  for (const [index, row] of report.rows.entries()) {
    if (y < 125) {
      page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = drawHeader(page, font, supported, report, generatedAt);
    }
    const height = 62;
    if (index % 2 === 0) {
      page.drawRectangle({
        x: MARGIN, y: y - height, width: CONTENT_WIDTH, height,
        color: rgb(0.985, 0.986, 0.974),
      });
    }
    const heading = fit(pdfText(row.heading, supported), font, 10.5, CONTENT_WIDTH - 24);
    page.drawText(heading, { x: MARGIN + 10, y: y - 17, size: 10.5, font, color: ink });
    for (const [lineIndex, detail] of row.details.slice(0, 2).entries()) {
      page.drawText(fit(pdfText(detail, supported), font, 8.2, CONTENT_WIDTH - 24), {
        x: MARGIN + 10, y: y - 33 - lineIndex * 12, size: 8.2, font, color: muted,
      });
    }
    page.drawLine({
      start: { x: MARGIN, y: y - height },
      end: { x: PAGE_WIDTH - MARGIN, y: y - height },
      thickness: 0.5, color: rule,
    });
    y -= height;
  }

  const pages = document.getPages();
  for (const [index, current] of pages.entries()) {
    current.drawLine({
      start: { x: MARGIN, y: 50 }, end: { x: PAGE_WIDTH - MARGIN, y: 50 },
      thickness: 0.5, color: rule,
    });
    current.drawText("Confidential - customer information", {
      x: MARGIN, y: 35, size: 7.5, font, color: muted,
    });
    const pagination = `Page ${index + 1} of ${pages.length}`;
    current.drawText(pagination, {
      x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(pagination, 7.5),
      y: 35, size: 7.5, font, color: muted,
    });
  }
  return document.save();
}
