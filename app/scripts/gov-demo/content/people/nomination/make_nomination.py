# Fictional input for the training-nomination scenario (government demo).
#   python3 -I make_nomination.py <attendance.csv> [expected.json]
# The people come from the training space's own attendance sheet, never from the sensitive HR register.
# CSV and Markdown on purpose: they are indexed without unzip / poppler.
import csv, json, random, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent
rng = random.Random(2027)
people = list(csv.DictReader(open(sys.argv[1], encoding="utf-8-sig")))
PROGRAMS = [  # code, name, first-batch seats, only department
    ("ت-27-15", "نظام حماية البيانات الشخصية", 8, None),
    ("ت-27-20", "إدارة الاجتماعات وكتابة المحاضر", 7, None),
    ("ت-27-06", "مهارات التواصل مع المستفيدين", 3, "خدمة المستفيدين"),
]
COLS = ["رقم الطلب", "الرقم الوظيفي", "الاسم", "الإدارة", "رمز البرنامج", "اسم البرنامج", "ترتيب الرغبة", "تاريخ التقديم",
        "موافقة الرئيس المباشر", "ساعات التدريب 2026", "درجة الاحتياج", "مرتبط بمبادرة", "نسبة حضور آخر دورة", "سبق حضور البرنامج خلال 24 شهرا"]
rows = []
for p in people:
    hours = rng.choice([4, 8, 12, 15, 18, 22, 24, 28, 30, 34, 38, 40, 44])
    if p["مستحق للشهادة"] == "نعم":
        hours = max(hours, 15)
    service = p["الإدارة"] == "خدمة المستفيدين"
    n = rng.choice([2, 3, 3]) if service else rng.choice([1, 2, 2, 2, 3])
    for wish, (code, name, _, _) in enumerate(rng.sample(PROGRAMS if (service or n == 3) else PROGRAMS[:2], n), 1):
        rows.append(dict(zip(COLS, [f"ط-{len(rows) + 1:03}", p["الرقم الوظيفي"], p["الاسم"], p["الإدارة"], code, name, wish,
            f"2026-11-{rng.choice([15, 15, 16, 17, 17, 18, 18, 19, 19, 19, 20]):02}",
            "نعم" if rng.random() > .08 else "لا", hours, rng.choice(["عالية", "متوسطة", "متوسطة", "منخفضة"]),
            rng.choice(["نعم", "لا", "لا"]), p["نسبة الحضور"], "نعم" if rng.random() < .08 else "لا"])))
with open(HERE / "طلبات_الترشيح_مارس_2027.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, COLS); w.writeheader(); w.writerows(rows)

(HERE / "ضوابط_المفاضلة_مارس_2027.md").write_text("""# ضوابط مفاضلة الترشيح لدورات مارس 2027

الهيئة التجريبية للخدمات الحكومية (جهة وهمية لأغراض العرض). مسودة لعرضها على لجنة شؤون الموظفين، مبنية على «سياسة التدريب والتطوير».

## 1. البرامج ومقاعد الدفعة الأولى

| رمز البرنامج | البرنامج | مقاعد الدفعة الأولى | الفئة المستهدفة |
|---|---|---|---|
""" + "".join(f"| {c} | {n} | {s} | {d or 'جميع الإدارات'} |\n" for c, n, s, d in PROGRAMS) + """
البرامج الثلاثة متزامنة في مارس 2027.

## 2. شروط الاستبعاد

تطبق بالترتيب، ويسجل أول سبب ينطبق فقط:

1. موافقة الرئيس المباشر «لا»، والسبب: لا توجد موافقة الرئيس المباشر (المادة 6 من السياسة).
2. تاريخ التقديم بعد 2026-11-19، والسبب: التقديم بعد الموعد.
3. الإدارة خارج الفئة المستهدفة، والسبب: خارج الفئة المستهدفة.
4. سبق حضور البرنامج خلال 24 شهرا، والسبب: سبق حضور البرنامج.
5. بعد تطبيق ما سبق، إن بقي للموظف أكثر من طلبين يبقى الطلبان الأعلى رغبة (1 أعلى من 2)، والسبب: تجاوز دورتين متزامنتين (المادة 6 من السياسة).

## 3. نقاط المفاضلة (من 100، بلا تقريب)

| المعيار | الوزن | الحساب | الأساس |
|---|---|---|---|
| نقص الساعات | 35 | (40 - ساعات التدريب 2026) ÷ 40 × 35، ولا يقل عن صفر | المادتان 2 و6 |
| درجة الاحتياج | 30 | عالية 30، متوسطة 20، منخفضة 10 | المادة 3 |
| الارتباط بمبادرة | 20 | نعم 20، لا 0 | المادة 3 |
| الالتزام بالحضور | 15 | نسبة حضور آخر دورة ÷ 100 × 15 | ضابط تنظيمي |

## 4. كسر التعادل

الأقل ساعات تدريب، ثم الأسبق تقديما، ثم الأصغر رقما وظيفيا.

## 5. النتيجة

في كل برنامج: «مرشح» بعدد المقاعد، ثم «احتياطي» لأول 3 بعدهم، ثم «لم يرشح» للبقية، و«مستبعد» لمن انطبق عليه شرط استبعاد.
النتيجة توصية آلية، ولا تعد قرارا حتى تعتمدها اللجنة. ولا تستخدم في تقييم الأداء الوظيفي.
""", encoding="utf-8")

if len(sys.argv) > 2:  # the answer key the rehearsal is checked against
    prog = {c: (s, d) for c, _, s, d in PROGRAMS}; out = {}; left = []
    for r in rows:
        bad = (r[COLS[8]] == "لا" or r[COLS[7]] > "2026-11-19" or (prog[r[COLS[4]]][1] not in (None, r[COLS[3]])) or r[COLS[13]] == "نعم")
        if bad: out[r[COLS[0]]] = ["مستبعد", None]
        else: left.append(r)
    ok = []
    for e in {r[COLS[1]] for r in left}:
        mine = sorted((r for r in left if r[COLS[1]] == e), key=lambda r: r[COLS[6]])
        ok += mine[:2]
        for r in mine[2:]: out[r[COLS[0]]] = ["مستبعد", None]
    pts = lambda r: max(0, 40 - r[COLS[9]]) / 40 * 35 + {"عالية": 30, "متوسطة": 20, "منخفضة": 10}[r[COLS[10]]] + (20 if r[COLS[11]] == "نعم" else 0) + int(r[COLS[12]]) / 100 * 15
    for c, (seats, _) in prog.items():
        q = sorted((r for r in ok if r[COLS[4]] == c), key=lambda r: (-round(pts(r), 6), r[COLS[9]], r[COLS[7]], r[COLS[1]]))
        for i, r in enumerate(q):
            out[r[COLS[0]]] = ["مرشح" if i < seats else "احتياطي" if i < seats + 3 else "لم يرشح", pts(r)]
    json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
    import collections
    print(len(rows), collections.Counter(v[0] for v in out.values()))
    for c in prog: print(c, collections.Counter(out[r[COLS[0]]][0] for r in rows if r[COLS[4]] == c))
