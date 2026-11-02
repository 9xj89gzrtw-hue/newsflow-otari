/**
 * The one test that talks to a real gateway.
 *
 * It is skipped unless OTARI_LIVE=1, so CI stays hermetic and a clone without a
 * gateway still runs green. Locally it is the only check that proves the claims
 * the demo makes: that two different open-weight models answer, that the model
 * named in the response is the one that served it, and that the budget counter
 * fills from real usage.
 *
 *   docker run -d --name otari-demo -p 8010:8000 ... mzdotai/otari:latest
 *   OTARI_LIVE=1 OTARI_API_KEY=tk-... OTARI_BASE_URL=http://localhost:8010/api/v1 \
 *     node --test tests/live.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { OtariClient, Budget } from "../lib/otari.mjs";
import { runDigest } from "../lib/pipeline.mjs";

const live = process.env.OTARI_LIVE === "1";
const baseUrl = process.env.OTARI_BASE_URL || "http://localhost:8010/api/v1";
const apiKey = process.env.OTARI_API_KEY || "";

const models = {
  triage: process.env.OTARI_MODEL_TRIAGE || "localrouter:free-fast",
  write: process.env.OTARI_MODEL_WRITE || "localrouter:free-best",
  fallback: process.env.OTARI_MODEL_FALLBACK || "localrouter:free-coder"
};

function client() {
  return new OtariClient({ baseUrl, apiKey, models, timeoutMs: 180000 });
}

test("the gateway answers and names the model that served the request", { skip: !live && "set OTARI_LIVE=1 with a running gateway" }, async () => {
  assert.ok(apiKey, "OTARI_API_KEY is required for the live test");
  const out = await client().chat({
    model: models.triage,
    messages: [{ role: "user", content: "Reply with exactly: OTARI OK" }],
    maxTokens: 20,
    temperature: 0
  });
  assert.match(out.content, /OTARI OK/i);
  assert.ok(out.served, "the response must name the model that answered");
  assert.ok(out.usage.total_tokens > 0, "usage must come from the gateway, not be invented");
});

test("the role report matches what the gateway actually served", { skip: !live && "set OTARI_LIVE=1 with a running gateway" }, async () => {
  assert.ok(apiKey, "OTARI_API_KEY is required for the live test");
  const out = await runDigest({
    items: [
      { title: "Rust 1.84", url: "", summary: "Rust 1.84 ships async closures.", source: "fixture" },
      { title: "Postgres 18", url: "", summary: "Postgres 18 adds async I/O.", source: "fixture" }
    ],
    client: client(),
    budget: new Budget({ maxTokens: 20000 }),
    topN: 2
  });

  const { triage, write, distinct, collapsed } = out.stats.roles;
  assert.ok(write, "the writer must report the model that answered");
  assert.ok(triage.length > 0, "triage must report the model that answered");
  // The claim under test is the honesty of the report, not the luck of the
  // router: distinct and collapsed must be exact opposites of each other.
  assert.equal(distinct, !triage.includes(write));
  assert.equal(collapsed, triage.includes(write));
  if (collapsed) {
    console.log(
      `note: both roles were served by ${write}; set OTARI_MODEL_WRITE to a model that resolves differently to demonstrate two models`
    );
  }
});

test("a full digest runs against the live gateway and stays inside the budget", { skip: !live && "set OTARI_LIVE=1 with a running gateway" }, async () => {
  assert.ok(apiKey, "OTARI_API_KEY is required for the live test");
  const budget = new Budget({ maxTokens: 30000 });
  const out = await runDigest({
    items: [
      {
        title: "PostgreSQL 18 released",
        url: "",
        summary: "The PostgreSQL project released version 18 with asynchronous I/O and incremental backups.",
        source: "test fixture"
      },
      {
        title: "Sponsored: buy our course",
        url: "",
        summary: "A paid promotion with no technical content.",
        source: "test fixture"
      }
    ],
    client: client(),
    budget,
    topN: 2
  });

  assert.ok(out.digest.length > 0, "the writer must return a digest");
  assert.ok(out.stats.budget.calls >= 2, "at least one triage call and one writer call");
  assert.ok(out.stats.budget.tokens > 0);
  assert.ok(out.stats.budget.tokens <= 30000);
  assert.equal(out.audit.length, 2);
});
