// What the visual editor can hold (plans/19): exactly what model.ts can write as Markdown.

import { Extension, Node, type Extensions, type NodeViewRenderer } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { safeHref } from "./model";

export function editorExtensions(opts: { kept: Map<string, string>; keptView?: NodeViewRenderer }): Extensions {
  const Keep = Node.create({
    name: "keep",
    group: "keptBlock",
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes: () => ({ id: { default: "", parseHTML: (el) => el.getAttribute("data-keep"), renderHTML: (a) => ({ "data-keep": a.id }) } }),
    // Cut and pasted inside this document only: an id from anywhere else is nothing.
    parseHTML: () => [{ tag: "div[data-keep]", getAttrs: (el) => (opts.kept.has(el.getAttribute("data-keep") ?? "") ? null : false) }],
    renderHTML: ({ HTMLAttributes }) => ["div", HTMLAttributes],
    ...(opts.keptView ? { addNodeView: () => opts.keptView! } : {}),
  });
  return [
    StarterKit.configure({
      document: false,
      code: false,
      underline: false, // Markdown has none
      link: { openOnClick: false, autolink: false, linkOnPaste: true, isAllowedUri: (url) => !!url && safeHref(url) },
    }),
    // A locked part is only ever a top-level block: inside a list its source would mean something else.
    Node.create({ name: "doc", topNode: true, content: "(block | keptBlock)+" }),
    // Bold code, and code in a link, are ordinary Markdown.
    Code.extend({ excludes: "" }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    // A Markdown cell is one line: Enter goes to the next cell, and there's no break inside (Word
    // would print it as «<br>»).
    TableHeader.extend({ content: "paragraph" }),
    TableCell.extend({ content: "paragraph" }),
    Extension.create({
      name: "cellKeys",
      priority: 1000,
      addKeyboardShortcuts() {
        const inTable = () => this.editor.isActive("table");
        return {
          Enter: () => inTable() && (this.editor.commands.goToNextCell() || true),
          "Shift-Enter": () => inTable(),
          "Mod-Enter": () => inTable(),
        };
      },
    }),
    Keep,
  ];
}
