// «القوائم» (plans/10): live tables, like a Notion database. A list page (table or board, cells
// edited in place, columns editable), the lists of a space (a tab on the space page), and every
// list I can read (#/lists). The assistant makes and updates them too (create_list, update_list).
// Every permission decision is the server's (lists.ts); canWrite/canDelete only pick the buttons.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { ask, EmptyState, Menu, PageHeader, tell } from "./ui";

type ColType = "text" | "number" | "date" | "status" | "select" | "person" | "check";
type Column = { key: string; name: string; type: ColType; options?: string[] };
type Cell = string | number | boolean | null;
type Row = { _id: string; cells: Record<string, Cell>; order: number; steering?: string | null };
type ListData = {
  list: { _id: string; title: string; description: string; columns: Column[]; view: "table" | "board"; updatedAt: number };
  rows: Row[];
  space: { _id: string; name: string; personal: boolean };
  people: { userId: string; name: string }[];
  canWrite: boolean;
  canDelete: boolean;
};
type Summary = { _id: string; title: string; description: string; rowCount: number; updatedAt: number; spaceId: string };

const TYPE_LABEL: Record<ColType, string> = { text: "نص", number: "رقم", date: "تاريخ", status: "حالة", select: "اختيار", person: "شخص", check: "✓" };
const DONE_RE = /^(منجزة|منجز|تم|مكتملة|مكتمل|done|completed?)$/i;

/** A status value's tone: done → green, the first option → neutral, anything between → in progress. */
function tone(col: Column, v: Cell) {
  if (typeof v !== "string" || !v) return "bg-raised text-faint";
  if (DONE_RE.test(v)) return "bg-positive-soft text-positive";
  if (col.type === "status" && col.options?.[0] === v) return "bg-raised text-muted";
  return col.type === "status" ? "bg-primary-soft text-primary" : "bg-sunken text-ink";
}

const run = (p: Promise<unknown>) => p.catch((e) => void tell(errorText(e)));

// ---------------------------------------------------------------- one cell

