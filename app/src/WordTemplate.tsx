// A certificate template is a Word file (plans/17 §3): the manager designs it in Word and writes
// {{variables}} where the data goes. Here: pick the record set, upload the .docx (or download a
// ready one to start from), check that each variable found its column, look at the real
// preview, save. Every save is a new version that a manager approves before use.

import { useEffect, useState } from "react";
import { useAction, useQuery } from "onebase/react";
import { api, errorText } from "./lib";

type Variable = { name: string; reserved: string | null; column: string | null };
type Analysis = { variables: Variable[]; unmatched: string[]; missingFonts: string[] };
/** Editing: the template, and its current mapping (variable as written -> column key). */
export type WordStart = { templateId: string; name: string; recordSetId: string; mapping: Record<string, string> };

const RESERVED_LABEL: Record<string, string> = { serial: "الرقم التسلسلي", verifyCode: "رمز التحقق", issuedDate: "تاريخ الإصدار" };

async function fileBase64(file: File) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function saveBase64(base64: string, fileName: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WordTemplate({ spaceId, start, onDone }: { spaceId: string; start?: WordStart; onDone: () => void }) {
  const sets = useQuery(api.records.sets, { spaceId: spaceId as any });
  const analyze = useAction(api.templates.analyzeWord);
  const previewWord = useAction(api.templates.previewWord);
  const saveWord = useAction(api.templates.saveWord);
  const sample = useAction(api.templates.sampleWord);
  const download = useAction(api.templates.downloadWord);

  const [name, setName] = useState(start?.name ?? "");
  const [recordSetId, setRecordSetId] = useState(start?.recordSetId ?? "");
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>(start?.mapping ?? {});
  const [a, setA] = useState<Analysis | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "read" | "preview" | "save">("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const set = sets?.find((s) => s._id === recordSetId);
  const hasFile = Boolean(file || start?.templateId);
  const args = () => ({ spaceId: spaceId as any, recordSetId: recordSetId as any, ...(file ? { dataBase64: file.data } : {}), ...(start?.templateId ? { templateId: start.templateId as any } : {}), mapping });

  // Read the file's variables (and preview when every one has a column) when the file, the set or a mapping changes.
  const key = JSON.stringify([recordSetId, file?.name, file?.data.length, mapping]);
  useEffect(() => {
    if (!recordSetId || !hasFile) return;
    let live = true;
    setError("");
    setBusy("read");
    analyze(args())
      .then(async (r) => {
        if (!live) return;
        setA(r);
        if (r.unmatched.length === 0 && r.variables.some((x) => !x.reserved)) {
          setBusy("preview");
          const p = await previewWord(args());
          if (!live) return;
          setImage(p.image);
          if (p.error) setError(p.error);
        } else setImage(null);
      })
      .catch((e) => live && (setA(null), setError(errorText(e))))
      .finally(() => live && setBusy(""));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const copy = (header: string) => {
    void navigator.clipboard?.writeText(`{{${header}}}`).catch(() => {});
    setCopied(header);
    setTimeout(() => setCopied(""), 1200);
  };

  const fields = a?.variables.filter((x) => !x.reserved) ?? [];
  const ready = !!name.trim() && !!recordSetId && hasFile && !!a && a.unmatched.length === 0 && fields.length > 0;

  return (
    <div className="card space-y-4 p-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">اسم القالب</span>
          <input className="input w-full" placeholder="مثلاً: شهادة إتمام دورة" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">البيانات من</span>
          <select
            className="input w-full"
            value={recordSetId}
            onChange={(e) => {
              setRecordSetId(e.target.value);
              setMapping({});
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
        <>
          <div className="space-y-2 rounded-lg bg-sunken p-3">
            <p>
              صمّم الشهادة في Word كما تريد، واكتب المتغيرات بين قوسين مزدوجين حيث تُكتب البيانات. انقر اسماً لنسخه:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {set.columns
                .filter((c) => c.key !== set.subjectColumn)
                .map((c) => (
                  <button key={c.key} type="button" className="rounded border border-line bg-surface px-2 py-0.5 text-xs" onClick={() => copy(c.header)} title="انسخ">
                    {copied === c.header ? "نُسخ ✓" : `{{${c.header}}}`}
                  </button>
                ))}
              {["الرقم_التسلسلي", "رمز_التحقق", "تاريخ_الإصدار"].map((r) => (
                <button key={r} type="button" className="rounded border border-dashed border-line px-2 py-0.5 text-xs text-muted" onClick={() => copy(r)} title="يُملأ عند الإصدار">
                  {copied === r ? "نُسخ ✓" : `{{${r}}}`}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="btn-primary cursor-pointer">
              {file || start?.templateId ? "اختر ملفاً آخر" : "ارفع ملف وورد"}
              <input
                type="file"
                aria-label="ملف وورد"
                className="hidden"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  // A replacement file keeps the choices made for variables of the same name.
                  setFile({ name: f.name, data: await fileBase64(f) });
                  if (!name.trim()) setName(f.name.replace(/\.docx$/i, ""));
                }}
              />
            </label>
            {file && <span className="text-muted">{file.name}</span>}
            {!file && start?.templateId && (
              <button type="button" className="btn-ghost" onClick={() => download({ templateId: start.templateId as any }).then((r) => saveBase64(r.base64, r.fileName)).catch((e) => setError(errorText(e)))}>
                نزّل الملف الحالي لتعديله
              </button>
            )}
            {!hasFile && (
              <button type="button" className="btn-ghost" onClick={() => sample({ spaceId: spaceId as any, recordSetId: recordSetId as any, name }).then((r) => saveBase64(r.base64, r.fileName)).catch((e) => setError(errorText(e)))}>
                ليس عندك ملف؟ نزّل نموذجاً جاهزاً
              </button>
            )}
          </div>
        </>
      )}

      {busy === "read" && <p className="text-muted">جارٍ قراءة الملف…</p>}

      {a && (
        <div className="overflow-auto rounded border border-line">
          <table className="w-full text-xs">
            <thead className="bg-sunken">
              <tr>
                <th className="th">المتغير في الملف</th>
                <th className="th">يُملأ من</th>
              </tr>
            </thead>
            <tbody>
              {a.variables.map((x) => (
                <tr key={x.name} className="border-t border-rule">
                  <td className="td" dir="auto">{`{{${x.name}}}`}</td>
                  <td className="td">
                    {x.reserved ? (
                      <span className="text-muted">{RESERVED_LABEL[x.reserved]} (عند الإصدار)</span>
                    ) : (
                      <select
                        className={`input h-8 ${x.column ? "" : "border-negative"}`}
                        aria-label={`عمود ${x.name}`}
                        value={x.column ?? ""}
                        onChange={(e) => setMapping({ ...mapping, [x.name]: e.target.value })}
                      >
                        <option value="">— اختر عموداً —</option>
                        {set?.columns.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.header}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
              {a.variables.length === 0 && (
                <tr>
                  <td colSpan={2} className="td text-warning">
                    لم نجد متغيرات في الملف. اكتب مثلاً {"{{الاسم}}"} حيث يُكتب الاسم.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {a && a.unmatched.length > 0 && <p className="text-xs text-negative">اختر عموداً لكل متغير، أو صحّح اسمه في الملف.</p>}
      {a && a.missingFonts.length > 0 && (
        <p className="rounded-lg bg-warning-soft p-2 text-xs">
          الخطوط غير موجودة على الخادم وسيُستخدم بديل عنها: <b>{a.missingFonts.join("، ")}</b>. راجع المعاينة، أو اطلب تثبيتها.
        </p>
      )}

      {busy === "preview" && <p className="text-muted">جارٍ إعداد المعاينة…</p>}
      {image && (
        <figure className="space-y-1">
          <figcaption className="text-xs text-muted">المعاينة: كما تُطبع، بأول صف من السجل ورقم ورمز تجريبيين.</figcaption>
          <img src={image} alt="معاينة الشهادة" className="w-full border border-line" />
        </figure>
      )}

      {error && <p className="alert-negative">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!ready || !!busy}
          onClick={async () => {
            setError("");
            setBusy("save");
            try {
              await saveWord({ ...args(), name });
              onDone();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy("");
            }
          }}
        >
          {busy === "save" ? "جارٍ الحفظ…" : start?.templateId ? "احفظ نسخة جديدة" : "احفظ القالب"}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          إلغاء
        </button>
        <span className="text-xs text-muted">النسخة المحفوظة لا تُستخدم حتى تعتمدها.</span>
      </div>
    </div>
  );
}
