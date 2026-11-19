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

// ---------------------------------------------------------------- forms (step 2)

describe("forms → a list", () => {
  let pub: string;
  let slug: string;
  let list: string;
  let keys: Record<string, string>;
  const tokenIn = (html: string) => /name="_t" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const post = (body: Record<string, string>, host = PUB) =>
    fetch(`${s.url}/f/${slug}`, { method: "POST", redirect: "manual", headers: { "X-Forwarded-Host": host, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  async function formFor(a: ActorKey) {
    const cookie = await openAs(a, slug);
    const html = await (await page(`/p/${slug}`, cookie)).text();
    return { cookie, html, token: tokenIn(html) };
  }

  beforeAll(async () => {
    const art = must(await s.call("mutation", "artifacts:create", { title: "استبيان", kind: "markdown", content: "# استبيان الدورة", spaceId: f.spaces.S_plain }, tok("mgr"))).artifactId;
    const r = must(await s.call("mutation", "publications:publish", { artifactId: art, audience: "workspace" }, tok("mgr")));
    pub = r.id;
    slug = r.url.split("/p/")[1];
    list = must(await s.call("mutation", "lists:create", { spaceId: f.spaces.S_plain, title: "ردود الاستبيان", columns: [{ name: "الاسم", type: "text" }, { name: "العمر", type: "number" }, { name: "المستوى", type: "select", options: ["مبتدئ", "متقدم"] }, { name: "داخلي", type: "text" }] }, tok("mgr")));
    const cols = must(await s.call("query", "lists:get", { listId: list }, tok("mgr"))).list.columns;
    keys = Object.fromEntries(cols.map((c: any) => [c.name, c.key]));
    must(await s.call("mutation", "publications:setForm", { publicationId: pub, form: { listId: list, fields: [{ key: keys["الاسم"], required: true }, { key: keys["العمر"], required: false }, { key: keys["المستوى"], required: false }], recordSender: true, onePerReader: true, thanks: "شكراً THX-1" } }, tok("mgr")));
  });

  test("setForm, addFeedbackForm, formOptions: whoever manages the publication", async () => {
    for (const a of ACTORS) {
      const allowed = a === "mgr";
      expect([a, (await s.call("query", "publications:formOptions", { publicationId: pub }, tok(a))).ok]).toEqual([a, allowed]);
      if (a !== "mgr") expect([a, (await s.call("mutation", "publications:setForm", { publicationId: pub, form: null }, tok(a))).ok]).toEqual([a, false]);
      if (a !== "mgr") expect([a, (await s.call("mutation", "publications:addFeedbackForm", { publicationId: pub }, tok(a))).ok]).toEqual([a, false]);
    }
    // A list of another space can't take the replies.
    const other = must(await s.call("mutation", "lists:create", { spaceId: f.spaces.S_sens, title: "أخرى" }, tok("mgr")));
    expect((await s.call("mutation", "publications:setForm", { publicationId: pub, form: { listId: other, fields: [], recordSender: false, onePerReader: false } }, tok("mgr"))).ok).toBe(false);
  });

  test("the page shows the form's fields, posting only to this origin's /f/", async () => {
    const res = await page(`/p/${slug}`, await openAs("out", slug));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`form-action http://${PUB}/f/`);
    expect(csp).toContain("allow-forms");
    const html = await res.text();
    expect(html).toContain(`action="/f/${slug}"`);
    expect(html).toContain(`name="f_${keys["الاسم"]}"`);
    expect(html).not.toContain(`name="f_${keys["داخلي"]}"`); // not a form field
    expect(tokenIn(html).length).toBeGreaterThan(20);
  });

  test("a reply from someone outside the space becomes a row, with who sent it; once only", async () => {
    const { token } = await formFor("out");
    const r = await post({ _t: token, [`f_${keys["الاسم"]}`]: "سارة", [`f_${keys["العمر"]}`]: "٣٠", [`f_${keys["المستوى"]}`]: "متقدم", [`f_${keys["داخلي"]}`]: "حقن" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/p/${slug}?sent=1`);
    const g = must(await s.call("query", "lists:get", { listId: list }, tok("mgr")));
    const sender = g.list.columns.find((c: any) => c.name === "المرسل");
    const row = g.rows.find((x: any) => x.cells[keys["الاسم"]] === "سارة");
    expect(row.cells[keys["العمر"]]).toBe(30);
    expect(row.cells[keys["المستوى"]]).toBe("متقدم");
    expect(row.cells[keys["داخلي"]]).toBeUndefined();
    expect(g.people.find((p: any) => p.userId === row.cells[sender.key])?.name).toBe("موظف out");
    // The list's space doesn't widen: out still can't read the list.
    expect((await s.call("query", "lists:get", { listId: list }, tok("out"))).ok).toBe(false);
    // Once per reader.
    const again = await post({ _t: token, [`f_${keys["الاسم"]}`]: "ثانية" });
    expect(again.headers.get("location")).toBe(`/p/${slug}?err=answered`);
    expect(await (await page(`/p/${slug}?sent=1`, (await formFor("out")).cookie)).text()).toContain("THX-1");
    expect(must(await s.call("query", "publications:mine", {}, tok("mgr"))).mine.find((p: any) => p._id === pub).form.replies).toBe(1);
  });

  test("required, wrong options, bad tokens and the app's host are refused", async () => {
    const { token } = await formFor("rdr");
    expect((await post({ _t: token, [`f_${keys["العمر"]}`]: "5" })).headers.get("location")).toBe(`/p/${slug}?err=required`);
    expect((await post({ _t: token, [`f_${keys["الاسم"]}`]: "س", [`f_${keys["المستوى"]}`]: "خبير" })).headers.get("location")).toBe(`/p/${slug}?err=invalid`);
    expect((await post({ _t: "not-a-token", [`f_${keys["الاسم"]}`]: "س" })).headers.get("location")).toBe(`http://${APP}/#/open/${slug}`);
    expect((await post({ _t: token, [`f_${keys["الاسم"]}`]: "س" }, APP)).status).toBe(404);
    expect(JSON.stringify(must(await s.call("query", "lists:get", { listId: list }, tok("mgr"))).rows)).not.toContain("خبير");
  });

  test("closing date and reply limit close the form; revoking stops replies", async () => {
    must(await s.call("mutation", "publications:setForm", { publicationId: pub, form: { listId: list, fields: [{ key: keys["الاسم"], required: true }], recordSender: false, onePerReader: false, maxReplies: 2 } }, tok("mgr")));
    const { token } = await formFor("mem");
    expect((await post({ _t: token, [`f_${keys["الاسم"]}`]: "أ" })).headers.get("location")).toBe(`/p/${slug}?sent=1`); // 2nd reply
    expect((await post({ _t: token, [`f_${keys["الاسم"]}`]: "ب" })).headers.get("location")).toBe(`/p/${slug}?err=full`);
    must(await s.call("mutation", "publications:setForm", { publicationId: pub, form: { listId: list, fields: [{ key: keys["الاسم"], required: true }], recordSender: false, onePerReader: false, closesAt: Date.now() - 1000 } }, tok("mgr")));
    expect((await post({ _t: token, [`f_${keys["الاسم"]}`]: "ج" })).headers.get("location")).toBe(`/p/${slug}?err=closed`);
    must(await s.call("mutation", "publications:revoke", { publicationId: pub }, tok("mgr")));
    expect((await post({ _t: token, [`f_${keys["الاسم"]}`]: "د" })).headers.get("location")).toBe(`http://${APP}/#/open/${slug}`);
  });

  test("«نموذج ملاحظات» makes its own list and form", async () => {
    const art = must(await s.call("mutation", "artifacts:create", { title: "صفحة الدورة", kind: "markdown", content: "x", spaceId: f.spaces.S_plain }, tok("mgr"))).artifactId;
    const r = must(await s.call("mutation", "publications:publish", { artifactId: art, audience: "space" }, tok("mgr")));
    const listId = must(await s.call("mutation", "publications:addFeedbackForm", { publicationId: r.id }, tok("mgr")));
    const l = must(await s.call("query", "lists:get", { listId }, tok("mem")));
    expect(l.list.title).toBe("ملاحظات: صفحة الدورة");
    expect(l.list.columns.map((c: any) => c.name)).toEqual(["التقييم", "التعليق", "المرسل"]);
    const s2 = r.url.split("/p/")[1];
    const html = await (await page(`/p/${s2}`, await openAs("mem", s2))).text();
    expect(html).toContain("5 ممتاز");
    // Deleting the list takes the form off the page; the page stays.
    must(await s.call("mutation", "lists:remove", { listId }, tok("mgr")));
    const after = must(await s.call("query", "publications:forArtifact", { artifactId: art }, tok("mgr"))).publications.find((p: any) => p._id === r.id);
    expect(after.form).toBeNull();
    expect(after.state).toBe("live");
  });
});
