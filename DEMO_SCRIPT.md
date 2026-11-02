# Demo script — 3 to 5 minutes, spoken in your own voice

The rules are explicit: the demo and the feedback must be a screen recording **with audio**, and AI
voice is not allowed. So this file is a script, not a recording. Read it, click what it says, and
record yourself doing it.

Two recordings are needed:

1. **Demo**, 3-5 minutes, answering the four video questions.
2. **Feedback**, 3-5 minutes, if you prefer speaking over `FEEDBACK.md`.

You can record both in one take if you keep them separate in the submission form.

## Before you record

```bash
# gateway (keep the terminal visible in a second window, it is part of the story)
docker ps --filter name=otari-demo

# the app
cd newsflow-otari-studio
OTARI_API_KEY=$(cat /tmp/otari_key.txt) npm start
open http://localhost:8787
```

Have the gateway log open in a terminal: `docker logs -f otari-demo`. Showing the request arriving at
Otari is worth more than any slide.

## 0:00-0:30 — What this is

> "This is NewsFlow Studio. It builds a technical news digest from Hacker News and Lobsters. Two
> open-weight models do two different jobs: a small one triages every story, and a bigger one writes
> the digest. Every model call goes through an Otari gateway that I run myself, so the budget is
> enforced before a request leaves my server, and the gateway, not my code, decides which model
> answers."

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

Switch to `docker logs -f otari-demo`:

> "Here is the same run from Otari's side: the model names, the token counts, and the key that made
> the calls. The page has no key and no provider URL. It calls my server, my server calls Otari, and
> Otari calls the provider."

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
> "Provider endpoints refuse a private address with no documented way to say 'this is my own box',
> even though a setting with that name exists. `OTARI_CONFIG_PATH` did not read a mounted file; only
> `OTARI_CONFIG_YAML` worked. And a fresh container answers 402 until you turn `require_pricing` off."

> **What's missing?**
> "The response tells me which model served the request, but not which alias it routed from, so I
> measure that myself. And I would like the remaining budget for my key before I build a prompt,
> not a 402 after it."

## 4:00-4:30 — Close

> "The repo is `newsflow-otari-studio`, MIT, no build step, thirty-six tests that run without a
> network and three that run against a live gateway. The written feedback is in `FEEDBACK.md` with
> the exact commands and responses."

## Recording

macOS: `Cmd-Shift-5` → Record Selected Portion, microphone on. Or:

```bash
# screen only, then mux your own audio track
ffmpeg -f avfoundation -i "1:none" -t 300 -r 30 demo_raw.mov
```

Do not let a tool synthesise the voice. The rules disqualify it, and the recording is the one part of
this submission an agent cannot do for you.
