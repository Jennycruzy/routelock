"use strict";

const $ = (id) => document.getElementById(id);
const BASE_PATH = String(window.ROUTELOCK_BASE_PATH || "/botchain").replace(/\/$/, "");
const BOT_CHAIN = {
  name: "BOT Chain Mainnet",
  chainIdHex: "0x2a5",
  rpcUrl: "https://rpc.botchain.ai",
  explorer: "https://scan.botchain.ai",
};

let walletProvider = null;
let walletAccount = null;
let modalReturnFocus = null;
let contracts = {};
let offerings = [];
let busy = false;
let permissionlessIssuers = null;
let selectedOffer = null;
let checkoutDraft = null;
let trackedOrder = null;
const attachedProviders = new WeakSet();
const PURCHASE_EVENT_TOPIC = "0x7ed2fd813ad925b4ecdca41043f705ad97a7817ee8c397a41e766532441d4078";
const ORDER_STORAGE_KEY = "routelock:botchain:compute-orders";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function shortAddress(address) {
  const value = String(address ?? "");
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function transactionLink(hash) {
  return `${BOT_CHAIN.explorer}/tx/${encodeURIComponent(hash)}`;
}

function readSavedOrders() {
  try { return JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || "[]"); } catch { return []; }
}

function saveOrder(order) {
  const orders = readSavedOrders().filter((item) => item.tokenId !== order.tokenId);
  orders.unshift(order);
  localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(orders.slice(0, 20)));
}

async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function providers() {
  const injected = window.ethereum;
  if (!injected) return [];
  return Array.isArray(injected.providers) ? injected.providers : [injected];
}

