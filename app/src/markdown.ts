// Model answers as Markdown. The model's text is untrusted: raw HTML is escaped, links are kept
// only for http(s)/mailto and open in a new tab, images become plain links (nothing is fetched),
// and "[n]" source markers become small citation chips (data-cite) the chat opens on click.

import { Marked } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null);

const md = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html(token) {
      return esc(token.text);
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      // An in-app page the assistant points to (a list it made): same tab, ids only.
      if (/^#\/(list|lists|tasks|space)\/?[\w/-]*$/.test(token.href.trim())) return `<a href="${esc(token.href.trim())}">${text}</a>`;
      const href = safeHref(token.href);
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image(token) {
      const href = safeHref(token.href);
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(token.text || href)}</a>` : esc(token.text);
    },
  },
});

/** Renders answer text to safe HTML. `cites` = the source numbers that exist (others stay plain text). */
function citeChip(n: number, check?: "unrelated" | "contradicts") {
  if (!check) return `<button type="button" class="cite" data-cite="${n}" aria-label="المصدر ${n}">${n}</button>`;
  return `<button type="button" class="cite cite-${check}" data-cite="${n}" aria-label="المصدر ${n}: ${CITE_CHECK[check]}" title="${CITE_CHECK[check]}">${n}<span aria-hidden="true">؟</span></button>`;
}

/** plans/12: a citation the check doubted gets a mark on its chip (the text stays as written). */
export const CITE_CHECK: Record<"unrelated" | "contradicts", string> = { unrelated: "المصدر لا يذكر هذا بوضوح", contradicts: "المصدر يقول خلاف هذا" };

export function renderAnswer(text: string, cites: Set<number>, checks?: Map<number, "unrelated" | "contradicts">): string {
  const html = md.parse(text) as string;
  // Only touch text between tags, never attributes.
  return html.replace(/(^|>)([^<]+)/g, (_, open: string, body: string) =>
    open +
    body.replace(/\[(\d{1,3})\]/g, (m, n: string) => (cites.has(Number(n)) ? citeChip(Number(n), checks?.get(Number(n))) : m)),
  );
}
