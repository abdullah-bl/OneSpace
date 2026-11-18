"""pandas analysis-code test: model writes code, we run it locally (temp dir, timeout), compare to ground truth."""
import json, os, random, re, shutil, subprocess, tempfile
from lib import DATA, chat

PY = os.environ.get("PY_EXEC", os.path.expanduser("~/.sandbox/venvs/gpu-ml/bin/python"))
DEPTS = ["المالية", "الموارد البشرية", "تقنية المعلومات", "المشتريات", "الشؤون القانونية"]
TITLES = ["أخصائي", "محلل", "مشرف", "مدير", "مساعد إداري"]


def make_data():
    """Deterministic synthetic HR + purchases files (written once)."""
    emp, pur = os.path.join(DATA, "employees.csv"), os.path.join(DATA, "purchases.csv")
    if os.path.exists(emp) and os.path.exists(pur):
        return emp, pur
    rng = random.Random(42)
    first = ["محمد", "أحمد", "سارة", "نورة", "خالد", "فهد", "ريم", "منى", "عبدالله", "هند", "ماجد", "لمى"]
    last = ["العتيبي", "الشهري", "القحطاني", "الدوسري", "الزهراني", "الحربي", "السبيعي", "المطيري"]
    with open(emp, "w", encoding="utf-8") as f:
        f.write("رقم_الموظف,الاسم,الإدارة,المسمى,تاريخ_التعيين,الراتب,أيام_الغياب,تقييم_الأداء\n")
        for i in range(240):
            d = rng.choice(DEPTS)
            sal = rng.randint(7, 30) * 1000 + rng.choice([0, 250, 500, 750])
            rating = "" if rng.random() < 0.06 else str(round(rng.uniform(2.0, 5.0), 1))
            f.write(f"E{1000+i},{rng.choice(first)} {rng.choice(last)},{d},{rng.choice(TITLES)},"
                    f"{rng.randint(2008, 2026)}-{rng.randint(1,12):02d}-{rng.randint(1,28):02d},{sal},{rng.randint(0, 25)},{rating}\n")
    cats = ["أجهزة", "أثاث", "قرطاسية", "برمجيات", "صيانة"]
    vendors = ["شركة التقنية المتقدمة", "مؤسسة الأثاث الحديث", "مكتبة جرير", "شركة الحلول الرقمية", "مؤسسة الصيانة الشاملة"]
    with open(pur, "w", encoding="utf-8") as f:
        f.write("رقم_الطلب,التاريخ,الإدارة,الفئة,المورد,الكمية,سعر_الوحدة\n")
        for i in range(400):
            f.write(f"PO-{5000+i},2026-{rng.randint(1,10):02d}-{rng.randint(1,28):02d},{rng.choice(DEPTS)},{rng.choice(cats)},"
                    f"{rng.choice(vendors)},{rng.randint(1, 40)},{round(rng.uniform(15, 4500), 2)}\n")
    return emp, pur


# question, file, ground-truth function (pandas) -> JSON-able
def cases():
    import_pd = "import pandas as pd\n"
    return [
        ("ما متوسط الراتب لكل إدارة؟ أعد قاموساً {اسم الإدارة: المتوسط مقرباً لمنزلتين}.", "employees.csv",
         "r = df.groupby('الإدارة')['الراتب'].mean().round(2).to_dict()"),
        ("كم عدد الموظفين الذين عُيّنوا في عام 2020 أو بعده؟ أعد رقماً.", "employees.csv",
         "r = int((pd.to_datetime(df['تاريخ_التعيين']).dt.year >= 2020).sum())"),
        ("ما أرقام الموظفين الخمسة الأكثر غياباً؟ عند التساوي رتّب حسب رقم الموظف تصاعدياً. أعد قائمة بأرقام الموظفين.", "employees.csv",
         "r = df.sort_values(['أيام_الغياب','رقم_الموظف'], ascending=[False, True]).head(5)['رقم_الموظف'].tolist()"),
        ("ما متوسط تقييم الأداء في إدارة تقنية المعلومات مع تجاهل القيم الفارغة؟ أعد رقماً مقرباً لمنزلتين.", "employees.csv",
         "r = round(float(df[df['الإدارة']=='تقنية المعلومات']['تقييم_الأداء'].mean()), 2)"),
        ("ما إجمالي قيمة المشتريات (الكمية × سعر الوحدة) لكل شهر؟ أعد قاموساً {رقم الشهر كعدد صحيح: الإجمالي مقرباً لمنزلتين}.", "purchases.csv",
         "df['v']=df['الكمية']*df['سعر_الوحدة']; r = {int(k): round(float(v),2) for k,v in df.groupby(pd.to_datetime(df['التاريخ']).dt.month)['v'].sum().items()}"),
        ("أي مورد حصل على أعلى قيمة مشتريات إجمالية (الكمية × سعر الوحدة)؟ أعد اسم المورد.", "purchases.csv",
         "df['v']=df['الكمية']*df['سعر_الوحدة']; r = df.groupby('المورد')['v'].sum().idxmax()"),
        ("ما نسبة قيمة مشتريات فئة 'برمجيات' من إجمالي قيمة المشتريات؟ أعد نسبة مئوية مقربة لمنزلتين (مثل 21.37).", "purchases.csv",
         "df['v']=df['الكمية']*df['سعر_الوحدة']; r = round(float(df[df['الفئة']=='برمجيات']['v'].sum()/df['v'].sum()*100), 2)"),
        ("لكل إدارة، كم عدد الموظفين الذين تقييمهم 4.5 أو أعلى؟ أعد قاموساً {الإدارة: العدد} ويشمل الإدارات التي عددها صفر.", "employees.csv",
         "r = {d: int(((df['الإدارة']==d) & (df['تقييم_الأداء']>=4.5)).sum()) for d in df['الإدارة'].unique()}"),
        ("ما الإدارة التي لديها أعلى متوسط أيام غياب لكل موظف؟ أعد اسم الإدارة.", "employees.csv",
         "r = df.groupby('الإدارة')['أيام_الغياب'].mean().idxmax()"),
        ("ما مجموع رواتب المديرين (المسمى = مدير) الذين عُيّنوا قبل 2015؟ أعد رقماً.", "employees.csv",
         "r = int(df[(df['المسمى']=='مدير') & (pd.to_datetime(df['تاريخ_التعيين']).dt.year < 2015)]['الراتب'].sum())"),
    ]


