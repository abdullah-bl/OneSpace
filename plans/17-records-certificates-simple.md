# 17 — Records and certificates, set up from what the user already has

## Why

Records, templates and documents (Phase 4) work, and the rules behind them are right: values come from an imported file, a person approves, anyone can verify. Setting them up asks too much of an ordinary manager:

- **A record set is built before the file.** The manager types every column header exactly as in the Excel file, invents a Latin key for each, picks a type, marks the owner column and the uniqueness columns. Then uploads a file that must match.
- **A template is JSON.** Positions in points, typed by hand, with a suggested layout as the only help.
- **Every certificate takes three steps:** request, approve, issue, one record at a time.
- **Employees are linked to their records by hand:** the workspace admin types each national id on each account.

The model is reversed: **start from what the user already has (the Excel file, the old certificate) and let them choose**, instead of describing it first.

## What stays

- Values in an official document come from the record, by code. Never from the model, never typed.
- Imports are all-or-nothing and every import is a dated version.
- A template is used only after a manager approves it. Issuing still needs a person's approval.
- `my_records` matches on the identifiers on the account, never on a name or anything in a chat.

## 1. Records: upload, then choose

1. **Upload the Excel file.** The name is suggested from the file name.
2. **The file's own columns are shown**, with sample values. For each:
   - «اعتمد» (all ticked). An unticked column is not stored, and later files may still contain it;
   - a type guessed from the values (date, number, yes/no, text);
   - «إلزامي» guessed: ticked when no cell is empty.
   Keys are generated (`c1`, `c2`…) and never shown.
3. **The owner column is found:** a column whose values look like ids (digits, mostly distinct). The page says how many match accounts: «يطابق 37 من 40 موظفاً». National id or employee number is chosen by which matches more.
4. **Uniqueness is suggested:** the fewest chosen columns that make every row distinct, owner column first. Shown as one line («لا يتكرر: رقم الهوية + الدورة»), changeable.
5. **«أنشئ واستورد»** validates the whole file against the chosen definition, then creates the set and imports version 1 in one transaction. If anything fails, nothing is created and every error is listed by row.

**Later files** (`commitImport`) already match columns by header and ignore extra ones. Next: show the difference before confirming («أُضيف 12، تغيّر 3، حُذف 1»).

Backend: `records:analyzeFile` (reads the file, guesses, counts account matches; writes nothing) and `records:createFromFile` (validate, create, import). Inference is a pure function in `recordSources.ts` (`inferColumns`, `suggestUnique`).

## 2. Linking employees: the same way

The admin uploads a staff file (email + national id and/or employee number). Accounts are matched by email; the page shows matched / not found / already set to another account before saving. One audit entry per change, like `admin:setIdentifiers`.

## 3. Certificate design: a Word file with {{variables}}

People already design certificates in Word. So the template is their Word file, not a layout
built in OneSpace.

1. **Upload the .docx**, designed as they like (logo, fonts, frame), with variables where the data goes: `{{الاسم}}`, `{{الدورة}}`, `{{employee_id}}`.
2. **The variables are read from the file** and matched to the record set's columns by name. Any variable with no column (a typo like `{{full_namne}}`) is shown to be mapped or fixed; nothing is saved until every one is.
3. **Reserved variables** filled at issue: `{{الرقم_التسلسلي}}`, `{{رمز_التحقق}}`, `{{تاريخ_الإصدار}}` (or `{{serial}}`, `{{verify_code}}`, `{{issue_date}}`).
4. **Preview**: the real PDF with the first row, as an image. Fonts the file uses that the server doesn't have are named.
5. **Approve, then issue** in batches (§4), unchanged.

No Word file? «نموذج جاهز» downloads a .docx with the set's variables, to edit in Word and upload.

How it works:
- Word splits text into runs, so `{{الاسم}}` may be stored in pieces. Each paragraph's runs are rejoined around a variable before reading or filling, so the user never sees this.
- Filling is code: the values come from the record, escaped, into the variables only. The filled .docx is deterministic (same data, same bytes); LibreOffice (already on the server for file conversion) turns it into the PDF.
- That PDF isn't byte-reproducible across LibreOffice runs, so for Word templates the issued file and its sha256 are what's kept and verified (by code or by uploading the file). «reproduce» stays for layout templates only.
- The visual layout editor is removed from the UI. Existing layout templates keep issuing as they are; new templates are Word files.

## 4. Approval: once for the design, once per batch

- **The design is approved once** (as now); any change is a new version to approve.
- **Issue in batches:** «أصدر لكل صفوف هذا السجل» or for selected rows. One review screen lists N certificates with a preview; one approval issues them all. Approve and issue become one step.
- **After an import**, a notice: «12 صفاً جديداً بلا شهادة».
- **Per-document approval** stays as a space setting, for sensitive spaces or to separate who requests from who approves.

## 5. What the assistant does

The assistant proposes structure and picks rows. It never writes a value into an official document.

| Situation | Assistant |
|---|---|
| Excel dropped in a chat: «اعتمد هذا سجلاً للدورات» | `propose_record_set`: the same analysis as step 1, shown as a card (name, columns, owner, uniqueness) with «أنشئ». The person confirms. |
| A file is refused | Explains the errors plainly and what to change (the cell or the column type). |
| An old certificate (Word) uploaded: «حوّلها قالباً» | Proposes which words become which {{variables}} (the name, the course…), as a preview. A manager saves and approves. |
| «أصدر شهادات دورة السلامة لمن أنهاها هذا الشهر» | `query_records`, then a batch `fill_template`: one batch for the manager to approve. |
| An employee: «أعطني شهادتي» | `my_records`: the download link if issued, otherwise a request to the space's manager. |

## Order

1. Records from a file (§1). ✓ (`records:analyzeFile`, `records:createFromFile`)
2. Staff file for identifiers (§2). ✓ (`staffFile:analyze`, `staffFile:apply`)
3. Batch issue and one-step approve (§4). ✓ (`documents:rowsForTemplate`, `requestMany`, `approveAndIssue`). Not yet: the per-document approval setting, and a PDF preview before issuing (comes with §3's real-row preview).
4. Word templates (§3). ✓ (`lib/docxTemplate.ts`; `templates:analyzeWord`, `previewWord`, `saveWord`, `sampleWord`, `downloadWord`; `WordTemplate.tsx`). Replaces the visual layout editor built first (28655df), which was more to learn than a Word file people already have. LibreOffice runs with `SAL_DISABLE_CUPS=1`: without it every .docx import waited ~25 s on the printer service.
5. Assistant tools (§5). ✓ `propose_record_set` (the server analyses the file with the records tab's code; the card shows it; «نفّذ» recomputes from the file). `fill_template` takes `recordIds` (up to 50, ids only; the card names the template, the people and how many already have one). The template may be given by its exact name: the model sees names, not ids, and passed «شهادة حضور» as the id in the first live try. `query_records` / `my_records` give rows by column header; `my_records` says where to download (#/me) and which department to ask. Not yet: turning an old Word certificate into a template (proposing which words become variables), and a request from the employee to the department.
6. Difference preview on re-import (§1).
