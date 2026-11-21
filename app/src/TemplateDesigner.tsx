// The certificate design editor (plans/17 §3): no JSON to write. The design is shown as it
// will print: the background (an uploaded PDF or image, rendered by the server) with every
// element drawn on top at its real position and size, using a real row of the record set.
// Click an empty spot to put a field (or fixed text, serial, code, date) there; drag to move;
// pick an element to change its size, alignment, prefix or text. «معاينة حقيقية» renders the
// actual PDF the way issuing does. JSON stays under «متقدم». Every save is a new version that
// a manager approves before use.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useAction, useOnebase, useQuery } from "onebase/react";
import { api, errorText } from "./lib";
import { ask } from "./ui";
// The certificate font (pdf.ts embeds Readex Pro), so text here takes the width it will print with.
import "@fontsource/readex-pro/arabic-400.css";
import "@fontsource/readex-pro/arabic-700.css";
import "@fontsource/readex-pro/latin-400.css";
import "@fontsource/readex-pro/latin-700.css";

type Align = "left" | "center" | "right";
type Pos = { x: number; y: number; size?: number; align?: Align; bold?: boolean; maxWidth?: number };
type El =
  | ({ type: "text"; text: string } & Pos)
  | ({ type: "field"; field: string; prefix?: string; suffix?: string } & Pos)
  | ({ type: "serial" | "verifyCode" | "issuedDate"; prefix?: string } & Pos)
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; width?: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; width?: number };
type Layout = { page: { width: number; height: number }; elements: El[] };
type Field = { key: string; label: string; column: string };
type Style = "classic" | "centered" | "blank";

const A4 = { width: 842, height: 595 };
const SAMPLE = { serial: "OS-2026-000123", verifyCode: "ABCD-EFGH-JKLM", issuedDate: new Date().toISOString().slice(0, 10) };
const KIND_LABEL: Record<string, string> = { text: "نص", field: "حقل", serial: "الرقم التسلسلي", verifyCode: "رمز التحقق", issuedDate: "تاريخ الإصدار", line: "خط", rect: "إطار" };

function parse(json: string): Layout | null {
  try {
    const raw = JSON.parse(json);
    if (!raw || !Array.isArray(raw.elements)) return null;
    return { page: raw.page ?? A4, elements: raw.elements };
  } catch {
    return null;
  }
}

export type DesignerStart = {
  templateId?: string;
  name: string;
  recordSetId: string;
  fields: Field[];
  layout: string | null;
  hasBackground: boolean;
};

