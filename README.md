# NewsFlow Studio — Otari edition

A news digest where **one open-weight model triages every story and a second one writes the digest**,
and every model call goes through an [Otari](https://github.com/mozilla-ai/otari) gateway — the hosted
platform at [otari.ai](https://otari.ai) by default, or the same software self-hosted.

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

## Run it — hosted Otari.ai

The hackathon asks for the hosted platform, so the app points there unless told
otherwise. You need a key from [otari.ai](https://otari.ai).

```bash
# 1. Which models and which tool the hosted deployment actually serves:
curl -sS https://otari.ai/api/v1/models -H "Authorization: Bearer $OTARI_API_KEY"

# 2. Name two of those models, one for each role. The names below are examples;
#    take the real ones from the answer above.
export OTARI_MODEL_TRIAGE=<small-open-weight-model>
export OTARI_MODEL_WRITE=<larger-model>
export OTARI_MODEL_FALLBACK=<third-model>

# 3. The app:
OTARI_API_KEY=$OTARI_API_KEY npm start     # http://localhost:8787
```

`OTARI_BASE_URL` overrides the host (default `https://otari.ai/api/v1`).

### Or run the gateway yourself

The hosted platform and the open-source image are the same API, so the demo also
runs offline. This is how the numbers in this README were measured:

```bash
docker run -d --name otari-demo -p 8010:8000 \
  -e OTARI_MASTER_KEY="$(openssl rand -hex 16)" \
  -e OTARI_WEB_FETCH_ENABLED=true \
  -e OTARI_CONFIG_YAML='
default_pricing: true
require_pricing: false
providers:
  localrouter:
    provider_type: openai
    api_base: "http://host.docker.internal:3928/v1"
    api_key: "local"
    models: [free-fast, free-best, free-coder]
  ollama:
    api_base: "http://host.docker.internal:11434"
' \
  mzdotai/otari:latest

# Optional, for the two-model run: a local open-weight model.
docker run -d --name ollama -p 11434:11434 -v ollama-models:/root/.ollama ollama/ollama:latest
docker exec ollama ollama pull qwen2.5:1.5b-instruct

# The key Otari prints once on first boot:
docker logs otari-demo 2>&1 | grep -oE 'tk-[A-Za-z0-9_-]+' | head -1

OTARI_BASE_URL=http://localhost:8010/api/v1 OTARI_API_KEY=tk-... npm start
```

`OTARI_MODEL_TRIAGE`, `OTARI_MODEL_WRITE` and `OTARI_MODEL_FALLBACK` name the three models. The Otari
key stays on the server: the page calls `/api/digest` and cannot mint a key or
spend a budget of its own.

Two settings let the gateway do more than route models:

```bash
# the gateway reads each page through its own bounded fetcher (falls back to the
# app's fetch when the tool is not served, or when OTARI_WEB_FETCH=off)
-e OTARI_WEB_FETCH_ENABLED=true

# optional: a service key's end-user budget, applied to the `user` id the app sends
OTARI_END_USER_BUDGET=<budget id from /api/v1/end-user-budgets>
```

The app's own per-user limits are `USER_MAX_TOKENS` (60000), `USER_MAX_RUNS` (6) and
`USER_WINDOW_MINUTES` (60). A request past them is refused with `429` and `Retry-After` before any
model call. `GET /api/me` returns the current window for whoever is asking.

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

That is a real run on this machine: both aliases resolved to one model, and the app said so instead of
claiming two.

To get a genuine two-model run, point the roles at backends that cannot collapse into each other —
one local open-weight model and one hosted:

```bash
OTARI_MODEL_TRIAGE="ollama:qwen2.5:1.5b-instruct" \
OTARI_MODEL_WRITE="localrouter:free-best" \
OTARI_API_KEY=tk-... npm start
```

Measured with that split, three fixture stories (one a sponsored post):

```
roles:   triage qwen2.5:1.5b-instruct (local Ollama)  write qwen/qwen3.7-flash:free (router)
distinct: true        calls: 4 (3 triage + 1 writer)   tokens: 789   time: 13.8s
chosen:  "Rust 1.84 ships async closures", "Postgres 18 released"   (sponsored story dropped)
```

That is also the cheapest shape: the model that reads every story is a 1.5B running on the same
machine, and the model that writes six sentences is the good one. The `roles` field is what turns the
"two models" claim into a measurement, and `tests/live.test.mjs` asserts the report is consistent
rather than asserting the router was lucky.

### Gateway tools and per-user budgets, measured

Run against the same local gateway with `OTARI_WEB_FETCH_ENABLED=true`:

```
POST /api/digest  {"feeds":["hacker-news"],"limit":2,"topN":2}
  X-User-Id: agent1-live-test

ok: true   ms: 95882   tokens: 4278
audit: fetched=ok via=gateway  "Show HN: Kvittas, an Expense Splitting App"
       fetched=ok via=gateway  "Show HN: Bema: Work messaging built for humans"
user:  {runs: 1/6, tokens: 4278, remainingTokens: 55722, resetAt: ...}
```

Both pages were read by the gateway's own `otari_web_fetch`; the app's fetch never ran. The same
build with the tool disabled logs `via=direct` for the same stories, which is the fallback the unit
tests pin.

The per-user window, with `USER_MAX_RUNS=1` and a second request while the first was still running:

```
HTTP/1.1 429 Too Many Requests
retry-after: 3540

{"error":"user_budget_exceeded",
 "message":"this user has started 1 of 1 runs in the current window",
 "retryAfterSeconds":3540}
```

A run in flight counts against the window, so two tabs cannot both spend the last of it. The
reservation is corrected to the actual token count when the run ends.

Search on the same deployment, where no search provider is configured:

```
$ node --input-type=module -e '…tools.search("Rust 1.84 async closures")'
{"ok":false,
 "reason":"gateway tool: every model failed: localrouter:free-fast \
           (gateway 400: {\"detail\":\"otari_web_search tool requested but there is \
           nothing to search with: this gateway has no search …\"})"}
```

That is the branch, not a crash: a linkless story keeps its feed description and the audit records
why. A deployment with a search backend fills `otari_tool_calls[].sources` and the app uses those
URLs instead of asking the model to name a source.

## What Otari does here

| Capability | Where it is used, not just enabled |
|---|---|
| Model routing | two aliases (`triage`, `write`) plus a `fallback`, resolved per call |
| Fallbacks | `chatWithFallback` walks the list in order and records every failure |
| Budgets | `Budget.assertRoom()` throws **before** the call; the counter fills from `usage` |
| Multiple models, distinct roles | the triage/writer split, verified by `roles` |
| Guardrails | instruction-shaped text is removed and PII is redacted before any prompt |
| Per-user budgets | `UserBudgetStore`: a token and run window per user (`X-User-Id`, session cookie, or address), reserved **before** the run. With `OTARI_END_USER_BUDGET` set, the same id also goes to Otari as `user` + `Otari-End-User-Budget`; without it the id stays in the app, because a non-service key refuses a `user` that is not its own |
| Web fetch | the gateway's `otari_web_fetch` reads each story first; the app's own fetch is the fallback, and the audit row says `gateway` or `direct` |
| Web search | `otari_web_search` resolves a story the feed gave without a link; its sources are the gateway's, not the model's prose. Wired and unit-tested; the free deployment used here has no search backend, so the live run logged the gateway's 400 and fell back to the direct fetch (see below) |

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
npm test        # 51 checks, no network
npm run test:live   # 3 checks against a running gateway
```

The unit tests cover the injection/PII screen, the gateway client (key handling, error mapping,
fallback ordering, budget refusals) and the pipeline (triage filtering, dead pages, timeouts, a
triage outage, the empty digest, the token cap, and both role-report outcomes), the gateway tools
(forced calls, a gateway that ran no tool, a release that reports no tool calls at all) and the
per-user window (reservation, commit, release, `429` with `Retry-After`). The live tests skip
themselves unless `OTARI_LIVE=1`, so CI never depends on a free router being up.

## Files

| Path | What it is |
|---|---|
| `lib/guardrails.mjs` | injection and PII screen, with an audit trail |
| `lib/otari.mjs` | gateway client, `Budget`, `GatewayError` |
| `lib/pipeline.mjs` | fetch → screen → triage → write, plus the role report |
| `lib/gatewayTools.mjs` | forced `otari_web_fetch` / `otari_web_search`, with the app's fetch as fallback |
| `lib/userBudget.mjs` | per-user token and run window, reserved before the run, corrected after |
| `server.mjs` | static UI, `/api/digest`, `/api/health`, RSS parsing |
| `public/` | the page: no framework, no build step, no key |
| `tests/` | unit tests and the opt-in live suite |

## Licence

MIT.
