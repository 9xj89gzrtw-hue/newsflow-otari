import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayTools } from "../lib/gatewayTools.mjs";
import { OtariClient } from "../lib/otari.mjs";

/** A gateway that answers with otari_tool_calls, as Chat Completions reports them. */
function gateway({ content = "Page text.", calls = [], status = 200, body = null } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        body ??
        JSON.stringify({
          model: "qwen/qwen3.7-flash:free",
          choices: [{ index: 0, message: { role: "assistant", content } }],
          usage: { prompt_tokens: 120, completion_tokens: 60 },
          otari_tool_calls: calls
        })
    };
  };
  return { fetchImpl, seen };
}

const clientWith = (fetchImpl) =>
  new OtariClient({
    baseUrl: "http://x/api/v1",
    apiKey: "tk-test",
    models: { triage: "localrouter:free-fast", write: "localrouter:free-best", fallback: "localrouter:free-coder" },
    fetchImpl
  });

test("web_fetch is forced, so a completed fetch is a fact in otari_tool_calls", async () => {
  const fetchCall = { id: "otari_wf_1", type: "web_fetch", status: "completed", url: "https://a.example/rust" };
  const { fetchImpl, seen } = gateway({ content: "Rust 1.84 ships async closures.", calls: [fetchCall] });
  const tools = new GatewayTools({ client: clientWith(fetchImpl) });

  const out = await tools.fetchPage("https://a.example/rust");

  assert.equal(out.ok, true);
  assert.equal(out.via, "gateway");
  assert.match(out.text, /async closures/);
  assert.deepEqual(seen[0].body.tools, [{ type: "otari_web_fetch" }]);
  assert.equal(seen[0].body.tool_choice.function.name, "otari_web_fetch");
});

test("a gateway that ran no fetch is a failure, not an empty page", async () => {
  const { fetchImpl } = gateway({ content: "I could not read it.", calls: [] });
  const out = await new GatewayTools({ client: clientWith(fetchImpl) }).fetchPage("https://a.example/rust");
  assert.equal(out.ok, false);
  assert.match(out.reason, /no web_fetch/);
});

test("a gateway with fetch disabled answers 400 and the caller can fall back", async () => {
  const { fetchImpl } = gateway({ status: 400, body: '{"detail":"web fetch is not enabled"}' });
  const out = await new GatewayTools({ client: clientWith(fetchImpl) }).fetchPage("https://a.example/rust");
  assert.equal(out.ok, false);
  assert.match(out.reason, /gateway tool: every model failed: .*gateway 400/);
});

test("web_search returns the gateway's own sources, not the model's prose", async () => {
  const searchCall = {
    id: "otari_ws_1",
    type: "web_search",
    status: "completed",
    query: "Rust async closures",
    sources: [{ url: "https://blog.rust-lang.org/1.84", title: "Announcing Rust 1.84", published_date: "2025-01-09" }]
  };
  const { fetchImpl, seen } = gateway({ content: "The best source is the Rust blog.", calls: [searchCall] });
  const out = await new GatewayTools({ client: clientWith(fetchImpl) }).search("Rust async closures");

  assert.equal(out.ok, true);
  assert.equal(out.sources[0].url, "https://blog.rust-lang.org/1.84");
  assert.deepEqual(seen[0].body.tools, [{ type: "otari_web_search" }]);
});

test("a search with no sources is reported as such", async () => {
  const { fetchImpl } = gateway({ content: "nothing", calls: [{ type: "web_search", status: "completed", sources: [] }] });
  const out = await new GatewayTools({ client: clientWith(fetchImpl) }).search("nothing");
  assert.equal(out.ok, false);
});

// A release older than `otari_tool_calls` reports nothing. For a fetch the
// forced call still put the page in the answer, so the text is usable; for a
// search there is no answer to read, and a URL must never be invented.
test("a gateway that does not report tool calls still yields the fetched text", async () => {
  const { fetchImpl } = gateway({ content: "Rust 1.84 ships async closures.", calls: null });
  const out = await new GatewayTools({ client: clientWith(fetchImpl) }).fetchPage("https://a.example/rust");
  assert.equal(out.ok, true);
  assert.match(out.text, /async closures/);
  assert.equal(out.url, "https://a.example/rust");
});

test("a gateway that does not report tool calls yields no search sources", async () => {
  const { fetchImpl } = gateway({ content: "https://made-up.example/rust", calls: null });
  const out = await new GatewayTools({ client: clientWith(fetchImpl) }).search("Rust async closures");
  assert.equal(out.ok, false);
  assert.match(out.reason, /no sources/);
});