function providerFor(kind) {
  const list = providers();
  if (kind === "okx") {
    return window.okxwallet || list.find((provider) => provider.isOkxWallet || provider.isOKExWallet) || null;
  }
  return list.find((provider) => provider.isMetaMask && !provider.isOkxWallet && !provider.isOKExWallet) || list[0] || null;
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE_PATH}${path}`, { ...options, headers, cache: "no-store" });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function openWalletModal() {
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("wallet-modal").hidden = false;
  $("wallet-modal-message").textContent = "";
  requestAnimationFrame(() => $("wallet-close")?.focus());
}

function closeWalletModal() {
  $("wallet-modal").hidden = true;
  if (modalReturnFocus) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function updateWalletUi(chainIdHex) {
  const walletButton = $("wallet-button");
  const status = $("wallet-status");
  const connected = walletAccount !== null;
  if (walletButton) {
    walletButton.innerHTML = connected
      ? `${esc(shortAddress(walletAccount))} <span aria-hidden="true">⌄</span>`
      : "Connect wallet <span aria-hidden=\"true\">↗</span>";
  }
  if (!status) return;
  if (!connected) {
    status.innerHTML = `<span class="check-circle">✓</span> Connect your wallet to buy or provide compute.`;
    return;
  }
  const matches = String(chainIdHex || "").toLowerCase() === BOT_CHAIN.chainIdHex;
  status.innerHTML = matches
    ? `<span class="check-circle connected">✓</span> Ready on ${esc(BOT_CHAIN.name)} as <span class="wallet-address">${esc(shortAddress(walletAccount))}</span>.`
    : `<span class="check-circle warning">!</span> Your wallet is connected. Switch it to ${esc(BOT_CHAIN.name)} to continue.`;
}

async function walletChainId() {
  return walletProvider ? walletProvider.request({ method: "eth_chainId" }) : null;
}

async function switchToBotChain() {
  if (!walletProvider) return;
  try {
    await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BOT_CHAIN.chainIdHex }] });
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const unknownChain = error?.code === 4902 || error?.code === -32602 ||
      message.includes("unrecognized chain") || message.includes("unknown chain") ||
      message.includes("chain has not been added") || message.includes("try adding the chain");
    if (!unknownChain) throw error;
    await walletProvider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: BOT_CHAIN.chainIdHex,
        chainName: BOT_CHAIN.name,
        nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
        rpcUrls: [BOT_CHAIN.rpcUrl],
        blockExplorerUrls: [BOT_CHAIN.explorer],
      }],
    });
    await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BOT_CHAIN.chainIdHex }] });
  }
}

function attachProvider(provider) {
  if (!provider?.on || attachedProviders.has(provider)) return;
  attachedProviders.add(provider);
  provider.on("accountsChanged", (accounts) => {
    walletAccount = accounts?.[0] ?? null;
    void walletChainId().then((chainId) => updateWalletUi(chainId));
  });
  provider.on("chainChanged", (chainId) => updateWalletUi(chainId));
}

async function connectWallet(kind) {
  const provider = providerFor(kind);
  const message = $("wallet-modal-message");
  if (!provider) {
    message.textContent = `${kind === "okx" ? "OKX Wallet" : "MetaMask"} was not found in this browser.`;
    return;
  }
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    walletProvider = provider;
    walletAccount = accounts?.[0] ?? null;
    attachProvider(provider);
    await switchToBotChain();
    updateWalletUi(await walletChainId());
    closeWalletModal();
  } catch (error) {
    message.textContent = error?.code === 4001 ? "Wallet request canceled." : (error?.message || "Wallet connection failed.");
  }
}

async function restoreWallet() {
  const provider = providerFor("metamask") || providerFor("okx");
  if (!provider) return;
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    if (!accounts?.[0]) return;
    walletProvider = provider;
    walletAccount = accounts[0];
    attachProvider(provider);
    updateWalletUi(await walletChainId());
  } catch {
    // A locked wallet is normal. The explicit connect button remains available.
  }
}

function formatAtomic(value, decimals = 6) {
  const raw = BigInt(value).toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals) || "0";
  const fraction = raw.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function decimalAtomic(value, decimals = 6) {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error("Enter a valid amount.");
  const [wholePart, fractionPart = ""] = text.split(".");
  if (fractionPart.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const whole = wholePart || "0";
  const fraction = fractionPart.padEnd(decimals, "0");
  return BigInt(`${whole}${fraction}`);
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error("The connected wallet address is invalid.");
  return String(address).slice(2).toLowerCase().padStart(64, "0");
}

function bytes32Word(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value))) throw new Error("The offer id is invalid.");
  return String(value).slice(2).toLowerCase();
}

function calldata(selector, ...words) {
  return `${selector}${words.join("")}`;
}

function contract(name) {
  const address = contracts[name];
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) {
    throw new Error("BOT Chain contract addresses are not available yet. Reload the page and try again.");
  }
  return address;
}

async function ensureBotWallet() {
  if (!walletProvider || !walletAccount) {
    openWalletModal();
    throw new Error("Connect your wallet first.");
  }
  const current = await walletChainId();
  if (String(current || "").toLowerCase() !== BOT_CHAIN.chainIdHex) await switchToBotChain();
  const finalChain = await walletChainId();
  updateWalletUi(finalChain);
  if (String(finalChain || "").toLowerCase() !== BOT_CHAIN.chainIdHex) {
    throw new Error("Your wallet must be on BOT Chain Mainnet (677) before continuing.");
  }
  return walletAccount;
}

function setMessage(id, text, error = false) {
  const element = $(id);
  if (!element) return;
  element.classList.toggle("error", error);
  element.textContent = text;
}

function updateProviderAvailability() {
  const button = $("provider-publish");
  if (permissionlessIssuers === false) {
    if (button) button.disabled = true;
    setMessage("provider-message", "Provider publishing is not open on the current BOT deployment yet. The factory must be redeployed with open provider onboarding before any wallet can publish.", true);
  } else if (permissionlessIssuers === true) {
    if (button && !busy) button.disabled = false;
    setMessage("provider-message", "Anyone can publish from a BOT Chain wallet.");
  }
}

async function waitForReceipt(hash) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const receipt = await walletProvider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      if (String(receipt.status).toLowerCase() === "0x0") throw new Error("The BOT Chain transaction reverted.");
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The transaction is taking too long to confirm. Check it on BOT Chain Scan.");
}

async function sendWalletTransaction(to, data, label, messageId) {
  setMessage(messageId, `${label}: confirm the transaction in your wallet.`);
  const hash = await walletProvider.request({
    method: "eth_sendTransaction",
    params: [{ from: walletAccount, to, data }],
  });
  setMessage(messageId, `${label}: waiting for BOT Chain confirmation…`);
  await waitForReceipt(hash);
  return hash;
}

async function readAllowance(token, owner, spender) {
  const data = calldata("0xdd62ed3e", addressWord(owner), addressWord(spender));
  const result = await walletProvider.request({ method: "eth_call", params: [{ to: token, data }, "latest"] });
  return BigInt(result || "0x0");
}

async function approveIfNeeded(token, spender, amount, label, messageId) {
  if (amount === 0n) return null;
  const allowance = await readAllowance(token, walletAccount, spender);
  if (allowance >= amount) return null;
  return sendWalletTransaction(token, calldata("0x095ea7b3", addressWord(spender), word(amount)), label, messageId);
}

function plainAvailabilityReason(offer) {
  if (Number(offer.remainingSupply || 0) === 0) return "No jobs remain on this offer.";
  if (offer.paused) return "This offer is paused by its provider.";
  if (offer.validUntil && new Date(offer.validUntil).getTime() < Date.now()) return "This offer has expired.";
  return "This offer cannot accept a new job yet.";
}

function shortDate(value) {
  if (!value) return "Open-ended";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Active" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function renderOfferings() {
  const target = $("buyer-offers");
  if (!target) return;
  if (offerings.length === 0) {
    target.innerHTML = `<div class="service-empty"><span class="service-label">NO LIVE OFFERS YET</span><strong>Providers will appear here as on-chain services.</strong><p>Switch to the provider path to publish the first backed service.</p></div>`;
    return;
  }
  target.innerHTML = offerings.map((offer, index) => {
    const available = offer.available === true;
    const price = esc(offer.price || formatAtomic(offer.priceAtomic || "0"));
    const remaining = Number(offer.remainingSupply || 0);
    const state = available ? `Available · ${remaining} job${remaining === 1 ? "" : "s"} open` : plainAvailabilityReason(offer);
    const serviceName = esc(offer.label || "Provider-backed compute service");
    const backing = offer.backed === true ? "Backed" : "Needs backing";
    return `<article class="service-card${available ? "" : " unavailable"}">
      <div class="service-card-top"><span class="service-card-index">SERVICE 0${index + 1}</span><span class="service-card-status">${available ? "AVAILABLE NOW" : "CLOSED"}</span></div>
      <h3>${serviceName}</h3>
      <p class="service-card-description">A provider-backed compute job. The workload is executed by the provider path; the service entitlement and payment record live on BOT Chain 677.</p>
      <p class="service-card-price">${price} <small>USDT per job</small></p>
      <div class="service-card-facts">
        <div class="service-card-fact"><span>Jobs open</span><strong>${esc(String(remaining))}</strong></div>
        <div class="service-card-fact"><span>Security</span><strong>${esc(backing)}</strong></div>
        <div class="service-card-fact"><span>Provider</span><strong>${esc(shortAddress(offer.issuer))}</strong></div>
      </div>
      ${available
        ? `<button class="button button-dark" type="button" data-offering-index="${index}">Choose this service <span aria-hidden="true">↗</span></button>`
        : `<p class="service-card-note">${esc(state)}</p>`}
      <details class="service-card-details"><summary>What happens after I choose it?</summary><p>Your wallet approves the payment to the escrow and mints the service entitlement. The provider path then supplies the execution proof used for settlement.</p></details>
    </article>`;
  }).join("");
  target.querySelectorAll("[data-offering-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const offer = offerings[Number(button.dataset.offeringIndex)];
      if (offer) openCheckout(offer);
    });
  });
}

function checkoutStep(step) {
  const order = ["configure", "review", "purchase", "track"];
  const current = order.indexOf(step);
  document.querySelectorAll("[data-checkout-step]").forEach((item) => {
    const index = order.indexOf(item.dataset.checkoutStep);
    item.classList.toggle("active", index === current);
    item.classList.toggle("complete", index < current);
  });
  $("buyer-configure").hidden = step !== "configure";
  $("buyer-review").hidden = step !== "review";
  $("buyer-purchase").hidden = step !== "purchase";
  $("buyer-track").hidden = step !== "track";
}

function openCheckout(offer) {
  selectedOffer = offer;
  checkoutDraft = null;
  trackedOrder = null;
  $("buyer-checkout").hidden = false;
  $("checkout-offer").innerHTML = `<span><strong>${esc(offer.label || "Compute service")}</strong><br>${esc(shortAddress(offer.issuer))}</span><span><strong>${esc(offer.price || formatAtomic(offer.priceAtomic || "0"))} USDT</strong><br>one job</span>`;
  $("buyer-job-name").value = "";
  $("buyer-workload").value = "";
  $("buyer-output").value = "";
  $("buyer-input-ref").value = "";
  checkoutStep("configure");
  requestAnimationFrame(() => $("buyer-checkout").scrollIntoView({ behavior: "smooth", block: "start" }));
}

function closeCheckout() {
  $("buyer-checkout").hidden = true;
  selectedOffer = null;
  checkoutDraft = null;
}

function reviewCheckout(event) {
  event.preventDefault();
  if (!selectedOffer) return;
  checkoutDraft = {
    jobName: $("buyer-job-name").value.trim(),
    workload: $("buyer-workload").value.trim(),
    output: $("buyer-output").value.trim(),
    inputRef: $("buyer-input-ref").value.trim(),
  };
  if (!checkoutDraft.jobName || !checkoutDraft.workload || !checkoutDraft.output) return;
  $("checkout-review-content").innerHTML = `
    <div><span>Service</span><strong>${esc(selectedOffer.label || "Compute service")} · ${esc(selectedOffer.price || formatAtomic(selectedOffer.priceAtomic || "0"))} USDT</strong></div>
    <div><span>Job name</span><strong>${esc(checkoutDraft.jobName)}</strong></div>
    <div><span>Workload</span><p>${esc(checkoutDraft.workload)}</p></div>
    <div><span>Required output</span><p>${esc(checkoutDraft.output)}</p></div>
    ${checkoutDraft.inputRef ? `<div><span>Input reference</span><p>${esc(checkoutDraft.inputRef)}</p></div>` : ""}`;
  checkoutStep("review");
}

function tokenIdFromReceipt(receipt, offer) {
  const factory = contract("entitlementFactory").toLowerCase();
  const classTopic = String(offer.classId).toLowerCase();
  const log = (receipt.logs || []).find((item) =>
    String(item.address || "").toLowerCase() === factory &&
    String(item.topics?.[0] || "").toLowerCase() === PURCHASE_EVENT_TOPIC &&
    String(item.topics?.[1] || "").toLowerCase() === classTopic
  );
  if (!log?.topics?.[2]) throw new Error("Purchase confirmed, but the entitlement ID could not be read from the receipt.");
  return BigInt(log.topics[2]).toString();
}

function purchaseProgress(title, detail) {
  $("purchase-title").textContent = title;
  $("purchase-detail").textContent = detail;
}

async function trackOrder(order = trackedOrder) {
  if (!order) return;
  trackedOrder = order;
  checkoutStep("track");
  $("track-transaction").href = transactionLink(order.purchaseTx);
  $("track-summary").innerHTML = `<h4>${esc(order.jobName)}</h4><p>Entitlement #${esc(order.tokenId)} · Request commitment ${esc(shortAddress(order.requestHash))}</p>`;
  try {
    const replay = await api(`/api/replay/${encodeURIComponent(order.tokenId)}`);
    const proofRecorded = Array.isArray(replay.commitments) && replay.commitments.some((item) => item.field === "carrierRefHash" && item.recorded);
    const stages = [
      [true, "Purchased", `Entitlement #${order.tokenId} is owned by ${shortAddress(replay.owner || walletAccount)}.`],
      [replay.submittedAt !== null, "Request submitted", replay.submittedAt ? `Specification hash recorded ${new Date(replay.submittedAt).toLocaleString()}.` : "Waiting for the request commitment."],
      [replay.verdict !== "NONE" && replay.verdict !== "None", "AI policy decision", replay.verdict && replay.verdict !== "NONE" ? `${replay.verdict}${replay.engineVersion ? ` · ${replay.engineVersion}` : ""}` : "Waiting for compliance review."],
      [proofRecorded, "Provider execution", proofRecorded ? "Provider evidence is committed on BOT Chain." : "Waiting for the provider workload and proof."],
      [String(replay.state).toLowerCase().includes("delivered"), "Completed", `Current on-chain state: ${replay.state}.`],
    ];
    const firstOpen = stages.findIndex(([complete]) => !complete);
    $("track-timeline").innerHTML = stages.map(([complete, title, detail], index) => `<div class="track-event ${complete ? "complete" : index === firstOpen ? "active" : ""}"><i>${complete ? "✓" : index + 1}</i><div><strong>${esc(title)}</strong><p>${esc(detail)}</p></div></div>`).join("");
  } catch (error) {
    $("track-timeline").innerHTML = `<p class="workspace-message error">Status could not be refreshed. ${esc(error?.message || "Try again.")}</p>`;
  }
}

