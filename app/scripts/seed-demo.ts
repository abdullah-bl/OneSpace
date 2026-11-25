// Demo data for trying OneSpace locally: three accounts, a shared department space and an
// "everyone" policies space. Passwords are random and written to app/.demo-users.md (gitignored),
// never printed. Run against a fresh server: ONESPACE_URL defaults to http://127.0.0.1:8090.
// The accounts sign up, so start that server with SELF_SIGNUP=on (sign-up is closed by default).
//   bun scripts/seed-demo.ts

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.ONESPACE_URL ?? "http://127.0.0.1:8090";
const adminKey =
  process.env.ONEBASE_ADMIN_KEY ?? (existsSync("onebase_data/admin.key") ? readFileSync("onebase_data/admin.key", "utf8").trim() : "");
if (!adminKey) throw new Error("admin key not found (ONEBASE_ADMIN_KEY or onebase_data/admin.key)");

const pw = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
const users = [
  { key: "admin", email: "admin@onespace.test", name: "مدير مساحة العمل", role: "مدير مساحة العمل + مدير مساحة الشؤون الإدارية" },
  { key: "manager", email: "manager@onespace.test", name: "سارة المشرفة", role: "مديرة مساحة السياسات، وعضو في الشؤون الإدارية" },
  { key: "employee", email: "employee@onespace.test", name: "خالد الموظف", role: "موظف: عضو في الشؤون الإدارية، وقارئ للسياسات" },
].map((u) => ({ ...u, password: pw(), token: "", userId: "" }));

async function call(kind: string, path: string, args: any, token?: string) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body: any = await res.json();
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage ?? body.error ?? res.status}`);
  return body.value;
}

async function signUp(u: (typeof users)[number]) {
  const res = await fetch(`${url}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "password", params: { flow: "signUp", email: u.email, password: u.password, name: u.name } }),
  });
  const body: any = await res.json();
  if (!body.token) throw new Error(`signUp ${u.email}: ${JSON.stringify(body)}${res.status === 403 ? " (start the server with SELF_SIGNUP=on)" : ""}`);
  u.token = body.token;
  u.userId = body.userId;
}

for (const u of users) await signUp(u);
const [admin, manager, employee] = users;

const boot = await Bun.$`bun scripts/bootstrap-admin.ts ${admin.email} ${"الإدارة التجريبية"}`
  .env({ ...process.env, ONESPACE_URL: url, ONEBASE_ADMIN_KEY: adminKey })
  .nothrow()
  .quiet();
if (boot.exitCode !== 0) throw new Error("bootstrap failed: " + boot.stderr.toString());

await call("mutation", "admin:activate", { userId: manager.userId, employeeNo: "1002" }, admin.token);
await call("mutation", "admin:activate", { userId: employee.userId, employeeNo: "1003" }, admin.token);

const dept = await call("mutation", "admin:createSharedSpace", { name: "الشؤون الإدارية", managerId: admin.userId }, admin.token);
const policies = await call(
  "mutation",
  "admin:createSharedSpace",
  { name: "السياسات والتعليمات", managerId: manager.userId, everyone: true },
  admin.token,
);
const id = (x: any) => (typeof x === "string" ? x : x?.spaceId ?? x?._id);
await call("mutation", "spaces:addMember", { spaceId: id(dept), userId: manager.userId, role: "member" }, admin.token);
await call("mutation", "spaces:addMember", { spaceId: id(dept), userId: employee.userId, role: "member" }, admin.token);

const out = join(import.meta.dir, "..", ".demo-users.md");
writeFileSync(
  out,
  `# حسابات تجريبية (محلية فقط، لا تُرفع)\n\nالرابط: ${url}\n\n| الحساب | البريد | كلمة المرور | الدور |\n|---|---|---|---|\n` +
    users.map((u) => `| ${u.name} | ${u.email} | \`${u.password}\` | ${u.role} |`).join("\n") +
    "\n",
  { mode: 0o600 },
);
console.log(`seeded ${users.length} users and 2 shared spaces; credentials in ${out}`);
