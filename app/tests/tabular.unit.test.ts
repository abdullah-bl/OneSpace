// The table parsers (CSV/XLSX → rows), without a server.

import { describe, expect, test } from "bun:test";
import { parseTable, readCsv } from "../onebase/lib/tabular";
import { makeXlsx } from "./sandbox";

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
