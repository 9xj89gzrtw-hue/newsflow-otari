# Demo script — 3 to 5 minutes, spoken in your own voice

The rules are explicit: the demo and the feedback must be a screen recording **with audio**, and AI
voice is not allowed. So this file is a script, not a recording. Read it, click what it says, and
record yourself doing it.

Two recordings are needed:

1. **Demo**, 3-5 minutes, answering the four video questions.
2. **Feedback**, 3-5 minutes, if you prefer speaking over `FEEDBACK.md`.

You can record both in one take if you keep them separate in the submission form.

## Before you record

Record against the **hosted platform** — the rules say the project must use Otari.ai, and the startup
line is your proof on camera.

```bash
# 1. A key from https://otari.ai, then the models that deployment serves:
curl -sS https://otari.ai/api/v1/models -H "Authorization: Bearer $OTARI_API_KEY"

# 2. The app, with one model per role (names from the answer above):
cd newsflow-otari-studio
OTARI_API_KEY=$OTARI_API_KEY \
OTARI_MODEL_TRIAGE=<small-open-weight-model> \
OTARI_MODEL_WRITE=<larger-model> \
OTARI_MODEL_FALLBACK=<third-model> npm start
open http://localhost:8787
```

Keep the terminal visible: `npm start` prints `gateway: https://otari.ai/api/v1` and one `[tools]`
line, and every run prints one `[digest] gateway=… tokens=… calls=… roles=…` line. That line is what you point at when the
narration says the calls went through Otari.

If you record the self-hosted variant instead, start the container from the README and keep
`docker logs -f otari-demo` open; set `OTARI_BASE_URL=http://localhost:8010/api/v1`. Say on camera
which one you are running.

## 0:00-0:30 — What this is

> "This is NewsFlow Studio. It builds a technical news digest from Hacker News and Lobsters. Two
> open-weight models do two different jobs: a small one triages every story, and a bigger one writes
> the digest. Every model call goes through the Otari gateway — here the hosted platform at
> otari.ai — so the gateway, not my code, decides which model answers and what each call costs."

Show the page. Point at the gateway chip: `gateway: reachable`.

## 0:30-1:30 — The run

Press **Build today's digest**. While it runs:

> "It fetches about twelve stories, strips the HTML, screens each one, and sends it to the triage
> model. That is one call per story, which is why it is the cheap model. Then the survivors go to the
> writer in a single call."

When it finishes, point at the pills:

> "Tokens and call count come from the gateway response, not from my own accounting. The writer pill
> names the model that actually answered."

**If the pill says `one model served both roles`, say so out loud.** That is the honest path and it
is the most interesting thing in the demo:

> "I asked for two different models and the router gave me one, twice. The app measures which model
> served each role instead of trusting the config, so it says so here. That is exactly the failure a
> two-model claim usually hides."

## 1:30-2:30 — Guardrails

Scroll to the **Guardrail audit** table.

> "Every fetched page is untrusted input. A page can carry 'ignore previous instructions' and a model
> will follow it. So the text is screened before it reaches a prompt: instruction-shaped sentences
> are dropped, and emails, card numbers and phone numbers are replaced."

Point at a row with a non-zero count and open the tooltip:

> "This row had one dropped sentence. Notice the article survived — the screen works sentence by
> sentence, because a fetched page arrives as one long line and line-level filtering would delete the
> reporting along with the attack."

## 2:30-3:15 — The gateway, from the other side

Switch to the terminal and point at the run line:

```
[digest] gateway=https://otari.ai/api/v1 items=12 tokens=4278 calls=5 ms=95882 roles=distinct
```

> "Here is the same run from the server side. The gateway host is in the line, the token count is
> what Otari reported — from the gateway's own `usage`, not my own estimate — and the page never sees
> the key. The page calls my
> server, my server calls Otari.ai, and Otari calls the provider."

If you run the self-hosted variant, show `docker logs -f otari-demo` instead and say that it is the
same gateway image, self-hosted.

Then show the budget refusal, which is the point of the whole exercise:

```bash
# in another terminal, set the token cap on the page to 4000 and run again
```

> "With the cap at four thousand tokens the run refuses to start, because the budget check happens
> before the prompt is built. A budget that only complains afterwards is a report, not a limit."

## 3:15-4:00 — The four questions

> **What did you build, and which features did you use?**
> "A digest app where triage and writing are two roles with two models, both behind Otari. I used
> model routing and fallbacks, budgets with a pre-call check, multiple models in distinct roles, and
> guardrails on untrusted input."

> **What worked well?**
> "One key for every model, and a budget the client cannot bypass. Swapping the writer model was a
> config change. And Otari failed closed every time I tested it — it never routed around a limit."

> **What didn't work?**
> "On the self-hosted image: provider endpoints refuse a private address with no documented way to
> say 'this is my own box', even though a setting with that name exists. `OTARI_CONFIG_PATH` is read
> by docker-compose but not by `otari serve`, so `docker run -e OTARI_CONFIG_PATH=…` starts without a
> config and says nothing. And a fresh container answers 402 until you turn `require_pricing` off.
> I filed the first two as issues."

> **What's missing?**
> "The response tells me which model served the request, but not which alias it routed from, so I
> measure that myself. And I would like the remaining budget for my key before I build a prompt,
> not a 402 after it."

## 4:00-4:30 — Close

> "The repo is `newsflow-otari`, MIT, no build step, fifty-three tests, of which three need a live
> gateway and skip themselves without one. The written feedback is in `FEEDBACK.md` with
> the exact commands and responses."

## Recording

macOS: `Cmd-Shift-5` → Record Selected Portion, microphone on. Or:

```bash
# screen only, then mux your own audio track
ffmpeg -f avfoundation -i "1:none" -t 300 -r 30 demo_raw.mov
```

Do not let a tool synthesise the voice. The rules disqualify it, and the recording is the one part of
this submission an agent cannot do for you.
