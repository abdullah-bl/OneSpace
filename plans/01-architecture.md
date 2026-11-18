# المعمارية

## الصورة العامة

```
┌──────────────────────────── المتصفح (React + Vite + Tailwind، RTL) ────────────────────────────┐
│  الشريط الجانبي: محادثات · ملفات · مهام · وكلاء · إدارة   │  المحادثة  │  لوحة المخرجات        │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │ WebSocket (live queries) + HTTP
┌───────────────────────────────────────────▼──────────────────────────────────────────────────┐
│                                         OneBase                                              │
│  access.ts  ◄── نقطة الصلاحيات الوحيدة، كل دالة وكل أداة تمر منها                              │
│  التطبيق: spaces · files · tasks · artifacts · templates · agents · audit                    │
│  المكوّنات: agent · rag · workflow · work-queue · rate-limiter · aggregate · teams · notifications │
│  ai.ts  ◄── chat / embed / rerank فوق مزوّد OpenAI-compatible (من Environment)                │
└──────────┬───────────────────────────────┬───────────────────────────────┬───────────────────┘
           │ /v1/chat/completions           │ /v1/embeddings, /v1/rerank     │ HTTP محلي + سر مشترك
┌──────────▼───────────┐        ┌───────────▼──────────┐          ┌────────▼────────────────────┐
│ خادم النموذج الرئيسي │        │ خادم التضمين والترتيب │          │ sandbox-runner              │
│ llama-server / vLLM  │        │ llama-server          │          │ حاوية لكل تشغيل، بدون شبكة  │
└──────────────────────┘        └──────────────────────┘          └─────────────────────────────┘
```

كل شيء على جهاز واحد الآن. الفصل بين الخدمات يسمح بنقل خادم النموذج لجهاز آخر لاحقاً بتغيير متغير بيئة فقط.

## النماذج والمزوّد

المزوّد يُعرَّف في OneBase Environment (`onebase env set` أو صفحة Environment في لوحة التحكم)، ويُقرأ من `process.env` داخل `onebase/ai.ts`:

| المتغير | الغرض |
|---|---|
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | النموذج الرئيسي (محادثة، أدوات، كود) |
| `LLM_FAST_BASE_URL`, `LLM_FAST_MODEL` | النموذج الخفيف |
| `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_DIMENSIONS` | التضمين |
| `RERANK_BASE_URL`, `RERANK_MODEL` | إعادة الترتيب (اختياري، يُعطَّل إن غاب) |
| `SANDBOX_URL`, `SANDBOX_SECRET` | مشغّل الساندبوكس |

تبديل ollama أو vLLM أو llama.cpp يصير تغيير عنوان فقط، لأن الثلاثة يقدّمون واجهة OpenAI-compatible.

توزيع الأدوار على النماذج:

| النموذج | الدور |
|---|---|
| Qwen 3.8 (27B) | المحادثة، استدعاء الأدوات، كتابة كود التحليل، قراءة الصفحات الممسوحة (عنده mmproj) |
| LFM3 (1.7B) | مهام خفيفة وسريعة: عنونة المحادثة، إعادة صياغة سؤال البحث، التصنيف والتوجيه |
| embeddinggemma-2 | تضمين المقاطع والأسئلة |

ملاحظات تشغيلية:

- **البُعد يُحدَّد عند تركيب مكوّن rag ولا يتغير.** تغيير نموذج التضمين لاحقاً يعني إعادة فهرسة كاملة. نخزّن اسم النموذج مع الفهرس ونرفض التشغيل إن اختلف.
- **بُعد embeddinggemma-2 وصيغة بادئات السؤال/المستند تُقرأ من بطاقة النموذج وتُقاس في المرحلة 0**، ولا تُفترض.
- `llama-server` يحتاج `--jinja` لاستدعاء الأدوات و `--parallel N` لتعدد المستخدمين. vLLM أفضل عند زيادة المستخدمين المتزامنين.
- **العدد قليل مبدئياً:** `llama-server` و SQLite يكفيان. vLLM و Postgres يؤجَّلان للمرحلة 7.
- **طابور للـGPU:** كل توليد يمر عبر `work-queue` بحد `maxParallelism` يساوي عدد الـslots، والمستخدم يرى أنه في الانتظار بدل أن يتعطل الخادم.

## ربط الأجزاء بمكوّنات OneBase

| الحاجة | المكوّن | ملاحظة |
|---|---|---|
| المحادثات، الرسائل، البث | `agent` | نستخدمه لتخزين الـthreads والرسائل والـstreams. حلقة التوليد نكتبها نحن (انظر أدناه) |
| فهرسة المستندات والبحث | `rag` | namespace لكل مساحة. يدعم vector و text و hybrid |
| خط معالجة الملف (استخراج ← تقطيع ← تضمين) | `workflow` | خطوات مسجّلة تكمل بعد إعادة التشغيل |
| طابور التوليد والـOCR | `work-queue` | يحمي الـGPU |
| حدود الاستخدام لكل مستخدم | `rate-limiter` | |
| عدّادات الاستخدام واللوحات | `aggregate` | توكنات لكل مستخدم/وكيل |
| مساحة العمل وأعضاؤها | `@onebase/teams` | الفريق = مساحة العمل (الإدارة). عضوية المساحات الداخلية في جدول التطبيق |
| الإشعارات | `@onebase/notifications` | مهام، اعتمادات، اكتمال فهرسة |
| من متصل الآن | `presence` | اختياري |
| ترحيل البيانات | `migrations` | |

### لماذا نكتب حلقة التوليد بأنفسنا