async function loadOfferings() {
  const target = $("buyer-offers");
  try {
    const data = await api("/api/consumer/catalog");
    offerings = Array.isArray(data.offerings) ? data.offerings.filter((offer) => offer.vertical === "compute") : [];
    if (data.capabilities?.contracts) contracts = data.capabilities.contracts;
    renderOfferings();
  } catch (error) {
    if (target) target.innerHTML = `<p class="workspace-message error">Provider offers could not be loaded. ${esc(error?.message || "Try again.")}</p>`;
  }
}

async function loadCapabilities() {
  const capability = $("compute-capability");
  const state = $("execution-state");
  const ingress = $("live-ingress");
  const detail = $("ingress-detail");
  const settings = $("settings-state");
  try {
    const data = await api("/api/consumer/capabilities");
    contracts = data.contracts || {};
    const compute = data.compute || {};
    const computeLane = data.lanes?.compute || {};
    const proofUrls = Array.isArray(compute.proofUrls) ? compute.proofUrls : computeLane.proofUrls;
    const proofUrl = Array.isArray(proofUrls) ? proofUrls[0] : null;
    const active = compute.active === true && typeof proofUrl === "string" && proofUrl.startsWith("https://");
    if (state) state.textContent = active ? "ACTIVE" : "NOT READY";
    if (capability) {
      capability.className = `consumer-capability ${active ? "ready" : "warning"}`;
      capability.innerHTML = active
        ? `<span class="status-dot live"></span> <strong>Current compute is live.</strong> The workload runs at the Akash provider link below.`
        : `<span class="status-dot testing"></span> <strong>Current compute is not ready.</strong> ${esc(compute.reason || "There is no active workload yet.")}`;
    }
    if (active) {
      ingress.href = proofUrl;
      ingress.classList.remove("is-disabled");
      ingress.removeAttribute("aria-disabled");
      detail.innerHTML = `Live provider link: <a class="order-link" href="${esc(proofUrl)}" target="_blank" rel="noreferrer">${esc(proofUrl)}</a>`;
    } else {
      ingress.removeAttribute("href");
      ingress.classList.add("is-disabled");
      ingress.setAttribute("aria-disabled", "true");
      detail.textContent = "No live provider link is available yet.";
    }
    if (settings) settings.textContent = compute.providerConfigured === true
      ? "Provider setup is ready for another Akash run."
      : `A new provider run is not configured. ${compute.missingConfiguration?.length ? `Missing: ${compute.missingConfiguration.join(", ")}.` : "The current proof can still be opened above."}`;
    try {
      const merchant = await api("/api/merchant/capabilities");
      permissionlessIssuers = merchant.permissionlessIssuers === true;
      updateProviderAvailability();
    } catch {
      permissionlessIssuers = false;
      updateProviderAvailability();
    }
  } catch (error) {
    if (state) state.textContent = "UNAVAILABLE";
    if (capability) {
      capability.className = "consumer-capability warning";
      capability.innerHTML = `<span class="status-dot testing"></span> <strong>Compute status could not be read.</strong> ${esc(error?.message || "Try again.")}`;
    }
    if (detail) detail.textContent = "The live provider link could not be loaded.";
    if (settings) settings.textContent = "Provider setup could not be read.";
  }
  await loadOfferings();
}

