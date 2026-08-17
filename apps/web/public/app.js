/* RouteLock frontend behaviour.
 *
 * Vanilla, no build step, no framework. Every number rendered here arrives from
 * `/api/*`, which reads a live chain or performs real inference — there is no
 * sample data in this file and no offline mode. When a fetch fails, the failure
 * is shown; nothing falls back to a plausible-looking value, because a page that
 * invents its own data is the exact failure this project treats as
 * disqualifying.
 */

"use strict";

const $ = (id) => document.getElementById(id);

/** Escape before inserting into markup. Model output and chain data both reach
 *  the DOM here, and the model's rationale is free text from a third party. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function api(path, options) {
  const response = await fetch(path, options);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} answered ${response.status} with no JSON body`);
  }
  if (!response.ok) {
    const error = new Error(body.error ?? `${path} answered ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function showError(container, error) {
  const extra = error.status === 402
    ? " The served inference budget is spent — this is the cap working, not a fault."
    : "";
  container.innerHTML =
    `<div class="error"><strong>${esc(error.status ? `${error.status}` : "failed")}</strong>` +
    `${esc(error.message)}${esc(extra)}</div>`;
}

function short(address) {
  const s = String(address ?? "");
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

/* ─────────────────────────── live chain header ─────────────────────────── */

async function loadState() {
  const live = $("live");
  try {
    const state = await api("/api/state");
    const explorer = state.explorer;
    const link = (address, label) =>
      explorer
        ? `<a class="pill" href="${esc(explorer)}/address/${esc(address)}" target="_blank" rel="noreferrer">${esc(label)} <strong>${esc(short(address))}</strong></a>`
        : `<span class="pill">${esc(label)} <strong>${esc(short(address))}</strong></span>`;

    const registry = state.contracts.find((c) => c.name === "ActivationRegistry");

    live.innerHTML = [
      `<span class="pill">chain <strong>${esc(state.chain.name)} (${esc(state.chain.id)})</strong></span>`,
      `<span class="pill">block <strong>${esc(state.block)}</strong></span>`,
      `<span class="pill">deployed at block <strong>${esc(state.deployedAtBlock)}</strong></span>`,
      `<span class="pill">entitlements minted <strong>${esc(state.totals.minted)}</strong></span>`,
      `<span class="pill">fulfilment receipts <strong>${esc(state.totals.receipts)}</strong></span>`,
      `<span class="pill">escrow holds <strong>${esc(state.settlement.escrowHolds)} ${esc(state.settlement.symbol)}</strong></span>`,
      registry ? link(registry.address, "registry") : "",
    ].join("");

    renderRoles(state.roles, explorer);

    $("foot").innerHTML =
      `Read from ${esc(state.rpc)} at ${esc(state.readAt)}. ` +
      `Settlement token ${esc(state.settlement.symbol)} (${esc(state.settlement.decimals)} dp) at ` +
      `<span class="mono">${esc(state.settlement.address)}</span>. ` +
      `Deployment recorded by <span class="mono">forge script --broadcast</span> on ` +
      `${esc(state.deployedAt.slice(0, 10))}.`;
  } catch (error) {
    live.innerHTML = `<span class="pill bad">chain read failed: ${esc(error.message)}</span>`;
  }
}

function renderRoles(roles, explorer) {
  $("roles-summary").textContent =
    `— ${roles.checks.filter((c) => c.holds).length} of ${roles.checks.length} hold ` +
    `(${roles.positive} grants that must exist, ${roles.negative} that must not)`;

  const rows = roles.checks
    .map(
      (c) => `<tr>
        <td class="mono">${esc(c.what)}</td>
        <td>${esc(c.contract)}</td>
        <td class="mono">${esc(c.role)}</td>
        <td class="mono">${
          explorer
            ? `<a href="${esc(explorer)}/address/${esc(c.account)}" target="_blank" rel="noreferrer">${esc(short(c.account))}</a>`
            : esc(short(c.account))
        }</td>
        <td>${c.expected ? "granted" : "<em>absent</em>"}</td>
        <td>${c.holds ? '<span class="yes">holds</span>' : '<span class="no">FAILS</span>'}</td>
      </tr>`,
    )
    .join("");

  $("roles").innerHTML =
    `<div class="scroll-x"><table>
      <thead><tr><th>assertion</th><th>contract</th><th>role</th><th>account</th><th>expected</th><th>live</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="muted small">These are the same assertions <span class="mono">Deploy.s.sol</span>
    makes immediately after wiring, which is why a deployment that fails any of them does not
    exist. Re-read here from the live contracts.</p>`;
}

