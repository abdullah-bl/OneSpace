"""Generate a synthetic Arabic admin/policy corpus + retrieval questions using the LOCAL main model.

Output: data/corpus.json  [{id, doc, title, heading, text}]
        data/qa.json      [{chunk_id, question, key}]
Re-running skips files that already exist (delete them to regenerate).
NOTE: synthetic — not real documents of the department. See REPORT.md.
"""
import json, os, sys
from lib import DATA, chat, pmap, norm_ar

TOPICS = [
    "سياسة الإجازات (السنوية والمرضية والاضطرارية والأمومة والدراسية)",
    "سياسة العمل عن بعد والعمل المرن",
    "لائحة المشتريات والعقود والمنافسات",
    "سياسة أمن المعلومات وكلمات المرور والبريد الإلكتروني",
    "دليل التدريب والتطوير والابتعاث",
    "لائحة الانتدابات والسفر وبدلاتها",
    "سياسة تقييم الأداء الوظيفي والمكافآت",
    "إجراءات التوظيف والتعيين وفترة التجربة",
    "سياسة استخدام الأصول والأجهزة والسيارات الحكومية",
    "لائحة الحضور والانصراف والتأخير والعمل الإضافي",
    "سياسة إدارة الوثائق والمراسلات والأرشفة",
    "دليل الصرف من الميزانية والعهد المالية والسلف",
]
N_SECTIONS = int(os.environ.get("CORPUS_SECTIONS", "10"))

DOC_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "sections": {"type": "array", "minItems": N_SECTIONS, "maxItems": N_SECTIONS, "items": {
            "type": "object", "properties": {"heading": {"type": "string"}, "text": {"type": "string"}},
            "required": ["heading", "text"]}},
    },
    "required": ["title", "sections"],
}


def gen_doc(topic):
    prompt = (
        f"اكتب وثيقة رسمية باللغة العربية الفصحى بعنوان مناسب عن: {topic}، صادرة عن إدارة الشؤون الإدارية في جهة حكومية.\n"
        f"الوثيقة تتكون من {N_SECTIONS} مواد بالضبط. لكل مادة عنوان قصير ونص من 70 إلى 130 كلمة.\n"
        "يجب أن تحتوي كل مادة على تفاصيل محددة وفريدة: أرقام (أيام، مبالغ بالريال، نسب، مهل زمنية)، جهات مسؤولة، شروط واستثناءات.\n"
        "لا تكرر نفس الأرقام بين المواد. أعد JSON فقط."
    )
    msg, _, dt = chat([{"role": "user", "content": prompt}], max_tokens=6000, temperature=0.7,
                      response_format={"type": "json_schema", "json_schema": {"name": "doc", "schema": DOC_SCHEMA}})
    d = json.loads(msg["content"])
    print(f"  doc ok ({dt:.0f}s): {d['title']}", flush=True)
    return d


QA_SCHEMA = {"type": "object", "properties": {"question": {"type": "string"}, "key": {"type": "string"}},
             "required": ["question", "key"]}


def gen_q(c):
    prompt = (
        "النص التالي مادة من لائحة إدارية:\n\n" + c["heading"] + "\n" + c["text"] + "\n\n"
        "اكتب سؤالاً واحداً واقعياً كما يكتبه موظف في محادثة، تكون إجابته موجودة في هذا النص تحديداً.\n"
        "- استخدم صياغة مختلفة وكلمات مرادفة قدر الإمكان ولا تنسخ عبارات من النص.\n"
        "- لا تذكر اسم اللائحة أو رقم المادة.\n"
        "- key: عبارة قصيرة جداً (رقم أو كلمة أو كلمتان) منسوخة حرفياً من النص وتمثل جوهر الإجابة.\n"
        "أعد JSON فقط."
    )
    msg, _, _ = chat([{"role": "user", "content": prompt}], max_tokens=300, temperature=0.7,
                     response_format={"type": "json_schema", "json_schema": {"name": "qa", "schema": QA_SCHEMA}})
    q = json.loads(msg["content"])
    ok = norm_ar(q["key"]).strip() in norm_ar(c["text"])
    return {"chunk_id": c["id"], "question": q["question"], "key": q["key"], "key_in_text": ok}


def main():
    cp = os.path.join(DATA, "corpus.json")
    if not os.path.exists(cp):
        print(f"generating {len(TOPICS)} docs x {N_SECTIONS} sections ...", flush=True)
        docs = pmap(gen_doc, TOPICS)
        corpus = []
        for di, d in enumerate(docs):
            for si, s in enumerate(d["sections"]):
                corpus.append({"id": f"d{di:02d}s{si:02d}", "doc": di, "title": d["title"],
                               "heading": s["heading"], "text": s["text"]})
        json.dump(corpus, open(cp, "w"), ensure_ascii=False, indent=1)
    corpus = json.load(open(cp))
    qp = os.path.join(DATA, "qa.json")
    if not os.path.exists(qp):
        print(f"generating questions for {len(corpus)} chunks ...", flush=True)
        qa = pmap(gen_q, corpus)
        json.dump(qa, open(qp, "w"), ensure_ascii=False, indent=1)
        print("key_in_text:", sum(q["key_in_text"] for q in qa), "/", len(qa))


if __name__ == "__main__":
    main()