async function buyCompute(offer = selectedOffer) {
  if (busy) return;
  busy = true;
  const messageId = "buyer-message";
  try {
    if (!offer || !checkoutDraft) throw new Error("Configure and review the compute request first.");
    if (!offer.available) throw new Error(plainAvailabilityReason(offer));
    await ensureBotWallet();
    checkoutStep("purchase");
    purchaseProgress("Preparing your request…", "RouteLock is hashing the workload specification before payment.");
    const canonicalRequest = JSON.stringify({ version: 1, classId: offer.classId, buyer: walletAccount.toLowerCase(), ...checkoutDraft });
    const requestHash = await hashText(canonicalRequest);
    const evidenceHash = await hashText(JSON.stringify({ inputRef: checkoutDraft.inputRef || null, requiredOutput: checkoutDraft.output }));
    const token = offer.settlementToken || contract("settlementToken");
    const escrow = contract("settlementEscrow");
    const factory = contract("entitlementFactory");
    const price = BigInt(offer.priceAtomic || "0");
    purchaseProgress("Approve the service payment…", `${formatAtomic(price)} USDT will move directly into RouteLock escrow.`);
    await approveIfNeeded(token, escrow, price, "Payment approval", messageId);
    purchaseProgress("Purchase the entitlement…", "Confirm the BOT Chain transaction in your wallet.");
    const hash = await sendWalletTransaction(
      factory,
      calldata("0x293c6a3a", bytes32Word(offer.classId), addressWord(walletAccount)),
      "Purchase",
      messageId,
    );
    const receipt = await walletProvider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    const tokenId = tokenIdFromReceipt(receipt, offer);
    purchaseProgress("Submit the workload commitment…", `Entitlement #${tokenId} is minted. Confirm the request hash transaction.`);
    const submitHash = await sendWalletTransaction(
      contract("activationRegistry"),
      calldata("0x0086aa36", word(tokenId), bytes32Word(requestHash), bytes32Word(evidenceHash)),
      "Submit request",
      messageId,
    );
    trackedOrder = { tokenId, classId: offer.classId, jobName: checkoutDraft.jobName, requestHash, evidenceHash, purchaseTx: hash, submitTx: submitHash, createdAt: new Date().toISOString() };
    saveOrder(trackedOrder);
    await trackOrder(trackedOrder);
    $(messageId).innerHTML = `Compute request submitted as entitlement #${esc(tokenId)}. <a class="order-link" href="${transactionLink(submitHash)}" target="_blank" rel="noreferrer">View request transaction ↗</a>`;
    await loadOfferings();
  } catch (error) {
    setMessage(messageId, error?.message || "The purchase could not be completed.", true);
    if ($("buyer-checkout") && !$("buyer-checkout").hidden) checkoutStep(checkoutDraft ? "review" : "configure");
  } finally {
    busy = false;
  }
}

