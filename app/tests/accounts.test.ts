// Enterprise sign-in: closed sign-up, employees added by the admin, temporary and changed
// passwords, disabling signs out, the first admin without sign-up, and single sign-on through an
// OpenID Connect directory (a fake one here) that joins the account the admin made ahead.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";

const b64 = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");
const sha256 = (s: string) => b64(new Uint8Array(new Bun.CryptoHasher("sha256").update(s).digest()));

async function signIn(s: Server, email: string, password: string) {
  const res = await fetch(`${s.url}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "password", params: { flow: "signIn", email, password } }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/**
 * A directory like AD FS: discovery, a token endpoint that returns an (unsigned, test-only)
 * ID token with the user's claims, and a userinfo endpoint that knows only `sub`.
 */
function fakeDirectory() {
  const codes = new Map<string, Record<string, unknown>>();
  let issuer = "";
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo` });
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        const claims = codes.get(form.get("code") ?? "");
        if (!claims || form.get("client_id") !== "onespace" || form.get("client_secret") !== "s3cret") return Response.json({ error: "invalid_grant" }, { status: 400 });
        const idToken = `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify({ iss: issuer, aud: "onespace", ...claims }))}.`;
        return Response.json({ access_token: `at-${claims.sub}`, token_type: "Bearer", id_token: idToken });
      }
      if (url.pathname === "/userinfo") return Response.json({ sub: req.headers.get("Authorization")?.replace("Bearer at-", "") });
      return new Response("not found", { status: 404 });
    },
  });
  issuer = `http://127.0.0.1:${server.port}`;
  return {
    issuer,
    stop: () => server.stop(true),
    /** Runs the whole browser round trip for this directory user; returns the session token. */
    async signIn(s: Server, claims: Record<string, unknown>): Promise<string> {
      const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
      const start = await fetch(`${s.url}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "sso", params: {}, redirectTo: `${s.url}/`, challenge: sha256(verifier) }),
      }).then((r) => r.json() as any);
      if (!start.redirect) throw new Error("no redirect: " + JSON.stringify(start));
      const authorize = new URL(start.redirect);
      expect(authorize.origin).toBe(issuer);
      const code = crypto.randomUUID();
      codes.set(code, claims);
      const back = new URL(authorize.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", authorize.searchParams.get("state")!);
      const cb = await fetch(back, { redirect: "manual" });
      const location = new URL(cb.headers.get("Location") ?? "");
      const onebaseCode = location.searchParams.get("onebase_code");
      if (!onebaseCode) throw new Error("callback failed: " + location.toString());
      const done = await fetch(`${s.url}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: onebaseCode, verifier }),
      }).then((r) => r.json() as any);
      if (!done.token) throw new Error("exchange failed: " + JSON.stringify(done));
      return done.token;
    },
  };
}

