// Makes the first workspace admin. Run once, on the server:
//   bun scripts/bootstrap-admin.ts admin@example.org ["اسم مساحة العمل"] ["اسم المدير"]
// Sign-up is closed by default, so the account is made here when it doesn't exist, and a temporary
// password is printed once (the app asks for a new one at the first sign-in). With SSO only, no
// password: the admin signs in with the organization account of that email. An account that
// already exists (it signed up, or came through SSO) keeps its own sign-in.
// Talks to the running server's admin API with the admin key, which only the server operator has
// (ONEBASE_ADMIN_KEY, or <data>/admin.key). It calls the internal action passwords:bootstrap, which
// refuses once a workspace exists, so it can't be used to take over a running workspace.
//   ONESPACE_URL   server address (default http://127.0.0.1:8090)
//   ONESPACE_DATA  data dir to read admin.key from (default ./onebase_data)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [email, workspaceName, name] = process.argv.slice(2);
if (!email) {
  console.error("usage: bun scripts/bootstrap-admin.ts <email> [workspace name] [admin name]");
  process.exit(2);
}
const url = process.env.ONESPACE_URL ?? "http://127.0.0.1:8090";
const key = process.env.ONEBASE_ADMIN_KEY ?? readFileSync(join(process.env.ONESPACE_DATA ?? "./onebase_data", "admin.key"), "utf8").trim();
const res = await fetch(`${url}/_admin/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ name: "passwords:bootstrap", args: { email, ...(workspaceName ? { workspaceName } : {}), ...(name ? { name } : {}) } }),
});
const body: any = await res.json().catch(() => ({}));
if (!body.ok || !body.value?.ok) {
  console.error("bootstrap failed:", body.value?.error ?? body.error ?? res.status);
  process.exit(1);
}
const { password } = body.value.value as { userId: string; password: string | null };
console.log(`${email} is now the workspace admin.`);
if (password) console.log(`Temporary password (shown once; the app asks for a new one at sign-in): ${password}`);
else console.log("Sign in with the account's existing password, or with the organization's single sign-on.");
