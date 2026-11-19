// «النشر» (plans/11, step 1): who may publish, approve, update and revoke; who may open a page; and
// the content origin: pages only on PUBLISH_ORIGIN's host, one-time tickets bound to one page and
// reader, a cookie scoped to that page, the sandbox CSP, and every refusal looking the same.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { ACTORS, buildFixture, expectedAllowed, expectedRole, SPACES, type ActorKey, type Fixture, type SpaceKey } from "./fixture";

const PUB = "pub.test";
const APP = "app.test";
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;
const owner = (sp: SpaceKey) => (sp === "P_mem" ? "mem" : "mgr");
/** Per space: an output, and a live publication of it for the space. */
const setup = {} as Record<SpaceKey, { art: string; pub: string; slug: string }>;

beforeAll(async () => {
  s = await new Server(undefined, { PUBLISH_ORIGIN: `http://${PUB}`, APP_ORIGIN: `http://${APP}` }).start();
  f = await buildFixture(s);
  for (const sp of SPACES) {
    const t = tok(owner(sp))!;
    const art = must(await s.call("mutation", "artifacts:create", { title: `صفحة ${sp}`, kind: "html", content: `<h1>محتوى ${sp} PUBTXT</h1><script>alert(1)</script><meta http-equiv="refresh" content="0;url=http://evil.test">`, spaceId: f.spaces[sp] }, t)).artifactId;
    const r = must(await s.call("mutation", "publications:publish", { artifactId: art, audience: "space" }, t));
    setup[sp] = { art, pub: r.id, slug: r.url.split("/p/")[1] };
  }
}, 120_000);

afterAll(async () => {
  await s?.stop();
});

