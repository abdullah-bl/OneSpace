// Which sandbox /output files also become a Phase 4 artifact (side panel), and its content.
// Pure code, no model. Every output stays a regular file in the target space; this only adds a
// viewable artifact for the kinds the panel can show:
//   .csv / .xlsx          → table   (first sheet, header row = columns)
//   .md                   → markdown
//   .html / .htm          → html    (shown only in the sandboxed iframe, src/sandbox.ts)
//   .txt                  → markdown (in a code block)
//   .png .jpg .jpeg .gif .webp .svg → markdown with the image inline as a data: URI (the panel's
//                                     CSP allows only data: images), up to MAX_IMAGE_BYTES
// Anything else (pdf, json, …), or a file too large/invalid for an artifact, stays a file only.

import { parseTable } from "./tabular";

export type OutputArtifact = { kind: "markdown" | "html" | "table"; content: string };

export const MAX_IMAGE_BYTES = 300 * 1024; // base64 grows ×4/3; artifacts hold ≤ 512 KB of text
const MAX_TEXT_BYTES = 500 * 1024;

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

function ext(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Markdown-safe text for an image alt / heading. */
function plain(name: string) {
  return name.replace(/[\[\]()<>`*_#\\|]/g, " ").trim() || "output";
}

export function artifactForOutput(name: string, bytes: Uint8Array): OutputArtifact | null {
  const e = ext(name);
  try {
    if (e === "csv" || e === "xlsx") {
      const t = parseTable(bytes, name);
      return { kind: "table", content: JSON.stringify({ columns: t.fields, rows: t.rows.map((r) => t.fields.map((f) => r[f] ?? null)) }) };
    }
    if (e === "md" || e === "html" || e === "htm" || e === "txt") {
      if (bytes.length > MAX_TEXT_BYTES) return null;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (e === "md") return { kind: "markdown", content: text };
      if (e === "txt") {
        const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
        return { kind: "markdown", content: `${fence}\n${text}\n${fence}\n` };
      }
      return { kind: "html", content: text };
    }
    const mime = IMAGE_MIME[e];
    if (mime) {
      if (bytes.length > MAX_IMAGE_BYTES) return null;
      return { kind: "markdown", content: `![${plain(name)}](data:${mime};base64,${Buffer.from(bytes).toString("base64")})\n` };
    }
  } catch {
    return null; // not a valid table / not UTF-8: the file is still saved
  }
  return null;
}
