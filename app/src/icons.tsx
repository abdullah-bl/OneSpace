// A small local icon set: 16px outline icons, 1.5px stroke, drawn inline (no icon font, no CDN).
// Icons are affordances next to a label, never decoration on their own.

import type { SVGProps } from "react";

const PATHS: Record<string, string> = {
  undo: "M9 5L4 10l5 5M4 10h10a6 6 0 0 1 0 12h-2",
  redo: "M15 5l5 5-5 5M20 10H10a6 6 0 0 0 0 12h2",
  bold: "M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z",
  italic: "M10 4h8M6 20h8M14 4l-4 16",
  strike: "M4 12h16M16 7c0-2-2-3-4-3s-4 1-4 3c0 5 9 3 9 9 0 2-2 4-5 4s-5-2-5-4",
  bullets: "M4 6h12M4 12h12M4 18h12M20 6h.01M20 12h.01M20 18h.01",
  numbers: "M4 6h11M4 12h11M4 18h11M19 4h1v5M18.5 15h2l-2 5h2.5",
  indent: "M4 5h16M4 19h16M4 12h9M20 9l-3 3 3 3",
  outdent: "M4 5h16M4 19h16M4 12h9M17 9l3 3-3 3",
  quote: "M19 4v16M15 7H4M15 12H4M15 17H8",
  link: "M10 14a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l1-1",
  rule: "M4 12h16",
  plus: "M12 5v14M5 12h14",
  chat: "M4 5h16v11H9l-5 4z",
  folder: "M3 6h6l2 2h10v11H3z",
  check: "M4 12l5 5L20 6",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  at: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4",
  clip: "M20 11.5l-8.3 8.3a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4L14.5 7.6",
  send: "M12 19V5M5 12l7-7 7 7",
  copy: "M8 8h11v11H8zM5 16V5h11",
  retry: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  menu: "M4 6h16M4 12h16M4 18h16",
  x: "M6 6l12 12M18 6L6 18",
  clock: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 7v5l3 2",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  gear: "M12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM19 12l2-1-1-3-2 .3-1.4-1.4L17 5l-3-1-1 2h-2l-1-2-3 1 .3 2L5.9 8.4 4 8l-1 3 2 1v0l-2 1 1 3 2-.3 1.4 1.4L7 19l3 1 1-2h2l1 2 3-1-.3-2 1.4-1.4 2 .4 1-3z",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  globe: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  users: "M9 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6",
  user: "M12 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8zM4 21a8 8 0 0 1 16 0",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  chevron: "M15 6l-6 6 6 6",
  down: "M6 9l6 6 6-6",
  up: "M6 15l6-6 6 6",
  stop: "M7 7h10v10H7z",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z",
  bot: "M5 9h14v10H5zM12 5v4M9 14h.01M15 14h.01M3 13v2M21 13v2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  thumbUp: "M7 11v9H4v-9zM7 11l4-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1.3 6.7A2 2 0 0 1 16.7 20H7",
  thumbDown: "M7 13V4H4v9zM7 13l4 7a2 2 0 0 0 2-2v-3h5a2 2 0 0 0 2-2.3l-1.3-6.7A2 2 0 0 0 16.7 4H7",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  panel: "M4 5h16v14H4zM14 5v14",
  play: "M8 5v14l11-7z",
  pause: "M8 5v14M16 5v14",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6z",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  next: "M9 6l6 6-6 6",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  chip: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  help: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  memory: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1",
  pin: "M9 4h6l-1 6 3 3v1H7v-1l3-3zM12 14v6",
  book: "M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zM4 20a2 2 0 0 0 2 2h13v-4",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className ?? ""}`}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The product mark: a folded sheet (a space of papers) in near-black, its corner turned, for مساحة. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path d="M3 3h12l6 6v12H3z" fill="#141414" />
      <path d="M15 3v6h6" fill="#8a8a8a" />
      <path d="M7 12h8M7 16h5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
