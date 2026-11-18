// Backup/restore drill: builds a workspace on a fresh server, takes an (encrypted) backup with
// `onebase backup`, restores it with `onebase restore` into a CLEAN data dir, starts a second
// server on the restored dir, and checks that accounts, spaces, files (bytes + versions),
// permissions and the audit log all came back.
//   bun scripts/backup-restore-test.ts                      (starts the local SeaweedFS S3)
//   ONESPACE_BACKUP=s3://... bun scripts/backup-restore-test.ts

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Server, must } from "../tests/harness";

const APP = resolve(import.meta.dir, "..");
const ONEBASE = join(APP, "node_modules/.bin/onebase");
const secret = process.env.ONEBASE_SECRET_KEY ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
process.env.ONEBASE_SECRET_KEY = secret;

let base = process.env.ONESPACE_BACKUP;
if (!base) {
  const out = Bun.spawnSync(["bash", join(APP, "scripts/local-s3.sh")], { stderr: "inherit" });
  if (out.exitCode !== 0) throw new Error("could not start the local S3 (scripts/local-s3.sh)");
  base = out.stdout.toString().trim().split("\n").pop()!;
}
// a unique prefix per run, so the drill never restores an older run's snapshot
const backupUrl = base.replace(/^(s3:\/\/[^/?]+\/[^?]*)/, (m) => `${m.replace(/\/$/, "")}/drill-${Date.now()}`);

function cli(args: string[]) {
  const r = Bun.spawnSync([ONEBASE, ...args], { cwd: APP, env: process.env, stdout: "pipe", stderr: "pipe" });
  const text = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`onebase ${args[0]} failed:\n${text}`);
  return text.trim();
}

function check(cond: unknown, what: string) {
  if (!cond) throw new Error("FAILED: " + what);
  console.log("  ok  " + what);
}

const PW = "password-123";
const a = new Server();
await a.start();
let b: Server | null = null;
const cleanDir = mkdtempSync(join(tmpdir(), "onespace-restore-"));
rmSync(cleanDir, { recursive: true }); // restore into a directory that doesn't exist yet
try {
  console.log("1. build data on server A:", a.dataDir);
  const admin = await a.auth("signUp", "admin@drill.test", PW, "المدير");
  const emp = await a.auth("signUp", "emp@drill.test", PW, "موظف");
  const outsider = await a.auth("signUp", "out@drill.test", PW, "خارجي");
  must(await a.adminRun("admin:bootstrap", { email: "admin@drill.test" }));
  for (const u of [emp, outsider]) must(await a.call("mutation", "admin:activate", { userId: u.userId }, admin.token));
  const spaceId = must(await a.call("mutation", "admin:createSharedSpace", { name: "لجنة-الاستعادة", managerId: emp.userId, sensitive: true }, admin.token));
  const s1 = await a.upload(emp.token, "نسخة أولى");
  const fileId = must(await a.call("mutation", "files:create", { storageId: s1, name: "محضر.txt", spaceId }, emp.token));
  const s2 = await a.upload(emp.token, "نسخة ثانية");
  must(await a.call("mutation", "files:uploadVersion", { fileId, storageId: s2 }, emp.token));
  const ps = await a.upload(emp.token, "خاص بالموظف");
  const personalFile = must(await a.call("mutation", "files:create", { storageId: ps, name: "خاص.txt" }, emp.token));
  await a.get(`/download?fileId=${fileId}`, emp.token); // one audited sensitive download
  const auditBefore = must(await a.call("query", "audit:list", {}, admin.token)).length;

  console.log("2. backup (encrypted) to", backupUrl.replace(/secretAccessKey=[^&]*/, "secretAccessKey=***"));
  console.log("   " + cli(["backup", "--data", a.dataDir, "--backup", backupUrl]));
  console.log("   " + cli(["backups", "--backup", backupUrl]).split("\n").join("\n   "));
  await a.stop(false);

  console.log("3. restore into a clean dir:", cleanDir);
  console.log("   " + cli(["restore", "--backup", backupUrl, "--data", cleanDir]));
  check(existsSync(join(cleanDir, "db.sqlite")), "db.sqlite restored");

  console.log("4. start server B on the restored dir and verify");
  b = new Server(cleanDir);
  await b.start();
  const admin2 = await b.auth("signIn", "admin@drill.test", PW);
  const emp2 = await b.auth("signIn", "emp@drill.test", PW);
  const out2 = await b.auth("signIn", "out@drill.test", PW);
  check(must(await b.call("query", "account:me", {}, admin2.token)).workspaceRole === "admin", "admin account and workspace role restored (password sign-in works)");
  const files = must(await b.call("query", "files:list", { spaceId }, emp2.token));
  check(files.length === 1 && files[0].name === "محضر.txt" && files[0].version === 2, "shared space and file metadata restored");
  check((await b.get(`/download?fileId=${fileId}`, emp2.token)).text === "نسخة ثانية", "current version bytes restored");
  check((await b.get(`/download?fileId=${fileId}&v=1`, emp2.token)).text === "نسخة أولى", "older version bytes restored");
  check((await b.get(`/download?fileId=${personalFile}`, emp2.token)).text === "خاص بالموظف", "personal file restored");
  check((await b.get(`/download?fileId=${personalFile}`, out2.token)).status === 404, "permissions still enforced after restore (outsider denied)");
  check((await b.call("query", "files:list", { spaceId }, admin2.token)).ok === false, "admin still can't read a shared space they're not in");
  check(must(await b.call("query", "audit:list", {}, admin2.token)).length >= auditBefore, "audit log restored");
  console.log("\nBACKUP/RESTORE DRILL PASSED");
} finally {
  await a.stop();
  await b?.stop();
}
