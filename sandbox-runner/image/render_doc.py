"""OneSpace document renderer: one output (Markdown or HTML) → DOCX, PDF or PPTX.

Runs inside the sandbox (no network) as `import onespace_doc; onespace_doc.main()`. OneBase sends
/input/doc.json = {"title", "kind": "markdown"|"html", "content", "format": "docx"|"pdf"|"pptx"}
and gets /output/out.<format> back. Arabic is first-class: paragraphs whose first strong letter is
Arabic are right-to-left (bidi paragraphs and runs in Word, rtl paragraphs in PowerPoint, and
`unicode-bidi: plaintext` in the PDF, which Pango/HarfBuzz shape).
"""

import json
import re
import sys

INPUT = "/input/doc.json"
OUTPUT = "/output/out."

_RTL = re.compile(r"[֐-ࣿיִ-﷿ﹰ-ﻼ]")
_LTR = re.compile(r"[A-Za-zÀ-ɏ]")


def is_rtl(text):
    """Direction of a paragraph from its first strong letter (Unicode bidi rule P2, simplified)."""
    for ch in text:
        if _RTL.match(ch):
            return True
        if _LTR.match(ch):
            return False
    return False


# ---------------------------------------------------------------- Markdown → blocks

def _runs(inline):
    """Inline token → [(text, {"b","i","code","href"})]."""
    out = []
    bold = italic = 0
    href = None
    for t in inline.children or []:
        if t.type == "strong_open":
            bold += 1
        elif t.type == "strong_close":
            bold -= 1
        elif t.type == "em_open":
            italic += 1
        elif t.type == "em_close":
            italic -= 1
        elif t.type == "link_open":
            href = t.attrGet("href")
        elif t.type == "link_close":
            href = None
        elif t.type in ("softbreak",):
            out.append((" ", {}))
        elif t.type == "hardbreak":
            out.append(("\n", {}))
        elif t.type == "code_inline":
            out.append((t.content, {"code": True}))
        elif t.type == "image":
            alt = "".join(c.content for c in (t.children or []))
            if alt:
                out.append((alt, {"i": True}))
        elif t.type in ("text", "html_inline"):
            if t.content:
                out.append((t.content, {"b": bold > 0, "i": italic > 0, "href": href}))
    return out


def text_of(runs):
    return "".join(r[0] for r in runs)


def parse_markdown(src):
    from markdown_it import MarkdownIt

    md = MarkdownIt("commonmark").enable(["table", "strikethrough"])
    tokens = md.parse(src or "")
    blocks = []
    lists = []  # stack of {"ordered", "n"}
    quote = 0
    table = None
    row = None
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t.type == "heading_open":
            blocks.append({"t": "h", "level": int(t.tag[1]), "runs": _runs(tokens[i + 1])})
            i += 3
            continue
        if t.type in ("bullet_list_open", "ordered_list_open"):
            start = t.attrGet("start")
            lists.append({"ordered": t.type == "ordered_list_open", "n": int(start) - 1 if start else 0})
        elif t.type in ("bullet_list_close", "ordered_list_close"):
            lists.pop()
        elif t.type == "list_item_open":
            lists[-1]["n"] += 1
            lists[-1]["fresh"] = True
        elif t.type == "blockquote_open":
            quote += 1
        elif t.type == "blockquote_close":
            quote -= 1
        elif t.type == "paragraph_open":
            runs = _runs(tokens[i + 1])
            b = {"t": "p", "runs": runs, "quote": quote > 0}
            if lists:
                top = lists[-1]
                # Only the item's first paragraph carries the bullet/number.
                b["list"] = {"ordered": top["ordered"], "depth": len(lists), "n": top["n"], "first": top.pop("fresh", False)}
            blocks.append(b)
            i += 3
            continue
        elif t.type in ("fence", "code_block"):
            blocks.append({"t": "code", "text": t.content.rstrip("\n")})
        elif t.type == "hr":
            blocks.append({"t": "hr"})
        elif t.type == "table_open":
            table = {"t": "table", "rows": []}
        elif t.type == "tr_open":
            row = []
        elif t.type in ("th_open", "td_open"):
            row.append(_runs(tokens[i + 1]) if tokens[i + 1].type == "inline" else [])
        elif t.type == "tr_close":
            table["rows"].append(row)
        elif t.type == "table_close":
            width = max((len(r) for r in table["rows"]), default=0)
            table["rows"] = [r + [[]] * (width - len(r)) for r in table["rows"]]
            if width:
                blocks.append(table)
            table = None
        elif t.type == "html_block":
            text = re.sub(r"<[^>]+>", "", t.content).strip()
            if text:
                blocks.append({"t": "p", "runs": [(text, {})], "quote": False})
        i += 1
    return blocks


