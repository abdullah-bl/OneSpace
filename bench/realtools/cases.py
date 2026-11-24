"""Cases for the real-tools bench: an Arabic request, the prompt context the app would give, the
tool(s) that are a right first call, and checks on its arguments.

The context mimics what chat.ts puts in the system prompt (space files with ids, «القوائم الحية هنا»,
«المخرجات هنا», «المهارات المتاحة», external sources), with ids shaped like real OneBase ids.

expect: list of acceptable first tools; [] means a right answer calls no tool.
checks: {dotted.path: rule} where rule is "present", or {"eq": v}, {"has": substring}, {"in": [..]},
        {"len>=": n}. Paths index lists with numbers (rows.0).
"""

F_EMP = "k17d4m2q8x3n5p6r9s0t"   # الموظفون.xlsx
F_POL = "k19a2b3c4d5e6f7g8h9j"   # سياسة العمل عن بعد.pdf
F_BUY = "k1m2n3p4q5r6s7t8v9w0"   # المشتريات 2026.xlsx
F_TRN = "k1z9y8x7w6v5t4s3r2q1"   # خطة التدريب.docx
L_PRJ = "l3h5j7k9m2n4p6q8r0s1"   # متابعة مشروع الأرشفة
L_ATT = "l8g6f4d2s1a9z7x5c3v2"   # حضور الدورة
A_REP = "a4t6y8u0i2o4p6a8s0d2"   # تقرير الحضور الشهري
A_PAGE = "a9q7w5e3r1t9y7u5i3o1"  # صفحة دليل الموظف الجديد
APP_Q = "p2k4m6n8b0v2c4x6z8l0"   # اختبار تحديد المستوى
SRC_HR = "s5d7f9g1h3j5k7l9z1x3"  # نظام الموارد البشرية

CONTEXT = f"""هذه محادثة داخل مساحة "الموارد البشرية". ملفات المساحة (4):
- الموظفون.xlsx (معرّف: {F_EMP})
- سياسة العمل عن بعد.pdf (معرّف: {F_POL})
- المشتريات 2026.xlsx (معرّف: {F_BUY})
- خطة التدريب.docx (معرّف: {F_TRN})

القوائم الحية هنا (جداول يحدّثها الموظف ويتابعها؛ اقرأ واحدة بـ read_list وعدّلها بـ update_list بدل كتابة جدول جديد):
- «متابعة مشروع الأرشفة» (listId={L_PRJ}، 12 صف، في «الموارد البشرية»)
- «حضور الدورة» (listId={L_ATT}، 30 صف، في «الموارد البشرية»)

المخرجات هنا (مستندات وجداول وصفحات محفوظة؛ لتصدير أحدها Word أو PDF مرّر artifactId إلى export_document، ولتعديله update_artifact، بدل كتابته من جديد):
- «تقرير الحضور الشهري» (artifactId={A_REP}، مستند، النسخة 3، في «الموارد البشرية»، من هذه المحادثة)
- «صفحة دليل الموظف الجديد» (artifactId={A_PAGE}، صفحة، النسخة 1، في «الموارد البشرية»)
- «اختبار تحديد المستوى» (appId={APP_Q}، تطبيق، في «الموارد البشرية»)

المهارات المتاحة في هذه المحادثة (طرق عمل محفوظة؛ إذا طابق الطلب إحداها فحمّل تعليماتها بأداة use_skill قبل أن تبدأ واتبعها. لا تمنح أي صلاحية):
- /monthly-attendance: تقرير الحضور الشهري من ملف البصمة بصيغة الإدارة (من مهارات الموظف، فيها سكربت محفوظ)
- /formal-letter: صياغة خطاب رسمي بصيغة الإدارة (من مهارات الموظف)

المصادر الخارجية المتاحة لـ query_source:
- «نظام الموارد البشرية» (source={SRC_HR}، قاعدة PostgreSQL: أرسل sql (SELECT فقط)؛ الجداول: employees(id, name, department, hire_date, grade), leaves(employee_id, type, start_date, end_date, days))"""

C = []


def case(id, group, q, expect, checks=None, grounding="documents", note=""):
    C.append({"id": id, "group": group, "q": q, "expect": expect, "checks": checks or {}, "grounding": grounding, "note": note})


