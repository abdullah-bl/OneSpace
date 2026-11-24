// Checks a model's tool arguments against the tool's JSON Schema before anything runs, and turns
// what is wrong into a message the model can fix in the same answer (bench/realtools: small models
// rarely break the schema, but when they do the tool failed later with a vague error).
//
// Lenient where a small model slips and the meaning is clear: a number for a string, "5" for a
// number, "true" for a boolean, one value where a list is expected, a list or object sent as a JSON
// string. Strict on what changes meaning: missing required fields, wrong types, values outside an
// enum, too few or too many items. Unknown extra fields are left alone (tools ignore them), and
// lengths and numeric ranges stay with each tool, which clamps or explains them itself.

import type { AppTool } from "./types";

type Schema = Record<string, any>;
export type ArgCheck = { args: any; problems: string[] };

function typesOf(s: Schema): string[] {
  return s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
}

function isType(v: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return true;
  }
}

/** The value converted to one of `types`, when the conversion can't change what was meant. */
function coerce(v: unknown, types: string[]): unknown {
  for (const t of types) {
    if (typeof v === "number" && t === "string") return String(v);
    if (typeof v === "string") {
      const s = v.trim();
      if ((t === "number" || t === "integer") && /^-?\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        if (isType(n, t)) return n;
      }
      if (t === "boolean" && (s === "true" || s === "false")) return s === "true";
      if ((t === "array" && s.startsWith("[")) || (t === "object" && s.startsWith("{"))) {
        try {
          const parsed = JSON.parse(s);
          if (isType(parsed, t)) return parsed;
        } catch {}
      }
    }
  }
  // One value where a list is expected: a list of that one value.
  if (types.includes("array") && v !== null && v !== undefined && !Array.isArray(v)) return [v];
  return v;
}

const TYPE_AR: Record<string, string> = { string: "نصاً", number: "رقماً", integer: "عدداً صحيحاً", boolean: "true/false", array: "قائمة", object: "كائناً", null: "null" };

function walk(v: unknown, s: Schema, path: string, problems: string[]): unknown {
  if (!s || typeof s !== "object") return v;
  const types = typesOf(s);
  if (types.length && !types.some((t) => isType(v, t))) {
    const c = coerce(v, types);
    if (types.some((t) => isType(c, t))) v = c;
    else {
      problems.push(`${path} يجب أن يكون ${types.map((t) => TYPE_AR[t] ?? t).join(" أو ")}`);
      return v;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    problems.push(`${path} من هذه القيم فقط: ${s.enum.map((x: unknown) => JSON.stringify(x)).join("، ")}`);
    return v;
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) problems.push(`${path} يحتاج ${s.minItems} عنصراً على الأقل`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems) problems.push(`${path} أكثر من ${s.maxItems} عنصراً`);
    if (s.items) return v.map((x, i) => walk(x, s.items, `${path}[${i}]`, problems));
    return v;
  }
  if (isType(v, "object")) {
    const o = { ...(v as Record<string, unknown>) };
    const props: Record<string, Schema> = s.properties ?? {};
    for (const k of s.required ?? []) {
      if (o[k] === undefined || o[k] === null) problems.push(`الحقل المطلوب ${path === "" ? k : `${path}.${k}`} ناقص`);
    }
    for (const [k, x] of Object.entries(o)) {
      const name = path === "" ? k : `${path}.${k}`;
      // A null for an optional field means "not given" (several models send it).
      if (x === null && props[k] && !typesOf(props[k]).includes("null") && !(s.required ?? []).includes(k)) {
        delete o[k];
        continue;
      }
      if (props[k]) o[k] = walk(x, props[k], name, problems);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") o[k] = walk(x, s.additionalProperties, name, problems);
    }
    return o;
  }
  return v;
}

/** The arguments to run the tool with (lightly repaired), and what is wrong with them. */
export function checkToolArgs(tool: AppTool, args: unknown): ArgCheck {
  if (args && typeof args === "object" && "__invalid" in (args as object)) {
    return { args, problems: ["الوسائط ليست JSON صالحاً (تأكد من إغلاق النصوص والأقواس، ومن تهريب علامات التنصيص داخل النص)"] };
  }
  const problems: string[] = [];
  const repaired = walk(args ?? {}, tool.parameters as Schema, "", problems);
  if (!problems.length && tool.checkArgs) {
    const extra = tool.checkArgs(repaired);
    if (extra) problems.push(extra);
  }
  return { args: repaired, problems };
}

/** What the model is told when its call was turned back: what to fix, and to call again now. */
export function argProblemText(tool: AppTool, problems: string[]): string {
  const required: string[] = ((tool.parameters as Schema).required ?? []) as string[];
  return (
    `لم تُنفَّذ ${tool.name}: ${problems.slice(0, 6).join("؛ ")}.` +
    (required.length ? ` الحقول المطلوبة: ${required.join("، ")}.` : "") +
    " صحّح الوسائط وأعد استدعاء الأداة في هذه الإجابة، ولا تقل للموظف إنها نُفّذت."
  );
}

// ---------------------------------------------------------------- ids

const ID_IN_TEXT = /(?<![a-z0-9])[a-z0-9]{20}(?![a-z0-9])/g;
const ID_LIKE = /^(?=.*[a-z])(?=.*\d)[a-z0-9]{16,28}$/;

/** The record ids (20 lowercase letters and digits) that appear in these texts: what the model was shown. */
export function idsIn(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(ID_IN_TEXT)) if (/[a-z]/.test(m[0]) && /\d/.test(m[0])) out.add(m[0]);
  return out;
}

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * An id the model copied with a slip (a repeated or dropped run of characters: seen in
 * bench/realtools) is put back to the one id it was shown that is within 4 edits of it, when exactly
 * one is. Ids it was shown, and anything not id-shaped, are left alone. It never reaches further than
 * the ids in this conversation, and every tool still checks access for the user.
 */
export function repairIds(args: unknown, known: Set<string>): { args: unknown; fixed: string[] } {
  const fixed: string[] = [];
  const fix = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (!ID_LIKE.test(v) || known.has(v)) return v;
      let hit: string | null = null;
      let best = 5;
      let tie = false;
      for (const k of known) {
        const d = distance(v, k, 4);
        if (d < best) [hit, best, tie] = [k, d, false];
        else if (d === best) tie = true;
      }
      if (!hit || tie) return v;
      fixed.push(`${v}→${hit}`);
      return hit;
    }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  return { args: fix(args), fixed };
}
