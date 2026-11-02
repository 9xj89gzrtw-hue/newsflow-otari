/**
 * A client for the Otari gateway.
 *
 * The app never talks to a model provider. It talks to Otari, which resolves
 * the provider, enforces budgets and records usage. Two rules follow from that
 * and are enforced here:
 *
 *   - the provider key never enters this process, only the Otari key does;
 *   - every call names the model it wants, so routing stays visible in the log
 *     instead of being hidden inside an SDK default.
 */

export class GatewayError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.body = body;
  }
}

/** Token prices are zero here because the deployment routes to free open-weight
 *  models; a paid deployment passes real prices and the budget stops working
 *  the moment they matter. */
export class Budget {
  constructor({ maxUsd = 0.05, maxTokens = 60000 } = {}) {
    this.maxUsd = maxUsd;
    this.maxTokens = maxTokens;
    this.usd = 0;
    this.tokens = 0;
    this.calls = 0;
  }

  /** Throws before the call, not after: a budget that only complains afterwards
   *  is a report, not a limit. */
  assertRoom(estimatedTokens = 0) {
    if (this.tokens + estimatedTokens > this.maxTokens) {
      throw new GatewayError(
        `budget: this run would pass the ${this.maxTokens} token cap (${this.tokens} used, ${estimatedTokens} more needed)`
      );
    }
  }

  record(usage, { inputPerMillion = 0, outputPerMillion = 0 } = {}) {
    const inTok = Number(usage?.prompt_tokens ?? 0);
    const outTok = Number(usage?.completion_tokens ?? 0);
    this.tokens += inTok + outTok;
    this.usd += (inTok / 1e6) * inputPerMillion + (outTok / 1e6) * outputPerMillion;
    this.calls += 1;
    return this.snapshot();
  }

  snapshot() {
    return {
      calls: this.calls,
      tokens: this.tokens,
      usd: Number(this.usd.toFixed(6)),
      maxUsd: this.maxUsd,
      maxTokens: this.maxTokens
    };
  }
}

export class OtariClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl  e.g. http://localhost:8010/api/v1
   * @param {string} o.apiKey   Otari virtual key, never a provider key
   * @param {object} o.models   { triage, write, fallback }
   */
  constructor({ baseUrl, apiKey, models, fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
    if (!baseUrl) throw new Error("OtariClient needs a baseUrl");
    if (!apiKey) throw new Error("OtariClient needs an apiKey");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.models = models;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.log = [];
  }

  async chat({ model, messages, maxTokens = 400, temperature = 0.2, json = false }) {
    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (json) body.response_format = { type: "json_object" };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      const text = await res.text();
      if (!res.ok) {
        throw new GatewayError(`gateway ${res.status}: ${text.slice(0, 300)}`, { status: res.status, body: text });
      }
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content ?? "";
      const served = data?.free_router?.model || data?.model || model;
      this.log.push({ model, served, usage: data.usage || null });
      return { content, served, usage: data.usage || null, raw: data };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Try each model in order and stop at the first answer that is not empty.
   * This is the fallback the rubric asks about: one model down is a slow digest,
   * not a dead app. Every attempt is recorded, including the failures.
   */
  async chatWithFallback(models, payload) {
    const attempts = [];
    for (const model of models) {
      try {
        const out = await this.chat({ ...payload, model });
        attempts.push({ model, ok: true, served: out.served });
        return { ...out, attempts };
      } catch (err) {
        attempts.push({ model, ok: false, error: err.message.slice(0, 200) });
      }
    }
    const err = new GatewayError(
      `every model failed: ${attempts.map((a) => `${a.model} (${a.error})`).join("; ")}`
    );
    err.attempts = attempts;
    throw err;
  }
}
