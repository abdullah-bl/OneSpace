// Makes the first workspace admin. Run once, after that person has signed up in the app:
//   bun scripts/bootstrap-admin.ts admin@example.org ["اسم مساحة العمل"]
// Talks to the running server's admin API with the admin key, which only the server operator has
// (ONEBASE_ADMIN_KEY, or <data>/admin.key). It calls the internal mutation admin:bootstrap, which
// refuses once a workspace exists, so it can't be used to take over a running workspace.
//   ONESPACE_URL   server address (default http://127.0.0.1:8090)
//   ONESPACE_DATA  data dir to read admin.key from (default ./onebase_data)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [email, workspaceName] = process.argv.slice(2);
if (!email) {
  console.error("usage: bun scripts/bootstrap-admin.ts <email> [workspace name]");
  process.exit(2);
}
const url = process.env.ONESPACE_URL ?? "http://127.0.0.1:8090";
const key = process.env.ONEBASE_ADMIN_KEY ?? readFileSync(join(process.env.ONESPACE_DATA ?? "./onebase_data", "admin.key"), "utf8").trim();
const res = await fetch(`${url}/_admin/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ name: "admin:bootstrap", args: { email, ...(workspaceName ? { workspaceName } : {}) } }),
});
const body: any = await res.json().catch(() => ({}));
if (!body.ok || !body.value?.ok) {
  console.error("bootstrap failed:", body.value?.error ?? body.error ?? res.status);
  process.exit(1);
}
console.log(`${email} is now the workspace admin.`, body.value.value);