export function TemplateDesigner({ spaceId, start, onDone }: { spaceId: string; start?: DesignerStart; onDone: () => void }) {
  const client = useOnebase();
  const sets = useQuery(api.records.sets, { spaceId: spaceId as any });
  const files = useQuery(api.files.list, { spaceId: spaceId as any });
  const save = useAction(api.templates.saveVersion);
  const preview = useAction(api.templates.preview);

  const [name, setName] = useState(start?.name ?? "");
  const [recordSetId, setRecordSetId] = useState(start?.recordSetId ?? "");
  const [fields, setFields] = useState<Field[]>(start?.fields ?? []);
  // "" none, "keep" the current version's, or a file id of the space.
  const [background, setBackground] = useState<string>(start?.hasBackground ? "keep" : "");
  const [layout, setLayout] = useState<Layout | null>(start?.layout ? parse(start.layout) : null);
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [placing, setPlacing] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const [real, setReal] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; sx: number; sy: number; el: El } | null>(null);

  const set = sets?.find((s) => s._id === recordSetId);
  const page = layout?.page ?? A4;
  const bgArgs = background === "keep" ? { templateId: start?.templateId as any, keepBackground: true } : background ? { backgroundFileId: background as any } : {};
  const binding = recordSetId && fields.length ? { recordSetId: recordSetId as any, fields: Object.fromEntries(fields.map((f) => [f.key, f.column])) } : undefined;
  const schema = fields.map(({ key, label }) => ({ key, label }));

  // The background alone (and its page size) plus a real row, whenever the background or the data changes.
  const bgKey = JSON.stringify([background, recordSetId, fields]);
  useEffect(() => {
    let live = true;
    setReal(null);
    preview({ spaceId: spaceId as any, ...bgArgs, layout: JSON.stringify({ page: layout?.page ?? A4, elements: [] }), fieldsSchema: schema, dataBinding: binding })
      .then((r) => {
        if (!live) return;
        setBgImage(background ? r.image : null);
        setSample(r.sample);
        if (background && layout && (Math.round(r.page.width) !== layout.page.width || Math.round(r.page.height) !== layout.page.height)) setLayout({ ...layout, page: { width: Math.round(r.page.width), height: Math.round(r.page.height) } });
        if (background && !layout) setLayout({ page: { width: Math.round(r.page.width), height: Math.round(r.page.height) }, elements: [] });
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgKey]);

  const applyStyle = async (style: Style) => {
    if (layout?.elements.length && !(await ask("يستبدل هذا التصميمَ الحالي. متابعة؟"))) return;
    const json = await client.query(api.templates.suggestLayout, { title: name || "شهادة", fields: schema, style, page: background ? page : undefined });
    setLayout(parse(json));
    setSelected(null);
  };

  const update = (i: number, patch: Partial<El>) => setLayout((l) => (l ? { ...l, elements: l.elements.map((e, j) => (j === i ? ({ ...e, ...patch } as El) : e)) } : l));
  const remove = (i: number) => {
    setLayout((l) => (l ? { ...l, elements: l.elements.filter((_, j) => j !== i) } : l));
    setSelected(null);
  };
  const add = (el: El) => {
    setLayout((l) => {
      const base = l ?? { page, elements: [] };
      setSelected(base.elements.length);
      return { ...base, elements: [...base.elements, el] };
    });
    setPlacing(null);
  };

  // Screen <-> PDF points (origin bottom-left).
  const toPdf = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: Math.round(((clientX - r.left) / r.width) * page.width), y: Math.round(((r.bottom - clientY) / r.height) * page.height), left: clientX - r.left, top: clientY - r.top };
  };
  const onCanvasClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return;
    setSelected(null);
    setPlacing(toPdf(e.clientX, e.clientY));
  };
  const startDrag = (i: number, e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(i);
    setPlacing(null);
    drag.current = { i, sx: e.clientX, sy: e.clientY, el: layout!.elements[i]! };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const r = canvas.current!.getBoundingClientRect();
    const dx = Math.round(((e.clientX - d.sx) / r.width) * page.width);
    const dy = Math.round(((d.sy - e.clientY) / r.height) * page.height);
    const el = d.el;
    if (el.type === "line") update(d.i, { x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy } as Partial<El>);
    else update(d.i, { x: el.x + dx, y: el.y + dy } as Partial<El>);
  };

  // Arrow keys nudge the selection (Shift: 10 pt); Delete removes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selected === null || !layout || (e.target as HTMLElement).closest("input,textarea,select")) return;
      const el = layout.elements[selected]!;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (d) {
        e.preventDefault();
        if (el.type === "line") update(selected, { x1: el.x1 + d[0]!, x2: el.x2 + d[0]!, y1: el.y1 + d[1]!, y2: el.y2 + d[1]! } as Partial<El>);
        else update(selected, { x: el.x + d[0]!, y: el.y + d[1]! } as Partial<El>);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const textOf = (e: El) => {
    if (e.type === "text") return e.text;
    if (e.type === "field") return `${e.prefix ?? ""}${sample[e.field] ?? fields.find((f) => f.key === e.field)?.label ?? e.field}${e.suffix ?? ""}`;
    if (e.type === "serial" || e.type === "verifyCode" || e.type === "issuedDate") return `${e.prefix ?? ""}${SAMPLE[e.type]}`;
    return "";
  };
  const pct = (n: number, of: number) => `${(n / of) * 100}%`;
  const layoutJson = useMemo(() => (layout ? JSON.stringify(layout, null, 2) : ""), [layout]);
  const sel = selected !== null ? layout?.elements[selected] : undefined;

  const doSave = async () => {
    setError("");
    if (!layout) return setError("اختر تصميماً جاهزاً أو ضع حقلاً على الصفحة");
    setBusy(true);
    try {
      await save({ spaceId: spaceId as any, templateId: start?.templateId as any, name, layout: JSON.stringify(layout), fieldsSchema: schema, dataBinding: binding!, ...bgArgs });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const doPreview = async () => {
    if (!layout) return;
    setError("");
    setBusy(true);
    try {
      const r = await preview({ spaceId: spaceId as any, ...bgArgs, layout: JSON.stringify(layout), fieldsSchema: schema, dataBinding: binding });
      if (r.error) setError(r.error);
      setReal(r.image);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const bgFiles = (files ?? []).filter((f) => ["application/pdf", "image/png", "image/jpeg"].includes(f.mime));

  return (
    <div className="card space-y-4 p-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">اسم القالب</span>
          <input className="input w-full" placeholder="مثلاً: شهادة إتمام دورة" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="block">
          <span className="label">البيانات من</span>
          <select
            className="input w-full"
            value={recordSetId}
            onChange={(e) => {
              setRecordSetId(e.target.value);
              const s = sets?.find((x) => x._id === e.target.value);
              setFields(s ? s.columns.filter((c) => c.key !== s.subjectColumn).map((c) => ({ key: c.key, label: c.header, column: c.key })) : []);
            }}
          >
            <option value="">اختر سجلاً…</option>
            {sets?.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {set && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">الحقول ({fields.length}) — من أعمدة «{set.name}»</summary>
          <div className="mt-2 space-y-1">
            {fields.map((f, i) => (
              <div key={f.key} className="flex items-center gap-2">
                <input className="input h-8 w-40" aria-label="اسم الحقل" value={f.label} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <span>←</span>
                <select className="input h-8" aria-label="العمود" value={f.column} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}>
                  {set.columns.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.header}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-ghost h-8" onClick={() => setFields(fields.filter((_, j) => j !== i))}>
                  إزالة
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {recordSetId && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="label m-0">الخلفية</span>
            <select className="input h-8" aria-label="الخلفية" value={background} onChange={(e) => setBackground(e.target.value)}>
              <option value="">بلا خلفية (A4 أفقية)</option>
              {start?.hasBackground && <option value="keep">خلفية النسخة الحالية</option>}
              {bgFiles.map((f) => (
                <option key={f._id} value={f._id}>
                  {f.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">تصميمكم بشعاركم (PDF أو صورة) من ملفات المساحة.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="label m-0">تصميم جاهز</span>
            {(
              [
                ["classic", "كلاسيكي"],
                ["centered", "في الوسط"],
                ["blank", "فارغ (لتصميمك)"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" className="btn-secondary h-8" onClick={() => void applyStyle(k)}>
                {l}
              </button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_15rem]">
            <div>
              <p className="mb-1 text-xs text-muted">انقر مكاناً فارغاً لتضع فيه حقلاً. اسحب العناصر لتحريكها، والأسهم للتحريك الدقيق.</p>
              <div
                ref={canvas}
                role="application"
                aria-label="الشهادة"
                className="relative w-full select-none overflow-hidden border border-line bg-white shadow-sm"
                style={{ aspectRatio: `${page.width} / ${page.height}`, containerType: "inline-size", fontFamily: "'Readex Pro', var(--font-sans, sans-serif)", color: "#1a1a1f" }}
                onClick={onCanvasClick}
                onPointerMove={onMove}
                onPointerUp={() => (drag.current = null)}
              >
                {bgImage && <img src={bgImage} alt="" data-bg="1" className="absolute inset-0 h-full w-full" draggable={false} />}
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none">
                  {layout?.elements.map((e, i) =>
                    e.type === "line" ? (
                      <g key={i} className="pointer-events-auto cursor-move" onPointerDown={(ev) => startDrag(i, ev)}>
                        <line x1={e.x1} y1={page.height - e.y1} x2={e.x2} y2={page.height - e.y2} stroke="transparent" strokeWidth={12} />
                        <line x1={e.x1} y1={page.height - e.y1} x2={e.x2} y2={page.height - e.y2} stroke={selected === i ? "var(--color-accent, #2563eb)" : "#4c4c59"} strokeWidth={e.width ?? 1} />
                      </g>
                    ) : null,
                  )}
                </svg>
                {layout?.elements.map((e, i) => {
                  if (e.type === "line") return null;
                  if (e.type === "rect")
                    return (
                      <div
                        key={i}
                        className="absolute cursor-move"
                        style={{ left: pct(e.x, page.width), bottom: pct(e.y, page.height), width: pct(e.w, page.width), height: pct(e.h, page.height), border: `${((e.width ?? 1) / page.width) * 100}cqw solid ${selected === i ? "var(--color-accent, #2563eb)" : "#105e5c"}`, pointerEvents: "none" }}
                      >
                        <span className="absolute -top-0.5 end-0 h-3 w-3 cursor-move rounded-full bg-control/60" style={{ pointerEvents: "auto" }} title="إطار" onPointerDown={(ev) => startDrag(i, ev)} />
                      </div>
                    );
                  const align = e.align ?? "right";
                  return (
                    <div
                      key={i}
                      dir="auto"
                      className={`absolute cursor-move whitespace-nowrap leading-none ${selected === i ? "outline outline-1 outline-offset-2 outline-blue-500" : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-control"}`}
                      style={{
                        left: pct(e.x, page.width),
                        bottom: pct(e.y, page.height),
                        transform: `translateX(${align === "left" ? "0" : align === "center" ? "-50%" : "-100%"})`,
                        fontSize: `${((e.size ?? 14) / page.width) * 100}cqw`,
                        fontWeight: e.bold ? 700 : 400,
                        maxWidth: e.maxWidth ? pct(e.maxWidth, page.width) : undefined,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      onPointerDown={(ev) => startDrag(i, ev)}
                    >
                      {textOf(e)}
                    </div>
                  );
                })}
                {placing && (
                  <div className="absolute z-10 w-48 rounded-lg border border-line bg-surface p-1 text-xs shadow-lg" style={{ left: Math.min(placing.left, (canvas.current?.clientWidth ?? 300) - 200), top: Math.min(placing.top, (canvas.current?.clientHeight ?? 300) - 40) }} onClick={(e) => e.stopPropagation()}>
                    <div className="px-2 py-1 text-faint">ضع هنا:</div>
                    {fields.map((f) => (
                      <button key={f.key} type="button" className="block w-full rounded px-2 py-1 text-start hover:bg-raised" onClick={() => add({ type: "field", field: f.key, x: placing.x, y: placing.y, size: 18, align: "center", bold: true })}>
                        {f.label}
                      </button>
                    ))}
                    <hr className="my-1 border-rule" />
                    <button type="button" className="block w-full rounded px-2 py-1 text-start hover:bg-raised" onClick={() => add({ type: "text", text: "نص", x: placing.x, y: placing.y, size: 16, align: "center" })}>
                      نص ثابت
                    </button>
                    {(["serial", "verifyCode", "issuedDate"] as const).map((k) => (
                      <button key={k} type="button" className="block w-full rounded px-2 py-1 text-start hover:bg-raised" onClick={() => add({ type: k, prefix: `${KIND_LABEL[k]}: `, x: placing.x, y: placing.y, size: 11, align: "center" })}>
                        {KIND_LABEL[k]}
                      </button>
                    ))}
                    <button type="button" className="block w-full rounded px-2 py-1 text-start hover:bg-raised" onClick={() => add({ type: "line", x1: placing.x - 100, y1: placing.y, x2: placing.x + 100, y2: placing.y, width: 1 })}>
                      خط
                    </button>
                    <button type="button" className="block w-full rounded px-2 py-1 text-start text-muted hover:bg-raised" onClick={() => setPlacing(null)}>
                      إلغاء
                    </button>
                  </div>
                )}
                {!layout && <div className="absolute inset-0 grid place-items-center text-muted">اختر تصميماً جاهزاً، أو انقر لتضع أول حقل</div>}
              </div>
            </div>

            <aside className="space-y-2" aria-label="خصائص العنصر">
              {sel ? (
                <>
                  <div className="font-medium">{sel.type === "field" ? `حقل: ${fields.find((f) => f.key === sel.field)?.label ?? sel.field}` : KIND_LABEL[sel.type]}</div>
                  {sel.type === "text" && (
                    <label className="block">
                      <span className="label">النص</span>
                      <input className="input w-full" value={sel.text} onChange={(e) => update(selected!, { text: e.target.value })} />
                    </label>
                  )}
                  {(sel.type === "field" || sel.type === "serial" || sel.type === "verifyCode" || sel.type === "issuedDate") && (
                    <label className="block">
                      <span className="label">قبله</span>
                      <input className="input w-full" placeholder="مثلاً: أتمّ دورة " value={sel.prefix ?? ""} onChange={(e) => update(selected!, { prefix: e.target.value || undefined })} />
                    </label>
                  )}
                  {sel.type === "field" && (
                    <label className="block">
                      <span className="label">بعده</span>
                      <input className="input w-full" value={sel.suffix ?? ""} onChange={(e) => update(selected!, { suffix: e.target.value || undefined })} />
                    </label>
                  )}
                  {sel.type !== "line" && sel.type !== "rect" && (
                    <>
                      <label className="block">
                        <span className="label num">الحجم: {sel.size ?? 14}</span>
                        <input type="range" min={6} max={72} className="w-full" value={sel.size ?? 14} onChange={(e) => update(selected!, { size: Number(e.target.value) })} />
                      </label>
                      <div className="flex gap-1" role="group" aria-label="المحاذاة">
                        {(
                          [
                            ["right", "يمين"],
                            ["center", "وسط"],
                            ["left", "يسار"],
                          ] as const
                        ).map(([a, l]) => (
                          <button key={a} type="button" aria-pressed={(sel.align ?? "right") === a} className={`h-8 flex-1 rounded border text-xs ${(sel.align ?? "right") === a ? "border-ink bg-ink text-surface" : "border-line"}`} onClick={() => update(selected!, { align: a })}>
                            {l}
                          </button>
                        ))}
                      </div>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={!!sel.bold} onChange={(e) => update(selected!, { bold: e.target.checked })} /> عريض
                      </label>
                      <label className="block">
                        <span className="label">أقصى عرض (يصغّر الخط إن طال النص)</span>
                        <input className="input w-full num" type="number" min={0} value={sel.maxWidth ?? ""} onChange={(e) => update(selected!, { maxWidth: Number(e.target.value) >= 10 ? Number(e.target.value) : undefined })} />
                      </label>
                    </>
                  )}
                  <button type="button" className="btn-danger w-full" onClick={() => remove(selected!)}>
                    احذف العنصر
                  </button>
                </>
              ) : (
                <p className="text-xs text-muted">اختر عنصراً لتعدّل حجمه ومحاذاته ونصه.</p>
              )}
            </aside>
          </div>

          {real && (
            <figure className="space-y-1">
              <figcaption className="text-xs text-muted">المعاينة الحقيقية: كما تُطبع، بأول صف من السجل ورقم ورمز تجريبيين.</figcaption>
              <img src={real} alt="معاينة الشهادة" className="w-full border border-line" />
            </figure>
          )}

          <details>
            <summary className="cursor-pointer text-xs text-muted">متقدم: التخطيط بصيغة JSON</summary>
            <textarea
              className="input mt-2 h-60 w-full font-mono text-xs"
              dir="ltr"
              value={json ?? layoutJson}
              onChange={(e) => {
                setJson(e.target.value);
                const p = parse(e.target.value);
                if (p) setLayout(p);
              }}
              onBlur={() => setJson(null)}
            />
          </details>
        </>
      )}

      {error && <p className="alert-negative">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy || !name.trim() || !binding || !layout} onClick={() => void doSave()}>
          {start?.templateId ? "احفظ نسخة جديدة" : "احفظ القالب"}
        </button>
        <button type="button" className="btn-secondary" disabled={busy || !layout || !binding} onClick={() => void doPreview()}>
          {busy ? "…" : "معاينة حقيقية"}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          إلغاء
        </button>
        <span className="text-xs text-muted">النسخة المحفوظة لا تُستخدم حتى تعتمدها.</span>
      </div>
    </div>
  );
}