describe("password accounts with sign-up closed", () => {
  const s = new Server(undefined, { SELF_SIGNUP: "off" });
  let admin = "";
  let adminTemp = "";
  beforeAll(async () => {
    await s.start();
    const boot = must(await s.adminRun("passwords:bootstrap", { email: "Boss@Org.test", workspaceName: "الجهة", name: "المدير" }));
    adminTemp = boot.password;
    admin = (await signIn(s, "boss@org.test", adminTemp)).body.token;
  });
  afterAll(() => s.stop());

  test("nobody can sign up", async () => {
    const res = await fetch(`${s.url}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "password", params: { flow: "signUp", email: "x@org.test", password: "password-123" } }),
    });
    expect(res.status).toBe(403);
    const methods: any = await fetch(`${s.url}/api/auth/methods`).then((r) => r.json());
    expect(methods.methods).toEqual([{ id: "password", kind: "password", name: expect.any(String), signUp: false }]);
  });

  test("the first admin gets a temporary password and must change it", async () => {
    expect(adminTemp).toMatch(/^[A-Za-z2-9]{12}$/);
    const me = must(await s.call("query", "account:me", {}, admin));
    expect(me).toMatchObject({ email: "boss@org.test", status: "active", workspaceRole: "admin", mustChangePassword: true });
    must(await s.call("action", "passwords:change", { current: adminTemp, next: "boss-password-1" }, admin));
    expect(must(await s.call("query", "account:me", {}, admin)).mustChangePassword).toBe(false);
    // The bootstrap can't run twice.
    expect((await s.adminRun("passwords:bootstrap", { email: "other@org.test" })).ok).toBe(false);
  });

  test("an added employee is active at once and signs in with the temporary password", async () => {
    const userId = must(await s.call("mutation", "admin:addAccount", { email: " Sara@Org.test ", name: "سارة", employeeNo: "1001" }, admin));
    const { password } = must(await s.call("action", "passwords:issue", { userId }, admin));
    const sara = await signIn(s, "sara@org.test", password);
    expect(sara.status).toBe(200);
    const me = must(await s.call("query", "account:me", {}, sara.body.token));
    expect(me).toMatchObject({ status: "active", workspaceRole: "member", mustChangePassword: true });
    const spaces = must(await s.call("query", "spaces:mine", {}, sara.body.token));
    expect(spaces.some((x: any) => x.kind === "personal")).toBe(true);
    // Same email twice is refused, in either case.
    expect((await s.call("mutation", "admin:addAccount", { email: "SARA@org.test", name: "ثانية" }, admin)).ok).toBe(false);

    // Wrong current password, too short, unchanged: refused.
    expect((await s.call("action", "passwords:change", { current: "wrong-one-1", next: "sara-password-2" }, sara.body.token)).ok).toBe(false);
    expect((await s.call("action", "passwords:change", { current: password, next: "short" }, sara.body.token)).ok).toBe(false);
    expect((await s.call("action", "passwords:change", { current: password, next: password }, sara.body.token)).ok).toBe(false);
    must(await s.call("action", "passwords:change", { current: password, next: "sara-password-2" }, sara.body.token));
    expect((await signIn(s, "sara@org.test", password)).status).not.toBe(200);
    expect((await signIn(s, "sara@org.test", "sara-password-2")).status).toBe(200);

    // A reset by the admin ends every session she has, and asks for a new password again.
    const reset = must(await s.call("action", "passwords:issue", { userId }, admin));
    expect((await s.call("query", "account:me", {}, sara.body.token)).ok).toBe(false); // signed out
    const again = await signIn(s, "sara@org.test", reset.password);
    expect(must(await s.call("query", "account:me", {}, again.body.token)).mustChangePassword).toBe(true);

    const audit = must(await s.call("query", "audit:list", {}, admin));
    const actions = audit.map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["user.create", "user.password_issue", "user.password_change"]));
  });

  test("changing a password needs a signed-in account", async () => {
    expect((await s.call("action", "passwords:change", { current: "anything-1", next: "anything-2" })).ok).toBe(false);
  });

  test("only the workspace admin adds employees or issues passwords", async () => {
    const userId = must(await s.call("mutation", "admin:addAccount", { email: "omar@org.test", name: "عمر" }, admin));
    const { password } = must(await s.call("action", "passwords:issue", { userId }, admin));
    const omar = (await signIn(s, "omar@org.test", password)).body.token;
    expect((await s.call("mutation", "admin:addAccount", { email: "x2@org.test", name: "س" }, omar)).ok).toBe(false);
    expect((await s.call("action", "passwords:issue", { userId }, omar)).ok).toBe(false);
    expect((await s.call("action", "passwords:issue", { userId })).ok).toBe(false);
    // The admin changes their own password from their menu, not here.
    const me = must(await s.call("query", "account:me", {}, admin));
    expect((await s.call("action", "passwords:issue", { userId: me._id }, admin)).ok).toBe(false);
  });

  test("disabling an account signs it out at once", async () => {
    const userId = must(await s.call("mutation", "admin:addAccount", { email: "leaver@org.test", name: "مغادر" }, admin));
    const { password } = must(await s.call("action", "passwords:issue", { userId }, admin));
    const token = (await signIn(s, "leaver@org.test", password)).body.token;
    expect(must(await s.call("query", "account:me", {}, token))).not.toBeNull();
    must(await s.call("mutation", "admin:disable", { userId }, admin));
    const after = await s.call("query", "account:me", {}, token);
    expect(after.ok).toBe(false);
    expect(after.ok ? "" : after.error).toMatch(/signed out/);
    // Signing in again works, but the account sees nothing, and gets no new password.
    const back = (await signIn(s, "leaver@org.test", password)).body.token;
    expect(must(await s.call("query", "account:me", {}, back)).status).toBe("disabled");
    expect((await s.call("query", "spaces:mine", {}, back)).ok).toBe(false);
    expect((await s.call("action", "passwords:issue", { userId }, admin)).ok).toBe(false);
  });
});

describe("single sign-on (OpenID Connect)", () => {
  const dir = fakeDirectory();
  const s = new Server(undefined, { SELF_SIGNUP: "off", SSO_ISSUER: dir.issuer, SSO_CLIENT_ID: "onespace", SSO_CLIENT_SECRET: "s3cret", SSO_NAME: "دخول الجهة" });
  let admin = "";
  beforeAll(async () => {
    await s.start();
    const boot = must(await s.adminRun("passwords:bootstrap", { email: "boss@org.test" }));
    admin = (await signIn(s, "boss@org.test", boot.password)).body.token;
  });
  afterAll(async () => {
    await s.stop();
    dir.stop();
  });

  test("the sign-in page lists the directory", async () => {
    const methods: any = await fetch(`${s.url}/api/auth/methods`).then((r) => r.json());
    expect(methods.methods.map((m: any) => [m.id, m.name])).toContainEqual(["sso", "دخول الجهة"]);
  });

  test("an employee the admin added joins that account on the first SSO sign-in", async () => {
    const userId = must(await s.call("mutation", "admin:addAccount", { email: "huda@org.test", name: "هدى" }, admin));
    // AD FS style: the email only as the UPN in the ID token, in another case.
    const token = await dir.signIn(s, { sub: "S-1-5-21-huda", upn: "Huda@Org.test", name: "هدى العتيبي" });
    const me = must(await s.call("query", "account:me", {}, token));
    expect(me).toMatchObject({ _id: userId, status: "active", workspaceRole: "member", mustChangePassword: false });
    // Next time, the same account by its directory id.
    expect(must(await s.call("query", "account:me", {}, await dir.signIn(s, { sub: "S-1-5-21-huda", upn: "huda@org.test" })))._id).toBe(userId);
  });

  test("someone in the directory the admin didn't add waits for activation", async () => {
    const token = await dir.signIn(s, { sub: "S-1-5-21-new", email: "new@org.test", name: "موظف جديد" });
    const me = must(await s.call("query", "account:me", {}, token));
    expect(me).toMatchObject({ email: "new@org.test", name: "موظف جديد", status: "pending", workspaceRole: null });
    expect((await s.call("query", "spaces:mine", {}, token)).ok).toBe(false);
    must(await s.call("mutation", "admin:activate", { userId: me._id }, admin));
    expect(must(await s.call("query", "account:me", {}, token)).status).toBe("active");
  });

  test("an ID token for another client is refused", async () => {
    // The fake's tokens always name aud "onespace"; one with a foreign issuer must not sign in.
    await expect(dir.signIn(s, { sub: "x", email: "x@org.test", iss: "https://evil.example" })).rejects.toThrow();
  });
});