def doc_rtl(blocks, title):
    sample = title + " " + " ".join(text_of(b.get("runs", [])) for b in blocks[:20] if b.get("runs"))
    return len(_RTL.findall(sample)) > len(_LTR.findall(sample))


def with_title(blocks, title):
    """The title as a first-level heading, unless the document already opens with one."""
    if title and not (blocks and blocks[0]["t"] == "h" and blocks[0]["level"] == 1):
        return [{"t": "h", "level": 1, "runs": [(title, {})]}] + blocks
    return blocks


# ---------------------------------------------------------------- DOCX

def render_docx(blocks, title, path):
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    doc = Document()
    doc.core_properties.title = title
    rtl_doc = doc_rtl(blocks, title)

    def fonts(rpr_owner, name="Arial"):
        rpr = rpr_owner.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = OxmlElement("w:rFonts")
            rpr.insert(0, rf)
        for k in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            rf.set(qn(k), name)

    for style in ("Normal", "Title", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "List Bullet", "List Number"):
        try:
            st = doc.styles[style]
        except KeyError:
            continue
        fonts(st.element)
        if style == "Normal":
            st.font.size = Pt(11)
            # Complex-script size follows the Latin size (Arabic text uses szCs).
            szcs = OxmlElement("w:szCs")
            szcs.set(qn("w:val"), "22")
            st.element.get_or_add_rPr().append(szcs)
        if rtl_doc:
            ppr = st.element.get_or_add_pPr()
            ppr.append(OxmlElement("w:bidi"))

    def direction(p, rtl):
        ppr = p._p.get_or_add_pPr()
        bidi = ppr.find(qn("w:bidi"))
        if bidi is None:
            bidi = OxmlElement("w:bidi")
            ppr.insert(0, bidi)
        bidi.set(qn("w:val"), "1" if rtl else "0")
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if rtl else WD_ALIGN_PARAGRAPH.LEFT

    def add_runs(p, runs, base_bold=False):
        for text, f in runs:
            if not text:
                continue
            r = p.add_run(text)
            rpr = r._r.get_or_add_rPr()
            if _RTL.search(text):
                rpr.append(OxmlElement("w:rtl"))
            if f.get("b") or base_bold:
                r.bold = True
                rpr.append(OxmlElement("w:bCs"))
            if f.get("i"):
                r.italic = True
                rpr.append(OxmlElement("w:iCs"))
            if f.get("code"):
                r.font.name = "Consolas"
            if f.get("href"):
                r.font.color.rgb = RGBColor(0x1F, 0x4E, 0x9D)
                r.underline = True

    for b in blocks:
        if b["t"] == "h":
            level = min(b["level"], 4)
            p = doc.add_heading("", level=level)
            add_runs(p, b["runs"])
            direction(p, is_rtl(text_of(b["runs"])) if text_of(b["runs"]).strip() else rtl_doc)
        elif b["t"] == "p":
            lst = b.get("list")
            style = None
            if lst and lst["first"]:
                style = "List Number" if lst["ordered"] else "List Bullet"
                if lst["depth"] > 1:
                    style += " %d" % min(lst["depth"], 3)
            try:
                p = doc.add_paragraph(style=style)
            except KeyError:
                p = doc.add_paragraph(style="List Number" if lst and lst["ordered"] else "List Bullet")
            add_runs(p, b["runs"])
            txt = text_of(b["runs"])
            direction(p, is_rtl(txt) if txt.strip() else rtl_doc)
            if b.get("quote"):
                p.paragraph_format.left_indent = Pt(18)
                p.paragraph_format.right_indent = Pt(18)
                for r in p.runs:
                    r.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
        elif b["t"] == "code":
            for line in b["text"].split("\n") or [""]:
                p = doc.add_paragraph()
                r = p.add_run(line)
                r.font.name = "Consolas"
                r.font.size = Pt(9.5)
                direction(p, False)
                p.paragraph_format.space_after = Pt(0)
        elif b["t"] == "hr":
            p = doc.add_paragraph()
            ppr = p._p.get_or_add_pPr()
            bdr = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            for k, val in (("w:val", "single"), ("w:sz", "6"), ("w:space", "1"), ("w:color", "999999")):
                bottom.set(qn(k), val)
            bdr.append(bottom)
            ppr.append(bdr)
        elif b["t"] == "table":
            rows = b["rows"]
            tbl = doc.add_table(rows=len(rows), cols=len(rows[0]))
            tbl.style = "Table Grid"
            trtl = rtl_doc or any(is_rtl(text_of(c)) for c in rows[0])
            if trtl:
                tbl._tbl.tblPr.append(OxmlElement("w:bidiVisual"))
            for ri, row in enumerate(rows):
                for ci, cell in enumerate(row):
                    p = tbl.cell(ri, ci).paragraphs[0]
                    add_runs(p, cell, base_bold=ri == 0)
                    txt = text_of(cell)
                    direction(p, is_rtl(txt) if txt.strip() else trtl)
            doc.add_paragraph()
    doc.save(path)


