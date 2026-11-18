// A small local icon set: 16px outline icons, 1.5px stroke, drawn inline (no icon font, no CDN).
// Icons are affordances next to a label, never decoration on their own.

import type { SVGProps } from "react";

const PATHS: Record<string, string> = {
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
  bot: "M5 9h14v10H5zM12 5v4M9 14h.01M15 14h.01M3 13v2M21 13v2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  thumbUp: "M7 11v9H4v-9zM7 11l4-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1.3 6.7A2 2 0 0 1 16.7 20H7",
  thumbDown: "M7 13V4H4v9zM7 13l4 7a2 2 0 0 0 2-2v-3h5a2 2 0 0 0 2-2.3l-1.3-6.7A2 2 0 0 0 16.7 4H7",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  panel: "M4 5h16v14H4zM14 5v14",
  play: "M8 5v14l11-7z",
  pause: "M8 5v14M16 5v14",
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
