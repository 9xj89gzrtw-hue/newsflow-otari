# NewsFlow Studio — Otari edition

A news digest where **one open-weight model triages every story and a second one writes the digest**,
and every model call goes through a self-hosted [Otari](https://github.com/mozilla-ai/otari) gateway.

The point is not that a model can summarize the news. The point is that the gateway is the only thing
that talks to a provider: it decides which model answers, it enforces the token budget before the call
leaves the server, and it records which model actually served each request. The app reports that
number instead of assuming it.

```
feed (HN, Lobsters)
  → fetch article, screen it (injection + PII)
  → Otari: triage model  → {relevant, topic, importance}   (one call per story)
  → Otari: writer model  → digest prose                    (one call per run)
  → budget counter, role report, guardrail audit → UI
```

## Run it

```bash
# 1. A gateway. The published image is enough for the demo:
docker run -d --name otari-demo -p 8010:8000 \
  -e OTARI_MASTER_KEY="$(openssl rand -hex 16)" \
  -e OTARI_CONFIG_YAML='
default_pricing: true
require_pricing: false
providers:
  localrouter:
    provider_type: openai
    api_base: "http://host.docker.internal:3928/v1"
    api_key: "local"
    models: [free-fast, free-best, free-coder]
' \
  mzdotai/otari:latest

# 2. The key Otari prints once on first boot:
docker logs otari-demo 2>&1 | grep -oE 'tk-[A-Za-z0-9_-]+' | head -1

# 3. The app:
OTARI_API_KEY=tk-... npm start     # http://localhost:8787
```

`OTARI_BASE_URL`, `OTARI_MODEL_TRIAGE`, `OTARI_MODEL_WRITE` and `OTARI_MODEL_FALLBACK` override the
defaults. The Otari key stays on the server: the page calls `/api/digest` and cannot mint a key or
spend a budget of its own.

## Two models in two roles, measured

The config names two models, but a gateway is free to route two aliases to the same upstream model.
Asking for `free-fast` and `free-best` on a shared free router can land both calls on one model, and
then "two models" is a claim about the config file, not about the run.

So the app records the `model` field from every gateway response and reports:

```json
"roles": {
  "triage": ["qwen/qwen3.7-flash:free"],
  "write": "qwen/qwen3.7-flash:free",
  "distinct": false,
  "collapsed": true
}
```

When `collapsed` is true the UI says so in a warning pill instead of claiming two models. To get a
genuine two-model run, point the two roles at backends that cannot collapse into each other:

| Role | Backend | Example |
|---|---|---|
| triage | a small local open-weight model, many cheap calls | `ollama:qwen2.5:1.5b` |
| write | a larger hosted open-weight model, one call | `localrouter:free-best` |

That is the configuration the demo should be recorded with, and it is also the cheapest one: the
model that reads sixteen articles is the 1.5B, and the model that writes six sentences is the good one.

## What Otari does here

| Capability | Where it is used, not just enabled |
|---|---|
| Model routing | two aliases (`triage`, `write`) plus a `fallback`, resolved per call |
| Fallbacks | `chatWithFallback` walks the list in order and records every failure |
| Budgets | `Budget.assertRoom()` throws **before** the call; the counter fills from `usage` |
| Multiple models, distinct roles | the triage/writer split, verified by `roles` |
| Guardrails | instruction-shaped text is removed and PII is redacted before any prompt |
| Per-user budgets | one `Budget` per request; the token cap comes from the page |
| Web fetch | the app fetches article bodies itself; Otari's `web_fetch` tool is the alternative |

Otari features that are **not** claimed: MCP integrations and code execution are not used by this
app, so they earn nothing here.

## Guardrails

Fetched pages are untrusted input: a page can carry "ignore previous instructions" or a fake system
turn. `lib/guardrails.mjs` runs before the prompt is built.

- instruction-shaped **sentences** are dropped, not whole articles — a fetched page arrives as one
  long line, so line-level filtering would throw away the reporting along with the attack;
- emails, card numbers, IBANs and international phone numbers are replaced with markers;
- the run returns an audit row per story: fetch status, dropped sentences, redaction counts.

A row with no flags means the screen ran and found nothing. That is a different statement from
"nobody looked", which is why the audit is shown even when it is empty.

## Tests

```bash
npm test        # 36 checks, no network
npm run test:live   # 3 checks against a running gateway
```

The unit tests cover the injection/PII screen, the gateway client (key handling, error mapping,
fallback ordering, budget refusals) and the pipeline (triage filtering, dead pages, timeouts, a
triage outage, the empty digest, the token cap, and both role-report outcomes). The live tests skip
themselves unless `OTARI_LIVE=1`, so CI never depends on a free router being up.

## Files

| Path | What it is |
|---|---|
| `lib/guardrails.mjs` | injection and PII screen, with an audit trail |
| `lib/otari.mjs` | gateway client, `Budget`, `GatewayError` |
| `lib/pipeline.mjs` | fetch → screen → triage → write, plus the role report |
| `server.mjs` | static UI, `/api/digest`, `/api/health`, RSS parsing |
| `public/` | the page: no framework, no build step, no key |
| `tests/` | unit tests and the opt-in live suite |

## Licence

MIT.