/* ────────────────────────── what was fulfilled ─────────────────────────── */

async function loadFulfilment() {
  const container = $("fulfilment");
  try {
    const data = await api("/api/fulfilment");

    if (data.count === 0) {
      container.innerHTML =
        `<div class="probe"><h3>No fulfilment yet</h3>
        <div class="detail">The adapter is built and exercised against the live endpoint, but no
        credit has been retired. Stated plainly rather than implied — an adapter with no fulfilment
        is not active, whatever its code does.</div></div>`;
      return;
    }

    container.innerHTML = data.records
      .map((r) => {
        // `recent` is the check that catches a shared placeholder receipt: a
        // transaction created minutes ago cannot be millions of blocks old.
        const ok = r.providerFound === true && r.providerState === "retired" && r.recent === true;
        return `<div class="probe ${ok ? "holds" : "fails"}">
          <h3>${ok ? "✓" : "✗"} ${esc(r.tonnes)} t retired — provider says <strong>${esc(r.providerState ?? "unknown")}</strong></h3>
          ${factList([
            ["charged", `${r.chargedUsdc} USDC`],
            ["beneficiary", r.beneficiary],
            ["requested at", r.at],
            ["mined at", r.minedAt ?? "unknown"],
            ["payment chain", r.settlementChain],
            ["block", r.block ? `${r.block} (${r.blocksBehindHead} behind head)` : "unknown"],
            ["recent enough to be proof", r.recent === null ? "unknown" : r.recent ? "yes" : "NO"],
          ])}
          ${
            r.proofUrl
              ? `<p style="margin-top:14px"><a href="${esc(r.proofUrl)}" target="_blank" rel="noreferrer">
                  Open the public retirement certificate ↗</a></p>`
              : ""
          }
          ${r.note ? `<p class="detail" style="margin-top:10px">${esc(r.note)}</p>` : ""}
          <details>
            <summary>Why the block number is shown at all</summary>
            <p class="muted small">Because a receipt that exists is not a receipt that is recent. A
            test-mode retirement on another provider once returned <span class="mono">COMPLETED</span>,
            a real transaction hash and a real certificate — for a retirement performed in April 2024
            by somebody else. The tell was the block: minutes-old work sitting 36 million blocks in the
            past. So the distance from the head is computed and published here, and the code refuses a
            receipt whose beneficiary is not the one requested.</p>
            <pre>cast receipt ${esc(r.txHash)} --rpc-url https://mainnet.base.org</pre>
          </details>
        </div>`;
      })
      .join("");
  } catch (error) {
    showError(container, error);
  }
}

/* ──────────────────────────── the guarantee ───────────────────────────── */

async function loadGuarantee() {
  const container = $("guarantee");
  try {
    const result = await api("/api/guarantee");

    const probes = result.probes
      .map(
        (p) => `<div class="probe ${p.holds ? "holds" : "fails"}">
          <h3>${p.holds ? "✓" : "✗"} ${esc(p.what)}</h3>
          <div class="detail">${esc(p.call)}<br>from ${esc(p.caller)}</div>
          <div class="detail" style="margin-top:6px">
            expected <strong>${esc(p.expected)}</strong>, got <strong>${esc(p.outcome)}</strong>${
              p.selector
                ? ` — selector ${esc(p.selector)}${
                    p.selectorMatches
                      ? " = ComplianceRoleForbiddenHere()"
                      : " which is <em>not</em> the expected error"
                  }`
                : ""
            }
          </div>
        </div>`,
      )
      .join("");

    container.innerHTML =
      probes +
      `<details><summary>Reproduce it yourself, without this page</summary>
        <pre>${result.reproduce.map(esc).join("\n\n")}</pre>
        <p class="muted small">Both are <span class="mono">eth_call</span>. Nothing is sent and
        nothing is signed. The second call succeeding <em>in simulation</em> does not grant anything:
        the role graph above independently shows the compliance key holds no role on the escrow.</p>
      </details>`;
  } catch (error) {
    showError(container, error);
  }
}

