// An edit that isn't saved yet (plans/19): closing the panel, opening another output, going to
// another screen or closing the tab asks first. Nothing is stored: the document may be sensitive.

import { ask } from "./ui";

let unsaved = false;
const warn = (e: BeforeUnloadEvent) => e.preventDefault();

export function setUnsaved(on: boolean) {
  if (on === unsaved) return;
  unsaved = on;
  if (on) window.addEventListener("beforeunload", warn);
  else window.removeEventListener("beforeunload", warn);
}

export const hasUnsaved = () => unsaved;

/**
 * True when it's fine to leave: nothing unsaved, or the person chose to drop it. The flag stays until
 * the editor itself closes: if the screen keeps it open, leaving again asks again.
 */
export async function leaveUnsaved(): Promise<boolean> {
  if (!unsaved) return true;
  return await ask("عندك تعديلات لم تُحفظ. تخرج وتتركها؟", { danger: true, confirmLabel: "اخرج بلا حفظ" });
}