async function publishProviderOffer(event) {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = $("provider-publish");
  const messageId = "provider-message";
  if (button) button.disabled = true;
  try {
    if (permissionlessIssuers !== true) {
      throw new Error("Provider publishing is not open on the current BOT deployment. A permissionless factory deployment is required.");
    }
    await ensureBotWallet();
    const label = $("provider-label").value.trim();
    const terms = $("provider-terms").value.trim();
    if (!label || !terms) throw new Error("Add an offer name and describe what you can run.");
    const price = decimalAtomic($("provider-price").value);
    const payout = decimalAtomic($("provider-payout").value);
    const collateral = decimalAtomic($("provider-collateral").value);
    const supplyText = $("provider-supply").value.trim();
    const daysText = $("provider-days").value.trim();
    if (!/^\d+$/.test(supplyText) || Number(supplyText) < 1 || Number(supplyText) > 4294967295) {
      throw new Error("Available jobs must be a whole number between 1 and 4,294,967,295.");
    }
    if (!/^\d+$/.test(daysText) || Number(daysText) < 1 || Number(daysText) > 3650) {
      throw new Error("Offer duration must be between 1 and 3,650 days.");
    }
    const supply = BigInt(supplyText);
    const days = BigInt(daysText);
    if (collateral < payout * supply) throw new Error("Collateral must cover the provider payout for every job you list.");
    const draft = await api("/api/merchant/draft", {
      method: "POST",
      body: JSON.stringify({ label, terms, issuer: walletAccount }),
    });
    const validUntil = BigInt(Math.floor(Date.now() / 1000)) + days * 86400n;
    const token = contract("settlementToken");
    const escrow = contract("settlementEscrow");
    const factory = contract("entitlementFactory");
    const createHash = await sendWalletTransaction(
      factory,
      calldata(
        "0x0826d4eb",
        bytes32Word(draft.classId),
        bytes32Word(draft.termsHash),
        addressWord(token),
        word(price),
        word(payout),
        word(validUntil),
        word(supply),
      ),
      "Publish offer",
      messageId,
    );
    if (collateral > 0n) {
      await approveIfNeeded(token, escrow, collateral, "Collateral approval", messageId);
      await sendWalletTransaction(
        escrow,
        calldata("0x36fa1bec", bytes32Word(draft.classId), word(collateral)),
        "Lock collateral",
        messageId,
      );
    }
    let discoveryWarning = "";
    try {
      await api("/api/merchant/discover", {
        method: "POST",
        body: JSON.stringify({ classId: draft.classId }),
      });
    } catch (error) {
      discoveryWarning = ` The offer is on chain, but the list will update after a refresh (${error?.message || "discovery delayed"}).`;
    }
    $(messageId).innerHTML = `Offer published. Buyers can now find it and purchase a job.${esc(discoveryWarning)} <a class="order-link" href="${transactionLink(createHash)}" target="_blank" rel="noreferrer">View offer transaction ↗</a>`;
    await loadOfferings();
  } catch (error) {
    setMessage(messageId, error?.message || "The provider offer could not be published.", true);
  } finally {
    busy = false;
    if (button) button.disabled = permissionlessIssuers !== true;
  }
}

