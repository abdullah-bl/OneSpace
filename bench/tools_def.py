"""15 realistic workspace tools (OpenAI function format) + case generator with known expected tool/args."""
import random


def fn(name, desc, props, required):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props, "required": required, "additionalProperties": False}}}


S = {"type": "string"}
TOOLS = [
    fn("search_documents", "البحث في مستندات المساحات المسموحة للمستخدم وإرجاع قائمة بعناوين ومعرّفات المستندات المطابقة (بدون المحتوى).",
       {"query": {"type": "string", "description": "نص البحث"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, ["query"]),
    fn("read_document", "قراءة النص الكامل لمستند معيّن بمعرّفه.", {"doc_id": {"type": "string"}}, ["doc_id"]),
    fn("create_task", "إنشاء مهمة جديدة وإسنادها لموظف.",
       {"title": S, "assignee": {"type": "string", "description": "اسم الموظف"}, "due_date": {"type": "string", "description": "YYYY-MM-DD"},
        "priority": {"type": "string", "enum": ["low", "medium", "high"]}, "description": S}, ["title", "assignee"]),
    fn("list_tasks", "عرض المهام الحالية مع إمكانية التصفية حسب الحالة أو الموظف.",
       {"status": {"type": "string", "enum": ["open", "in_progress", "done"]}, "assignee": S}, []),
    fn("send_notification", "إرسال إشعار نصي داخلي لموظف.", {"user": {"type": "string", "description": "اسم الموظف"}, "message": S}, ["user", "message"]),
    fn("schedule_meeting", "جدولة اجتماع في التقويم مع حضور محددين.",
       {"title": S, "attendees": {"type": "array", "items": S, "minItems": 1}, "date": {"type": "string", "description": "YYYY-MM-DD"},
        "time": {"type": "string", "description": "HH:MM"}, "duration_minutes": {"type": "integer"}}, ["title", "attendees", "date", "time"]),
    fn("get_employee", "جلب بيانات موظف (الإدارة، المسمى، المدير المباشر، رقم الموظف) بالاسم.", {"name": S}, ["name"]),
    fn("get_leave_balance", "الاستعلام عن رصيد الإجازات المتبقي لموظف.", {"employee_name": S,
       "leave_type": {"type": "string", "enum": ["annual", "sick", "emergency"]}}, ["employee_name"]),
    fn("submit_leave_request", "تقديم طلب إجازة لموظف.", {"employee_name": S, "leave_type": {"type": "string", "enum": ["annual", "sick", "emergency"]},
       "start_date": {"type": "string", "description": "YYYY-MM-DD"}, "end_date": {"type": "string", "description": "YYYY-MM-DD"}},
       ["employee_name", "leave_type", "start_date", "end_date"]),
    fn("calculate", "تنفيذ عملية حسابية بدقة. استخدمها لأي حساب رقمي.", {"expression": {"type": "string", "description": "تعبير حسابي مثل (540000-480000)/480000*100"}}, ["expression"]),
    fn("run_analysis", "تحليل ملف بيانات (CSV/Excel) بكود في بيئة معزولة والإجابة عن سؤال تحليلي.",
       {"file_name": S, "question": S}, ["file_name", "question"]),
    fn("create_document", "إنشاء مستند جديد (مذكرة، تقرير، خطاب) من قالب.",
       {"title": S, "template": {"type": "string", "enum": ["memo", "report", "letter"]}, "content": S}, ["title", "template", "content"]),
    fn("translate_text", "ترجمة نص إلى لغة أخرى.", {"text": S, "target_language": {"type": "string", "enum": ["ar", "en", "fr"]}}, ["text", "target_language"]),
    fn("get_budget", "الاستعلام عن ميزانية إدارة لسنة مالية محددة.", {"department": S, "year": {"type": "integer"}}, ["department", "year"]),
    fn("summarize_conversation", "تلخيص محادثة سابقة بمعرّفها.", {"conversation_id": S, "max_words": {"type": "integer"}}, ["conversation_id"]),
]
TOOL_BY_NAME = {t["function"]["name"]: t for t in TOOLS}

NAMES = ["سارة العتيبي", "خالد الشهري", "نورة القحطاني", "فهد الدوسري", "ريم الزهراني", "عبدالله الحربي", "منى السبيعي", "ماجد المطيري"]
DEPTS = ["المالية", "الموارد البشرية", "تقنية المعلومات", "المشتريات", "الشؤون القانونية"]
TOPICS = ["سياسة العمل عن بعد", "لائحة المشتريات", "خطة التدريب السنوية", "عقد صيانة الأجهزة", "تقرير الحضور الشهري", "سياسة أمن المعلومات"]
DATES = ["2026-12-03", "2026-12-10", "2026-12-15", "2027-01-05", "2027-01-20"]
TIMES = ["09:00", "10:30", "13:00", "14:15"]
FILES = ["employees.csv", "purchases_2026.xlsx", "attendance_oct.csv"]

# (expected tool, template, arg-checks) — checks: {arg: substring expected in value}
TEMPLATES = [
    ("search_documents", "ابحث لي عن المستندات المتعلقة بـ{topic}", {"query": "{topic_k}"}),
    ("search_documents", "هل عندنا أي ملف يتكلم عن {topic}؟ أبي أشوف وش موجود", {}),
    ("read_document", "اقرأ المستند رقم DOC-{n} وقل لي محتواه", {"doc_id": "{n}"}),
    ("read_document", "افتح الوثيقة ذات المعرّف DOC-{n}", {"doc_id": "{n}"}),
    ("create_task", "أنشئ مهمة لـ{name} بعنوان مراجعة {topic} تنتهي في {date} بأولوية عالية", {"assignee": "{name_k}", "due_date": "{date}", "priority": "high"}),
    ("create_task", "كلّف {name} بإعداد تقرير عن {topic}", {"assignee": "{name_k}"}),
    ("list_tasks", "وش المهام المفتوحة عند {name}؟", {"assignee": "{name_k}"}),
    ("list_tasks", "اعرض لي كل المهام المنجزة", {"status": "done"}),
    ("send_notification", "أرسل إشعار لـ{name} إن اجتماع {topic} تأجل", {"user": "{name_k}"}),
    ("send_notification", "بلّغ {name} أن عليه تسليم ملف {topic} اليوم", {"user": "{name_k}"}),
    ("schedule_meeting", "احجز اجتماع عن {topic} مع {name} و{name2} يوم {date} الساعة {time}", {"date": "{date}", "time": "{time}"}),
    ("schedule_meeting", "رتّب اجتماع مع {name} بتاريخ {date} الساعة {time} لمناقشة {topic}", {"date": "{date}", "time": "{time}"}),
    ("get_employee", "من المدير المباشر لـ{name}؟", {"name": "{name_k}"}),
    ("get_employee", "أعطني بيانات الموظف {name}", {"name": "{name_k}"}),
    ("get_leave_balance", "كم باقي من رصيد الإجازة السنوية لـ{name}؟", {"employee_name": "{name_k}"}),
    ("get_leave_balance", "كم يوم إجازة مرضية متبقي عند {name}؟", {"employee_name": "{name_k}", "leave_type": "sick"}),
    ("submit_leave_request", "قدّم طلب إجازة سنوية لـ{name} من {date} إلى {date2}", {"employee_name": "{name_k}", "leave_type": "annual", "start_date": "{date}", "end_date": "{date2}"}),
    ("submit_leave_request", "أبي إجازة اضطرارية لـ{name} من {date} لين {date2}", {"leave_type": "emergency", "start_date": "{date}"}),
    ("calculate", "احسب نسبة الزيادة من {a} إلى {b}", {}),
    ("calculate", "كم يساوي {a} مضروب في {n} ثم مقسوم على 12؟", {}),
    ("run_analysis", "حلل ملف {file} وقل لي متوسط الرواتب حسب الإدارة", {"file_name": "{file}"}),
    ("run_analysis", "من ملف {file} طلع لي أكثر 5 موظفين غياباً", {"file_name": "{file}"}),
    ("create_document", "اكتب مذكرة رسمية بعنوان تعميم بشأن {topic} توضح ضرورة الالتزام بها", {"template": "memo"}),
    ("create_document", "أنشئ خطاباً موجهاً لإدارة {dept} بخصوص {topic}", {"template": "letter"}),
    ("translate_text", "ترجم للإنجليزية: نرجو منكم الالتزام بمواعيد الحضور", {"target_language": "en"}),
    ("translate_text", "Translate to Arabic: The meeting has been moved to next week", {"target_language": "ar"}),
    ("get_budget", "كم ميزانية إدارة {dept} لسنة {year}؟", {"department": "{dept}", "year": "{year}"}),
    ("get_budget", "أبي أعرف ميزانية {dept} في {year}", {"department": "{dept}", "year": "{year}"}),
    ("summarize_conversation", "لخص لي المحادثة رقم CONV-{n}", {"conversation_id": "{n}"}),
    ("summarize_conversation", "أعطني ملخصاً في 50 كلمة للمحادثة CONV-{n}", {"conversation_id": "{n}"}),
]

# confusable groups -> used to pick hard distractors
CONFUSABLE = {
    "search_documents": ["read_document", "summarize_conversation", "run_analysis"],
    "read_document": ["search_documents", "summarize_conversation"],
    "create_task": ["list_tasks", "send_notification", "schedule_meeting"],
    "list_tasks": ["create_task"],
    "send_notification": ["schedule_meeting", "create_task", "create_document"],
    "schedule_meeting": ["send_notification", "create_task"],
    "get_employee": ["get_leave_balance"],
    "get_leave_balance": ["submit_leave_request", "get_employee"],
    "submit_leave_request": ["get_leave_balance"],
    "calculate": ["run_analysis", "get_budget"],
    "run_analysis": ["calculate", "read_document"],
    "create_document": ["send_notification", "translate_text"],
    "translate_text": ["create_document"],
    "get_budget": ["calculate", "run_analysis"],
    "summarize_conversation": ["read_document", "search_documents"],
}


def make_cases(n, seed=7):
    rng = random.Random(seed)
    cases = []
    for i in range(n):
        tool, tpl, checks = TEMPLATES[i % len(TEMPLATES)]
        name, name2 = rng.sample(NAMES, 2)
        d1, d2 = sorted(rng.sample(DATES, 2))
        topic = rng.choice(TOPICS)
        v = dict(name=name, name2=name2, name_k=name.split()[0], date=d1, date2=d2, topic=topic,
                 topic_k=topic.split()[-1], time=rng.choice(TIMES), n=str(rng.randint(100, 999)),
                 file=rng.choice(FILES), dept=rng.choice(DEPTS), year=str(rng.choice([2025, 2026, 2027])),
                 a=str(rng.choice([480000, 125000, 96000])), b=str(rng.choice([540000, 150000, 110000])))
        cases.append({"id": i, "prompt": tpl.format(**v), "tool": tool,
                      "checks": {k: c.format(**v) for k, c in checks.items()}})
    return cases


def toolset(expected, k, seed):
    rng = random.Random(seed)
    if k >= len(TOOLS):
        names = [t["function"]["name"] for t in TOOLS]
    else:
        conf = [c for c in CONFUSABLE[expected]][: k - 1]
        rest = [t["function"]["name"] for t in TOOLS if t["function"]["name"] not in conf + [expected]]
        rng.shuffle(rest)
        names = [expected] + conf + rest[: k - 1 - len(conf)]
    rng.shuffle(names)
    return [TOOL_BY_NAME[n] for n in names]


def validate_args(tool_name, args):
    """Strict JSON-schema-lite validation. Returns list of problems."""
    p = []
    if tool_name not in TOOL_BY_NAME:
        return [f"unknown tool {tool_name}"]
    sch = TOOL_BY_NAME[tool_name]["function"]["parameters"]
    if not isinstance(args, dict):
        return ["arguments not an object"]
    for r in sch["required"]:
        if r not in args:
            p.append(f"missing {r}")
    for k, v in args.items():
        if k not in sch["properties"]:
            p.append(f"extra {k}")
            continue
        ps = sch["properties"][k]
        t = ps.get("type")
        ok = {"string": isinstance(v, str), "integer": isinstance(v, int) and not isinstance(v, bool),
              "array": isinstance(v, list)}.get(t, True)
        if not ok:
            p.append(f"type {k}")
        if "enum" in ps and v not in ps["enum"]:
            p.append(f"enum {k}={v}")
    return p
