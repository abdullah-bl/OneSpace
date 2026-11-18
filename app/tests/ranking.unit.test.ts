// The pure ranking function and the table parsers, without a server.

import { describe, expect, test } from "bun:test";
import { canonicalJson, explainCriterion, rank, RankingInputError, scoreCriterion, sha256Hex, toNumber, type RankingSpec } from "../onebase/lib/ranking";
import { parseTable, readCsv } from "../onebase/lib/tabular";
import { makeXlsx } from "./sandbox";

export const SPEC: RankingSpec = {
  idField: "رقم الهوية",
  nameField: "الاسم",
  criteria: [
    { field: "المعدل", label: "المعدل التراكمي", weight: 60, direction: "desc", min: 0, max: 5 },
    { field: "الاختبار", label: "درجة الاختبار", weight: 30, direction: "desc", min: 0, max: 100 },
    { field: "الغياب", label: "أيام الغياب", weight: 10, direction: "asc", min: 0, max: 20 },
  ],
  tieBreak: [{ field: "الاختبار", direction: "desc" }],
};

const rows = () => [
  { "رقم الهوية": "103", الاسم: "سارة", المعدل: "4.5", الاختبار: "80", الغياب: "2" },
  { "رقم الهوية": "101", الاسم: "أحمد", المعدل: 4.5, الاختبار: 80, الغياب: 2 }, // identical to سارة → shared rank
  { "رقم الهوية": "102", الاسم: "خالد", المعدل: "٤٫٥", الاختبار: "٩٠", الغياب: "12" }, // Arabic digits
  { "رقم الهوية": "104", الاسم: "منى", المعدل: "5", الاختبار: null, الغياب: "0" }, // missing exam
  { "رقم الهوية": "105", الاسم: "ريم", المعدل: "6", الاختبار: "100", الغياب: "-3" }, // clamped
];

describe("ranking function", () => {
  test("numbers: plain, Arabic-Indic digits, separators; junk is missing", () => {
    expect(toNumber("٤٫٥")).toBe(4.5);
    expect(toNumber("1,234.5")).toBe(1234.5);
    expect(toNumber("85%")).toBe(85);
    expect(toNumber(" 7 ")).toBe(7);
    expect(toNumber("غائب")).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
  });

  test("per-criterion points follow the published formula", () => {
    const s = scoreCriterion(SPEC.criteria[0]!, "4.5");
    expect(s.points).toBe(54); // 60 × 4.5 / 5
    expect(explainCriterion(s)).toBe("المعدل التراكمي: 60 × (4.5 − 0) ÷ (5 − 0) = 54");
    const absent = scoreCriterion(SPEC.criteria[2]!, "5");
    expect(absent.points).toBe(7.5); // 10 × (20 − 5) / 20
    expect(scoreCriterion(SPEC.criteria[1]!, null)).toMatchObject({ points: 0, missing: true });
  });

  test("totals, tie-breaks, shared ranks, missing values and clamping", () => {
    const r = rank(SPEC, rows());
    const byKey = Object.fromEntries(r.map((x) => [x.key, x]));
    // ريم: 60×1 + 30×1 + 10×1 = 100 (6 → 5 and −3 → 0 clamped)
    expect(byKey["105"]).toMatchObject({ total: 100, rank: 1 });
    expect(byKey["105"]!.breakdown[0]!.clamped).toBe(true);
    // خالد: 54 + 27 + 4 = 85 ; سارة/أحمد: 54 + 24 + 9 = 87 ; منى: 60 + 0 + 10 = 70
    expect(byKey["101"]).toMatchObject({ total: 87, rank: 2 });
    expect(byKey["103"]).toMatchObject({ total: 87, rank: 2 });
    expect(byKey["102"]).toMatchObject({ total: 85, rank: 4 });
    expect(byKey["104"]).toMatchObject({ total: 70, rank: 5 });
    expect(byKey["104"]!.breakdown[1]!.missing).toBe(true);
    // display order inside a shared rank is by id (code points), never by locale
    expect(r.map((x) => x.key)).toEqual(["105", "101", "103", "102", "104"]);
  });

  test("tie-break decides between equal totals", () => {
    const spec: RankingSpec = { ...SPEC, criteria: [{ field: "x", label: "x", weight: 10, direction: "desc", min: 0, max: 10 }], tieBreak: [{ field: "t", direction: "asc" }] };
    const r = rank(spec, [
      { "رقم الهوية": "a", الاسم: "A", x: 5, t: 3 },
      { "رقم الهوية": "b", الاسم: "B", x: 5, t: 1 },
      { "رقم الهوية": "c", الاسم: "C", x: 5, t: null },
    ]);
    expect(r.map((x) => [x.key, x.rank])).toEqual([
      ["b", 1],
      ["a", 2],
      ["c", 3],
    ]);
  });

  test("identical input → identical output, independent of row order", () => {
    const a = rank(SPEC, rows());
    const b = rank(SPEC, rows().reverse());
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256Hex(canonicalJson(a))).toBe(sha256Hex(canonicalJson(rank(SPEC, rows()))));
  });

  test("bad input is refused, not guessed", () => {
    expect(() => rank(SPEC, [...rows(), { ...rows()[0]! }])).toThrow(RankingInputError); // duplicate id
    expect(() => rank(SPEC, [{ الاسم: "بلا هوية" }])).toThrow(RankingInputError);
    expect(() => rank({ ...SPEC, criteria: [{ ...SPEC.criteria[0]!, weight: 0 }] }, rows())).toThrow(RankingInputError);
    expect(() => rank({ ...SPEC, criteria: [{ ...SPEC.criteria[0]!, min: 5, max: 5 }] }, rows())).toThrow(RankingInputError);
  });

  test("canonical JSON sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: null, c: "x" }] })).toBe('{"a":[1,{"c":"x","d":null}],"b":1}');
  });
});

describe("table parsing", () => {
  test("CSV with BOM, quotes, CRLF and semicolons", () => {
    expect(readCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
    expect(readCsv("a;b\n1;2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    const t = parseTable(new TextEncoder().encode("id,name\n1,سارة\n\n2,\n"), "x.csv");
    expect(t.fields).toEqual(["id", "name"]);
    expect(t.rows).toEqual([
      { id: "1", name: "سارة" },
      { id: "2", name: null },
    ]);
  });

  test("XLSX first sheet with shared strings and numbers", () => {
    const bytes = makeXlsx([
      ["رقم الهوية", "الاسم", "المعدل"],
      ["101", "أحمد", 4.5],
      ["102", "خالد & <سارة>", null],
    ]);
    const t = parseTable(bytes, "students.xlsx");
    expect(t.fields).toEqual(["رقم الهوية", "الاسم", "المعدل"]);
    expect(t.rows).toEqual([
      { "رقم الهوية": "101", الاسم: "أحمد", المعدل: 4.5 },
      { "رقم الهوية": "102", الاسم: "خالد & <سارة>", المعدل: null },
    ]);
  });

  test("unsupported or broken files are refused", () => {
    expect(() => parseTable(new Uint8Array([1, 2, 3]), "x.pdf")).toThrow();
    expect(() => parseTable(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), "x.xlsx")).toThrow();
    expect(() => parseTable(new TextEncoder().encode("a,a\n1,2"), "x.csv")).toThrow();
  });
});
