// The ranking calculation: a pure, deterministic function of (criteria, rows). No I/O, no clock,
// no randomness, no locale-dependent comparison, a fixed order of floating-point operations and
// fixed rounding, so the same snapshot + the same criteria version always give the same numbers,
// bit for bit. The model never ranks and never suggests weights: it only explains these results.
//
// Formula, per criterion c with weight w, scale [min, max] and direction:
//   higher is better ("desc"):  points = w × (clamp(v) − min) ÷ (max − min)
//   lower is better  ("asc"):   points = w × (max − clamp(v)) ÷ (max − min)
//   missing or non-numeric value → 0 points (flagged)
// total = Σ points (criteria order). Sort: total desc, then each tie-break field, then id (code
// points) for a stable display order. Rows equal on total and every tie-break share a rank (1,2,2,4).

export const RANKING_ALGORITHM = "onespace-ranking/1";

export type Direction = "desc" | "asc";
export type Criterion = { field: string; label: string; weight: number; direction: Direction; min: number; max: number };
export type TieBreak = { field: string; direction: Direction };
export type RankingSpec = { idField: string; nameField: string; criteria: Criterion[]; tieBreak: TieBreak[] };
export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export type CriterionScore = {
  field: string;
  label: string;
  weight: number;
  direction: Direction;
  min: number;
  max: number;
  /** The value read from the snapshot (as stored there). */
  raw: Cell;
  /** The number used after parsing and clamping to [min, max]; null when missing. */
  value: number | null;
  normalized: number;
  points: number;
  missing: boolean;
  clamped: boolean;
};

export type RankedResult = {
  key: string;
  name: string;
  rank: number;
  total: number;
  breakdown: CriterionScore[];
  tieBreak: { field: string; direction: Direction; value: number | null }[];
};

export class RankingInputError extends Error {}

