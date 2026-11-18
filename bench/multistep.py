"""Multi-step agent tasks (3–6+ tool steps) against mock tools with a final-state checker."""
import json, re
from tools_def import TOOL_BY_NAME
from lib import chat, digits_only, norm_ar

DOCS = {
    "DOC-101": ("ميزانية التدريب لعام 2025", "اعتُمدت ميزانية التدريب لجميع الإدارات لعام 2025 بمبلغ إجمالي قدره 480,000 ريال، تُصرف على الدورات الداخلية والخارجية."),
    "DOC-102": ("ميزانية التدريب لعام 2026", "اعتُمدت ميزانية التدريب لعام 2026 بمبلغ إجمالي قدره 540,000 ريال، مع تخصيص 30% منها للشهادات المهنية."),
    "DOC-103": ("تقرير الحضور والغياب - أكتوبر 2026", "عدد أيام الغياب بدون عذر في شهر أكتوبر: إدارة المالية 14 يوماً، إدارة الموارد البشرية 9 أيام، إدارة تقنية المعلومات 21 يوماً."),
    "DOC-104": ("الهيكل التنظيمي للإدارة", "مدير إدارة المالية: خالد الشهري. مديرة إدارة الموارد البشرية: نورة القحطاني. مديرة إدارة تقنية المعلومات: سارة العتيبي. مدير الإدارة العامة: عبدالله الحربي."),
    "DOC-105": ("سياسة العمل عن بعد", "يجوز للموظف العمل عن بعد بحد أقصى يومين في الأسبوع بعد موافقة المدير المباشر، ولا يشمل ذلك فترة التجربة."),
    "DOC-106": ("عقد صيانة الأجهزة", "عقد صيانة أجهزة الحاسب مع شركة التقنية المتقدمة بقيمة 96,000 ريال لمدة 12 شهراً، وينتهي العقد في 2026-12-31 ويحتاج تجديده إلى طلب قبل 30 يوماً من انتهائه."),
    "DOC-107": ("مشتريات الربع الثالث 2026", "بنود المشتريات في الربع الثالث: أجهزة حاسب محمول 45,250 ريال، أثاث مكتبي 18,900 ريال، أدوات قرطاسية 7,350 ريال."),
    "DOC-108": ("دليل الموظف الجديد", "يحصل الموظف الجديد على بطاقة دخول وبريد إلكتروني خلال 3 أيام عمل من مباشرته، ويحضر برنامج التهيئة في أول أسبوع."),
}


class Env:
    def __init__(self):
        self.calls, self.docs_created, self.tasks, self.notes = [], [], [], []

    def run(self, name, a):
        self.calls.append((name, a))
        if name == "search_documents":
            q = set(norm_ar(a.get("query", "")).split())
            scored = []
            for i, (t, c) in DOCS.items():
                words = set(norm_ar(t + " " + c).split())
                s = sum(1 for w in q if any(w in x or x in w for x in words if len(x) > 2) and len(w) > 2)
                scored.append((s, i, t))
            scored.sort(reverse=True)
            return json.dumps([{"doc_id": i, "title": t} for s, i, t in scored[:3] if s > 0] or [], ensure_ascii=False)
        if name == "read_document":
            d = DOCS.get(str(a.get("doc_id", "")).strip())
            return json.dumps({"title": d[0], "content": d[1]}, ensure_ascii=False) if d else '{"error":"not found"}'
        if name == "calculate":
            e = digits_only(str(a.get("expression", ""))).replace("×", "*").replace("÷", "/").replace(",", "")
            if not re.fullmatch(r"[\d\s+\-*/().%]+", e):
                return '{"error":"invalid expression"}'
            try:
                return json.dumps({"result": round(eval(e), 4)})
            except Exception as ex:
                return json.dumps({"error": str(ex)})
        if name == "create_document":
            self.docs_created.append(a); return '{"ok":true,"doc_id":"DOC-900"}'
        if name == "create_task":
            self.tasks.append(a); return '{"ok":true,"task_id":"T-%d"}' % len(self.tasks)
        if name == "send_notification":
            self.notes.append(a); return '{"ok":true}'
        if name == "get_employee":
            return '{"error":"استخدم الهيكل التنظيمي في المستندات"}'
        return '{"error":"tool not available"}'


TOOLS = [TOOL_BY_NAME[n] for n in ["search_documents", "read_document", "calculate", "create_document", "create_task", "send_notification", "get_employee"]]


def has_num(s, *nums):
    s = digits_only(s)
    return any(re.search(r"(?<![\d.])" + re.escape(n) + r"(?![\d])", s) for n in nums)


def blob(d):
    return json.dumps(d, ensure_ascii=False)


