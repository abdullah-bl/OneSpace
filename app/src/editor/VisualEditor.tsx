// The document editor for people who don't write Markdown (plans/19): they see the document and a
// toolbar; what's saved is still Markdown (document.ts). Loaded only when someone edits.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { Extension, type Editor, type NodeViewRenderer } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Icon, type IconName } from "../icons";
import { renderAnswer } from "../markdown";
import { askText, tell } from "../ui";
import { draftSource, openDocument, saveDocument, unchanged, type OpenDocument } from "./document";
import { editorExtensions } from "./extensions";
import { docJson, safeHref } from "./model";
import { tidyPastedTables } from "./paste";
import "./editor.css";

export type VisualEditorHandle = {
  /** The document as edited, as Markdown. Throws (SaveError) rather than returning something else. */
  result: () => { markdown: string; lossy: boolean };
  /** The document as Markdown without the checks, for fixing by hand when `result` refuses. */
  draft: () => string;
};

type Props = { source: string; disabled?: boolean; onDirty: (dirty: boolean) => void };

const DATA_IMAGE = /^!\[([^\]]*)\]\((data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,][^)\s]+)\)$/i;

/** A locked part: a chart shows as the chart, anything else as safe text. Never as live HTML. */
function keptView(kept: Map<string, string>): NodeViewRenderer {
  return ({ node }) => {
    const raw = kept.get(String(node.attrs.id)) ?? "";
    const dom = document.createElement("div");
    dom.className = "doc-kept";
    dom.contentEditable = "false";
    dom.dataset.keep = String(node.attrs.id);
    const label = document.createElement("p");
    label.className = "doc-kept-label";
    const body = document.createElement("div");
    const image = DATA_IMAGE.exec(raw.trim());
    if (image) {
      label.textContent = "صورة ثابتة: تبقى كما هي، وتقدر تحذفها";
      const img = document.createElement("img");
      img.src = image[2]!;
      img.alt = image[1]!;
      body.append(img);
    } else {
      label.textContent = "جزء ثابت: لا يُعدَّل هنا، ويبقى كما هو عند الحفظ";
      body.inert = true;
      if (/^\s*</.test(raw)) {
        // HTML: its words only. A parsed document runs and loads nothing.
        body.textContent = new DOMParser().parseFromString(raw, "text/html").body.textContent?.trim() || "(عنصر HTML)";
      } else {
        const html = renderAnswer(raw, new Set()).trim();
        if (html) body.innerHTML = html;
        else body.textContent = raw; // a link's definition shows as nothing
      }
    }
    dom.append(label, body);
    return { dom, ignoreMutation: () => true };
  };
}

/** Arabic or Latin, as the Word export decides it: by the majority of the letters. */
function directionOf(text: string): "rtl" | "ltr" {
  const prose = text.replace(/\]\([^)]*\)/g, "]").slice(0, 20_000);
  const ar = prose.match(/[֐-ࣿ]/g)?.length ?? 0;
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0;
  return latin > ar ? "ltr" : "rtl";
}

/**
 * A paragraph in the other language runs its own way. One with no letters (a number, an empty line)
 * stays on the document's side, and so do table cells, as in the preview.
 */
function paragraphDirection(dir: "rtl" | "ltr") {
  return Extension.create({
    name: "paragraphDirection",
    addProseMirrorPlugins: () => [
      new Plugin({
        props: {
          decorations(state) {
            const found: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === "table") return false;
              if (!node.isTextblock || node.type.name === "codeBlock") return true;
              const first = /[A-Za-z\u0590-\u08FF]/.exec(node.textContent)?.[0];
              if (first) {
                const own = /[A-Za-z]/.test(first) ? "ltr" : "rtl";
                if (own !== dir) found.push(Decoration.node(pos, pos + node.nodeSize, { dir: own }));
              }
              return false;
            });
            return DecorationSet.create(state.doc, found);
          },
        },
      }),
    ],
  });
}

/** Text copied from a chat answer is Markdown: pasted as the formatting it stands for. */
function pastedMarkdown(editor: Editor, text: string): boolean {
  if (editor.isActive("table") || editor.isActive("codeBlock")) return false;
  const parsed = openDocument(text);
  if (!parsed.parts.length || parsed.kept.size) return false;
  const formatted = parsed.parts.some((p) => p.block.t !== "p" || p.block.spans.some((s) => s.b || s.href || s.code || s.x));
  if (!formatted) return false;
  const { content } = editor.schema.nodeFromJSON(docJson(parsed.parts.map((p) => p.block)));
  editor.view.dispatch(editor.state.tr.replaceSelection(Slice.maxOpen(content)).scrollIntoView());
  return true;
}

