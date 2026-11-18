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
export function renderAnswer(text: string, cites: Set<number>): string {
  const html = md.parse(text) as string;
  // Only touch text between tags, never attributes.
  return html.replace(/(^|>)([^<]+)/g, (_, open: string, body: string) =>
    open +
    body.replace(/\[(\d{1,3})\]/g, (m, n: string) => (cites.has(Number(n)) ? `<button type="button" class="cite" data-cite="${n}" aria-label="المصدر ${n}">${n}</button>` : m)),
  );
}
