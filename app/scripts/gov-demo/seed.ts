// Step 1 of the government demo: accounts, the workspace, shared spaces and memberships, on a FRESH
// server. Passwords are random and written to app/.gov-demo-users.md (gitignored), never printed.
//   ONESPACE_URL=http://127.0.0.1:8091 bun scripts/gov-demo/seed.ts
// Then each domain script under scripts/gov-demo/spaces/ fills its space(s).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CREDS, URL_, rawCall } from "./lib.ts";
import { personas, spaces, WORKSPACE } from "./personas.ts";

const adminKey =
  process.env.ONEBASE_ADMIN_KEY ??
  (["onebase_gov_demo/admin.key"].map((p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "")).find(Boolean) ?? "");
if (!adminKey) throw new Error("admin key not found (ONEBASE_ADMIN_KEY or onebase_gov_demo/admin.key)");
if (existsSync(CREDS)) throw new Error(`${CREDS} exists: this workspace is already seeded`);

const pw = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
const people = personas.map((p) => ({ ...p, password: pw(), token: "", userId: "" }));

for (const u of people) {
  const res = await fetch(`${URL_}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "password", params: { flow: "signUp", email: u.email, password: u.password, name: u.name } }),
  });
  const body: any = await res.json();
  if (!body.token) throw new Error(`signUp ${u.email}: ${JSON.stringify(body)}`);
  u.token = body.token;
  u.userId = body.userId;
}
// Write credentials as soon as the accounts exist, so a later failure doesn't lose them.
writeFileSync(
  CREDS,
  `# حسابات العرض الحكومي (محلية فقط، لا تُرفع)\n\nالرابط: ${URL_}\n\n| الاسم | البريد | كلمة المرور | الصفة |\n|---|---|---|---|\n` +
    people.map((u) => `| ${u.name} | ${u.email} | \`${u.password}\` | ${u.title} |`).join("\n") +
    "\n",
  { mode: 0o600 },
);

const by = Object.fromEntries(people.map((u) => [u.key, u]));
const admin = by.admin!;
const boot = await fetch(`${URL_}/_admin/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminKey}` },
  body: JSON.stringify({ name: "admin:bootstrap", args: { email: admin.email, workspaceName: WORKSPACE } }),
});
const bootBody: any = await boot.json().catch(() => ({}));
if (!bootBody.ok || !bootBody.value?.ok) throw new Error("bootstrap: " + JSON.stringify(bootBody));

for (const u of people) {
  if (u.key === "admin") continue;
  await rawCall("mutation", "admin:activate", { userId: u.userId, employeeNo: u.employeeNo }, admin.token);
}
await rawCall("mutation", "admin:setIdentifiers", { userId: admin.userId, employeeNo: admin.employeeNo }, admin.token).catch(() => {});

for (const s of spaces) {
  const spaceId = await rawCall(
    "mutation",
    "admin:createSharedSpace",
    { name: s.name, managerId: by[s.manager]!.userId, ...(s.everyone ? { everyone: true } : {}), ...(s.sensitive ? { sensitive: true } : {}) },
    admin.token,
  );
  const mgr = by[s.manager]!;
  for (const [key, role] of s.members) await rawCall("mutation", "spaces:addMember", { spaceId, userId: by[key]!.userId, role }, mgr.token);
  console.log(`space ${s.name}: ${s.members.length + 1} people`);
}
console.log(`seeded ${people.length} accounts and ${spaces.length} spaces; credentials in ${CREDS}`);