/** GET on the content origin (the proxy's X-Forwarded-Host), never following redirects. */
const page = (path: string, cookie?: string, host = PUB) => fetch(`${s.url}${path}`, { redirect: "manual", headers: { "X-Forwarded-Host": host, ...(cookie ? { Cookie: cookie } : {}) } });
async function openAs(a: ActorKey, slug: string) {
  const r = must(await s.call("mutation", "publications:openTicket", { slug }, tok(a)));
  const u = new URL(r);
  expect(u.host).toBe(PUB);
  const res = await page(`${u.pathname}${u.search}`);
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

type Op = { name: string; allowed: (a: ActorKey, sp: SpaceKey) => boolean; run: (a: ActorKey, sp: SpaceKey) => Promise<Result> };
const manages = (a: ActorKey, sp: SpaceKey) => ["manager", "owner"].includes(expectedRole(a, sp) ?? "");

const OPS: Op[] = [
  { name: "publications:forArtifact", allowed: (a, sp) => expectedAllowed(a, sp, "read"), run: (a, sp) => s.call("query", "publications:forArtifact", { artifactId: setup[sp].art }, tok(a)) },
  { name: "publications:publish", allowed: (a, sp) => expectedAllowed(a, sp, "write"), run: (a, sp) => s.call("mutation", "publications:publish", { artifactId: setup[sp].art, audience: "space" }, tok(a)) },
  { name: "publications:openTicket", allowed: (a, sp) => expectedAllowed(a, sp, "read"), run: (a, sp) => s.call("mutation", "publications:openTicket", { slug: setup[sp].slug }, tok(a)) },
  { name: "publications:update", allowed: manages, run: (a, sp) => s.call("mutation", "publications:update", { publicationId: setup[sp].pub }, tok(a)) },
  {
    name: "publications:revoke",
    allowed: manages,
    run: async (a, sp) => {
      const t = tok(owner(sp))!;
      const extra = must(await s.call("mutation", "artifacts:create", { title: "للإيقاف", kind: "markdown", content: "x", spaceId: f.spaces[sp] }, t)).artifactId;
      const r = must(await s.call("mutation", "publications:publish", { artifactId: extra, audience: "space" }, t));
      return s.call("mutation", "publications:revoke", { publicationId: r.id }, tok(a));
    },
  },
];

describe("permission matrix", () => {
  for (const op of OPS)
    for (const sp of SPACES)
      for (const a of ACTORS) {
        const allowed = op.allowed(a, sp);
        test(`${op.name} | ${sp} | ${a} → ${allowed ? "allowed" : "denied"}`, async () => {
          const r = await op.run(a, sp);
          if (allowed && !r.ok) throw new Error(`expected allowed, got: ${r.error}`);
          if (!allowed && r.ok) throw new Error(`expected denied, got: ${JSON.stringify(r.value).slice(0, 200)}`);
        });
      }

  test("publications:mine: any active employee", async () => {
    for (const a of ACTORS) expect([a, (await s.call("query", "publications:mine", {}, tok(a))).ok]).toEqual([a, !["pend", "dis", "anon"].includes(a)]);
  });
});

describe("rules", () => {
  test("a member's publication waits for a manager; only a manager approves", async () => {
    const r = must(await s.call("mutation", "publications:publish", { artifactId: setup.S_plain.art, audience: "workspace" }, tok("mem")));
    expect(r.state).toBe("pending");
    const slug = r.url.split("/p/")[1];
    expect((await s.call("mutation", "publications:openTicket", { slug }, tok("mem"))).ok).toBe(false); // not live yet
    for (const a of ACTORS) if (a !== "mgr") expect((await s.call("mutation", "publications:review", { publicationId: r.id, approve: true }, tok(a))).ok).toBe(false);
    expect(must(await s.call("query", "publications:mine", {}, tok("mgr"))).pending.map((p: any) => p._id)).toContain(r.id);
    must(await s.call("mutation", "publications:review", { publicationId: r.id, approve: true }, tok("mgr")));
    // A workspace page: any active employee may open it, even one outside the space.
    for (const a of ACTORS) expect([a, (await s.call("mutation", "publications:openTicket", { slug }, tok(a))).ok]).toEqual([a, !["pend", "dis", "anon"].includes(a)]);
  });

  test("a sensitive space never publishes beyond its members", async () => {
    for (const a of ["mgr", "mem"]) expect((await s.call("mutation", "publications:publish", { artifactId: setup.S_sens.art, audience: "workspace" }, tok(a))).ok).toBe(false);
    expect(must(await s.call("query", "publications:forArtifact", { artifactId: setup.S_sens.art }, tok("mgr"))).audiences).toEqual(["space"]);
  });

  test("update shows the output's current version", async () => {
    must(await s.call("mutation", "artifacts:edit", { artifactId: setup.P_mem.art, content: "<p>النسخة الثانية V2TXT</p>" }, tok("mem")));
    const before = await page(`/p/${setup.P_mem.slug}`, await openAs("mem", setup.P_mem.slug));
    expect(await before.text()).not.toContain("V2TXT");
    must(await s.call("mutation", "publications:update", { publicationId: setup.P_mem.pub }, tok("mem")));
    expect(await (await page(`/p/${setup.P_mem.slug}`, await openAs("mem", setup.P_mem.slug))).text()).toContain("V2TXT");
  });
});

describe("the content origin", () => {
  test("the app's own host never serves /p/", async () => {
    const res = await page(`/p/${setup.S_plain.slug}`, undefined, APP);
    expect(res.status).toBe(404);
    expect((await fetch(`${s.url}/p/${setup.S_plain.slug}`, { redirect: "manual" })).status).toBe(404);
  });

  test("no cookie → the app's #/open; the same for a missing page", async () => {
    for (const slug of [setup.S_plain.slug, "AAAAAAAAAAAAAAAA"]) {
      const res = await page(`/p/${slug}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`http://${APP}/#/open/${slug}`);
    }
  });

  test("ticket → a cookie for that page only → the page, under the sandbox CSP; scripts and meta refresh inert", async () => {
    const cookie = await openAs("rdr", setup.S_plain.slug);
    const res = await page(`/p/${setup.S_plain.slug}`, cookie);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("PUBTXT");
    expect(html).not.toContain("evil.test");
    expect(csp).toMatch(/script-src 'sha256-[^']+'/); // the generated <script> has no hash → blocked
    // The same cookie doesn't open another page.
    expect((await page(`/p/${setup.S_every.slug}`, cookie)).status).toBe(302);
  });

  test("a ticket works once, only for its page", async () => {
    const r = must(await s.call("mutation", "publications:openTicket", { slug: setup.S_plain.slug }, tok("mem")));
    const t = new URL(r).search;
    expect((await page(`/p/${setup.S_every.slug}${t}`)).status).toBe(302); // other page: refused (and spent)
    expect((await page(`/p/${setup.S_plain.slug}${t}`)).status).toBe(302);
    const r2 = must(await s.call("mutation", "publications:openTicket", { slug: setup.S_plain.slug }, tok("mem")));
    const u = new URL(r2);
    expect((await page(`${u.pathname}${u.search}`)).status).toBe(303);
    expect((await page(`${u.pathname}${u.search}`)).status).toBe(302);
  });

  test("revoking, losing access or deleting the output closes an open page at once", async () => {
    const cookie = await openAs("mem", setup.S_every.slug);
    expect((await page(`/p/${setup.S_every.slug}`, cookie)).status).toBe(200);
    must(await s.call("mutation", "publications:revoke", { publicationId: setup.S_every.pub }, tok("mgr")));
    expect((await page(`/p/${setup.S_every.slug}`, cookie)).status).toBe(302);

    const cookie2 = await openAs("rdr", setup.S_plain.slug);
    must(await s.call("mutation", "artifacts:remove", { artifactId: setup.S_plain.art }, tok("mgr")));
    expect((await page(`/p/${setup.S_plain.slug}`, cookie2)).status).toBe(302);
    expect((await s.call("mutation", "publications:openTicket", { slug: setup.S_plain.slug }, tok("rdr"))).ok).toBe(false);
  });
});
