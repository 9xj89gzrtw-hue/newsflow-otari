/**
 * The digest pipeline.
 *
 * Two models, two jobs, on purpose:
 *
 *   triage  a small, fast open-weight model decides whether a story is relevant
 *           and how important it is. Cheap, many calls, JSON out.
 *   write   a stronger open-weight model writes the digest from the survivors.
 *           Expensive, one call, prose out.
 *
 * Splitting the roles is what makes the cost sane: the model that sees every
 * story is the cheap one, and the model that sees ten stories is the good one.
 */

import { screen } from "./guardrails.mjs";

const TRIAGE_SYSTEM = [
  "You triage news for a technical digest.",
  "Answer with JSON only, no prose, matching:",
  '{"relevant": true|false, "topic": "one of: ai, security, infra, web, other", "importance": 1-5}',
  "relevant is false only when the item is clearly marketing, a sponsored post, a listicle or a link roundup.",
  "When in doubt, answer relevant: true: a dropped story is invisible, a boring one is not."
].join(" ");

const WRITE_SYSTEM = [
  "You write a short technical digest for engineers.",
  "Rules: no marketing adjectives, no em dashes, no emoji.",
  "Every claim must come from the supplied text; if the text does not support it, leave it out.",
  "Write 3 to 6 sentences. Name the source of each fact in parentheses."
].join(" ");

const DEFAULT_FETCH_LIMIT = 8000;
/** How much text the triage model sees. Enough for the gist, small enough that a
 *  1.5B model can still answer with a short JSON object. */
const TRIAGE_CHARS = 900;

/** Fetch an article body. Failure is not fatal: the summary is used instead. */
async function fetchBody(url, { fetchImpl = globalThis.fetch, limit = DEFAULT_FETCH_LIMIT, timeoutMs = 12000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": "newsflow-otari-studio/1.0 (+digest demo)" },
      signal: ctl.signal,
      redirect: "follow"
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { ok: true, text: text.slice(0, limit) };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function parseTriage(content) {
  const raw = String(content || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    const n = Number(obj.importance);
    return {
      relevant: obj.relevant !== false,
      topic: typeof obj.topic === "string" ? obj.topic.slice(0, 24) : "other",
      // Number.isFinite, not `|| 3`: an explicit 0 means "least important" and
      // must clamp to 1 instead of silently becoming the default 3.
      importance: Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3
    };
  } catch {
    return null;
  }
}

/**
 * Which model actually answered in each role, and whether the roles really used
 * different models. A gateway is free to route two aliases to the same upstream
 * model, so this is measured from each response, never assumed from the config.
 * `collapsed` is the case worth showing: the app asked for two models and got
 * one, which is a different statement from "two models answered".
 */
function roleReport(triageServed, writerServed) {
  const triage = [...new Set(triageServed.filter(Boolean))];
  const write = writerServed || null;
  const sameModel = Boolean(write) && triage.includes(write);
  return {
    triage,
    write,
    distinct: Boolean(write) && triage.length > 0 && !sameModel,
    collapsed: sameModel
  };
}

/**
 * @param {object} o
 * @param {Array<{title:string,url:string,summary?:string,source?:string}>} o.items
 * @param {import("./otari.mjs").OtariClient} o.client
 * @param {import("./otari.mjs").Budget} o.budget
 * @param {number} o.topN  how many stories the writer sees
 */
export async function runDigest({ items, client, budget, topN = 5, fetchImpl, onEvent = () => {} }) {
  const started = Date.now();
  // One injection point for the network: the client already carries a fetch
  // (tests pass a stub there), so an article fetch and a gateway call can never
  // end up on different transports.
  const doFetch = fetchImpl || client.fetchImpl || globalThis.fetch;
  const audit = [];
  const scored = [];

  for (const item of items) {
    budget.assertRoom(600);

    let body = "";
    let fetched = { ok: false, reason: "not attempted" };
    if (item.url && /^https?:\/\//.test(item.url)) {
      fetched = await fetchBody(item.url, { fetchImpl: doFetch });
      if (fetched.ok) body = fetched.text;
    }

    const source = body || item.summary || "";
    const screened = screen(source);
    audit.push({
      title: item.title,
      url: item.url,
      fetched: fetched.ok ? "ok" : fetched.reason,
      injectedLines: screened.flags.injectedLines,
      redactions: screened.flags.redactions,
      truncated: screened.flags.truncated
    });

    onEvent({ type: "triage", title: item.title });

    let verdict = null;
    try {
      const out = await client.chatWithFallback([client.models.triage, client.models.fallback].filter(Boolean), {
        messages: [
          { role: "system", content: TRIAGE_SYSTEM },
          // A triage model needs the gist, not the article. Sending a full body
          // to a small model makes it worse at the one thing it is here to do,
          // and costs tokens on every story.
          { role: "user", content: `Title: ${item.title}\n\nText:\n${screened.text.slice(0, TRIAGE_CHARS)}` }
        ],
        maxTokens: 60,
        temperature: 0,
        json: true
      });
      budget.record(out.usage);
      verdict = parseTriage(out.content) || { relevant: true, topic: "other", importance: 3, unparsed: true };
      verdict.served = out.served;
    } catch (err) {
      // A triage failure must not drop the story: keep it, flagged, so the
      // writer still sees it and the UI can say the model was unreachable.
      verdict = { relevant: true, topic: "other", importance: 3, error: err.message.slice(0, 200) };
    }

    scored.push({ ...item, ...verdict, text: screened.text, screened: screened.flags });
  }

  const chosen = scored
    .filter((s) => s.relevant)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, topN);

  if (chosen.length === 0) {
    return {
      digest: "",
      chosen: [],
      stats: {
        items: items.length,
        relevant: 0,
        roles: roleReport(scored.map((s) => s.served), null),
        ms: Date.now() - started,
        budget: budget.snapshot()
      },
      audit
    };
  }

  budget.assertRoom(2000);
  onEvent({ type: "write", count: chosen.length });

  const material = chosen
    .map((s, i) => `[${i + 1}] ${s.title} (${s.source || "unknown"})\n${s.text.slice(0, 1800)}`)
    .join("\n\n");

  const written = await client.chatWithFallback([client.models.write, client.models.triage].filter(Boolean), {
    messages: [
      { role: "system", content: WRITE_SYSTEM },
      { role: "user", content: `Write the digest from these ${chosen.length} items.\n\n${material}` }
    ],
    maxTokens: 500,
    temperature: 0.3
  });
  budget.record(written.usage);

  return {
    digest: written.content.trim(),
    chosen: chosen.map((c) => ({
      title: c.title,
      url: c.url,
      topic: c.topic,
      importance: c.importance,
      served: c.served || null
    })),
    stats: {
      items: items.length,
      relevant: chosen.length,
      writer: written.served,
      writerAttempts: written.attempts,
      roles: roleReport(scored.map((s) => s.served), written.served),
      ms: Date.now() - started,
      budget: budget.snapshot()
    },
    audit
  };
}

export { fetchBody, parseTriage, TRIAGE_SYSTEM, WRITE_SYSTEM };
