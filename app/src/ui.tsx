// Shared UI pieces with behaviour (plans/07 §A). Plain look-and-feel lives in index.css utilities
// (btn-*, input, card, badge-*, alert-*, tabs/tab, page-title, …); components here add the parts
// CSS can't: menus that close on outside click and Escape, page headers, empty states.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export type MenuItem =
  | { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | "divider";

/** A button that opens a small list of actions. Escape / outside click / selection closes it. */
export function Menu({ label, icon = "dots", text, items, align = "end", className = "" }: { label: string; icon?: IconName; text?: string; items: MenuItem[]; align?: "start" | "end"; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={root} className={`relative ${className}`}>
      <button className={text ? "btn-ghost" : "btn-icon"} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={icon} size={17} />
        {text && <span>{text}</span>}
      </button>
      {open && (
        <div role="menu" className={`absolute top-10 z-40 min-w-48 animate-pop rounded-lg border border-line bg-surface p-1 shadow-[0_10px_30px_rgba(0,0,0,0.10)] ${align === "end" ? "end-0" : "start-0"}`}>
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={i} className="divider my-1" />
            ) : (
              <button
                key={i}
                role="menuitem"
                disabled={it.disabled}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm transition-colors disabled:opacity-50 ${it.danger ? "text-negative hover:bg-negative-soft" : "hover:bg-active"}`}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} size={15} className="shrink-0 text-muted" />}
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="meta">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A trigger and a panel that opens above it (for controls at the bottom of the screen, like the
 * message box). Closes on outside click, Escape (focus returns to the trigger) and selection;
 * ↑/↓ move between items. Items are any buttons with role menuitem / menuitemradio.
 */
export function Popover({
  trigger,
  label,
  children,
  align = "start",
  width = "w-64",
  triggerClass = "btn-ghost",
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  width?: string;
  triggerClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const items = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") return e.preventDefault(), close();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", keys);
    (root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? items()[0])?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", keys);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button ref={btn} type="button" className={triggerClass} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <div role="menu" aria-label={label} className={`absolute bottom-full z-40 mb-2 ${width} origin-bottom animate-pop rounded-xl border border-line bg-surface p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.14)] ${align === "end" ? "end-0" : "start-0"}`}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** One row of a Popover: icon, title, optional description and shortcut; a check when selected. */
export function PopoverItem({
  icon,
  title,
  description,
  hint,
  checked,
  disabled,
  onSelect,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm outline-none transition-colors hover:bg-active focus-visible:bg-active disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon && <Icon name={icon} size={17} className="mt-px shrink-0 text-muted" />}
      <span className="min-w-0 flex-1">
        <span className="block">{title}</span>
        {description && <span className="mt-0.5 block text-xs leading-5 text-muted">{description}</span>}
      </span>
      {hint && (
        <span className="mt-px shrink-0 text-xs text-faint" dir="ltr">
          {hint}
        </span>
      )}
      {checked && <Icon name="check" size={16} className="mt-px shrink-0 text-primary" />}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function EmptyState({ icon = "file", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex animate-rise flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-raised text-muted">
        <Icon name={icon} size={18} />
      </span>
      <p className="section-title">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs
// Never window.confirm() / prompt() / alert(): embedded browsers (the desktop app's pane, some
// webviews) cancel native dialogs without showing them, which made every confirmed action
// silently do nothing. ask() confirms, askText() asks for a line of text, tell() shows a message.

type AskOptions = { confirmLabel?: string; danger?: boolean; detail?: string };
type AskRequest = AskOptions & {
  message: string;
  input?: string; // askText: the starting value
  notice?: boolean; // tell: one button
  resolve: (r: { ok: boolean; value: string }) => void;
};
let pushAsk: ((r: AskRequest) => void) | null = null;

function open(r: Omit<AskRequest, "resolve">): Promise<{ ok: boolean; value: string }> {
  return new Promise((resolve) => {
    if (!pushAsk) return resolve({ ok: false, value: "" });
    pushAsk({ ...r, resolve });
  });
}

/** Asks in an in-app dialog; resolves true on confirm. Needs <ConfirmHost /> mounted once. */
export async function ask(message: string, opts: AskOptions = {}): Promise<boolean> {
  return (await open({ message, ...opts })).ok;
}

/** Asks for a line of text; resolves the trimmed text, or null when cancelled or empty. */
export async function askText(message: string, initial = "", opts: AskOptions = {}): Promise<string | null> {
  const r = await open({ message, input: initial, confirmLabel: "حفظ", ...opts });
  return r.ok && r.value.trim() ? r.value.trim() : null;
}

/** Shows a message with one button. */
export async function tell(message: string, detail?: string): Promise<void> {
  await open({ message, detail, notice: true, confirmLabel: "حسناً" });
}

export function ConfirmHost() {
  const [req, setReq] = useState<AskRequest | null>(null);
  const [value, setValue] = useState("");
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    pushAsk = (r) =>
      setReq((cur) => {
        cur?.resolve({ ok: false, value: "" });
        setValue(r.input ?? "");
        return r;
      });
    return () => {
      pushAsk = null;
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    if (req.input !== undefined) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  const close = (ok: boolean) => {
    req?.resolve({ ok, value });
    setReq(null);
  };
  if (!req) return null;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/30 p-4 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        className="card w-full max-w-sm animate-rise p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          close(true);
        }}
      >
        <p id="ask-title" className="font-medium leading-7">
          {req.message}
        </p>
        {req.detail && <p className="mt-1 text-sm text-muted">{req.detail}</p>}
        {req.input !== undefined && <input ref={inputRef} className="input mt-3 w-full" dir="auto" value={value} onChange={(e) => setValue(e.target.value)} maxLength={200} />}
        <div className="mt-5 flex justify-end gap-2">
          {!req.notice && (
            <button type="button" className="btn-secondary" onClick={() => close(false)}>
              إلغاء
            </button>
          )}
          <button ref={okRef} type="submit" className={req.danger ? "btn-danger" : "btn-primary"}>
            {req.confirmLabel ?? "تأكيد"}
          </button>
        </div>
      </form>
    </div>
  );
}
