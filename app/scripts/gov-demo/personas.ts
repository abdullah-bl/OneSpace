// The demo government entity: a fictional agency («الهيئة التجريبية للخدمات الحكومية»), its people and
// its spaces. All names and data are invented for the demo.

export const WORKSPACE = "الهيئة التجريبية للخدمات الحكومية";

export const personas = [
  { key: "admin", email: "it.director@gov-demo.test", name: "فيصل الحربي", title: "مدير تقنية المعلومات (مدير مساحة العمل)", employeeNo: "10001" },
  { key: "office", email: "office@gov-demo.test", name: "نورة القحطاني", title: "مديرة مكتب الرئيس التنفيذي", employeeNo: "10002" },
  { key: "hr", email: "hr.manager@gov-demo.test", name: "عبدالرحمن الشهري", title: "مدير الموارد البشرية", employeeNo: "10003" },
  { key: "hrspec", email: "hr.specialist@gov-demo.test", name: "ريم الدوسري", title: "أخصائية موارد بشرية", employeeNo: "10004" },
  { key: "legal", email: "legal@gov-demo.test", name: "محمد العنزي", title: "المستشار القانوني", employeeNo: "10005" },
  { key: "finance", email: "finance@gov-demo.test", name: "هند الزهراني", title: "مديرة الشؤون المالية", employeeNo: "10006" },
  { key: "procure", email: "procurement@gov-demo.test", name: "سلطان المطيري", title: "أخصائي المشتريات والعقود", employeeNo: "10007" },
  { key: "care", email: "care@gov-demo.test", name: "أمل الغامدي", title: "مديرة خدمة المستفيدين", employeeNo: "10008" },
  { key: "training", email: "training@gov-demo.test", name: "تركي السبيعي", title: "منسق التدريب والتطوير", employeeNo: "10009" },
  { key: "strategy", email: "strategy@gov-demo.test", name: "لمى الشمري", title: "محللة التخطيط الاستراتيجي والأداء", employeeNo: "10010" },
  { key: "employee", email: "employee@gov-demo.test", name: "ياسر الحارثي", title: "موظف خدمة المستفيدين", employeeNo: "10011" },
] as const;

export type PersonaKey = (typeof personas)[number]["key"];

type Role = "manager" | "member" | "reader";
export const spaces: { name: string; manager: PersonaKey; everyone?: boolean; sensitive?: boolean; members: [PersonaKey, Role][]; purpose: string }[] = [
  {
    name: "السياسات واللوائح",
    manager: "legal",
    everyone: true,
    members: [],
    purpose: "مرجع موحّد لكل الموظفين: الأنظمة واللوائح الداخلية وسياسات الهيئة، يسأل عنها أي موظف ويحصل على إجابة موثّقة بالمصدر.",
  },
  {
    name: "مكتب الرئيس التنفيذي",
    manager: "office",
    members: [["admin", "member"], ["strategy", "member"], ["legal", "reader"]],
    purpose: "المراسلات والخطابات الرسمية، محاضر الاجتماعات، متابعة القرارات والتوجيهات.",
  },
  {
    name: "الموارد البشرية",
    manager: "hr",
    sensitive: true,
    members: [["hrspec", "member"], ["training", "reader"]],
    purpose: "بيانات الموظفين، الإجازات، التعريفات والشهادات الرسمية، التوظيف والتهيئة.",
  },
  {
    name: "الشؤون القانونية",
    manager: "legal",
    members: [["office", "member"], ["procure", "reader"]],
    purpose: "مراجعة العقود، الرأي القانوني، متابعة القضايا والأنظمة ذات العلاقة.",
  },
  {
    name: "المالية والمشتريات",
    manager: "finance",
    sensitive: true,
    members: [["procure", "member"], ["strategy", "reader"]],
    purpose: "الميزانية والصرف، طلبات الشراء، المنافسات وتقييم العروض.",
  },
  {
    name: "خدمة المستفيدين",
    manager: "care",
    members: [["employee", "member"], ["strategy", "reader"], ["office", "reader"]],
    purpose: "البلاغات والشكاوى، الأسئلة الشائعة، استبيانات الرضا، التقارير الدورية.",
  },
  {
    name: "التدريب والتطوير",
    manager: "training",
    members: [["hrspec", "member"], ["hr", "member"]],
    purpose: "الخطة التدريبية، الاختبارات القصيرة، شهادات الحضور بالدفعات.",
  },
  {
    name: "التخطيط الاستراتيجي والأداء",
    manager: "strategy",
    members: [["office", "member"], ["finance", "reader"]],
    purpose: "مؤشرات الأداء، التقارير الربعية، تحليل البيانات، متابعة المبادرات.",
  },
  {
    name: "تقنية المعلومات والأمن السيبراني",
    manager: "admin",
    members: [["employee", "member"]],
    purpose: "سياسات الأمن السيبراني، البلاغات التقنية، الأدوات الداخلية الصغيرة.",
  },
];