const ROUND = 1e6;
export const round6 = (x: number) => Math.round(x * ROUND) / ROUND;

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** A cell as a number: plain numbers, numeric strings (Arabic-Indic digits, Arabic decimal/thousands separators, %). Else null. */
export function toNumber(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  const s = String(cell)
    .trim()
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/٫/g, ".")
    .replace(/[٬,\s]/g, "")
    .replace(/%$/, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function validateSpec(spec: RankingSpec): string[] {
  const errors: string[] = [];
  if (!spec.idField?.trim()) errors.push("حقل المعرّف مطلوب");
  if (!spec.nameField?.trim()) errors.push("حقل الاسم مطلوب");
  if (!spec.criteria?.length) errors.push("أضف معياراً واحداً على الأقل");
  const seen = new Set<string>();
  for (const c of spec.criteria ?? []) {
    if (!c.field?.trim()) errors.push("لكل معيار حقل");
    if (seen.has(c.field)) errors.push(`المعيار ${c.field} مكرر`);
    seen.add(c.field);
    if (!(Number.isFinite(c.weight) && c.weight > 0)) errors.push(`وزن ${c.label || c.field} يجب أن يكون أكبر من صفر`);
    if (!(Number.isFinite(c.min) && Number.isFinite(c.max) && c.max > c.min)) errors.push(`مدى ${c.label || c.field}: الحد الأعلى يجب أن يكون أكبر من الأدنى`);
    if (c.direction !== "asc" && c.direction !== "desc") errors.push(`اتجاه ${c.label || c.field} غير معروف`);
  }
  for (const t of spec.tieBreak ?? []) {
    if (!t.field?.trim()) errors.push("لكل قاعدة كسر تعادل حقل");
    if (t.direction !== "asc" && t.direction !== "desc") errors.push(`اتجاه كسر التعادل ${t.field} غير معروف`);
  }
  return errors;
}

export function scoreCriterion(c: Criterion, raw: Cell | undefined): CriterionScore {
  const parsed = toNumber(raw);
  const base = { field: c.field, label: c.label, weight: c.weight, direction: c.direction, min: c.min, max: c.max, raw: raw ?? null };
  if (parsed === null) return { ...base, value: null, normalized: 0, points: 0, missing: true, clamped: false };
  const value = Math.min(Math.max(parsed, c.min), c.max);
  const span = c.max - c.min;
  const normalized = round6(c.direction === "desc" ? (value - c.min) / span : (c.max - value) / span);
  const points = round6(c.weight * normalized);
  return { ...base, value, normalized, points, missing: false, clamped: value !== parsed };
}

/** Human-readable formula line for one criterion, e.g. "30 × (85 − 0) ÷ (100 − 0) = 25.5". */
export function explainCriterion(s: CriterionScore): string {
  if (s.missing) return `${s.label}: لا توجد قيمة رقمية → 0 نقطة`;
  const term = s.direction === "desc" ? `(${s.value} − ${s.min})` : `(${s.max} − ${s.value})`;
  return `${s.label}: ${s.weight} × ${term} ÷ (${s.max} − ${s.min}) = ${s.points}`;
}

export const FORMULA_TEXT =
  "النقاط لكل معيار = الوزن × (القيمة − الحد الأدنى) ÷ (الحد الأعلى − الحد الأدنى) إذا كان الأعلى أفضل، " +
  "أو الوزن × (الحد الأعلى − القيمة) ÷ (الحد الأعلى − الحد الأدنى) إذا كان الأقل أفضل. " +
  "القيمة تُحصر بين الحدين، والقيمة المفقودة = 0 نقطة. المجموع = مجموع نقاط المعايير، " +
  "ثم يُكسر التعادل بالحقول المعتمدة بالترتيب، ومن تساوى في كل ذلك يتشارك الترتيب.";

function cmpNum(a: number | null, b: number | null, dir: Direction): number {
  if (a === b) return 0;
  if (a === null) return 1; // missing values go last whatever the direction
  if (b === null) return -1;
  return dir === "desc" ? b - a : a - b;
}

/** Code-point order, independent of locale. */
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function rank(spec: RankingSpec, rows: Row[]): RankedResult[] {
  const errors = validateSpec(spec);
  if (errors.length) throw new RankingInputError(errors.join("؛ "));
  const keys = new Set<string>();
  const scored = rows.map((row, i) => {
    const rawKey = row[spec.idField];
    const key = rawKey === null || rawKey === undefined ? "" : String(rawKey).trim();
    if (!key) throw new RankingInputError(`الصف ${i + 1}: لا يوجد معرّف في الحقل ${spec.idField}`);
    if (keys.has(key)) throw new RankingInputError(`المعرّف ${key} مكرر`);
    keys.add(key);
    const breakdown = spec.criteria.map((c) => scoreCriterion(c, row[c.field]));
    let total = 0;
    for (const s of breakdown) total = total + s.points;
    const tieBreak = spec.tieBreak.map((t) => ({ field: t.field, direction: t.direction, value: toNumber(row[t.field]) }));
    const nameCell = row[spec.nameField];
    return { key, name: nameCell === null || nameCell === undefined ? "" : String(nameCell), total: round6(total), breakdown, tieBreak, rank: 0 };
  });
  const cmpRank = (a: (typeof scored)[number], b: (typeof scored)[number]) => {
    if (a.total !== b.total) return b.total - a.total;
    for (let i = 0; i < a.tieBreak.length; i++) {
      const c = cmpNum(a.tieBreak[i]!.value, b.tieBreak[i]!.value, a.tieBreak[i]!.direction);
      if (c !== 0) return c;
    }
    return 0;
  };
  scored.sort((a, b) => cmpRank(a, b) || cmpStr(a.key, b.key));
  for (let i = 0; i < scored.length; i++) {
    scored[i]!.rank = i > 0 && cmpRank(scored[i - 1]!, scored[i]!) === 0 ? scored[i - 1]!.rank : i + 1;
  }
  return scored;
}

/** JSON with object keys sorted, so equal data always serializes (and hashes) the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as object)
    .filter((k) => (value as any)[k] !== undefined)
    .sort(cmpStr);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(",")}}`;
}

export function sha256Hex(text: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** The parts of a criteria version that change results; its hash is stored with every run. */
export function specOf(c: RankingSpec): RankingSpec {
  return {
    idField: c.idField,
    nameField: c.nameField,
    criteria: c.criteria.map((x) => ({ field: x.field, label: x.label, weight: x.weight, direction: x.direction, min: x.min, max: x.max })),
    tieBreak: c.tieBreak.map((t) => ({ field: t.field, direction: t.direction })),
  };
}