/* ───────────────────────── verdict rendering ──────────────────────────── */

/** Why the rule reached this verdict, in the rule's own vocabulary.
 *
 *  These are the exact `kind` values `DecisionGround` and `CarbonGround` define
 *  — nothing here is a guess, and an unrecognised kind falls through to its own
 *  name rather than to a friendly sentence that might not be true. */
function explainGround(ground) {
  if (!ground || typeof ground !== "object") return "";
  switch (ground.kind) {
    // Shared by both verticals.
    case "approved":
      return "confidence cleared the threshold and no rule fired against it";
    case "low_confidence":
      return `the model stated ${ground.confidence}, and ${ground.threshold} was required — a question, not a rejection`;

    // HS classification.
    case "no_classification":
      return "the description does not support naming a subheading";
    case "missing_information":
      return `answerable gaps in the description (${(ground.questions ?? []).length})`;
    case "purpose_flag":
      return `purpose-based policy, which no tariff code can express: ${(ground.flags ?? []).join(", ")}`;
    case "carrier_policy":
      return `the carrier's own published policy — ${ground.clause ?? ""}: ${ground.detail ?? ""}`;

    // Carbon quality.
    case "integrity_flag":
      return `credit integrity: ${(ground.flags ?? []).join(", ")}`;
    case "identity_unknown":
      return "the listing does not identify its own project well enough to rule on";
    case "unregistered_class":
      return "the class is not registered with a recognised registry";
    case "insufficient_liquidity":
      return `only ${ground.available} t available against ${ground.requested} t requested`;
    case "vintage_too_old":
      return `oldest vintage is ${ground.ageYears}y old, and ${ground.maxAgeYears}y is the limit`;

    default:
      return String(ground.kind ?? "").replace(/_/g, " ");
  }
}

function meter(confidence, threshold) {
  const pct = Math.max(0, Math.min(1, Number(confidence) || 0)) * 100;
  const mark = Math.max(0, Math.min(1, Number(threshold) || 0)) * 100;
  return `<div class="meter">
    <div class="meter-track">
      <div class="meter-fill" style="width:${pct.toFixed(1)}%"></div>
      <div class="meter-mark" style="left:${mark.toFixed(1)}%" title="threshold ${esc(threshold)}"></div>
    </div>
    <div class="meter-labels">
      <span>stated confidence <strong>${esc(confidence)}</strong></span>
      <span>threshold <strong>${esc(threshold)}</strong></span>
    </div>
  </div>`;
}

