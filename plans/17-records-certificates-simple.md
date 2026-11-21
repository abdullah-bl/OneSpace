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

## 3. Certificate design: no JSON

- **Upload your design** (PDF or image with the logo and fixed text). It is the background. Click a spot, pick a field: «هنا الاسم», «هنا التاريخ». Drag to move, size and alignment per field.
- **Or pick a ready layout** (two or three) and add the logo.
- **The preview uses a real row** of the record set.
- JSON stays under «متقدم».

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
| «صمّم شهادة بشعارنا», or an old certificate uploaded | Reads it and proposes where each field goes, as a preview. A manager saves and approves. |
| «أصدر شهادات دورة السلامة لمن أنهاها هذا الشهر» | `query_records`, then a batch `fill_template`: one batch for the manager to approve. |
| An employee: «أعطني شهادتي» | `my_records`: the download link if issued, otherwise a request to the space's manager. |

## Order

1. Records from a file (§1). ✓ (`records:analyzeFile`, `records:createFromFile`)
2. Staff file for identifiers (§2). ✓ (`staffFile:analyze`, `staffFile:apply`)
3. Batch issue and one-step approve (§4). ✓ (`documents:rowsForTemplate`, `requestMany`, `approveAndIssue`). Not yet: the per-document approval setting, and a PDF preview before issuing (comes with §3's real-row preview).
4. Visual template editor (§3). ✓ (`TemplateDesigner.tsx`; `templates:preview` renders with pdftoppm, already a server dependency; PNG/JPG designs become a one-page PDF; a new version can keep the background).
5. Assistant tools (§5): `propose_record_set` first, then batch `fill_template`, then design reading.
6. Difference preview on re-import (§1).