TASKS = [
    ("ابحث في المستندات عن ميزانية التدريب لعامي 2025 و2026، واحسب نسبة الزيادة المئوية، ثم أنشئ مذكرة بعنوان 'ملخص ميزانية التدريب' تذكر فيها النسبة.",
     lambda e: any(has_num(blob(d), "12.5") for d in e.docs_created), 4),
    ("ما الحد الأقصى لأيام العمل عن بعد أسبوعياً حسب السياسة؟ أرسل الجواب في إشعار للموظف فهد الدوسري.",
     lambda e: any("فهد" in n.get("user", "") and (has_num(n.get("message", ""), "2") or "يومين" in n.get("message", "") or "يومان" in n.get("message", "")) for n in e.notes), 3),
    ("احسب التكلفة الشهرية لعقد صيانة الأجهزة من المستندات، وأنشئ تقريراً قصيراً بها.",
     lambda e: any(has_num(blob(d), "8000") for d in e.docs_created), 4),
    ("اجمع إجمالي أيام الغياب بدون عذر لكل الإدارات في أكتوبر وأنشئ تقريراً بالمجموع.",
     lambda e: any(has_num(blob(d), "44") for d in e.docs_created), 4),
    ("حدد الإدارة صاحبة أعلى غياب في تقرير أكتوبر، ثم أنشئ مهمة لمدير/مديرة تلك الإدارة (من الهيكل التنظيمي) لمراجعة أسباب الغياب.",
     lambda e: any("سارة" in t.get("assignee", "") for t in e.tasks), 5),
    ("احسب إجمالي مشتريات الربع الثالث، وأنشئ تقريراً بالإجمالي، ثم أرسل إشعاراً لمدير إدارة المالية (حسب الهيكل التنظيمي) يخبره بالإجمالي.",
     lambda e: any(has_num(blob(d), "71500") for d in e.docs_created) and any("خالد" in n.get("user", "") and has_num(n.get("message", ""), "71500") for n in e.notes), 6),
    ("عقد صيانة الأجهزة يحتاج تجديداً. حدد آخر موعد لطلب التجديد حسب العقد، وأنشئ مهمة لمديرة تقنية المعلومات بتاريخ استحقاق هو ذلك الموعد.",
     lambda e: any("سارة" in t.get("assignee", "") and t.get("due_date", "") in ("2026-12-01", "2026-11-30") for t in e.tasks), 5),
    ("احسب الفرق بين ميزانية التدريب 2026 و2025 بالريال، وأرسل الفرق في إشعار لمدير إدارة المالية حسب الهيكل التنظيمي.",
     lambda e: any("خالد" in n.get("user", "") and has_num(n.get("message", ""), "60000") for n in e.notes), 6),
    ("احسب متوسط أيام الغياب للإدارة الواحدة في أكتوبر (لأقرب منزلتين عشريتين) وأنشئ مذكرة بالنتيجة.",
     lambda e: any(has_num(blob(d), "14.67", "14.66") for d in e.docs_created), 5),
    ("لكل إدارة في تقرير غياب أكتوبر، أنشئ مهمة لمديرها (من الهيكل التنظيمي) لمراجعة الغياب، واذكر في عنوان أو وصف كل مهمة عدد أيام غياب إدارته.",
     lambda e: all(any(nm in t.get("assignee", "") and has_num(blob(t), n) for t in e.tasks)
                   for nm, n in [("خالد", "14"), ("نورة", "9"), ("سارة", "21")]), 7),
]

SYSTEM = ("أنت وكيل إداري داخل مساحة عمل. استخدم الأدوات للحصول على المعلومات ولا تخمّن أي رقم أو اسم أو معرّف. "
          "استخدم أداة calculate لأي حساب. نفّذ المطلوب كاملاً بالأدوات ثم اختم برد قصير للمستخدم. التاريخ اليوم 2026-11-18.")


def run_task(task, think=False, max_turns=14, base=None, model=None):
    prompt, check, steps = task
    env = Env()
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]
    format_errors = 0; t_total = 0; toks = 0
    for turn in range(max_turns):
        try:
            m, raw, dt = chat(msgs, tools=TOOLS, think=think, max_tokens=4096 if think else 1024, base=base, model=model)
        except Exception as ex:
            return {"ok": False, "error": str(ex)[:200], "calls": len(env.calls)}
        t_total += dt; toks += raw["usage"]["completion_tokens"]
        tcs = m.get("tool_calls") or []
        msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": tcs} if tcs else {"role": "assistant", "content": m.get("content") or ""})
        if not tcs:
            break
        for tc in tcs:
            try:
                args = json.loads(tc["function"]["arguments"])
            except Exception:
                format_errors += 1; args = {}
            res = env.run(tc["function"]["name"], args)
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": res})
    ok = bool(check(env))
    return {"ok": ok, "expected_steps": steps, "tool_calls": len(env.calls), "turns": turn + 1,
            "format_errors": format_errors, "seconds": round(t_total, 1), "completion_tokens": toks,
            "trace": [(n, a) for n, a in env.calls], "final": (msgs[-1].get("content") or "")[:300]}