function factList(pairs) {
  return `<dl class="facts">${pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `<div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
    .join("")}</dl>`;
}

function renderHsRuling(ruling) {
  const p = ruling.proposal ?? {};
  const questions = (p.missingInformation ?? []).length
    ? `<h3 style="font-size:14px;margin:16px 0 4px">What it would need to be sure</h3>
       <ul class="plain">${p.missingInformation.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`
    : "";

  return `<div class="verdict ${esc(String(ruling.verdict).toLowerCase())}">
    <div class="verdict-head">
      <span class="verdict-name">${esc(ruling.verdict)}</span>
      <span class="verdict-why">${esc(explainGround(ruling.ground))}</span>
    </div>
    ${meter(p.confidence ?? 0, ruling.threshold)}
    ${factList([
      ["proposed HS-6", p.hs6 ?? "none"],
      ["lane", `${ruling.request.originCountry} → ${ruling.request.destinationCountry}${ruling.crossBorder ? " (cross-border)" : " (domestic)"}`],
      ["model", ruling.model],
      ["engine", ruling.engineVersion],
      ["decision hash", ruling.decisionHash],
    ])}
    ${p.rationale ? `<p class="muted" style="margin-top:14px">${esc(p.rationale)}</p>` : ""}
    ${questions}
    <details>
      <summary>The exact bytes this verdict commits to</summary>
      <p class="muted small">This is the canonical decision record. Hash it and you get the decision
      hash above — the same value <span class="mono">recordDecision</span> writes on chain. This
      ruling was <strong>not</strong> written to the chain: that needs a role this server does not
      hold.</p>
      <pre>${esc(ruling.canonical)}</pre>
    </details>
  </div>`;
}

/* ───────────────────────────── HS section ─────────────────────────────── */

$("hs-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("hs-submit");
  const out = $("hs-result");
  button.disabled = true;
  out.innerHTML = `<p class="muted">asking the model, then applying the rule…</p>`;

  try {
    const ruling = await api("/api/rule/hs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: $("hs-description").value,
        originCountry: $("hs-origin").value,
        destinationCountry: $("hs-destination").value,
        declaredValue: Number($("hs-value").value),
        currency: $("hs-currency").value,
        weightKg: Number($("hs-weight").value),
      }),
    });
    out.innerHTML = renderHsRuling(ruling);
    renderBudget(ruling.budget);
  } catch (error) {
    showError(out, error);
    if (error.body?.budget) renderBudget(error.body.budget);
  } finally {
    button.disabled = false;
  }
});

/* ─────────────────────────── carbon section ───────────────────────────── */

let selectedClass = null;

$("carbon-load").addEventListener("click", async () => {
  const button = $("carbon-load");
  const status = $("carbon-status");
  const container = $("carbon-inventory");
  button.disabled = true;
  status.textContent = "reading live inventory…";

  try {
    const inventory = await api("/api/carbon/inventory");
    status.textContent = `${inventory.count} classes, read ${inventory.readAt.slice(11, 19)} UTC — ${inventory.source}`;

    // Registry, vintage and supply live on each credit within a class, not on
    // the class — a class can hold credits from several vintages at once, which
    // is exactly what the engine's staleness rule is about.
    const uniq = (values) => [...new Set(values.filter((v) => v !== null && v !== undefined))];

    container.innerHTML = `<div class="scroll-x"><table>
      <thead><tr><th>class</th><th>where</th><th>registry</th><th>vintages</th><th>USDC / t</th><th>supply (t)</th><th></th></tr></thead>
      <tbody>${inventory.classes
        .map((c, index) => {
          const credits = c.credits ?? [];
          const supply = credits.reduce((sum, x) => sum + (Number(x.liquidityTonnes) || 0), 0);
          return `<tr id="cc-${index}">
            <td>${esc(c.name ?? "unnamed")}<br><span class="mono muted">${esc(c.carbonClassId)}</span></td>
            <td>${esc([c.country, c.category].filter(Boolean).join(" · ") || "—")}</td>
            <td>${esc(uniq(credits.map((x) => x.registry)).join(", ") || "—")}</td>
            <td class="mono">${esc(uniq(credits.map((x) => x.vintage)).sort().join(", ") || "—")}</td>
            <td class="mono">${c.priceUsdcPerTonne === null ? "—" : esc(c.priceUsdcPerTonne)}</td>
            <td class="mono">${supply === 0 ? "—" : esc(supply.toFixed(3))}</td>
            <td><button type="button" data-class="${esc(c.carbonClassId)}" data-row="cc-${index}">Rule on it</button></td>
          </tr>`;
        })
        .join("")}</tbody>
    </table></div>
    <p class="muted small">Supply moves: one listing went from 18,993 t to 0.056 t within minutes,
    which is why this is read live rather than cached.</p>`;

    for (const button of container.querySelectorAll("button[data-class]")) {
      button.addEventListener("click", () => ruleOnCarbon(button));
    }
  } catch (error) {
    showError(container, error);
    status.textContent = "";
  } finally {
    button.disabled = false;
  }
});

async function ruleOnCarbon(button) {
  const out = $("carbon-result");
  const previous = document.querySelector("tr.selected");
  if (previous) previous.classList.remove("selected");
  const row = $(button.dataset.row);
  if (row) row.classList.add("selected");
  selectedClass = button.dataset.class;

  button.disabled = true;
  out.innerHTML = `<p class="muted">reading the credit's own metadata, then ruling on it…</p>`;

  try {
    const ruling = await api("/api/rule/carbon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ carbonClass: selectedClass, tonnes: 0.001 }),
    });

    const f = ruling.facts ?? {};
    out.innerHTML = `<div class="verdict ${esc(String(ruling.verdict).toLowerCase())}">
      <div class="verdict-head">
        <span class="verdict-name">${esc(ruling.verdict)}</span>
        <span class="verdict-why">${esc(explainGround(ruling.ground))}</span>
      </div>
      ${meter(ruling.proposal?.confidence ?? 0, ruling.threshold)}
      ${factList([
        ["credit", f.name ?? ruling.carbonClass],
        ["registry", (f.registries ?? []).join(", ")],
        ["methodology", (f.methodologies ?? []).join(", ")],
        ["oldest vintage", f.oldestVintage ? `${f.oldestVintage} (${f.oldestVintageAgeYears}y old)` : ""],
        ["liquidity", f.liquidityTonnes ? `${f.liquidityTonnes} t` : ""],
        ["quoted", ruling.quotedUsdc === null ? "" : `${ruling.quotedUsdc} USDC / t`],
        ["engine", ruling.engineVersion],
        ["decision hash", ruling.decisionHash],
      ])}
      ${ruling.proposal?.rationale ? `<p class="muted" style="margin-top:14px">${esc(ruling.proposal.rationale)}</p>` : ""}
      <p class="muted small" style="margin-top:14px">Nothing was retired and nothing was paid. A
      retirement burns a credit permanently, so it is an operator action behind an explicit
      opt-in — and the code path this ruling used cannot sign at all.</p>
    </div>`;
    renderBudget(ruling.budget);
  } catch (error) {
    showError(out, error);
    if (error.body?.budget) renderBudget(error.body.budget);
  } finally {
    button.disabled = false;
  }
}

