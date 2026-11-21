// «الأدوات» (admin console, plans/08 §B): what each tool does, who may use it (agents, levels) and
// how it's doing (runs and failures in the last 7 days). Tools are defined in code; this page
// explains and shows them, and links to where they're switched on and off.

import { useState } from "react";
import { useQuery } from "onebase/react";
import { api } from "./lib";
import { Icon } from "./icons";
import { PageHeader } from "./ui";

/** Plain-Arabic explanations (the registry's descriptions are written for the model). */
const ABOUT: Record<string, string> = {
  search_documents: "يبحث في نصوص الملفات التي يملك الموظف قراءتها ويعيد أنسب النتائج مع مصادرها.",
  read_file: "يقرأ نص ملف بعينه كاملاً أو صفحات منه، حين لا تكفي نتائج البحث.",
  query_records: "يستعلم في السجلات المنظّمة (المتدربون والدورات والدرجات) في المساحات التي الموظف عضو فيها.",
  my_records: "يجلب سجلات الموظف نفسه: دوراته ونتائجه وشهاداته، ولا يجيب عن غيره.",
  create_artifact: "ينشئ مخرجاً: مستنداً أو جدولاً أو صفحة، يظهر في اللوحة الجانبية ويُحفظ ملفاً.",
  update_artifact: "يعدّل مخرجاً موجوداً بنسخة جديدة.",
  fill_template: "يجهّز مسودات مستندات رسمية (مثل الشهادات) من قالب معتمد وسجل أو أكثر، لمدير المساحة ليعتمدها.",
  propose_record_set: "يقترح إنشاء سجل من ملف Excel في المحادثة: يقرأ الأعمدة وأنواعها وصاحب كل سطر، ويؤكد المستخدم.",
  export_document: "يصنع ملف Word أو PDF أو عرض تقديمي، من مخرج موجود أو من نص جديد.",
  run_analysis: "يكتب كود Python ويشغّله في بيئة معزولة بلا إنترنت على الملفات المختارة.",
  query_source: "يقرأ من مصادر البيانات الخارجية (قواعد بيانات وأنظمة ومحركات بحث)، للقراءة فقط.",
};

export function ToolsView() {
  const tools = useQuery(api.toolsAdmin.overview);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <PageHeader
        title="الأدوات"
        subtitle="ما يستطيع المساعد فعله. الأداة لا توسّع الصلاحيات: تعمل بصلاحيات الموظف، وما يكتب منها في مساحة مشتركة ينتظر «نفّذ». تُتاح الأداة لوكيل من صفحة الوكلاء، ولموظف من مستواه."
      />
      {!tools ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : (
        <ul className="card divide-y divide-rule">
          {tools.map((t) => {
            const expanded = open === t.name;
            const rate = t.ran7d ? Math.round((t.failed7d / t.ran7d) * 100) : 0;
            return (
              <li key={t.name}>
                <button className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-start hover:bg-active" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : t.name)}>
                  <span className="min-w-56 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">
                      {t.label}
                      {t.writes ? <span className="badge-warning">يكتب</span> : <span className="badge">قراءة</span>}
                      <code className="text-[11px] text-faint" dir="ltr">
                        {t.name}
                      </code>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{ABOUT[t.name] ?? ""}</span>
                  </span>
                  <span className="w-24 text-xs text-muted">
                    <span className="num font-medium text-ink">{t.agents.length}</span> وكيل
                  </span>
                  <span className="w-32 text-xs">
                    <span className="num font-medium">{t.ran7d}</span> <span className="text-muted">تشغيلاً هذا الأسبوع</span>
                    {t.failed7d > 0 && <span className={`block ${rate >= 20 ? "text-negative" : "text-warning"}`}>{t.failed7d} تعثّر</span>}
                  </span>
                  <Icon name={expanded ? "up" : "down"} size={14} className="text-faint" />
                </button>
                {expanded && (
                  <div className="grid gap-4 bg-sunken/50 px-4 py-3 text-sm @2xl:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted">الوكلاء الذين يستخدمونها</p>
                      {t.agents.length ? (
                        <div className="flex flex-wrap gap-1">
                          {t.agents.map((a) => (
                            <a key={a._id} href="#/admin/agents" className={a.enabled ? "badge" : "badge opacity-60"}>
                              {a.name}
                            </a>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted">لا وكيل منشور.</p>
                      )}
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted">المستويات التي تسمح بها</p>
                      {t.levelsTotal === 0 ? (
                        <p className="text-xs text-muted">لا مستويات: متاحة لكل الموظفين.</p>
                      ) : t.levels.length ? (
                        <div className="flex flex-wrap gap-1">
                          {t.levels.map((l) => (
                            <a key={l} href="#/admin/levels" className="badge">
                              {l}
                            </a>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-warning">لا مستوى يسمح بها.</p>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
