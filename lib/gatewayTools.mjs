/**
 * Otari's built-in tools, used by the pipeline.
 *
 * The gateway runs `otari_web_fetch` and `otari_web_search` itself, on its own
 * network policy, so the app no longer has to be the only thing that touches a
 * page. Two rules keep this honest:
 *
 *   - the tool call is forced, so "the gateway fetched it" is a fact in
 *     `otari_tool_calls`, not something the model may or may not have done;
 *   - a failure here is one branch, not a crash: every caller falls back to the
 *     app's own `fetchBody()` and says which path served the story.
 *
 * Fetch is read through the model's answer because Chat Completions reports a
 * gateway fetch as `{url, status}` and keeps the extracted page for the model.
 * Search is read from `otari_tool_calls[].sources`, which is documented output:
 * the URLs are the gateway's, not a summary of them.
 */

const FETCH_TOOL = { type: "otari_web_fetch" };
const SEARCH_TOOL = { type: "otari_web_search" };

const force = (name) => ({ type: "function", function: { name } });

const READ_SYSTEM = [
  "Call otari_web_fetch for the URL.",
  "Then output the page text you received, verbatim, up to 1400 characters.",
  "Output nothing else."
].join(" ");

export class GatewayTools {
  /**
   * @param {object} o
   * @param {import("./otari.mjs").OtariClient} o.client
   * @param {number} [o.maxChars]  how much page text the app keeps
   * @param {number} [o.maxTokens] the reader's output cap
   */
  constructor({ client, maxChars = 1400, maxTokens = 1200 } = {}) {
    if (!client) throw new Error("GatewayTools needs an Otari client");
    this.client = client;
    this.maxChars = maxChars;
    this.maxTokens = maxTokens;
  }

  /**
   * Read a page through the gateway's `otari_web_fetch`.
   * @returns {Promise<{ok:true, text:string, via:"gateway", model:string|null, url:string}
   *                  | {ok:false, reason:string}>}
   */
  async fetchPage(url) {
    const models = [this.client.models.triage, this.client.models.fallback].filter(Boolean);
    try {
      const out = await this.client.chatWithFallback(models, {
        messages: [
          { role: "system", content: READ_SYSTEM },
          { role: "user", content: `URL: ${url}` }
        ],
        tools: [FETCH_TOOL],
        toolChoice: force("otari_web_fetch"),
        maxTokens: this.maxTokens,
        temperature: 0
      });
      const reported = Array.isArray(out.toolCalls);
      const call = reported ? out.toolCalls.find((c) => c.type === "web_fetch" && c.status === "completed") : null;
      const text = String(out.content || "").trim();
      // A release that predates `otari_tool_calls` reports nothing while the
      // forced call still ran; one that reports calls and has no fetch did not.
      if (reported && !call) return { ok: false, reason: "gateway ran no web_fetch" };
      if (!text) return { ok: false, reason: "web_fetch returned no text" };
      return { ok: true, text: text.slice(0, this.maxChars), via: "gateway", model: out.served, url: call?.url || url, usage: out.usage || null };
    } catch (err) {
      // A gateway with fetch disabled answers 400; a model without tool support
      // fails the attempt. Both are reasons to fetch the page directly.
      return { ok: false, reason: `gateway tool: ${err.message.slice(0, 160)}`, usage: err.usage || null };
    }
  }

  /**
   * Find the page for a story the feed gave without a link, through the
   * gateway's `otari_web_search`. The results are the tool's own sources.
   * @returns {Promise<{ok:true, sources:Array<{url:string,title?:string}>, model:string|null}
   *                  | {ok:false, reason:string}>}
   */
  async search(query) {
    const models = [this.client.models.triage, this.client.models.fallback].filter(Boolean);
    try {
      const out = await this.client.chatWithFallback(models, {
        messages: [
          {
            role: "system",
            content: "You search the web with otari_web_search. Search for the headline you are given. Then reply with one short sentence naming the best source."
          },
          { role: "user", content: query }
        ],
        tools: [SEARCH_TOOL],
        toolChoice: force("otari_web_search"),
        maxTokens: 120,
        temperature: 0
      });
      const call = [...out.toolCalls].reverse().find((c) => c.type === "web_search" && c.status === "completed");
      const sources = Array.isArray(call?.sources) ? call.sources.filter((s) => s?.url) : [];
      if (!sources.length) return { ok: false, reason: "gateway search found no sources" };
      return { ok: true, sources: sources.slice(0, 5), model: out.served, usage: out.usage || null };
    } catch (err) {
      return { ok: false, reason: `gateway tool: ${err.message.slice(0, 160)}`, usage: err.usage || null };
    }
  }
}

export { FETCH_TOOL, SEARCH_TOOL, READ_SYSTEM };
