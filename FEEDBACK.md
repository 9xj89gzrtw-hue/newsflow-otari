# Feedback for the Otari team

Written feedback, as the hackathon asks for. Everything below happened while building this project
against `mzdotai/otari:latest` on 2026-11-01/02, and each item has the command or response that
produced it.

## 1. When were you most tempted to skip Otari and call the provider directly?

Three times, all in the first hour.

**a) Registering a local provider endpoint.** I wanted the app to point at a model server on the host
and have Otari own the routing. The documented path is a provider endpoint:

```bash
POST /api/v1/provider-endpoints
{"name":"localrouter","provider":"openai","api_base":"http://host.docker.internal:3928/v1","api_key":"local"}
→ {"detail":"endpoint api_base refused: destination resolves to a disallowed private address"}
```

That refusal is correct for a tenant-supplied URL, but there is no documented way to say "this is my
own box". I tried `OTARI_PROVIDER_ALLOW_PRIVATE_HOSTS=true` and `provider_allow_private_hosts: true`
in the config; neither changed the answer, because `services/providers/_owned_endpoint_network.py`
calls `validate_retrieval_target(api_base)` without passing `allow_private`. The setting is named in
the test suite (`tests/unit/test_setting_names.py`) but this call path ignores it.

What I did instead: stopped using provider endpoints and declared a provider *instance* in the
config YAML, which does allow a private host. That works, but it means the app cannot let a user
bring their own model server, which is the feature provider endpoints exist for.

**b) The first request after boot returned 402.** `require_pricing` defaults to on, and with no
pricing configured every request is rejected. The log line is honest about it, so this cost minutes,
not hours — but a fresh container that answers 402 to a first request is a bad first impression. A
`require_pricing: false` default for a container with no pricing table would be friendlier.

**c) Mounting a config file.** `OTARI_CONFIG_PATH=/config.yml` with the file mounted did not take
effect: `/api/v1/models` came back `{"data":[]}` while the same YAML in `OTARI_CONFIG_YAML` worked.
The docs mention `OTARI_CONFIG_PATH=/dev/null` in the quickstart, so the variable exists; it just
did not read my file. `OTARI_CONFIG_YAML` is the path that works, and it is the one I would document
first for Docker users.

I did not skip Otari: calling `http://127.0.0.1:3928/v1` directly would have worked in two minutes,
and the whole point of the project is the gateway. But the temptation was real, and it was strongest
exactly where the gateway was trying to protect me.

## 2. What did you end up building yourself that Otari should've done for you?

**a) A role report.** The rubric asks for "two or more open-weight models for different purposes",
and the config file cannot prove it: I asked for `free-fast` and `free-best`, and both calls were
served by the same upstream model. Otari knew this — it logged the routing decision — but the
response body only carries the upstream `model` field, so the app has to diff the values itself and
admit the collision in the UI. A per-request `routed_from` / `served_by` pair in the response, and a
usage breakdown by (requested model, served model), would turn a claim into a measurement.

**b) A budget pre-check.** `Budget.assertRoom()` in this repo exists because the only way to know
whether a run fits is to estimate it and throw before building the prompt. Otari enforces the budget
correctly, but it enforces it at request time with a 402. If a key's remaining budget came back in a
response header, or there were a `GET /api/v1/keys/{id}/budget`, the app could refuse to start a
sixteen-story digest instead of failing on story eleven.

**c) Screening of fetched text.** Otari has `web_fetch`, and this app does its own fetching, so I
wrote the injection/PII screen myself (`lib/guardrails.mjs`). That is arguably the app's job, but
"fetch a page and hand me the text with instruction-shaped sentences removed and PII redacted" is a
tool the gateway is better placed to offer, because it sees every caller's fetched text.

**d) Nothing about key handling.** That part was genuinely good: the bootstrap key is printed once,
the management API needs the master key and says "Invalid master key" instead of silently allowing
it, and the virtual key never has to leave the server.

## 3. If the rules hadn't required Otari, would you have continued using Otari?

Yes, for this shape of app, with two conditions.

Reasons to keep it:

- one key and one endpoint for every model, so swapping the writer model is a config change and not a
  code change;
- the budget is enforced by something the client cannot bypass, which is the only version of a budget
  that survives a bug in my own code;
- usage comes from the gateway, so the numbers in the UI are not my own accounting of my own calls;
- self-hosting means the same code runs after the hackathon without a vendor account.

Conditions:

- I need to be able to pin a model per role and *know* the pin held. Aliases that silently resolve to
  whatever is live make a two-model claim unprovable, and that is the difference between a demo and a
  product.
- The private-address refusal needs a documented escape hatch for operator-owned endpoints, otherwise
  "bring your own model server" only works for public hosts.

What would make me leave: per-request pricing that changes without notice, or a gateway that fails
open (routes around a budget) instead of failing closed. Otari failed closed every time I tested it,
which is the right behaviour.

## 4. What didn't work, and what's missing

Bugs, in the order I hit them:

1. `OTARI_PROVIDER_ALLOW_PRIVATE_HOSTS` / `provider_allow_private_hosts` do not affect
   `/api/v1/provider-endpoints`. Repro: boot the container, set either, POST an endpoint with
   `api_base: http://host.docker.internal:3928/v1`, get
   `endpoint api_base refused: destination resolves to a disallowed private address`.
2. `OTARI_CONFIG_PATH` did not load a mounted YAML file; `OTARI_CONFIG_YAML` did.
3. `require_pricing` defaults to on with no pricing configured, so the first request is a 402.

Missing, in the order I would want it:

1. `served_by` in the response, next to `model`, plus per-model usage in the usage endpoint.
2. Remaining budget for the calling key in a header or a small endpoint.
3. A documented "operator-owned endpoint" mode, distinct from "tenant-supplied URL", so the SSRF
   protection stays on for users and off for the person running the box.
4. A worked Docker example that uses `OTARI_CONFIG_YAML` and a private model server end to end. The
   quickstart assumes a public provider and a key, which is not the self-hosted case the project is
   pitching.
