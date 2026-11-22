// Pasted tables (Word, Excel, web pages) made into what a Markdown table can be before the editor
// reads them (plans/19). Without this its schema splits a two-paragraph cell into two cells, and
// every column after it moves.

const BLOCKS = "p, div, li, h1, h2, h3, h4, h5, h6, pre, blockquote";
const MAX_SPAN = 100;

export function tidyPastedTables(html: string): string {
  if (!/<table/i.test(html)) return html;
  // A parsed document runs and loads nothing.
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Inner tables first: a table in a cell becomes that cell's words.
  for (const table of [...doc.querySelectorAll("table")].reverse()) {
    if (table.parentElement?.closest("td, th")) table.replaceWith(` ${[...table.querySelectorAll("td, th")].map((c) => c.textContent?.trim()).filter(Boolean).join("، ")} `);
  }
  for (const table of doc.querySelectorAll("table")) {
    for (const cell of table.querySelectorAll("td, th")) {
      // One paragraph, its parts a space apart.
      for (const br of cell.querySelectorAll("br")) br.replaceWith(" ");
      for (const el of [...cell.querySelectorAll(BLOCKS)].reverse()) el.replaceWith(" ", ...el.childNodes, " ");
      for (const el of [...cell.querySelectorAll("ul, ol")].reverse()) el.replaceWith(" ", ...el.childNodes, " ");
      const line = doc.createElement("p");
      line.append(...cell.childNodes);
      cell.append(line);
    }
    // A merged cell keeps its place, and the places it covered stay empty.
    const below = new Map<number, number>(); // column → rows still covered from above
    for (const row of table.rows) {
      const cells = [...row.cells];
      let column = 0;
      const fill = (before: Element | null) => {
        while ((below.get(column) ?? 0) > 0) {
          below.set(column, below.get(column)! - 1);
          row.insertBefore(doc.createElement("td"), before);
          column++;
        }
      };
      for (const cell of cells) {
        fill(cell);
        const across = Math.min(MAX_SPAN, Math.max(1, cell.colSpan));
        const down = Math.min(MAX_SPAN * 10, Math.max(1, cell.rowSpan));
        cell.removeAttribute("colspan");
        cell.removeAttribute("rowspan");
        for (let i = 0; i < across; i++) {
          if (down > 1) below.set(column, down - 1);
          column++;
          if (i) cell.after(doc.createElement("td"));
        }
      }
      fill(null);
    }
  }
  return doc.body.innerHTML;
}
