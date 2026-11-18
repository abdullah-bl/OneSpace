// Local demo for the Phase 6 UI without GPUs: the fake model server (tests/fake-ai.ts), a fresh
// onebase server serving dist/, an admin (admin@onespace.test / password-123), a member, an
// "everyone" space with a policy, and a task. `bun run build && bun scripts/demo-phase6.ts`.

import { Server, must } from "../tests/harness";
import { aiEnv, startFakeAI } from "../tests/fake-ai";
import { addBytes, waitIngest } from "../tests/rag-helpers";

const ai = startFakeAI();
const port = Number(process.env.PORT ?? 8097);
const s = new Server(undefined, aiEnv(ai));
// Serve the built UI too.
const origStart = s.start.bind(s);
await origStart(port);
s.proc.kill();
await s.proc.exited;
s.proc = Bun.spawn(
  ["node_modules/.bin/onebase", "serve", "--port", String(port), "--host", "127.0.0.1", "--data", s.dataDir, "--dir", "onebase", "--url", s.url, "--public", "dist"],
  { cwd: `${import.meta.dir}/..`, env: { ...process.env, ...aiEnv(ai), ONEBASE_ADMIN_KEY: s.adminKey }, stdout: "inherit", stderr: "inherit" },
);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${s.url}/api/health`)).ok) break;
  } catch {}
  await Bun.sleep(100);
}
const PW = "password-123";
const admin = await s.auth("signUp", "admin@onespace.test", PW, "المدير");
must(await s.adminRun("admin:bootstrap", { email: "admin@onespace.test" }));
const mem = await s.auth("signUp", "mem@onespace.test", PW, "موظف");
must(await s.call("mutation", "admin:activate", { userId: mem.userId }, admin.token));
const policies = must(await s.call("mutation", "admin:createSharedSpace", { name: "السياسات", managerId: admin.userId, everyone: true }, admin.token));
const work = must(await s.call("mutation", "admin:createSharedSpace", { name: "لجنة المشتريات", managerId: admin.userId }, admin.token));
must(await s.call("mutation", "spaces:addMember", { spaceId: work, userId: mem.userId, role: "member" }, admin.token));
const f = await addBytes(s, admin.token, policies, "سياسة-العمل-عن-بعد.txt", "سياسة العمل عن بعد: يجوز العمل عن بعد يومين في الأسبوع بموافقة المدير المباشر.", "text/plain");
await waitIngest(s, admin.token, policies, f);
must(await s.call("mutation", "tasks:create", { spaceId: work, title: "ملخص عروض الأسعار", assigneeId: mem.userId }, admin.token));
const writer = must(
  await s.call(
    "mutation",
    "agents:create",
    {
      config: {
        name: "كاتب المخرجات",
        description: "يقترح إنشاء مخرج",
        instructions: 'CALL_TOOL create_artifact {"title":"ملخص تجريبي","kind":"markdown","content":"# ملخص\\nنص تجريبي"}',
        allowedTools: ["create_artifact"],
        dataScope: "all",
        modelRole: "main",
        maxSteps: 2,
        visibility: { kind: "workspace", spaceIds: [] },
      },
    },
    admin.token,
  ),
);
must(await s.call("mutation", "agents:publish", { agentId: writer }, admin.token));
console.log(`demo ready at ${s.url} (admin@onespace.test / mem@onespace.test, ${PW})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => {
  await s.stop();
  ai.stop();
  process.exit(0);
});
await new Promise(() => {});