# ---------------------------------------------------------------- PPTX

def render_pptx(blocks, title, path):
    from pptx import Presentation
    from pptx.util import Emu, Inches, Pt

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    rtl_doc = doc_rtl(blocks, title)
    MAX_LINES = 8

    def para_dir(p, rtl):
        ppr = p._p.get_or_add_pPr()
        ppr.set("rtl", "1" if rtl else "0")
        ppr.set("algn", "r" if rtl else "l")

    def fill(p, runs, size=None, bold=False):
        for text, f in runs:
            if not text:
                continue
            r = p.add_run()
            r.text = text
            if f.get("b") or bold:
                r.font.bold = True
            if f.get("i"):
                r.font.italic = True
            if size:
                r.font.size = Pt(size)
            rpr = r._r.get_or_add_rPr()
            for tag in ("a:latin", "a:cs"):
                el = rpr.makeelement("{http://schemas.openxmlformats.org/drawingml/2006/main}" + tag.split(":")[1], {"typeface": "Arial"})
                rpr.append(el)

    def set_title(slide, runs, top=Inches(0.35), height=Inches(1.1)):
        t = slide.shapes.title
        t.left, t.top, t.width, t.height = Inches(0.6), top, prs.slide_width - Inches(1.2), height
        t.text_frame.clear()
        p = t.text_frame.paragraphs[0]
        fill(p, runs)
        txt = text_of(runs)
        para_dir(p, is_rtl(txt) if txt.strip() else rtl_doc)

    def place_box(slide):
        body = slide.placeholders[1]
        body.left, body.top = Inches(0.6), Inches(1.5)
        body.width, body.height = prs.slide_width - Inches(1.2), prs.slide_height - Inches(2.0)
        return body

    # Slides: a title slide, then one per H1/H2 (H3+ become bold lines). Long bodies continue.
    title_runs = [(title, {})] if title else []
    sections = []
    current = None
    first_h1_used = False
    for b in blocks:
        if b["t"] == "h" and b["level"] <= 2:
            if b["level"] == 1 and not first_h1_used and not sections and current is None:
                title_runs = b["runs"]
                first_h1_used = True
                continue
            current = {"title": b["runs"], "items": []}
            sections.append(current)
            continue
        if current is None:
            current = {"title": title_runs, "items": []}
            sections.append(current)
        current["items"].append(b)

    # A short lead (up to two plain paragraphs before the first section heading) is the subtitle.
    lead = []
    if sections and sections[0]["title"] is title_runs and len(sections[0]["items"]) <= 2 and all(b["t"] == "p" and not b.get("list") for b in sections[0]["items"]):
        lead = sections.pop(0)["items"]
    s0 = prs.slides.add_slide(prs.slide_layouts[0])
    set_title(s0, title_runs or [(title, {})], top=Inches(2.2), height=Inches(1.8))
    if len(s0.placeholders) > 1:
        sub_ph = s0.placeholders[1]
        sub_ph.left, sub_ph.top, sub_ph.width, sub_ph.height = Inches(1.2), Inches(4.2), prs.slide_width - Inches(2.4), Inches(1.6)
        tf = sub_ph.text_frame
        tf.clear()
        for k, b in enumerate(lead):
            p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
            fill(p, b["runs"], size=20)
            txt = text_of(b["runs"])
            para_dir(p, is_rtl(txt) if txt.strip() else rtl_doc)

    def content_slide(runs, cont=False):
        s = prs.slides.add_slide(prs.slide_layouts[1])
        set_title(s, runs + ([(" (تابع)" if rtl_doc else " (cont.)", {})] if cont else []))
        return s

    for sec in sections:
        lines = []
        for b in sec["items"]:
            if b["t"] == "table":
                lines.append(b)
            elif b["t"] == "h":
                lines.append({"t": "line", "runs": b["runs"], "bold": True, "level": 0})
            elif b["t"] == "p":
                lst = b.get("list")
                lines.append({"t": "line", "runs": b["runs"], "level": (lst["depth"] - 1) if lst else 0, "bullet": bool(lst)})
            elif b["t"] == "code":
                for ln in b["text"].split("\n")[:12]:
                    lines.append({"t": "line", "runs": [(ln, {"code": True})], "level": 0, "code": True})
        chunk, chunks = [], []
        for ln in lines:
            if ln["t"] == "table":
                caption = chunk.pop() if chunk and chunk[-1].get("bold") else None
                if chunk:
                    chunks.append(chunk)
                    chunk = []
                chunks.append([dict(ln, caption=caption)])
                continue
            chunk.append(ln)
            if len(chunk) >= MAX_LINES:
                chunks.append(chunk)
                chunk = []
        if chunk or not chunks:
            chunks.append(chunk)
        for ci, ch in enumerate(chunks):
            s = content_slide(sec["title"], cont=ci > 0)
            if ch and ch[0]["t"] == "table":
                rows = ch[0]["rows"][:12]
                body = s.placeholders[1]
                left, top, width = Inches(0.6), Inches(1.5), prs.slide_width - Inches(1.2)
                body._element.getparent().remove(body._element)
                cap = ch[0].get("caption")
                if cap:
                    box = s.shapes.add_textbox(left, top, width, Inches(0.6))
                    box.text_frame.word_wrap = True
                    p = box.text_frame.paragraphs[0]
                    fill(p, cap["runs"], size=22, bold=True)
                    txt = text_of(cap["runs"])
                    para_dir(p, is_rtl(txt) if txt.strip() else rtl_doc)
                    top = top + Inches(0.75)
                shape = s.shapes.add_table(len(rows), len(rows[0]), left, top, width, Emu(int(Inches(0.4)) * len(rows)))
                trtl = rtl_doc or any(is_rtl(text_of(c)) for c in rows[0])
                if trtl:
                    shape.table._tbl.tblPr.set("rtl", "1")  # first column on the right
                for ri, row in enumerate(rows):
                    for cj, cell in enumerate(row):
                        tf = shape.table.cell(ri, cj).text_frame
                        tf.clear()
                        p = tf.paragraphs[0]
                        fill(p, cell, size=18, bold=ri == 0)
                        txt = text_of(cell)
                        para_dir(p, is_rtl(txt) if txt.strip() else trtl)
                continue
            body = place_box(s)
            tf = body.text_frame
            tf.word_wrap = True
            tf.clear()
            for k, ln in enumerate(ch):
                p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
                p.level = min(ln.get("level", 0), 4)
                fill(p, ln["runs"], size=16 if ln.get("code") else 24, bold=ln.get("bold", False))
                txt = text_of(ln["runs"])
                para_dir(p, False if ln.get("code") else (is_rtl(txt) if txt.strip() else rtl_doc))
                if not ln.get("bullet") and not ln.get("code"):
                    ppr = p._p.get_or_add_pPr()
                    ppr.insert(0, ppr.makeelement("{http://schemas.openxmlformats.org/drawingml/2006/main}buNone", {}))
    prs.save(path)