const VisualEditor = forwardRef<VisualEditorHandle, Props>(function VisualEditor({ source, disabled, onDirty }, handle) {
  const [doc] = useState<OpenDocument>(() => openDocument(source));
  const [notice, setNotice] = useState("");
  const dirty = useRef(onDirty);
  dirty.current = onDirty;
  const locked = useRef(!!disabled);
  locked.current = !!disabled;
  const self = useRef<Editor | null>(null);
  const [setup] = useState(() => {
    const dir = directionOf(doc.text);
    return { dir, extensions: [...editorExtensions({ kept: doc.kept, keptView: keptView(doc.kept) }), paragraphDirection(dir)] };
  });
  const editor = useEditor({
    extensions: setup.extensions,
    content: doc.json,
    autofocus: "start",
    injectCSS: true,
    editorProps: {
      attributes: { class: "doc-editor", dir: setup.dir, role: "textbox", "aria-multiline": "true", "aria-label": "محرر المستند" },
      // While saving, shortcuts (Ctrl+B, Tab…) change nothing either.
      handleKeyDown: () => locked.current,
      transformPastedHTML: tidyPastedTables,
      handlePaste: (view, event) => {
        if (locked.current) return true;
        const data = event.clipboardData;
        if (!data) return false;
        const html = data.getData("text/html");
        const text = data.getData("text/plain");
        const image = /<img\b/i.test(html) || [...data.files].some((f) => f.type.startsWith("image/"));
        setNotice(image ? "الصور لا تُلصق في المستند. أُلصق النص فقط." : "");
        if (self.current?.isActive("table") && !/<table/i.test(html)) {
          // A cell is one line. Pasted as blocks, the second line would land on the next cell's text.
          const words = text || new DOMParser().parseFromString(html, "text/html").body.textContent || "";
          view.dispatch(view.state.tr.insertText(words.replace(/\s+/g, " ").trim()).scrollIntoView());
          return true;
        }
        return !html && !!text && !!self.current && pastedMarkdown(self.current, text);
      },
      handleDrop: (view, event, slice) => {
        if ([...(event.dataTransfer?.files ?? [])].length) {
          event.preventDefault();
          setNotice("الملفات والصور لا تُضاف بالسحب إلى المستند.");
          return true;
        }
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!at) return false;
        const $at = view.state.doc.resolve(at.pos);
        const intoCell = Array.from({ length: $at.depth + 1 }, (_, d) => $at.node(d).type.name).includes("table");
        if (!intoCell || (slice.content.childCount <= 1 && slice.content.firstChild?.type.name !== "table" && (slice.content.firstChild?.isTextblock || slice.content.firstChild?.isInline))) return false;
        event.preventDefault();
        setNotice("الخلية سطر واحد: لا تُسحب إليها عدة أسطر.");
        return true;
      },
    },
    onUpdate: ({ editor }) => dirty.current(!unchanged(doc, editor.getJSON())),
  });
  self.current = editor;

  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);

  useImperativeHandle(
    handle,
    () => ({
      result: () => (editor ? saveDocument(doc, editor.getJSON()) : { markdown: source, lossy: false }),
      draft: () => (editor ? draftSource(doc, editor.getJSON()) : source),
    }),
    [editor, doc, source],
  );

  if (!editor) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar editor={editor} disabled={!!disabled} />
      {notice && (
        <p className="shrink-0 bg-warning-soft px-3 py-1.5 text-xs text-warning" role="status">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  );
});
export default VisualEditor;