# --- files: search / read ---
case("search_1", "files", "كم مدة العمل عن بعد المسموحة في الأسبوع حسب السياسة؟", ["search_documents", "read_file"])
case("search_2", "files", "وش تقول اللائحة عن بدل الانتداب داخل المملكة؟", ["search_documents"], {"query": "present"})
case("search_3", "files", "هل فيه شي في مستنداتنا عن إجراءات الإخلاء وقت الطوارئ؟", ["search_documents"], {"query": "present"})
case("read_1", "files", "اقرأ لي ملف خطة التدريب كامل ولخصه", ["read_file"], {"fileId": {"eq": F_TRN}})
case("read_2", "files", "افتح سياسة العمل عن بعد صفحة 3 إلى 5", ["read_file"], {"fileId": {"eq": F_POL}, "pages": {"has": "3"}})

# --- analysis ---
case("analysis_1", "analysis", "من ملف الموظفين، كم موظف في كل إدارة؟ وارسم لي رسم بياني", ["run_analysis"], {"fileIds.0": {"eq": F_EMP}, "code": "present"})
case("analysis_2", "analysis", "احسب إجمالي المشتريات لكل شهر من ملف المشتريات 2026 وطلع لي جدول", ["run_analysis"], {"fileIds.0": {"eq": F_BUY}, "code": "present"})
case("analysis_3", "analysis", "قارن متوسط الرواتب بين الإدارات في ملف الموظفين", ["run_analysis"], {"fileIds": {"len>=": 1}})
case("skill_1", "skills", "سوّ لي تقرير الحضور الشهري المعتاد", ["use_skill", "run_analysis"], {"name": {"has": "monthly-attendance"}})
case("skill_2", "skills", "اكتب خطاب رسمي لإدارة المالية نطلب فيه تمديد موعد تسليم الميزانية أسبوعين", ["use_skill"], {"name": {"has": "formal-letter"}})

# --- outputs ---
case("artifact_md", "outputs", "اكتب لي مذكرة داخلية عن مواعيد الدوام في رمضان واحفظها كمستند", ["create_artifact"], {"kind": {"eq": "markdown"}, "title": "present", "content": "present"}, grounding="open")
case("artifact_slides", "outputs", "سوّ لي عرض تقديمي من 5 شرائح عن أهمية أمن المعلومات للموظفين", ["create_artifact", "export_document"], {"kind": {"in": ["slides"]}}, grounding="open", note="export_document pptx is also right")
case("artifact_table", "outputs", "سوّ جدول فيه أيام الأسبوع والمسؤول المناوب لكل يوم: أحمد، سارة، خالد، نورة، فهد", ["create_artifact", "create_list"], grounding="open")
case("update_art", "outputs", "عدّل تقرير الحضور الشهري وأضف في آخره فقرة توصيات: تفعيل البصمة في الفرع", ["update_artifact"], {"artifactId": {"eq": A_REP}})
case("export_1", "outputs", "صدّر تقرير الحضور الشهري PDF", ["export_document"], {"format": {"eq": "pdf"}, "artifactId": {"eq": A_REP}})
case("export_2", "outputs", "أبي ملف وورد فيه خطاب شكر لفريق الأرشفة على إنجاز المشروع", ["export_document", "create_artifact", "use_skill"], {"format": {"eq": "docx"}}, grounding="open")
case("publish_1", "outputs", "انشر صفحة دليل الموظف الجديد لكل موظفي الجهة", ["publish_output"], {"artifactId": {"eq": A_PAGE}, "audience": {"eq": "workspace"}})

# --- lists & tasks ---
case("list_create", "lists", "سوّ لي قائمة أتابع فيها مهام نقل المكتب: المهمة، المسؤول، الموعد، الحالة", ["create_list"], {"title": "present", "columns": {"len>=": 3}}, grounding="open")
case("list_read", "lists", "وش المتبقي في متابعة مشروع الأرشفة؟", ["read_list"], {"listId": {"eq": L_PRJ}})
case("list_update", "lists", "أضف لقائمة حضور الدورة: منى السبيعي، حاضرة", ["update_list", "read_list"], {"listId": {"eq": L_ATT}})
case("tasks_1", "lists", "وش المهام اللي علي هالأسبوع؟", ["read_tasks"])

