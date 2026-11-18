// Starts the real sandbox-runner (../sandbox-runner) for app tests and points OneBase at it via
// SANDBOX_URL / SANDBOX_SECRET (the harness passes process.env to `onebase serve`).
// Sandbox tests are skipped automatically when Docker or the image is missing.

import { resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

const RUNNER = resolve(import.meta.dir, "../../sandbox-runner");
const IMAGE = process.env.SANDBOX_IMAGE ?? "onespace-sandbox:2";

export async function sandboxAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

export type Runner = { url: string; secret: string; stop: () => Promise<void> };

/** Starts sandbox-runner on a free port and exports SANDBOX_URL/SANDBOX_SECRET for servers started afterwards. */
export async function startRunner(): Promise<Runner> {
  const secret = "app-test-" + crypto.randomUUID();
  const port = 30000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: RUNNER,
    env: { ...process.env, SANDBOX_SECRET: secret, SANDBOX_PORT: String(port), SANDBOX_IMAGE: IMAGE, SANDBOX_MAX_CONCURRENCY: "4" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  process.env.SANDBOX_URL = url;
  process.env.SANDBOX_SECRET = secret;
  return {
    url,
    secret,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

// ---------- a minimal XLSX writer for test data (zip of XML, deflate) ----------

function crc32(data: Uint8Array) {
  return Bun.hash.crc32(data) >>> 0;
}

function zip(entries: { name: string; data: string }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data, "utf8");
    const comp = deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** First row = header. Strings go to sharedStrings, numbers inline. */
export function makeXlsx(rows: (string | number | null)[][]): Uint8Array {
  const shared: string[] = [];
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((c, ci) => {
          const ref = `${col(ci)}${ri + 1}`;
          if (c === null) return "";
          if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
          shared.push(c);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="الطلاب" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    { name: "xl/sharedStrings.xml", data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>` },
    { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` },
  ]);
}
