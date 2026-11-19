// Reads a ready-made skill (Agent Skills format, as on skills.sh or GitHub): a SKILL.md alone, or a
// .zip of the skill's folder. SKILL.md's front matter gives the name and description, its body the
// instructions; references/ and other text files become reference files, scripts/*.py runnable
// scripts. Pure (no database): the caller saves the result after the person reviews it.
//
// Untrusted input: entry sizes and the total are capped before inflating (no zip bombs), paths are
// cleaned (no "..", no absolute paths), binaries are skipped, and nothing here runs or fetches.

import { inflateRawSync } from "node:zlib";

export type ImportedFile = { name: string; kind: "script" | "reference" | "example"; content: string };
export type ImportedSkill = {
  name: string;
  title: string;
  description: string;
  instructions: string;
  files: ImportedFile[];
  skipped: { path: string; reason: string }[];
};

export class SkillImportError extends Error {}

export const IMPORT_LIMITS = {
  zipBytes: 3 * 1024 * 1024,
  entryBytes: 512 * 1024,
  totalBytes: 4 * 1024 * 1024,
  files: 20,
  fileChars: 60_000,
  totalChars: 400_000,
  instructions: 16_000,
};

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html?|css|py|sh|bash|js|mjs|ts|sql|r|toml|ini|cfg)$/i;

/** «My_Skill Name» → «my-skill-name» (letters, digits, - and _; 2–40). */
export function skillName(raw: string, fallback = "مهارة-مستوردة") {
  const n = String(raw ?? "")
    .trim()
    .replace(/^\//, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 40);
  return n.length >= 2 ? n : fallback;
}

/** YAML front matter, the simple subset skills use: `key: value`, quoted values, and `>`/`|` blocks. */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      value = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[kv[1]!.toLowerCase()] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

/** The entries of a zip, each read only when asked and only up to the limits. */
export function readZip(bytes: Uint8Array): { path: string; size: number; read: () => Uint8Array }[] {
  if (bytes.length > IMPORT_LIMITS.zipBytes) throw new SkillImportError(`الملف أكبر من ${IMPORT_LIMITS.zipBytes / 1024 / 1024} م.ب`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SkillImportError("ملف zip غير صالح");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new SkillImportError("ملف zip غير صالح");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    out.push({
      path,
      size,
      read: () => {
        if (size > IMPORT_LIMITS.entryBytes) throw new SkillImportError(`${path}: أكبر من المسموح`);
        const lNameLen = view.getUint16(local + 26, true);
        const lExtraLen = view.getUint16(local + 28, true);
        const start = local + 30 + lNameLen + lExtraLen;
        const data = bytes.subarray(start, start + compSize);
        if (method === 0) return data;
        if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }));
        throw new SkillImportError(`${path}: ضغط غير مدعوم`);
      },
    });
  }
  return out;
}

/** A clean relative path inside the skill's folder, or null for anything outside it. */
function cleanPath(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === "..") || /^[A-Za-z]:$/.test(parts[0]!)) return null;
  return parts.join("/");
}

const decodeText = (bytes: Uint8Array) => {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.includes("\u0000") ? null : text.replace(/^﻿/, "");
};