# --- records ---
case("records_mine", "records", "وش الدورات اللي أخذتها وشهاداتي؟", ["my_records"])
case("records_q", "records", "اعرض سجلات المتدربين اللي رقمهم الوظيفي 44821", ["query_records"], {"subjectRef": {"has": "44821"}})
case("template_1", "records", "جهّز شهادة حضور للمتدرب صاحب السجل r7k2m9", ["fill_template", "query_records"], {"templateId": "present"})
case("recordset_1", "records", "اعتمد ملف الموظفين سجلاً للموظفين في المساحة", ["propose_record_set"], {"fileId": {"eq": F_EMP}})

# --- external source ---
case("source_1", "source", "كم عدد الموظفين في كل إدارة حسب نظام الموارد البشرية؟", ["query_source"], {"source": {"in": [SRC_HR, "نظام الموارد البشرية", "«نظام الموارد البشرية»"]}, "sql": {"has": "SELECT"}})
case("source_2", "source", "كم يوم إجازة أخذ الموظف رقم 1203 هالسنة؟ من النظام", ["query_source"], {"sql": {"has": "leaves"}})

# --- memory & chat ---
case("remember_1", "memory", "تذكّر إني أفضّل التواريخ بالهجري دائماً", ["remember"], {"text": "present"}, grounding="open")
case("recall_1", "memory", "كمّل على الخطة اللي اشتغلنا عليها المرة الماضية", ["recall", "read_chat"], grounding="open")
case("readchat_1", "memory", "كم كان الرقم اللي قلته لك بأول المحادثة عن الميزانية؟", ["read_chat", "recall"])
case("skill_save", "skills", "احفظ طريقة كتابة الخطابات هذي كمهارة اسمها thank-you-letter: مقدمة رسمية، شكر محدد، ختام بالدعاء", ["create_skill"], {"name": {"has": "thank-you-letter"}, "instructions": "present"}, grounding="open")

# --- apps ---
case("app_new", "apps", "ابن لي اختبار قصير 5 أسئلة عن السلامة المهنية يحله الموظفين وتنحفظ درجاتهم", ["create_list", "write_app"], grounding="open")
case("app_read", "apps", "وش الأسئلة الموجودة حالياً في اختبار تحديد المستوى؟", ["read_app"], {"appId": {"eq": APP_Q}})
case("app_test", "apps", "جرّب اختبار تحديد المستوى وتأكد إنه يشتغل قبل ما ننشره", ["test_app", "read_app"], {"appId": {"eq": APP_Q}})

# --- colleague (shared chat) ---
case("notify_1", "team", "خلّ محمد يراجع تقرير الحضور الشهري قبل الخميس", ["notify_colleague"], {"people.0": {"has": "محمد"}, "message": "present"})

# --- no tool: plain writing / general knowledge ---
case("none_1", "none", "ترجم هذي الجملة للإنجليزي: نشكركم على حسن تعاونكم", [], grounding="open")
case("none_2", "none", "صغ لي رسالة اعتذار قصيرة لزميل عن تأخري في الرد", [], grounding="open")
case("none_3", "none", "شكراً، كذا تمام", [], grounding="open")
case("none_4", "none", "وش الفرق بين الإجازة الاضطرارية والمرضية بشكل عام؟", [], grounding="open")

CASES = C

# Tool groups, for the "routed" condition: what a router that picked the right group would offer.
GROUPS = {
    "files": ["search_documents", "read_file", "run_analysis", "export_document", "create_artifact"],
    "analysis": ["run_analysis", "search_documents", "read_file", "create_artifact", "use_skill"],
    "skills": ["use_skill", "create_skill", "run_analysis", "create_artifact", "export_document"],
    "outputs": ["create_artifact", "update_artifact", "export_document", "publish_output", "create_list"],
    "lists": ["create_list", "update_list", "read_list", "read_tasks", "create_artifact"],
    "records": ["query_records", "my_records", "fill_template", "propose_record_set", "read_file"],
    "source": ["query_source", "search_documents", "run_analysis", "create_artifact", "read_file"],
    "memory": ["remember", "recall", "read_chat", "create_skill", "search_documents"],
    "apps": ["write_app", "read_app", "test_app", "create_list", "publish_output"],
    "team": ["notify_colleague", "read_list", "create_artifact", "publish_output", "search_documents"],
    "none": ["search_documents", "create_artifact", "remember", "create_list", "export_document"],
}
