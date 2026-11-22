// A slide deck (artifact kind "slides") shown with reveal.js in the app's own page. Safe without
// the sandboxed frame because every slide's HTML comes from renderAnswer (src/slides.ts): raw HTML
// the model wrote is escaped, so nothing it wrote can run. «اعرض» puts the deck full screen; arrows,
// space and clicks on the controls move between slides; presenter notes show under the deck.

import { useEffect, useMemo, useRef, useState } from "react";
import Reveal from "reveal.js";
import "reveal.js/dist/reveal.css";
import { renderSlides } from "./slides";
import { Icon } from "./icons";

export function SlidesView({ content, title }: { content: string; title: string }) {
  const slides = useMemo(() => renderSlides(content), [content]);
  const stage = useRef<HTMLDivElement>(null);
  const deckEl = useRef<HTMLDivElement>(null);
  const deck = useRef<any>(null);
  const [at, setAt] = useState(0);
  const [full, setFull] = useState(false);
  // Where the Fullscreen API is refused (iPhone Safari, embedded browsers) the deck covers the window instead.
  const [cover, setCover] = useState(false);

  useEffect(() => {
    const el = deckEl.current;
    if (!el) return;
    // Built here, not by React: reveal.js rewrites the sections' classes and styles as it runs.
    const box = el.querySelector(".slides")!;
    box.replaceChildren(
      ...slides.map((s) => {
        const sec = document.createElement("section");
        sec.innerHTML = s.html; // escaped Markdown (see the header)
        return sec;
      }),
    );
    let gone = false;
    const r = new Reveal(el, {
      embedded: true,
      rtl: true,
      hash: false,
      history: false,
      controls: true,
      progress: true,
      slideNumber: "c/t",
      // Keys move slides only while the deck has focus (not while typing in the chat).
      keyboardCondition: () => el.contains(document.activeElement),
      transition: "slide",
      width: 1280,
      height: 720,
      margin: 0.06,
      center: true,
      overview: true,
      help: false,
      pdfSeparateFragments: false,
    });
    const onChange = () => setAt(r.getIndices().h ?? 0);
    const ready = r.initialize().then(() => {
      if (gone) return;
      deck.current = r;
      r.on("slidechanged", onChange);
      setAt(0);
    });
    return () => {
      gone = true;
      deck.current = null;
      void ready.then(() => {
        try {
          r.destroy();
        } catch {
          /* already gone */
        }
      });
    };
  }, [slides]);

  useEffect(() => {
    const on = () => {
      const isFull = document.fullscreenElement === stage.current;
      setFull(isFull);
      deck.current?.layout();
      if (isFull) deckEl.current?.focus();
    };
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  useEffect(() => {
    const el = stage.current;
    if (!cover || !el) return;
    // The top layer (popover) covers the window even inside the panel, whose transform would
    // otherwise trap position:fixed.
    el.setAttribute("popover", "manual");
    try {
      el.showPopover();
    } catch {
      /* old browser: position:fixed only */
    }
    deck.current?.layout();
    deckEl.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setCover(false);
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("keydown", esc, true);
      try {
        el.hidePopover();
      } catch {
        /* not shown */
      }
      el.removeAttribute("popover");
    };
  }, [cover]);
  useEffect(() => {
    if (!cover) deck.current?.layout();
  }, [cover]);

  const present = () => {
    deck.current?.slide(0);
    const el = stage.current;
    // Some browsers refuse late, never answer, or say yes without going full screen: check what
    // actually happened, at the latest after a moment.
    const check = () => document.fullscreenElement !== el && setCover(true);
    const fs = el?.requestFullscreen?.();
    if (!fs) return setCover(true);
    const late = setTimeout(check, 800);
    void fs.then(
      () => undefined,
      () => (clearTimeout(late), check()),
    );
  };
  const showing = full || cover;
  const notes = slides[at]?.notes ?? "";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button className="btn-primary h-8 px-3 text-sm" onClick={present}>
          <Icon name="play" size={14} /> اعرض
        </button>
        <span className="meta num">
          {slides.length ? `${at + 1} / ${slides.length}` : "لا شرائح"}
        </span>
        <span className="meta ms-auto hidden sm:inline">الأسهم أو المسافة للتنقل · Esc للخروج</span>
      </div>
      <div ref={stage} className={`os-deck min-h-0 flex-1 ${showing ? "bg-black" : "relative bg-sunken p-3"} ${cover ? "fixed inset-0 z-[100] m-0 h-screen max-h-none w-screen max-w-none border-0 p-0" : ""}`}>
        {cover && (
          <button className="btn-icon absolute end-3 top-3 z-10 bg-surface/80" aria-label="إنهاء العرض" title="إنهاء العرض (Esc)" onClick={() => setCover(false)}>
            <Icon name="x" size={17} />
          </button>
        )}
        <div ref={deckEl} className="reveal h-full w-full rounded-md outline-none" tabIndex={0} aria-label={title} onClick={() => deckEl.current?.focus()}>
          <div className="slides" />
        </div>
      </div>
      {notes && !showing && (
        <div className="max-h-[30%] shrink-0 overflow-auto border-t border-line px-4 py-3 text-sm leading-7">
          <div className="meta mb-1">ملاحظات المقدّم</div>
          <p className="whitespace-pre-wrap">{notes}</p>
        </div>
      )}
    </div>
  );
}
