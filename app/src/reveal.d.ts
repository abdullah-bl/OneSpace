// reveal.js ships no types; we use only constructor, initialize, on, slide, layout, getIndices, destroy.
declare module "reveal.js" {
  export default class Reveal {
    constructor(el: HTMLElement, options?: Record<string, unknown>);
    initialize(): Promise<void>;
    on(event: string, fn: (e: unknown) => void): void;
    slide(h: number, v?: number): void;
    layout(): void;
    getIndices(): { h: number; v: number };
    destroy(): void;
  }
}