/** SKILL.md text → name, title, description, instructions (the body; a long body also kept as a reference). */
function fromSkillMd(text: string, fallbackName: string) {
  const { meta, body } = frontMatter(text);
  const name = skillName(meta.name ?? fallbackName);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = (meta.title ?? heading ?? name).slice(0, 80);
  const description = (meta.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const full = body.trim();
  const long = full.length > IMPORT_LIMITS.instructions;
  const instructions = long
    ? `${description || title}\n\nالتعليمات الكاملة لهذه المهارة في الملف المرجعي SKILL.md (أطول من أن تُحفظ هنا): حمّله أولاً ثم اتبعه.`
    : full;
  if (!instructions) throw new SkillImportError("SKILL.md بلا تعليمات");
  return { name, title, description, instructions, longBody: long ? full : null };
}

/** A file of the package → its kind, or why it is skipped. */
function classify(path: string): ImportedFile["kind"] | string {
  const lower = path.toLowerCase();
  if (!TEXT_EXT.test(lower)) return "ليس ملفاً نصياً (صور وخطوط وملفات تنفيذية لا تُستورد)";
  if (/(^|\/)scripts?\//.test(lower) && lower.endsWith(".py")) return "script";
  if (/(^|\/)(examples?|templates?|assets)\//.test(lower) && /\.(md|html?)$/.test(lower)) return "example";
  return "reference";
}

export function parseSkillPackage(fileName: string, bytes: Uint8Array): ImportedSkill {
  const base = fileName.replace(/\.(zip|md|markdown)$/i, "");
  if (!/\.zip$/i.test(fileName)) {
    if (bytes.length > IMPORT_LIMITS.entryBytes) throw new SkillImportError("الملف أكبر من المسموح");
    const text = decodeText(bytes);
    if (text === null) throw new SkillImportError("ليس ملفاً نصياً");
    const s = fromSkillMd(text, base);
    return { ...s, files: s.longBody ? [{ name: "SKILL.md", kind: "reference", content: s.longBody.slice(0, IMPORT_LIMITS.fileChars) }] : [], skipped: [] };
  }

  const entries = readZip(bytes).filter((e) => !e.path.endsWith("/") && !/(^|\/)(__MACOSX|\.git|node_modules)\//.test(e.path) && !/(^|\/)\.DS_Store$/.test(e.path));
  const skillMd = entries.filter((e) => /(^|\/)SKILL\.md$/i.test(e.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  if (!skillMd) throw new SkillImportError("لا يوجد SKILL.md في الملف");
  const root = skillMd.path.slice(0, skillMd.path.length - "SKILL.md".length);
  const text = decodeText(skillMd.read());
  if (text === null) throw new SkillImportError("SKILL.md ليس نصاً");
  const s = fromSkillMd(text, root.split("/").filter(Boolean).pop() ?? base);

  const files: ImportedFile[] = s.longBody ? [{ name: "SKILL.md", kind: "reference", content: s.longBody.slice(0, IMPORT_LIMITS.fileChars) }] : [];
  const skipped: ImportedSkill["skipped"] = [];
  let totalBytes = 0;
  let totalChars = files.reduce((n, f) => n + f.content.length, 0);
  for (const e of entries) {
    if (e === skillMd) continue;
    if (!e.path.startsWith(root)) {
      skipped.push({ path: e.path, reason: "خارج مجلد المهارة" });
      continue;
    }
    const path = cleanPath(e.path.slice(root.length));
    if (!path) {
      skipped.push({ path: e.path, reason: "مسار غير صالح" });
      continue;
    }
    const kind = classify(path);
    if (kind !== "script" && kind !== "reference" && kind !== "example") {
      skipped.push({ path, reason: kind });
      continue;
    }
    if (files.length >= IMPORT_LIMITS.files) {
      skipped.push({ path, reason: `الحد ${IMPORT_LIMITS.files} ملفاً` });
      continue;
    }
    if (e.size > IMPORT_LIMITS.entryBytes || totalBytes + e.size > IMPORT_LIMITS.totalBytes) {
      skipped.push({ path, reason: "أكبر من المسموح" });
      continue;
    }
    totalBytes += e.size;
    const content = decodeText(e.read());
    if (content === null) {
      skipped.push({ path, reason: "ليس نصاً" });
      continue;
    }
    if (content.length > IMPORT_LIMITS.fileChars || totalChars + content.length > IMPORT_LIMITS.totalChars) {
      skipped.push({ path, reason: "أطول من المسموح" });
      continue;
    }
    totalChars += content.length;
    files.push({ name: path, kind, content });
  }
  return { name: s.name, title: s.title, description: s.description, instructions: s.instructions, files, skipped };
}
