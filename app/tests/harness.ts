// Starts a real `onebase serve` on a fresh data dir and a free port, and talks to it over HTTP
// exactly like a client would: sign-up/sign-in for session tokens, /api/query|mutation with
// Bearer tokens, the /download route, and the admin API (admin key) for the bootstrap step.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const APP = resolve(import.meta.dir, "..");

export type Result = { ok: true; value: any } | { ok: false; error: string; status: number };

export class Server {
  proc!: Bun.Subprocess;
  url!: string;
  dataDir: string;
  adminKey = "test-admin-key-" + crypto.randomUUID();

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? mkdtempSync(join(tmpdir(), "onespace-test-"));
  }

  async start(port = 0) {
    const p = port || 20000 + Math.floor(Math.random() * 20000);
    this.url = `http://127.0.0.1:${p}`;
    this.proc = Bun.spawn([join(APP, "node_modules/.bin/onebase"), "serve", "--port", String(p), "--host", "127.0.0.1", "--data", this.dataDir, "--dir", join(APP, "onebase"), "--url", this.url], {
      cwd: APP,
      env: { ...process.env, ONEBASE_ADMIN_KEY: this.adminKey },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 200; i++) {
      try {
        const r = await fetch(`${this.url}/api/health`);
        if (r.ok) return this;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("server did not start: " + (await new Response(this.proc.stderr as ReadableStream).text()));
  }

  async stop(cleanup = true) {
    this.proc?.kill();
    await this.proc?.exited;
    if (cleanup) rmSync(this.dataDir, { recursive: true, force: true });
  }

  async call(kind: "query" | "mutation" | "action", path: string, args: any = {}, token?: string): Promise<Result> {
    const res = await fetch(`${this.url}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ path, args }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (body.status === "success") return { ok: true, value: body.value };
    return { ok: false, error: body.errorMessage ?? body.error ?? `HTTP ${res.status}`, status: res.status };
  }

  async auth(flow: "signUp" | "signIn", email: string, password: string, name?: string): Promise<{ token: string; userId: string }> {
    const res = await fetch(`${this.url}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "password", params: { flow, email, password, ...(name ? { name } : {}) } }),
    });
    const body: any = await res.json();
    if (!body.token) throw new Error(`${flow} failed for ${email}: ${JSON.stringify(body)}`);
    return { token: body.token, userId: body.userId };
  }

  async adminRun(name: string, args: any = {}): Promise<Result> {
    const res = await fetch(`${this.url}/_admin/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.adminKey}` },
      body: JSON.stringify({ name, args }),
    });
    const body: any = await res.json();
    const inner = body.value;
    if (body.ok && inner?.ok) return { ok: true, value: inner.value };
    return { ok: false, error: inner?.error ?? body.error, status: res.status };
  }

  /** Uploads bytes the way the browser does: upload URL from the backend, then POST the body. Returns the storageId. */
  async upload(token: string, content: string, type = "text/plain"): Promise<string> {
    const u = await this.call("mutation", "files:generateUploadUrl", {}, token);
    if (!u.ok) throw new Error("generateUploadUrl: " + u.error);
    const res = await fetch(u.value, { method: "POST", headers: { "Content-Type": type }, body: content });
    const body: any = await res.json();
    if (!body.storageId) throw new Error("upload failed " + JSON.stringify(body));
    return body.storageId;
  }

  async get(path: string, token?: string) {
    const res = await fetch(`${this.url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
}

export function must(r: Result): any {
  if (!r.ok) throw new Error("expected success, got: " + r.error);
  return r.value;
}
