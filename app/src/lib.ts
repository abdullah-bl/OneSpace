import { anyApi } from "onebase/browser";
import type { api as Api } from "../onebase/_generated/api";

/** Typed function references without pulling server code into the bundle. */
export const api = anyApi as unknown as typeof Api;

export type SpaceInfo = {
  _id: string;
  name: string;
  kind: "personal" | "shared";
  everyone: boolean;
  sensitive: boolean;
  myRole: string;
  canWrite: boolean;
  canManage: boolean;
};

/** The space's kind, as a label and an icon name (icons.tsx). */
export function badge(space: { kind: string; everyone: boolean }) {
  if (space.kind === "personal") return { icon: "lock" as const, label: "خاصة" };
  if (space.everyone) return { icon: "globe" as const, label: "للجميع" };
  return { icon: "users" as const, label: "مشتركة" };
}

export const spaceName = (s: { kind: string; name: string }) => (s.kind === "personal" ? "مساحتي" : s.name);

/** Uploads a file the way the browser does: an upload URL from the backend, then POST the bytes. */
export async function uploadBytes(getUrl: () => Promise<string>, file: File): Promise<string> {
  // Same-origin path: the server's --url may differ from the address the page was opened on.
  const u = new URL(await getUrl(), location.origin);
  const res = await fetch(u.pathname + u.search, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  const body = await res.json();
  if (!body.storageId) throw new Error(body.error ?? "فشل الرفع");
  return body.storageId;
}

export const ROLE_LABELS: Record<string, string> = {
  owner: "صاحب المساحة",
  manager: "مدير المساحة",
  member: "عضو",
  reader: "قارئ",
  everyone: "قارئ (للجميع)",
  admin: "مدير مساحة العمل",
};

export const STATUS_LABELS: Record<string, string> = { pending: "بانتظار التفعيل", active: "مفعّل", disabled: "معطّل" };

export function formatSize(n: number) {
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} ك.ب`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} م.ب`;
  return `${(n / 1024 ** 3).toFixed(1)} ج.ب`;
}

export function formatDate(ms: number) {
  return new Date(ms).toLocaleString("ar-SA-u-nu-latn", { dateStyle: "medium", timeStyle: "short" });
}

export function errorText(err: unknown) {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/^.*Uncaught (OneBaseError: )?/, "").replace(/^\[.*?\]\s*/, "");
}