function CellEdit({ col, value, people, canWrite, onSave }: { col: Column; value: Cell; people: ListData["people"]; canWrite: boolean; onSave: (v: Cell) => void }) {
  const [draft, setDraft] = useState(value === null || value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === null || value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const next = draft.trim() === "" ? null : col.type === "number" ? draft.trim() : draft;
    if ((next ?? "") !== (value === null || value === undefined ? "" : String(value))) onSave(next);
  };
  const ro = !canWrite;
  switch (col.type) {
    case "check":
      return <input type="checkbox" className="h-4 w-4 accent-[var(--color-primary)]" checked={value === true} disabled={ro} onChange={(e) => onSave(e.target.checked)} aria-label={col.name} />;
    case "status":
    case "select":
      return (
        <select
          className={`h-7 max-w-full rounded-full border-0 px-2.5 text-xs font-medium ${tone(col, value)} ${ro ? "appearance-none" : ""}`}
          value={typeof value === "string" ? value : ""}
          disabled={ro}
          onChange={(e) => onSave(e.target.value || null)}
          aria-label={col.name}
        >
          <option value="">—</option>
          {(col.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "person":
      return (
        <select className="h-7 w-full bg-transparent text-sm outline-none" value={typeof value === "string" ? value : ""} disabled={ro} onChange={(e) => onSave(e.target.value || null)} aria-label={col.name}>
          <option value="">—</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </select>
      );
    case "date":
      return <input type="date" className="h-7 w-full bg-transparent text-sm outline-none" value={typeof value === "string" ? value : ""} disabled={ro} onChange={(e) => onSave(e.target.value || null)} aria-label={col.name} />;
    default:
      return (
        <input
          className={`h-7 w-full min-w-0 bg-transparent text-sm outline-none ${col.type === "number" ? "num" : ""}`}
          dir="auto"
          inputMode={col.type === "number" ? "decimal" : undefined}
          value={draft}
          placeholder={ro ? "" : "…"}
          readOnly={ro}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setDraft(value === null || value === undefined ? "" : String(value));
          }}
          aria-label={col.name}
        />
      );
  }
}

// ---------------------------------------------------------------- columns editor

function ColumnsEditor({ list, onClose }: { list: ListData["list"]; onClose: () => void }) {
  const setColumns = useMutation(api.lists.setColumns);
  const [cols, setCols] = useState<(Column & { optionsText?: string })[]>(() => list.columns.map((c) => ({ ...c, optionsText: (c.options ?? []).join("، ") })));
  const [error, setError] = useState("");
  const set = (i: number, patch: Partial<Column & { optionsText?: string }>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const save = async () => {
    setError("");
    try {
      await setColumns({
        listId: list._id,
        columns: cols.map((c) => ({
          ...(c.key ? { key: c.key } : {}),
          name: c.name,
          type: c.type,
          ...(c.type === "status" || c.type === "select" ? { options: (c.optionsText ?? "").split(/[،,\n]/).map((x) => x.trim()).filter(Boolean) } : {}),
        })),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="card mb-4 animate-rise space-y-2 p-3 text-sm">
      <p className="text-xs text-muted">الأعمدة: حذف عمود أو تغيير نوعه يمسح قيمه.</p>
      {cols.map((c, i) => (
        <div key={c.key || `new-${i}`} className="flex flex-wrap items-center gap-2">
          <input className="input h-8 w-40" value={c.name} maxLength={60} onChange={(e) => set(i, { name: e.target.value })} aria-label="اسم العمود" />
          <select className="input h-8 w-auto" value={c.type} onChange={(e) => set(i, { type: e.target.value as ColType })} aria-label="نوع العمود">
            {(Object.keys(TYPE_LABEL) as ColType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          {(c.type === "status" || c.type === "select") && (
            <input className="input h-8 min-w-0 flex-1" value={c.optionsText ?? ""} onChange={(e) => set(i, { optionsText: e.target.value })} placeholder="الخيارات، بينها فاصلة" aria-label="الخيارات" />
          )}
          <span className="ms-auto flex gap-1">
            <button className="btn-ghost h-8 w-8 px-0" disabled={i === 0} onClick={() => setCols((cs) => cs.map((x, j) => (j === i - 1 ? cs[i]! : j === i ? cs[i - 1]! : x)))} aria-label="قدّم العمود">
              <Icon name="up" size={14} />
            </button>
            <button className="btn-ghost h-8 w-8 px-0" disabled={cols.length === 1} onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))} aria-label="احذف العمود">
              <Icon name="x" size={14} />
            </button>
          </span>
        </div>
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        <button className="btn-ghost h-8" onClick={() => setCols((cs) => [...cs, { key: "", name: `عمود ${cs.length + 1}`, type: "text" }])}>
          <Icon name="plus" size={14} /> عمود
        </button>
        <span className="ms-auto" />
        <button className="btn-primary h-8" onClick={() => void save()}>
          احفظ الأعمدة
        </button>
        <button className="btn-ghost h-8" onClick={onClose}>
          إلغاء
        </button>
      </div>
      {error && <p className="alert-negative">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- the list page

export function ListPage({ listId, go }: { listId: string; go: (p: string) => void }) {
  const data = useQuery(api.lists.get, { listId }) as ListData | undefined;
  const updateRow = useMutation(api.lists.updateRow);
  const addRow = useMutation(api.lists.addRow);
  const removeRow = useMutation(api.lists.removeRow);
  const updateMeta = useMutation(api.lists.updateMeta);
  const remove = useMutation(api.lists.remove);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [editCols, setEditCols] = useState(false);
  const [title, setTitle] = useState("");
  useEffect(() => setTitle(data?.list.title ?? ""), [data?.list.title]);

  const rows = useMemo(() => {
    if (!data) return [];
    const people = new Map(data.people.map((p) => [p.userId, p.name]));
    const text = (r: Row) => data.list.columns.map((c) => (c.type === "person" ? (people.get(String(r.cells[c.key])) ?? "") : String(r.cells[c.key] ?? ""))).join(" ");
    let out = q.trim() ? data.rows.filter((r) => text(r).includes(q.trim())) : [...data.rows];
    if (sort) {
      out.sort((a, b) => {
        const x = a.cells[sort.key] ?? null;
        const y = b.cells[sort.key] ?? null;
        if (x === y) return a.order - b.order;
        if (x === null) return 1;
        if (y === null) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ar")) * sort.dir;
      });
    }
    return out;
  }, [data, q, sort]);

  if (data === undefined) return <p className="p-8 text-sm text-muted">جارٍ التحميل…</p>;
  const { list, people, canWrite } = data;
  const save = (rowId: string, key: string, v: Cell) => void run(updateRow({ rowId, cells: { [key]: v } }));
  const statusCol = list.columns.find((c) => c.type === "status") ?? list.columns.find((c) => c.type === "select");
  const done = statusCol?.type === "status" ? data.rows.filter((r) => DONE_RE.test(String(r.cells[statusCol.key] ?? ""))).length : null;
  const firstText = list.columns.find((c) => c.type === "text") ?? list.columns[0]!;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 lg:px-8 lg:py-9">
      <a href={`#/space/${data.space._id}/lists`} className="text-xs text-muted hover:text-ink">
        {data.space.name} · القوائم
      </a>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <input
          className="min-w-0 flex-1 bg-transparent text-2xl font-bold outline-none"
          value={title}
          readOnly={!canWrite}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== list.title && void run(updateMeta({ listId, title }))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="اسم القائمة"
        />
        {statusCol && done !== null && data.rows.length > 0 && (
          <span className="num text-sm text-muted">
            {done}/{data.rows.length} منجزة
          </span>
        )}
        <div className="flex rounded-md border border-line p-0.5" role="tablist" aria-label="طريقة العرض">
          {(["table", "board"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={list.view === v}
              className={`h-7 rounded px-2.5 text-xs ${list.view === v ? "bg-active font-medium" : "text-muted"}`}
              onClick={() => canWrite && list.view !== v && void run(updateMeta({ listId, view: v }))}
              disabled={!canWrite || (v === "board" && !statusCol)}
              title={v === "board" && !statusCol ? "اللوحة تحتاج عمود حالة" : undefined}
            >
              {v === "table" ? "جدول" : "لوحة"}
            </button>
          ))}
        </div>
        {(canWrite || data.canDelete) && (
          <Menu
            label="خيارات القائمة"
            items={[
              ...(canWrite ? [{ label: "الأعمدة", icon: "table" as const, onSelect: () => setEditCols(true) }] : []),
              ...(data.canDelete
                ? [
                    {
                      label: "احذف القائمة",
                      icon: "x" as const,
                      danger: true,
                      onSelect: () =>
                        void ask(`حذف «${list.title}» وكل صفوفها؟`, { danger: true, confirmLabel: "حذف" }).then(async (ok) => {
                          if (ok) await run(remove({ listId }).then(() => go(`/space/${data.space._id}/lists`)));
                        }),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </div>
      {list.description && <p className="mt-1 text-sm text-muted">{list.description}</p>}

      <div className="mt-4">{editCols && <ColumnsEditor list={list} onClose={() => setEditCols(false)} />}</div>

      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line px-2.5 sm:max-w-72">
          <Icon name="search" size={14} className="text-faint" />
          <input className="min-w-0 flex-1 bg-transparent text-sm outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث في القائمة…" aria-label="بحث في القائمة" />
        </div>
        <span className="ms-auto text-xs text-faint">تُحفظ التعديلات فوراً ويراها كل من يفتح القائمة</span>
      </div>

      {list.view === "board" && statusCol ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {[...(statusCol.options ?? []), ""].map((opt) => {
            const items = rows.filter((r) => (r.cells[statusCol.key] ?? "") === opt);
            if (opt === "" && !items.length) return null;
            return (
              <section key={opt || "none"} className="w-64 shrink-0 rounded-lg bg-sunken p-2">
                <h3 className="mb-2 flex items-center gap-2 px-1 text-xs font-medium">
                  <span className={`rounded-full px-2 py-0.5 ${tone(statusCol, opt || null)}`}>{opt || "بلا حالة"}</span>
                  <span className="num text-faint">{items.length}</span>
                </h3>
                <ul className="space-y-2">
                  {items.map((r) => (
                    <li key={r._id} className="rounded-md border border-line bg-surface p-2 text-sm">
                      <p className="font-medium" dir="auto">
                        {String(r.cells[firstText.key] ?? "—")}
                      </p>
                      <div className="mt-1 space-y-0.5 text-xs text-muted">
                        {list.columns
                          .filter((c) => c.key !== firstText.key && c.key !== statusCol.key && r.cells[c.key] !== null && r.cells[c.key] !== undefined && r.cells[c.key] !== "")
                          .map((c) => (
                            <p key={c.key}>
                              {c.name}: {c.type === "person" ? (people.find((p) => p.userId === r.cells[c.key])?.name ?? "؟") : c.type === "check" ? (r.cells[c.key] ? "✓" : "✗") : String(r.cells[c.key])}
                            </p>
                          ))}
                      </div>
                      <div className="mt-2">
                        <CellEdit col={statusCol} value={r.cells[statusCol.key] ?? null} people={people} canWrite={canWrite} onSave={(v) => save(r._id, statusCol.key, v)} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-line bg-sunken text-xs text-muted">
                {list.columns.map((c) => (
                  <th key={c.key} className="px-2 py-2 text-start font-medium">
                    <button className="inline-flex items-center gap-1" onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}>
                      {c.name}
                      <span className="text-[10px] text-faint">{TYPE_LABEL[c.type]}</span>
                      {sort?.key === c.key && <Icon name={sort.dir === 1 ? "up" : "down"} size={12} />}
                    </button>
                  </th>
                ))}
                {canWrite && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id} className="group border-b border-rule last:border-0 hover:bg-sunken/50">
                  {list.columns.map((c, k) => (
                    <td key={c.key} className="px-2 py-1 align-middle">
                      {k === 0 && r.steering && (
                        <span className="badge-warning mb-0.5 inline-block text-[11px]" title={`يقرأ المساعد هذا الرد بيانات لا تعليمات. النص: «${r.steering}»`}>
                          فيه نص موجّه للمساعد
                        </span>
                      )}
                      <CellEdit col={c} value={r.cells[c.key] ?? null} people={people} canWrite={canWrite} onSave={(v) => save(r._id, c.key, v)} />
                    </td>
                  ))}
                  {canWrite && (
                    <td className="px-1">
                      <button className="btn-ghost h-7 w-7 px-0 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void run(removeRow({ rowId: r._id }))} aria-label="احذف الصف">
                        <Icon name="x" size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={list.columns.length + 1} className="px-3 py-6 text-center text-sm text-muted">
                    {q ? "لا نتائج." : "لا صفوف بعد."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && (
        <button className="btn-ghost mt-2 h-8" onClick={() => void run(addRow({ listId, ...(statusCol?.options?.[0] ? { cells: { [statusCol.key]: statusCol.options[0] } } : {}) }))}>
          <Icon name="plus" size={14} /> صف جديد
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- lists of a space / all my lists

function NewList({ spaceId, go, onCancel }: { spaceId: string; go: (p: string) => void; onCancel: () => void }) {
  const create = useMutation(api.lists.create);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    try {
      go(`/list/${await create({ spaceId, title })}`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="card mb-4 space-y-2 p-3">
      <div className="flex gap-2">
        <input className="input h-9 min-w-0 flex-1" autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && void submit()} placeholder="اسم القائمة: مهام اليوم، متابعة المتدربين…" aria-label="اسم القائمة" />
        <button className="btn-primary h-9" disabled={!title.trim()} onClick={() => void submit()}>
          أنشئ
        </button>
        <button className="btn-ghost h-9" onClick={onCancel}>
          إلغاء
        </button>
      </div>
      <p className="text-xs text-faint">تبدأ بأعمدة: المهمة، الحالة، الموعد. غيّرها من «الأعمدة». أو اطلبها من المساعد: «سوّ لي قائمة لمتابعة…».</p>
      {error && <p className="alert-negative">{error}</p>}
    </div>
  );
}

function ListRows({ lists, spaceName }: { lists: (Summary & { spaceName?: string })[]; spaceName?: boolean }) {
  return (
    <ul className="card divide-y divide-rule">
      {lists.map((l) => (
        <li key={l._id}>
          <a href={`#/list/${l._id}`} className="flex items-center gap-3 p-3 hover:bg-sunken">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
              <Icon name="table" size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{l.title}</span>
              <span className="meta block truncate">
                {spaceName && l.spaceName ? `${l.spaceName} · ` : ""}
                {l.rowCount} صف · {formatDate(l.updatedAt)}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The «القوائم» tab of a space. */
export function SpaceLists({ spaceId, go }: { spaceId: string; go: (p: string) => void }) {
  const data = useQuery(api.lists.forSpace, { spaceId }) as { canWrite: boolean; lists: Summary[] } | undefined;
  const [adding, setAdding] = useState(false);
  if (data === undefined) return <p className="text-sm text-muted">جارٍ التحميل…</p>;
  return (
    <div>
      {data.canWrite && !adding && (
        <div className="mb-4 flex">
          <button className="btn-secondary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> قائمة جديدة
          </button>
        </div>
      )}
      {adding && <NewList spaceId={spaceId} go={go} onCancel={() => setAdding(false)} />}
      {data.lists.length === 0 && !adding ? (
        <EmptyState icon="table" title="لا قوائم بعد">
          جداول حية يحدّثها الفريق ويتابعها: مهام، متابعة، حضور، خطة. أنشئ واحدة، أو اطلب من المساعد في محادثة هنا: «سوّ لي قائمة بـ…».
        </EmptyState>
      ) : (
        <ListRows lists={data.lists} />
      )}
    </div>
  );
}

/** #/lists: every list I can read; a new one goes to the space I pick (my personal space first). */
export function ListsPage({ spaces, go }: { spaces: SpaceInfo[]; go: (p: string) => void }) {
  const lists = useQuery(api.lists.recent) as (Summary & { spaceName: string; personal: boolean })[] | undefined;
  const writable = spaces.filter((s) => s.canWrite).sort((a, b) => (a.kind === "personal" ? -1 : b.kind === "personal" ? 1 : 0));
  const [spaceId, setSpaceId] = useState<string | null>(null);
  return (
    <div className="mx-auto w-full max-w-[860px] px-4 py-6 lg:py-9">
      <PageHeader
        title="القوائم"
        subtitle="جداول حية تعدّلها مكانها ويحدّثها المساعد: مهامك، متابعاتك، وما يتابعه فريقك في كل مساحة."
        actions={
          writable.length > 0 &&
          !spaceId && (
            <button className="btn-primary" onClick={() => setSpaceId(writable[0]!._id)}>
              <Icon name="plus" /> قائمة جديدة
            </button>
          )
        }
      />
      {spaceId && (
        <>
          {writable.length > 1 && (
            <label className="mb-2 flex items-center gap-2 text-sm">
              <span className="text-muted">في:</span>
              <select className="input h-8 w-auto" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
                {writable.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.kind === "personal" ? "مساحتي" : s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <NewList spaceId={spaceId} go={go} onCancel={() => setSpaceId(null)} />
        </>
      )}
      {lists === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : lists.length === 0 && !spaceId ? (
        <EmptyState icon="table" title="لا قوائم بعد">
          اطلب من المساعد «رتّب مهامي اليوم» أو «سوّ لي قائمة لمتابعة…» فيصنع قائمة تعدّلها وتعود إليها، أو أنشئ واحدة بنفسك.
        </EmptyState>
      ) : (
        <ListRows lists={lists} spaceName />
      )}
    </div>
  );
}
