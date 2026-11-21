// A PDF page as a PNG, with poppler's pdftoppm (already a server dependency for OCR,
// lib/extract.ts). Used to show a certificate's design and its real preview in the template
// editor; never used for the issued document itself, which stays the deterministic PDF.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function pdfPageToPng(pdf: Uint8Array, dpi = 96): Promise<Uint8Array | null> {
  const dir = mkdtempSync(join(tmpdir(), "onespace-tpl-"));
  try {
    const src = join(dir, "in.pdf");
    writeFileSync(src, pdf);
    const proc = Bun.spawn(["pdftoppm", "-r", String(dpi), "-png", "-f", "1", "-l", "1", "-singlefile", src, join(dir, "p")], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 30_000);
    const code = await proc.exited;
    clearTimeout(timer);
    const png = readdirSync(dir).find((f) => f.endsWith(".png"));
    if (code !== 0 || !png) return null;
    return new Uint8Array(readFileSync(join(dir, png)));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