def run_code(code, workdir, timeout=60):
    p = os.path.join(workdir, "analysis.py")
    open(p, "w", encoding="utf-8").write(code)
    try:
        r = subprocess.run([PY, "-I", p], cwd=workdir, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout[-4000:], r.stderr[-2000:]
    except subprocess.TimeoutExpired:
        return -9, "", "timeout"


def ground_truth(file, expr):
    with tempfile.TemporaryDirectory() as td:
        shutil.copy(os.path.join(DATA, file), td)
        code = f"import pandas as pd, json\ndf = pd.read_csv('{file}')\n{expr}\nprint(json.dumps(r, ensure_ascii=False))\n"
        rc, out, err = run_code(code, td)
        assert rc == 0, err
        return json.loads(out.strip().splitlines()[-1])


def same(a, b):
    # lenient: {"count": 87} vs 87, [87] vs 87
    if isinstance(a, dict) and len(a) == 1 and not isinstance(b, dict):
        a = next(iter(a.values()))
    if isinstance(a, list) and len(a) == 1 and not isinstance(b, list):
        a = a[0]
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= max(0.011, abs(b) * 1e-4)
    if isinstance(a, str) and isinstance(b, (int, float)):
        try: return same(float(a.replace(",", "").replace("%", "")), b)
        except ValueError: return False
    if isinstance(a, str) and isinstance(b, str):
        return a.strip() == b.strip()
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        ka = {str(k).strip(): v for k, v in a.items()}; kb = {str(k).strip(): v for k, v in b.items()}
        return ka.keys() == kb.keys() and all(same(ka[k], kb[k]) for k in kb)
    return False


def head_of(file):
    with open(os.path.join(DATA, file), encoding="utf-8") as f:
        return "".join([next(f) for _ in range(6)])


SYSTEM = ("أنت محلل بيانات. اكتب كود Python كاملاً يستخدم pandas فقط لقراءة الملف من المجلد الحالي والإجابة. "
          "ضع الكود في كتلة ```python واحدة. يجب أن يطبع الكود في آخر سطر النتيجة النهائية فقط بصيغة JSON عبر "
          "print(json.dumps(result, ensure_ascii=False)). لا تطبع أي شيء آخر.")


def run_case(case, think=False):
    q, file, expr = case
    gt = ground_truth(file, expr)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"الملف: {file}\nأول أسطر الملف:\n{head_of(file)}\nالسؤال: {q}"}]
    attempts = []
    for attempt in (1, 2):
        m, _, dt = chat(msgs, think=think, max_tokens=4096 if think else 1500)
        txt = m.get("content") or ""
        blocks = re.findall(r"```(?:python)?\n(.*?)```", txt, re.S)
        code = blocks[-1] if blocks else txt
        with tempfile.TemporaryDirectory() as td:
            shutil.copy(os.path.join(DATA, file), td)
            rc, out, err = run_code(code, td)
        got = None; correct = False
        if rc == 0 and out.strip():
            try:
                got = json.loads(out.strip().splitlines()[-1]); correct = same(got, gt)
            except Exception:
                err = "output is not JSON: " + out.strip()[-300:]
        attempts.append({"rc": rc, "correct": correct, "err": err[-400:], "got": str(got)[:300], "seconds": round(dt, 1)})
        if correct:
            break
        feedback = (f"الكود فشل بالخطأ:\n{err[-1500:]}" if rc != 0 or got is None else
                    f"الكود عمل وطبع: {out.strip()[-500:]}\nراجع الحل وتأكد من تطابقه مع المطلوب والصيغة المطلوبة.")
        msgs += [{"role": "assistant", "content": txt}, {"role": "user", "content": feedback + "\nأعد كتابة الكود كاملاً مصححاً."}]
    return {"q": q, "truth": str(gt)[:300], "ok_first": attempts[0]["correct"], "ok": attempts[-1]["correct"],
            "runs_first": attempts[0]["rc"] == 0, "attempts": attempts}