`agent.generateText` يأخذ الأدوات لكل استدعاء (ممتاز: نحسبها من سجل الوكيل وصلاحيات المستخدم)، لكن التعليمات ثابتة عند التركيب، والبث منفصل عن حلقة الأدوات. نحتاج لكل دور:

- تعليمات الوكيل المختار من قاعدة البيانات.
- بث النص أثناء استدعاء الأدوات، مع إظهار "يبحث في السياسات…" للمستخدم.
- ضبط حجم السياق (المقاطع المسترجعة + التاريخ) حسب نافذة النموذج.
- استشهادات منظّمة تُحفظ مع الرسالة.

لذلك: action باسم `runTurn` يدير الحلقة، ويستخدم `saveMessage` و `createStream/addDelta/finishStream` من المكوّن للتخزين والبث. والبديل الأنظف، بما أن OneBase مشروعك: إضافة `instructions` لكل استدعاء في `generateText` وبث مدمج، ثم نستغني عن الحلقة الخاصة.

## نموذج البيانات (جداول التطبيق)

```
users            + status (pending|active|disabled), nationalId?, employeeNo? (يدخلهما المدير، لا المستخدم)
workspaces*      (في مكوّن teams) مساحة العمل وأعضاؤها بدور admin|member
spaces           workspaceId, name, kind (personal|shared), ownerId?, everyone, sensitive, instructions?
spaceMembers     spaceId, userId, role (manager|member|reader), addedBy
files            spaceId, storageId, name, mime, size, sha256, version, uploadedBy,
                 ingest (pending|processing|ready|failed), status (active|superseded), effectiveDate?
fileVersions     fileId, version, storageId, sha256, uploadedBy
threads*         (في مكوّن agent) + threadMeta: threadId, userId, agentId, scopeSpaceIds[], taskId?
messageMeta      messageId, citations[{fileId, page, section, quote}], toolRuns[], feedback?
agents           name, description, instructions, allowedTools[], dataScope, modelRole, maxSteps,
                 visibility, enabled, version
tasks            spaceId, title, body, createdBy, assigneeId, due, priority,
                 status (new|inProgress|review|done), links[{type, id}]
taskComments     taskId, authorId, body
artifacts        spaceId, ownerId, kind (html|markdown|table|document), title, currentVersion,
                 sourceThreadId?, sources[], classification
artifactVersions artifactId, version, storageId, sha256, createdBy, runId?
templates        name, kind, version, bodyStorageId, fieldsSchema, dataBinding, approvedBy
issuedDocuments  templateId, templateVersion, recordRef, sha256, serial, issuedBy, approvedBy, storageId
records_*        البيانات المنظّمة (متدربون، درجات…) بجداول حقيقية، لا مقاطع نصية
                 + spaceId, subjectRef (رقم الهوية/الوظيفي) يُطابَق مع حساب صاحبه
runs             kind (sandbox|ranking), userId, codeHash, inputs[{name, sha256}], outputs[], limits, exit
rankingCriteria  name, version, criteria[{field, weight, direction}], tieBreak[], approvedBy
rankingRuns      criteriaId, criteriaVersion, inputSnapshotId, results[], status (draft|approved), approvedBy
auditLog         at, userId, action, resourceType, resourceId, spaceId?, agentId?, detail
```

قواعد ثابتة:

- **كل ملف ومخرج ومهمة ينتمي لمساحة واحدة**، وصلاحيته من مساحته.
- `everyone` يجعل كل موظفي مساحة العمل قرّاء (مثل السياسات). `sensitive` يشدّد التسجيل وخروج المخرجات (مثل ملفات الطلبة). التفاصيل في [02-permissions-privacy.md](02-permissions-privacy.md).
- القسم مساحة مشتركة، لا جدول مستقل.
- **البيانات المنظّمة ليست RAG.** "كم معدل الطالب فلان" يُجاب باستعلام عبر أداة، لا ببحث دلالي في مقاطع.
- `auditLog` إلحاق فقط، لا تعديل ولا حذف من التطبيق.

## الواجهة

- React 19 + Vite + Tailwind (نفس عدّة مشاريعك الحالية)، عربية أولاً واتجاه RTL، وكل الأصول محزومة محلياً.
- ثلاثة أعمدة: شريط جانبي، محادثة، لوحة مخرجات تُفتح عند الحاجة.
- الشريط الجانبي يعرض "مساحتي" ثم المساحات المشتركة التي أنا عضو فيها، مثل قنوات Slack.
- كل ملف ومساحة يحمل شارة واضحة: 🔒 خاصة · 👥 مشتركة · 🌐 للجميع، مع علامة للمساحة الحسّاسة.
- في صندوق المحادثة: اختيار الوكيل، وشرائح نطاق البحث ("كل ما أملك" / مساحة محددة / ملف محدد).
- الاستشهادات قابلة للنقر وتفتح الملف عند الصفحة.

## أين تدخل "components" في البناء

نبدأ بالكود داخل التطبيق مع حدود واضحة بين الوحدات، ثم نستخرج ما استقر إلى مستودع `onebase-components` ليُعاد استخدامه:

| مرشّح للاستخراج | متى |
|---|---|
| `@onebase/audit` (سجل تدقيق إلحاقي) | بعد المرحلة 1 |
| `@onebase/tasks` | بعد المرحلة 3 |
| `@onebase/artifacts` (مخرجات بنسخ) | بعد المرحلة 4 |
| `@onebase/ui-chat`, `@onebase/ui-artifacts` في مجلد `ui/` | بعد المرحلة 4 |

الصلاحيات (`access.ts`) تبقى في التطبيق: المكوّنات معزولة عن جداول التطبيق، والصلاحيات تحتاج قراءة المستخدمين والمساحات معاً.
