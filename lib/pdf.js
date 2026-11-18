// PDFs: a phone or laptop splits a PDF into single pages before sending (see public/app.js),
// so each page goes through DeScribe like one photo. Here the Mac checks a page before it
// is paid for: a real PDF, one page, not locked with a password.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { ReadError } from './reader.js';

export const MAX_PDF_PAGE_BYTES = 20 * 1024 * 1024; // the AI takes 32 MB per request, and base64 adds a third

export async function checkPdfPage(data) {
  let pdf;
  try {
    pdf = await PDFDocument.load(data, { updateMetadata: false });
  } catch (error) {
    // pdf-lib's own error type doesn't survive its build (it arrives as a plain Error), so
    // the message is checked too.
    if (error instanceof EncryptedPDFError || /is encrypted/i.test(String(error?.message))) {
      throw new ReadError('This PDF is locked with a password. Save a copy without the password, then add that.', { status: 422 });
    }
    throw new ReadError("This PDF is damaged and can't be read.", { status: 422 });
  }
  // pdf-lib opens some broken files without complaint, then fails when asked about pages.
  let pages;
  try {
    pages = pdf.getPageCount();
  } catch {
    throw new ReadError("This PDF is damaged and can't be read.", { status: 422 });
  }
  if (pages === 0) throw new ReadError('This PDF has no pages.', { status: 422 });
  if (pages > 1) throw new ReadError('PDFs are sent one page at a time. Reload DeScribe and add the PDF again.', { status: 400 });
}

// The browser copy of pdf-lib, which splits PDFs on the phone or laptop.
const BROWSER_COPY = fileURLToPath(import.meta.resolve('pdf-lib/dist/pdf-lib.esm.min.js'));
let browserCopy = null;
export async function pdfLibForBrowser() {
  browserCopy ??= await readFile(BROWSER_COPY);
  return browserCopy;
}