/* ─────────────────────────── replay section ───────────────────────────── */

$("replay-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const out = $("replay-result");
  out.innerHTML = `<p class="muted">reading the registry…</p>`;

  try {
    const record = await api(`/api/replay/${encodeURIComponent($("replay-token").value)}`);

    const commitments = record.commitments
      .map(
        (c) => `<tr>
          <td class="mono">${esc(c.field)}</td>
          <td class="mono">${c.recorded ? esc(c.value) : '<span class="muted">not recorded</span>'}</td>
          <td class="muted small">${esc(c.means)}</td>
        </tr>`,
      )
      .join("");

    out.innerHTML = `<div class="verdict ${esc(String(record.verdict).toLowerCase())}">
      <div class="verdict-head">
        <span class="verdict-name">${esc(record.verdict)}</span>
        <span class="verdict-why">${
          record.exists
            ? esc(`token ${record.tokenId} is ${record.state}`)
            : esc(`token ${record.tokenId} has never been minted`)
        }</span>
      </div>
      ${factList([
        ["owner", record.owner ?? "none"],
        ["state", record.state],
        ["engine version", record.engineVersion || "none recorded"],
        ["attempt", record.attempt],
        ["submitted", record.submittedAt ?? "—"],
        ["activated", record.activatedAt ?? "—"],
      ])}
      <div class="scroll-x"><table>
        <thead><tr><th>commitment</th><th>value</th><th>what it commits to</th></tr></thead>
        <tbody>${commitments}</tbody>
      </table></div>
      <details>
        <summary>Read the same record without this server</summary>
        <pre>${record.reproduce.map(esc).join("\n\n")}</pre>
      </details>
    </div>`;
  } catch (error) {
    showError(out, error);
  }
});

/* ───────────────────────────── budget line ───────────────────────────── */

function renderBudget(budget) {
  if (!budget) return;
  $("honesty-budget").innerHTML =
    `<strong>Budget now:</strong> ${esc(budget.callsUsed)} of ` +
    `${esc(budget.callsUsed + budget.callsRemaining)} served model calls used, ` +
    `about $${esc(budget.spentUsdEstimate)} at list price. Ledger ` +
    `<span class="mono">${esc(budget.ledger)}</span>.`;
}

async function loadBudget() {
  try {
    renderBudget(await api("/api/budget"));
  } catch (error) {
    $("honesty-budget").textContent = `budget unavailable: ${error.message}`;
  }
}

/* Chain reads happen on load; nothing that costs money runs unasked. */
loadState();
loadGuarantee();
loadFulfilment();
loadBudget();