# ---------------------------------------------------------------- PDF

CSS = """
@page { size: A4; margin: 2cm 2cm 2.2cm; @bottom-center { content: counter(page); font-size: 9pt; color: #777; } }
html { font-family: "Noto Naskh Arabic", "Noto Sans Arabic", "Amiri", "DejaVu Sans", sans-serif; font-size: 11pt; line-height: 1.75; color: #111; }
h1, h2, h3, h4, p, li, td, th, blockquote, figcaption { unicode-bidi: plaintext; text-align: start; }
h1 { font-size: 20pt; margin: 0 0 .6em; } h2 { font-size: 15pt; margin: 1.2em 0 .4em; } h3 { font-size: 12.5pt; margin: 1em 0 .3em; }
table { border-collapse: collapse; width: 100%; margin: .8em 0; font-size: 10pt; page-break-inside: auto; }
th, td { border: 1px solid #bbb; padding: 4px 8px; vertical-align: top; } th { background: #f0f0f0; } tr { page-break-inside: avoid; }
pre, code { font-family: "DejaVu Sans Mono", monospace; font-size: 9pt; direction: ltr; unicode-bidi: isolate; }
pre { background: #f6f6f6; padding: 8px; white-space: pre-wrap; text-align: left; }
blockquote { border-inline-start: 3px solid #ccc; margin: .6em 0; padding-inline-start: .8em; color: #555; }
hr { border: 0; border-top: 1px solid #ccc; } img { max-width: 100%; }
"""


