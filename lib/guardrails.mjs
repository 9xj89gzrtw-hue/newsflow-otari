/**
 * Guardrails for text that arrives from the open web.
 *
 * A news digest feeds untrusted article text into a model, so the text is an
 * attack surface: a page can carry "ignore previous instructions" or a fake
 * system turn, and a model that follows it will happily rewrite the digest.
 * These checks run before anything reaches the gateway, and they are the only
 * place that decides what a model is allowed to see.
 */

/** Lines that try to take over the conversation instead of being content. */
const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i,
  /\bdisregard\s+(all\s+)?(previous|prior|above)\b/i,
  /\byou\s+are\s+now\s+(a|an|the)\b/i,
  /^\s*(system|assistant|developer)\s*:/i,
  /<\|?im_start\|?>/i,
  /\[\/?INST\]/i,
  /\bnew\s+instructions?\s*:/i,
  /\bprint\s+(your\s+)?(system\s+)?prompt\b/i,
  /\breveal\s+(your\s+)?(system\s+)?prompt\b/i
];

/** Personal data that has no business in a public digest. */
const PII_PATTERNS = [
  { name: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, to: "[email]" },
  { name: "phone", re: /\+\d{1,3}[ -]?\d{2,4}[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}\b|\+\d{9,15}\b/g, to: "[phone]" },
  { name: "card", re: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g, to: "[number]" },
  { name: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, to: "[iban]" }
];

const MAX_CHARS = 12000;

const isInjection = (s) => INJECTION_PATTERNS.some((re) => re.test(s));

/** Split a line into sentences so one hostile sentence costs one sentence, not
 *  the article. Fetched pages arrive as a single line (whitespace is collapsed),
 *  which is exactly the case this has to survive. */
function sentences(line) {
  return line.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
}

/**
 * Remove instruction-shaped text and clamp the length.
 * Returns { text, dropped } so the caller can show what was blocked instead of
 * silently pretending the input was clean.
 */
export function stripInjection(raw, { maxChars = MAX_CHARS } = {}) {
  const input = String(raw ?? "");
  const kept = [];
  const dropped = [];
  for (const line of input.split(/\r?\n/)) {
    if (!isInjection(line)) {
      kept.push(line);
      continue;
    }
    const survivors = [];
    for (const part of sentences(line)) {
      if (isInjection(part)) dropped.push(part.trim().slice(0, 160));
      else survivors.push(part);
    }
    if (survivors.length) kept.push(survivors.join(" "));
  }
  let text = kept.join("\n");
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, dropped, truncated };
}

/** Replace personal data with neutral markers. Returns the counts per kind. */
export function redactPii(raw) {
  let text = String(raw ?? "");
  const redactions = {};
  for (const { name, re, to } of PII_PATTERNS) {
    const before = text;
    text = text.replace(re, to);
    if (text !== before) redactions[name] = (before.match(re) || []).length;
  }
  return { text, redactions };
}

/**
 * The full pass a document takes before it is allowed into a prompt.
 * `flags` is the audit trail shown in the UI: an empty list means nothing was
 * found, which is a different statement from "we did not look".
 */
export function screen(raw, opts) {
  const injected = stripInjection(raw, opts);
  const redacted = redactPii(injected.text);
  return {
    text: redacted.text,
    flags: {
      injectedLines: injected.dropped,
      truncated: injected.truncated,
      redactions: redacted.redactions
    },
    clean: injected.dropped.length === 0 && Object.keys(redacted.redactions).length === 0
  };
}