function Tool({ icon, label, run, on, disabled, children }: { icon?: IconName; label: string; run: () => void; on?: boolean; disabled?: boolean; children?: ReactNode }) {
  return (
    <button
      type="button"
      className={`flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs disabled:opacity-30 ${on ? "bg-primary-soft text-primary" : "text-ink hover:bg-active"}`}
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={disabled}
      // The selection stays in the document.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

const Gap = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;

function Toolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      undo: e.can().undo(),
      redo: e.can().redo(),
      level: e.isActive("heading") ? Number(e.getAttributes("heading").level) : 0,
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      bullets: e.isActive("bulletList"),
      numbers: e.isActive("orderedList"),
      tasks: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      table: e.isActive("table"),
      item: e.isActive("taskItem") ? "taskItem" : "listItem",
      inList: e.isActive("listItem") || e.isActive("taskItem"),
      header: e.isActive("tableHeader"),
    }),
  });
  const go = () => editor.chain().focus();

  const setLink = async () => {
    const { from, to } = editor.state.selection;
    const answer = await askText("عنوان الرابط", String(editor.getAttributes("link").href ?? ""), { confirmLabel: "أضف الرابط", maxLength: 4000 });
    if (!answer) return;
    const href = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(answer) ? `https://${answer}` : answer;
    if (!safeHref(href)) return void tell("هذا العنوان لا يصلح رابطاً");
    if (from === to && !editor.isActive("link")) go().setTextSelection(from).insertContent({ type: "text", text: answer, marks: [{ type: "link", attrs: { href } }] }).run();
    else go().setTextSelection({ from, to }).extendMarkRange("link").setLink({ href }).run();
  };

  return (
    // While saving, nothing changes: what's on screen is what was sent.
    <fieldset disabled={disabled} className="m-0 min-w-0 shrink-0 border-0 border-b border-line bg-surface p-0" dir="rtl">
      <div className="flex items-center gap-0.5 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]" role="toolbar" aria-label="تنسيق المستند">
        <Tool icon="undo" label="تراجع" disabled={!s.undo} run={() => go().undo().run()} />
        <Tool icon="redo" label="إعادة" disabled={!s.redo} run={() => go().redo().run()} />
        <Gap />
        <select
          className="h-8 shrink-0 rounded-md border border-line bg-surface px-2 text-xs"
          aria-label="نوع النص"
          value={s.level}
          disabled={s.table}
          onChange={(e) => {
            const level = Number(e.target.value);
            if (level) go().setHeading({ level: level as 1 }).run();
            else go().setParagraph().run();
          }}
        >
          <option value={0}>نص عادي</option>
          <option value={1}>عنوان رئيسي</option>
          <option value={2}>عنوان فرعي</option>
          <option value={3}>عنوان صغير</option>
          {s.level > 3 && <option value={s.level}>عنوان {s.level}</option>}
        </select>
        <Gap />
        <Tool icon="bold" label="عريض" on={s.bold} run={() => go().toggleBold().run()} />
        <Tool icon="italic" label="مائل" on={s.italic} run={() => go().toggleItalic().run()} />
        <Tool icon="strike" label="مشطوب" on={s.strike} run={() => go().toggleStrike().run()} />
        <Gap />
        <Tool icon="bullets" label="قائمة نقطية" on={s.bullets} disabled={s.table} run={() => go().toggleBulletList().run()} />
        <Tool icon="numbers" label="قائمة مرقّمة" on={s.numbers} disabled={s.table} run={() => go().toggleOrderedList().run()} />
        <Tool icon="tasks" label="قائمة مهام" on={s.tasks} disabled={s.table} run={() => go().toggleTaskList().run()} />
        {s.inList && (
          <>
            <Tool icon="indent" label="زيادة الإزاحة" run={() => go().sinkListItem(s.item).run()} />
            <Tool icon="outdent" label="إنقاص الإزاحة" run={() => go().liftListItem(s.item).run()} />
          </>
        )}
        <Gap />
        <Tool icon="link" label={s.link ? "تعديل الرابط" : "رابط"} on={s.link} run={() => void setLink()} />
        {s.link && <Tool icon="x" label="إزالة الرابط" run={() => go().extendMarkRange("link").unsetLink().run()} />}
        <Tool icon="table" label="إدراج جدول" on={s.table} disabled={s.table || s.inList} run={() => go().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
        <Tool icon="quote" label="اقتباس" on={s.quote} disabled={s.table} run={() => go().toggleBlockquote().run()} />
        <Tool icon="rule" label="خط فاصل" disabled={s.table || s.inList} run={() => go().setHorizontalRule().run()} />
      </div>
      {s.table && (
        <div className="flex animate-fade items-center gap-0.5 overflow-x-auto border-t border-line bg-sunken px-2 py-1 [scrollbar-width:none]" role="toolbar" aria-label="الجدول">
          <Tool icon="plus" label="صف تحته" run={() => go().addRowAfter().run()}>صف تحته</Tool>
          <Tool icon="plus" label="صف فوقه" disabled={s.header} run={() => go().addRowBefore().run()}>صف فوقه</Tool>
          <Tool icon="plus" label="عمود بعده" run={() => go().addColumnAfter().run()}>عمود بعده</Tool>
          <Tool icon="plus" label="عمود قبله" run={() => go().addColumnBefore().run()}>عمود قبله</Tool>
          <Gap />
          <Tool label="حذف الصف" run={() => go().deleteRow().run()}>حذف الصف</Tool>
          <Tool label="حذف العمود" run={() => go().deleteColumn().run()}>حذف العمود</Tool>
          <Tool label="حذف الجدول" run={() => go().deleteTable().run()}>حذف الجدول</Tool>
        </div>
      )}
    </fieldset>
  );
}