def render_pdf(kind, content, title, path):
    from weasyprint import CSS as WCSS, HTML
    from weasyprint.urls import URLFetcher

    # Only data: URLs: no network (there is none anyway) and no file:// reads of the container.
    fetcher = URLFetcher(allowed_protocols={"data"}, fail_on_errors=False)

    if kind == "html":
        html = content
        base = [WCSS(string="@page { size: A4; margin: 1.5cm; } html { font-family: 'Noto Naskh Arabic', 'Noto Sans Arabic', 'DejaVu Sans', sans-serif; }")]
    else:
        from markdown_it import MarkdownIt

        md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
        body = md.render(content or "")
        blocks = parse_markdown(content)
        rtl = doc_rtl(blocks, title)
        if title and not (blocks and blocks[0]["t"] == "h" and blocks[0]["level"] == 1):
            from html import escape

            body = "<h1>%s</h1>\n%s" % (escape(title), body)
        html = '<!doctype html><html lang="%s" dir="%s"><head><meta charset="utf-8"><title>%s</title></head><body>%s</body></html>' % (
            "ar" if rtl else "en",
            "rtl" if rtl else "ltr",
            title.replace("<", ""),
            body,
        )
        base = [WCSS(string=CSS)]
    HTML(string=html, base_url=None, url_fetcher=fetcher).write_pdf(path, stylesheets=base)


# ---------------------------------------------------------------- entry

def main():
    with open(INPUT, encoding="utf-8") as f:
        req = json.load(f)
    fmt = req.get("format")
    kind = req.get("kind", "markdown")
    title = str(req.get("title") or "").strip()
    content = str(req.get("content") or "")
    path = OUTPUT + fmt
    if fmt == "pdf":
        render_pdf(kind, content, title, path)
    elif fmt in ("docx", "pptx"):
        if kind != "markdown":
            raise SystemExit("only Markdown can become " + fmt)
        blocks = parse_markdown(content)
        if fmt == "docx":
            render_docx(with_title(blocks, title), title, path)
        else:
            render_pptx(blocks, title, path)
    else:
        raise SystemExit("unknown format: %r" % fmt)
    print(json.dumps({"ok": True, "file": "out." + fmt}))


if __name__ == "__main__":
    main()
