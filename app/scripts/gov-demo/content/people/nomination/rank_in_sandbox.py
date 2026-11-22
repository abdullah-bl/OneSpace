# Runs inside OneSpace's sandbox (analysis:run). Applies ضوابط_المفاضلة_مارس_2027.md.
import csv
from collections import Counter, defaultdict

PROG = {"ت-27-15": (8, None), "ت-27-20": (7, None), "ت-27-06": (3, "خدمة المستفيدين")}
NEED = {"عالية": 30, "متوسطة": 20, "منخفضة": 10}
DEADLINE = "2026-11-19"
with open("/input/طلبات_الترشيح_مارس_2027.csv", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

per_person = defaultdict(list)
for r in rows:
    code = r["رمز البرنامج"]
    h, att = int(r["ساعات التدريب 2026"]), int(r["نسبة حضور آخر دورة"])
    r["pts"] = [max(0, 40 - h) / 40 * 35, NEED[r["درجة الاحتياج"]], 20 if r["مرتبط بمبادرة"] == "نعم" else 0, att / 100 * 15]
    r["total"], r["rank"] = round(sum(r["pts"]), 6), ""
    why = None
    if r["موافقة الرئيس المباشر"] != "نعم":
        why = "لا توجد موافقة الرئيس المباشر (المادة 6)"
    elif r["تاريخ التقديم"] > DEADLINE:
        why = f"التقديم بعد الموعد: قدم في {r['تاريخ التقديم']} والموعد {DEADLINE}"
    elif PROG[code][1] and r["الإدارة"] != PROG[code][1]:
        why = f"خارج الفئة المستهدفة: البرنامج لإدارة {PROG[code][1]}"
    elif r["سبق حضور البرنامج خلال 24 شهرا"] == "نعم":
        why = "سبق حضور البرنامج خلال 24 شهرا"
    else:
        per_person[r["الرقم الوظيفي"]].append(r)
    r["state"], r["why"] = ("مستبعد", why) if why else ("", "")
for mine in per_person.values():
    for r in sorted(mine, key=lambda r: int(r["ترتيب الرغبة"]))[2:]:
        r["state"], r["why"] = "مستبعد", f"تجاوز دورتين متزامنتين (المادة 6): هذه الرغبة رقم {r['ترتيب الرغبة']}"

n = lambda x: f"{x:.3f}".rstrip("0").rstrip(".")
names, queues = {r["رمز البرنامج"]: r["اسم البرنامج"] for r in rows}, {}
for code, (seats, _) in PROG.items():
    q = sorted((r for r in rows if r["رمز البرنامج"] == code and not r["state"]),
               key=lambda r: (-r["total"], int(r["ساعات التدريب 2026"]), r["تاريخ التقديم"], int(r["الرقم الوظيفي"])))
    queues[code] = q
    cut = q[min(seats, len(q)) - 1]
    for i, r in enumerate(q, 1):
        r["rank"] = i
        if i <= seats:
            r["state"], r["why"] = "مرشح", f"الترتيب {i} ضمن {seats} مقاعد"
            continue
        r["state"] = "احتياطي" if i <= seats + 3 else "لم يرشح"
        r["why"] = f"الترتيب {i} والمقاعد {seats}، ومجموعه {n(r['total'])} وآخر مرشح {n(cut['total'])}"
        if r["total"] == cut["total"]:
            r["why"] += "، وحسم التعادل بالساعات ثم تاريخ التقديم ثم الرقم الوظيفي"

with open("/output/نتيجة_المفاضلة_مارس_2027.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(["رقم الطلب", "الرقم الوظيفي", "الاسم", "الإدارة", "البرنامج", "نقاط الساعات", "نقاط الاحتياج", "نقاط المبادرة", "نقاط الحضور", "المجموع", "الترتيب", "الحالة", "السبب"])
    for r in rows:
        w.writerow([r["رقم الطلب"], r["الرقم الوظيفي"], r["الاسم"], r["الإدارة"], r["اسم البرنامج"], *map(n, r["pts"]), n(r["total"]), r["rank"], r["state"], r["why"]])

STATES = ["مرشح", "احتياطي", "لم يرشح", "مستبعد"]
md = ["# مسودة محضر مفاضلة الترشيح لدورات مارس 2027", "",
      "الهيئة التجريبية للخدمات الحكومية (جهة وهمية لأغراض العرض). النتيجة توصية آلية، ولا تعد قرارا حتى تعتمدها لجنة شؤون الموظفين.", "",
      "## الملخص", "", f"عدد الطلبات {len(rows)} من {len({r['الرقم الوظيفي'] for r in rows})} موظفا.", "",
      "| البرنامج | الطلبات | " + " | ".join(STATES) + " |", "|---" * 6 + "|"]
for code in PROG:
    c = Counter(r["state"] for r in rows if r["رمز البرنامج"] == code)
    md.append(f"| {names[code]} | {sum(c.values())} | " + " | ".join(str(c[s]) for s in STATES) + " |")
for code, q in queues.items():
    md += ["", f"## {names[code]} ({code})", "", "| الترتيب | الاسم | الإدارة | المجموع | الحالة |", "|---" * 5 + "|"]
    md += [f"| {r['rank']} | {r['الاسم']} | {r['الإدارة']} | {n(r['total'])} | {r['state']} |" for r in q if r["state"] in STATES[:2]]
md += ["", "## الاعتماد", "", "| الصفة | الاسم | التوقيع | التاريخ |", "|---" * 4 + "|"]
md += [f"| {who} | | | |" for who in ("رئيس اللجنة", "عضو", "منسق التدريب")]
with open("/output/محضر_مفاضلة_مارس_2027.md", "w", encoding="utf-8") as f:
    f.write("\n".join(md) + "\n")
# The same result as text: without a sandbox the assistant can quote this, but cannot query a CSV.
txt = ["# أسباب نتيجة مفاضلة دورات مارس 2027", "", "توصية آلية بانتظار اعتماد اللجنة."]
for code, (seats, _) in PROG.items():
    q = queues[code]
    cut = q[min(seats, len(q)) - 1]["total"]
    txt += ["", f"## المرشحون لدورة {names[code]} ({code})", "", f"المقاعد {seats}، ومجموع آخر مرشح {n(cut)}.", ""]
    txt += [f"{r['rank']}. {r['الاسم']}: {n(r['total'])}" for r in q[:seats]]
    for state in STATES[1:]:
        for r in rows:
            if r["رمز البرنامج"] != code or r["state"] != state:
                continue
            # one section per request, so one person's reason is never read as a neighbour's
            txt += ["", f"## {r['الاسم']}: {state} في دورة {names[code]}", "",
                    f"{r['الاسم']} ({r['الرقم الوظيفي']}) {state} في دورة {names[code]}. السبب الوحيد المسجل: {r['why']}."]
            if state != "مستبعد":
                txt[-1] += f" الفرق عن آخر مرشح {n(cut - r['total'])} نقطة."
with open("/output/أسباب_نتيجة_المفاضلة_مارس_2027.md", "w", encoding="utf-8") as f:
    f.write("\n".join(txt) + "\n")
print(len(rows), dict(Counter(r["state"] for r in rows)))