function showRoleEntry({ push = true } = {}) {
  $("role-entry").hidden = false;
  $("service-view").hidden = true;
  if (push) window.history.pushState({}, "", window.location.pathname);
}

function setRole(role, { push = true, scroll = true } = {}) {
  if (role !== "buyer" && role !== "provider") return;
  document.querySelectorAll("[data-role]").forEach((button) => {
    const active = button.dataset.role === role;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("role-entry").hidden = true;
  $("service-view").hidden = false;
  $("buyer-role").hidden = role !== "buyer";
  $("provider-role").hidden = role !== "provider";
  $("service-kicker").textContent = role === "buyer" ? "SERVICE CATALOG / CUSTOMERS" : "SERVICE PAGE / PROVIDERS";
  $("service-title").innerHTML = role === "buyer"
    ? "Choose a service.<br><em>Run the work.</em>"
    : "Publish a service.<br><em>Offer your capacity.</em>";
  $("service-intro").textContent = role === "buyer"
    ? "Every card below is a live provider offer read from BOT Chain Mainnet."
    : "Create a provider offer from this page. Your wallet signs the on-chain actions; RouteLock never takes custody.";
  if (push) window.history.pushState({}, "", `${window.location.pathname}?role=${role}`);
  if (scroll) requestAnimationFrame(() => $("service-view")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

$("wallet-button")?.addEventListener("click", openWalletModal);
$("provider-form")?.addEventListener("submit", (event) => void publishProviderOffer(event));
$("buyer-configure")?.addEventListener("submit", reviewCheckout);
$("checkout-close")?.addEventListener("click", closeCheckout);
$("checkout-edit")?.addEventListener("click", () => checkoutStep("configure"));
$("checkout-buy")?.addEventListener("click", () => void buyCompute());
$("track-refresh")?.addEventListener("click", () => void trackOrder());
$("wallet-close")?.addEventListener("click", closeWalletModal);
$("wallet-modal")?.addEventListener("click", (event) => {
  if (event.target === $("wallet-modal")) closeWalletModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("wallet-modal") && !$("wallet-modal").hidden) closeWalletModal();
});
document.querySelectorAll("[data-wallet-provider]").forEach((button) => {
  button.addEventListener("click", () => void connectWallet(button.dataset.walletProvider));
});
document.querySelectorAll("[data-role]").forEach((button) => {
  button.addEventListener("click", () => setRole(button.dataset.role, { push: true, scroll: true }));
});
$("back-to-roles")?.addEventListener("click", () => showRoleEntry({ push: true }));
window.addEventListener("popstate", () => {
  const role = new URLSearchParams(window.location.search).get("role");
  if (role === "buyer" || role === "provider") setRole(role, { push: false, scroll: false });
  else showRoleEntry({ push: false });
});
$("live-ingress")?.addEventListener("click", (event) => {
  if ($("live-ingress").getAttribute("aria-disabled") === "true") event.preventDefault();
});

updateWalletUi();
const initialRole = new URLSearchParams(window.location.search).get("role");
if (initialRole === "buyer" || initialRole === "provider") setRole(initialRole, { push: false, scroll: false });
else showRoleEntry({ push: false });
updateProviderAvailability();
void restoreWallet();
void loadCapabilities();
