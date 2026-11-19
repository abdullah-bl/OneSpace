// Text that looks like a credential, hidden before it is shown again (an answer, a citation
// quote). The assistant may say a file holds a key; it never repeats the key itself.
//
// "Looks like" = a known key prefix (sk-, ghp_, AKIA…), or an opaque run of 12+ letters/digits that
// mixes upper case, lower case and digits. Record ids (lower case + digits) and ordinary words
// don't match.

const PREFIXED = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{10,}\b/g;
const OPAQUE = /(?<![A-Za-z0-9_\-/.])[A-Za-z0-9_\-]{12,}(?![A-Za-z0-9_\-])/g;
const LABELLED = /((?:password|passwd|secret|token|api[_ -]?key|كلمة\s*(?:ال)?(?:مرور|سر)|الرقم\s*السري)\s*[:=：]\s*)(\S{4,})/gi;

const looksOpaque = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !/^[A-Za-z]+[-_][A-Za-z]+$/.test(s);
const hide = (s: string) => `${s.slice(0, 2)}••••••`;

export function maskSecrets(text: string): string {
  return text
    .replace(LABELLED, (_, label: string, value: string) => label + hide(value))
    .replace(PREFIXED, hide)
    .replace(OPAQUE, (m) => (looksOpaque(m) ? hide(m) : m));
}
