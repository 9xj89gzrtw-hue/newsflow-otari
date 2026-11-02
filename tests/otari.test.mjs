import { test } from "node:test";
import assert from "node:assert/strict";
import { OtariClient, Budget, GatewayError } from "../lib/otari.mjs";

/** A fetch that answers from a script, so ordering is observable without a network. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.authorization });
    const next = responses.shift();
    if (!next) throw new Error("scriptedFetch ran out of responses");
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body))
    };
  };
  impl.calls = calls;
  return impl;
}

const ok = (content, usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  status: 200,
  body: {
    id: "chatcmpl-test",
    model: "qwen/qwen3.7-flash:free",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage
  }
});

test("sends the Otari key, never a provider key, and names the model", async () => {
  const fetchImpl = scriptedFetch([ok("hello")]);
  const client = new OtariClient({
    baseUrl: "http://localhost:8010/api/v1/",
    apiKey: "tk-virtual",
    models: { triage: "a", write: "b" },
    fetchImpl
  });
  await client.chat({ model: "localrouter:free-fast", messages: [{ role: "user", content: "hi" }] });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "http://localhost:8010/api/v1/chat/completions");
  assert.equal(fetchImpl.calls[0].auth, "Bearer tk-virtual");
  assert.equal(fetchImpl.calls[0].body.model, "localrouter:free-fast");
});

test("reports the model that actually served the request, not the one requested", async () => {
  const client = new OtariClient({
    baseUrl: "http://x/api/v1",
    apiKey: "k",
    models: {},
    fetchImpl: scriptedFetch([ok("answer")])
  });
  const out = await client.chat({ model: "localrouter:free-fast", messages: [] });
  assert.equal(out.content, "answer");
  assert.equal(out.served, "qwen/qwen3.7-flash:free");
  assert.equal(client.log.length, 1);
});

test("a non-200 becomes a GatewayError that carries the status and the body", async () => {
  const client = new OtariClient({
    baseUrl: "http://x/api/v1",
    apiKey: "k",
    models: {},
    fetchImpl: scriptedFetch([{ status: 402, body: { detail: "budget exceeded" } }])
  });
  await assert.rejects(
    () => client.chat({ model: "m", messages: [] }),
    (err) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.status, 402);
      assert.match(err.message, /402/);
      assert.match(err.message, /budget exceeded/);
      return true;
    }
  );
});

test("chatWithFallback stops at the first model that answers", async () => {
  const fetchImpl = scriptedFetch([ok("from the first")]);
  const client = new OtariClient({ baseUrl: "http://x/api/v1", apiKey: "k", models: {}, fetchImpl });
  const out = await client.chatWithFallback(["first", "second", "third"], { messages: [] });
  assert.equal(out.content, "from the first");
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(out.attempts, [{ model: "first", ok: true, served: "qwen/qwen3.7-flash:free" }]);
});

test("chatWithFallback walks the list in order and records each failure", async () => {
  const fetchImpl = scriptedFetch([
    { status: 503, body: { detail: "model offline" } },
    new Error("socket hang up"),
    ok("from the third")
  ]);
  const client = new OtariClient({ baseUrl: "http://x/api/v1", apiKey: "k", models: {}, fetchImpl });
  const out = await client.chatWithFallback(["first", "second", "third"], { messages: [] });
  assert.equal(out.content, "from the third");
  assert.deepEqual(
    out.attempts.map((a) => [a.model, a.ok]),
    [
      ["first", false],
      ["second", false],
      ["third", true]
    ]
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test("chatWithFallback throws with every attempt listed when all models fail", async () => {
  const fetchImpl = scriptedFetch([
    { status: 500, body: { detail: "boom" } },
    { status: 429, body: { detail: "slow down" } }
  ]);
  const client = new OtariClient({ baseUrl: "http://x/api/v1", apiKey: "k", models: {}, fetchImpl });
  await assert.rejects(
    () => client.chatWithFallback(["a", "b"], { messages: [] }),
    (err) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.attempts.length, 2);
      assert.match(err.message, /every model failed/);
      assert.match(err.message, /a \(/);
      assert.match(err.message, /b \(/);
      return true;
    }
  );
});

test("budget refuses the call before it is made, not after", () => {
  const budget = new Budget({ maxTokens: 1000 });
  budget.record({ prompt_tokens: 900, completion_tokens: 90 });
  assert.equal(budget.snapshot().tokens, 990);
  assert.throws(() => budget.assertRoom(50), /would pass the 1000 token cap/);
  assert.doesNotThrow(() => budget.assertRoom(10));
});

test("budget counts tokens from the gateway response and prices them at zero on free models", () => {
  const budget = new Budget();
  budget.record({ prompt_tokens: 1200, completion_tokens: 300 });
  const snap = budget.snapshot();
  assert.equal(snap.tokens, 1500);
  assert.equal(snap.calls, 1);
  assert.equal(snap.usd, 0);
});

test("budget prices a paid deployment and stops when the dollars run out", () => {
  const budget = new Budget({ maxUsd: 0.01, maxTokens: 1e9 });
  budget.record({ prompt_tokens: 1_000_000, completion_tokens: 0 }, { inputPerMillion: 3 });
  assert.equal(budget.snapshot().usd, 3);
  assert.ok(budget.snapshot().usd > budget.maxUsd, "the counter must exceed the cap so the caller can see it");
});

test("a constructor without a key fails loudly instead of calling an open endpoint", () => {
  assert.throws(() => new OtariClient({ baseUrl: "http://x", apiKey: "", models: {} }), /needs an apiKey/);
  assert.throws(() => new OtariClient({ baseUrl: "", apiKey: "k", models: {} }), /needs a baseUrl/);
});
