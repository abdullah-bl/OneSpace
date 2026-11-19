// A write tool's mutation throws on any refusal, so nothing it wrote before the refusal is kept
// (the transaction rolls back). The tool turns the error into a message the model can act on.

export function toolErrorText(e: unknown, denied: string) {
  const msg = e instanceof Error ? e.message.replace(/^.*?Uncaught (?:OneBase)?Error:\s*/s, "") : String(e);
  return /غير موجود أو لا تملك صلاحية|Denied/.test(msg) ? denied : msg.slice(0, 600);
}
