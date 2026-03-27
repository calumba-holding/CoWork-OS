import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import { parsePdfBuffer } from "./pdf-parser";
import {
  OCR_TIMEOUT_MS,
  TESSERACT_LANGUAGE_DEFAULT,
  isTesseractInstalled,
  sanitizeOcrOutput,
} from "../ipc/image-viewer-ocr";
import type { PdfReviewPageSummary, PdfReviewSummary } from "../../shared/types";

const execFile = promisify(execFileCallback);

type ExtractedTextItem = {
  str?: unknown;
  transform: number[];
  width?: number;
  height?: number;
};

type PdfReviewOptions = {
  maxPages?: number;
  maxCharsPerPage?: number;
  pageTextThreshold?: number;
  maxOcrPages?: number;
  renderScale?: number;
  includeOcr?: boolean;
};

export type PdfReviewData = PdfReviewSummary & {
  fullText: string;
  content: string;
};

const DEFAULT_MAX_PAGES = 12;
const DEFAULT_MAX_CHARS_PER_PAGE = 1800;
const DEFAULT_PAGE_TEXT_THRESHOLD = 32;
const DEFAULT_MAX_OCR_PAGES = 4;
const DEFAULT_RENDER_SCALE = 1400;
const OCR_TEMP_PREFIX = "cowork-pdf-ocr-";

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function groupTextLines(items: Array<{ str: string; x: number; y: number }>): string {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<{ text: string; y: number }> = [];
  const lineTolerance = 8;

  for (const item of sorted) {
    const existing = lines[lines.length - 1];
    if (!existing || Math.abs(existing.y - item.y) > lineTolerance) {
      lines.push({ text: item.str, y: item.y });
    } else {
      existing.text = `${existing.text} ${item.str}`;
    }
  }

  return lines
    .map((line) => normalizeWhitespace(line.text))
    .filter(Boolean)
    .join("\n");
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, maxChars).trimEnd()}\n[... page text truncated to first ${maxChars} characters ...]`,
    truncated: true,
  };
}

async function loadPdfJs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function renderPdfPageForOcr(pdfPath: string, pageNumber: number, renderScale: number) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), OCR_TEMP_PREFIX));
  const outputPrefix = path.join(tempDir, `page-${pageNumber}`);
  try {
    await execFile(
      "pdftoppm",
      [
        "-f",
        String(pageNumber),
        "-singlefile",
        "-png",
        "-scale-to-x",
        String(renderScale),
        "-scale-to-y",
        "-1",
        pdfPath,
        outputPrefix,
      ],
      { timeout: 15_000 },
    );
    return `${outputPrefix}.png`;
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function runPdfPageOcr(imagePath: string): Promise<string | null> {
  const available = await isTesseractInstalled();
  if (!available) return null;

  try {
    const { stdout } = await execFile(
      "tesseract",
      [imagePath, "stdout", "-l", TESSERACT_LANGUAGE_DEFAULT],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    const cleaned = sanitizeOcrOutput(stdout || "");
    return cleaned || null;
  } catch {
    return null;
  }
}

async function extractPageText(page: Any): Promise<string> {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const textItems = textContent.items as ExtractedTextItem[];
  const lines = textItems
    .filter((item) => typeof item.str === "string" && String(item.str).trim().length > 0)
    .map((item) => {
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      return {
        str: String(item.str),
        x,
        y,
      };
    });
  return groupTextLines(lines);
}

function buildReviewBlock(pageIndex: number, text: string, usedOcr: boolean): string {
  const lines = [`[Page ${pageIndex + 1}]`];
  if (usedOcr) {
    lines.push("[OCR fallback used]");
  }
  lines.push(text || "[No extractable text found on this page.]");
  return lines.join("\n");
}

export async function extractPdfReviewData(
  pdfPath: string,
  options: PdfReviewOptions = {},
): Promise<PdfReviewData> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
  const maxCharsPerPage = Math.max(200, Math.floor(options.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE));
  const pageTextThreshold = Math.max(1, Math.floor(options.pageTextThreshold ?? DEFAULT_PAGE_TEXT_THRESHOLD));
  const maxOcrPages = Math.max(0, Math.floor(options.maxOcrPages ?? DEFAULT_MAX_OCR_PAGES));
  const renderScale = Math.max(800, Math.floor(options.renderScale ?? DEFAULT_RENDER_SCALE));
  const includeOcr = options.includeOcr !== false;

  const buffer = await fs.readFile(pdfPath);

  try {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({ data: buffer });
    const document = await loadingTask.promise;
    const totalPages = document.numPages;
    const pageLimit = Math.min(totalPages, maxPages);

    const pages: PdfReviewPageSummary[] = [];
    const reviewBlocks: string[] = [];
    let nativeTextPages = 0;
    let ocrPages = 0;
    let scannedPages = 0;
    let ocrAttempts = 0;

    try {
      for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
        const page = await document.getPage(pageIndex + 1);
        const nativeText = normalizeWhitespace(await extractPageText(page));
        const nativeWordCount = nativeText ? nativeText.split(/\s+/).filter(Boolean).length : 0;
        const shouldTryOcr =
          includeOcr &&
          ocrAttempts < maxOcrPages &&
          (nativeText.length < pageTextThreshold || nativeWordCount < pageTextThreshold);

        let pageText = nativeText;
        let usedOcr = false;

        if (pageText) {
          nativeTextPages += 1;
        }

        if (shouldTryOcr) {
          scannedPages += 1;
          const pageImagePath = await renderPdfPageForOcr(pdfPath, pageIndex + 1, renderScale);
          if (pageImagePath) {
            ocrAttempts += 1;
            const ocrText = await runPdfPageOcr(pageImagePath);
            if (ocrText) {
              pageText = ocrText;
              usedOcr = true;
              ocrPages += 1;
            }
            await fs.rm(path.dirname(pageImagePath), { recursive: true, force: true }).catch(() => {});
          }
        }

        const normalizedPageText = normalizeWhitespace(pageText || "");
        const effectiveText = normalizedPageText || "[No extractable text found on this page.]";
        const truncatedResult = truncateText(effectiveText, maxCharsPerPage);

        pages.push({
          pageIndex,
          text: truncatedResult.text,
          usedOcr,
          truncated: truncatedResult.truncated,
        });
        reviewBlocks.push(buildReviewBlock(pageIndex, truncatedResult.text, usedOcr));
      }
    } finally {
      if (typeof document.destroy === "function") {
        await document.destroy();
      }
      await loadingTask.destroy();
    }

    if (totalPages > pageLimit) {
      reviewBlocks.push(`[... ${totalPages - pageLimit} additional page(s) omitted from preview ...]`);
    }

    return {
      pageCount: totalPages,
      nativeTextPages,
      ocrPages,
      scannedPages,
      truncatedPages: totalPages > pageLimit,
      pages,
      fullText: reviewBlocks.join("\n\n"),
      content: reviewBlocks.join("\n\n"),
    };
  } catch {
    try {
      const legacy = await parsePdfBuffer(buffer);
      const fallbackText = normalizeWhitespace(legacy.text || "");
      const truncatedResult = truncateText(
        fallbackText || "[No extractable text found in PDF.]",
        maxCharsPerPage,
      );
      const pages: PdfReviewPageSummary[] = [
        {
          pageIndex: 0,
          text: truncatedResult.text,
          usedOcr: false,
          truncated: truncatedResult.truncated,
        },
      ];
      return {
        pageCount: legacy.numpages || 1,
        nativeTextPages: fallbackText ? 1 : 0,
        ocrPages: 0,
        scannedPages: 0,
        truncatedPages: Boolean(legacy.numpages && legacy.numpages > 1),
        pages,
        fullText: buildReviewBlock(0, truncatedResult.text, false),
        content: buildReviewBlock(0, truncatedResult.text, false),
      };
    } catch {
      const placeholder = "[No extractable text found in PDF.]";
      const truncatedResult = truncateText(placeholder, maxCharsPerPage);
      const pages: PdfReviewPageSummary[] = [
        {
          pageIndex: 0,
          text: truncatedResult.text,
          usedOcr: false,
          truncated: truncatedResult.truncated,
        },
      ];
      return {
        pageCount: 1,
        nativeTextPages: 0,
        ocrPages: 0,
        scannedPages: 0,
        truncatedPages: false,
        pages,
        fullText: buildReviewBlock(0, truncatedResult.text, false),
        content: buildReviewBlock(0, truncatedResult.text, false),
      };
    }
  }
}
