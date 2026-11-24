// Gives every government-demo persona the same password, for presenting. The app has no
// change-password screen (reset needs email), so this writes the new hash straight into the demo's
// data directory. Only the personas in personas.ts are touched. The password is never printed.
//   bun scripts/gov-demo/set-password.ts '<password>'            (data in onebase_gov_demo)
//   ONEBASE_DATA=/data bun scripts/gov-demo/set-password.ts '<password>'
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDS } from "./lib.ts";
import { personas } from "./personas.ts";

const password = process.argv[2] ?? "";
if (password.length < 8) throw new Error("usage: set-password.ts '<password of at least 8 characters>'");
const dir = process.env.ONEBASE_DATA ?? "onebase_gov_demo";
const file = join(dir, "db.sqlite");
if (!existsSync(file)) throw new Error(`no database at ${file}`);

const db = new Database(file);
db.exec("PRAGMA busy_timeout = 5000");
const hashes = await Promise.all(personas.map(() => Bun.password.hash(password)));
let changed = 0;
db.transaction(() => {
  personas.forEach((p, i) => {
    changed += db.run("UPDATE _auth_accounts SET secret = ? WHERE provider = 'password' AND account_id = ?", [hashes[i]!, p.email]).changes;
    db.run(`DELETE FROM _auth_attempts WHERE "key" = ? OR "key" LIKE ?`, [`password:${p.email}`, `password:${p.email}|%`]);
  });
})();
db.close();
console.log(`${changed} of ${personas.length} demo accounts updated in ${file}`);

// The credentials file the other demo scripts sign in with. The old one is kept beside the data.
if (existsSync(CREDS) && dir === "onebase_gov_demo") {
  copyFileSync(CREDS, join(dir, "gov-demo-users.before.md"));
  const emails = new Set<string>(personas.map((p) => p.email));
  const text = readFileSync(CREDS, "utf8").replace(/(\|\s*([\w.+-]+@[\w.-]+)\s*\|\s*`)[^`]+(`)/g, (all, a, email, c) => (emails.has(email) ? a + password + c : all));
  writeFileSync(CREDS, text, { mode: 0o600 });
  console.log(`credentials file updated: ${CREDS}`);
}
