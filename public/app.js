/* The page talks to /api/digest and to nothing else. No model key, no provider
   URL, no direct call to Otari: the gateway stays behind the server. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const runBtn = $("run");
  const hint = $("hint");
  const chip = $("gateway-chip");

  async function health() {
    try {
      const res = await fetch("/api/health");
      const ok = res.ok;
      chip.textContent = ok ? "gateway: reachable" : "gateway: " + res.status;
      chip.className = "chip " + (ok ? "ok" : "bad");
    } catch {
      chip.textContent = "gateway: unreachable";
      chip.className = "chip bad";
    }
  }

  function setModels() {
    // The defaults the server ships with. Shown so the reader can see that two
    // different models do two different jobs, instead of one model doing both.
    $("m-triage").textContent = "localrouter:free-fast";
    $("m-write").textContent = "localrouter:free-best";
    $("m-fallback").textContent = "localrouter:free-coder";
  }

  function renderStats(s) {
    const box = $("stats");
    box.hidden = false;
    box.textContent = "";
    const add = (text, kind) => {
      const el = document.createElement("span");
      el.className = "pill" + (kind ? " " + kind : "");
      el.textContent = text;
      box.appendChild(el);
    };
    add(`${s.stats.items} fetched`);
    add(`${s.stats.relevant} written`);
    add(`${s.stats.budget.tokens} tokens`);
    add(`${s.stats.budget.calls} gateway calls`);
    add(`${s.stats.ms} ms`);
    if (s.stats.writer) add(`writer: ${s.stats.writer}`);
    const roles = s.stats.roles || {};
    if (roles.distinct) {
      add(`two models: ${(roles.triage || []).join(", ")} + ${roles.write}`);
    } else if (roles.collapsed) {
      add(`one model served both roles: ${roles.write}`, "warn");
      add("set OTARI_MODEL_WRITE to a different model", "warn");
    }
    const attempts = s.stats.writerAttempts || [];
    if (attempts.length > 1) add(`${attempts.length - 1} fallback(s)`, "warn");
    const flagged = (s.audit || []).filter((a) => a.injectedLines.length || Object.keys(a.redactions).length);
    if (flagged.length) add(`${flagged.length} screened`, "warn");
  }

  function renderAudit(audit) {
    const panel = $("audit-panel");
    if (!audit || !audit.length) return;
    panel.hidden = false;
    const tbody = $("audit").querySelector("tbody");
    tbody.textContent = "";
    for (const row of audit) {
      const tr = document.createElement("tr");
      const title = document.createElement("td");
      title.textContent = row.title.length > 78 ? row.title.slice(0, 78) + "…" : row.title;
      const fetch = document.createElement("td");
      fetch.className = "num" + (row.fetched === "ok" ? "" : " err");
      fetch.textContent = row.fetched;
      const inj = document.createElement("td");
      inj.className = "num" + (row.injectedLines.length ? " dirty" : "");
      inj.textContent = row.injectedLines.length ? String(row.injectedLines.length) : "0";
      if (row.injectedLines.length) inj.title = row.injectedLines.join(" | ");
      const red = document.createElement("td");
      const kinds = Object.entries(row.redactions || {});
      red.className = "num" + (kinds.length ? " dirty" : "");
      red.textContent = kinds.length ? kinds.map(([k, v]) => `${k}×${v}`).join(" ") : "0";
      tr.append(title, fetch, inj, red);
      tbody.appendChild(tr);
    }
  }

  function renderDigest(result) {
    const box = $("digest");
    box.classList.remove("empty");
    box.textContent = "";

    const paragraphs = String(result.digest || "").split(/\n{2,}/).filter(Boolean);
    if (!paragraphs.length) {
      box.classList.add("empty");
      box.textContent = "The writer returned an empty digest. The audit below says what it was given.";
    }
    for (const p of paragraphs) {
      const el = document.createElement("p");
      el.textContent = p;
      box.appendChild(el);
    }

    if (result.chosen && result.chosen.length) {
      const h = document.createElement("h3");
      h.textContent = "Sources";
      box.appendChild(h);
      const ul = document.createElement("ul");
      for (const c of result.chosen) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = c.url;
        a.textContent = c.title;
        a.rel = "noopener";
        li.append(a, document.createTextNode(` — ${c.topic}, ${c.importance}/5`));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
  }

  async function run() {
    const feeds = [...document.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
    if (!feeds.length) {
      hint.textContent = "Pick at least one source.";
      return;
    }
    runBtn.disabled = true;
    hint.textContent = "Fetching stories, triaging with the small model, writing with the larger one…";
    try {
      const res = await fetch("/api/digest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feeds,
          topN: Number($("topn").value) || 5,
          maxTokens: Number($("maxtok").value) || 40000
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        hint.textContent = "Gateway error: " + (data.error || res.status);
        return;
      }
      renderDigest(data);
      renderStats(data);
      renderAudit(data.audit);
      hint.textContent = "Done. Every number above came from the gateway response.";
    } catch (err) {
      hint.textContent = "Request failed: " + err.message;
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", run);
  setModels();
  health();
})();
