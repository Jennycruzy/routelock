/* RouteLock's small consumer surface.
 *
 * The browser owns the consumer's wallet actions. The API never receives a
 * private key or a payment signature until the wallet has explicitly produced
 * it here; every provider and role action remains behind the API's capability
 * gate.
 */

"use strict";

const $ = (id) => document.getElementById(id);

const NETWORKS = {
  xlayer_mainnet: {
    group: "xlayer",
    name: "X Layer Mainnet",
    shortName: "X Layer",
    chainId: 196,
    chainIdHex: "0xc4",
    rpcUrl: "https://rpc.xlayer.tech",
    explorer: "https://www.oklink.com/xlayer",
    settlement: "USD₮0",
    settlementDecimals: 6,
    contracts: {
      // Fresh Aave-enabled, permissionless X Layer deployment. These values
      // are only the safe first paint; the API deployment is still authoritative
      // once capabilities load.
      entitlementFactory: "0x31D6803f22B5447cd862bF3f108160f7aDb326ba",
      serviceEntitlement: "0x105BAF5638fD84a1CADfF695498288BE20362293",
      settlementEscrow: "0x8e7bB4133F73ae04e006116f0Fc7479A4Fe9030d",
      activationRegistry: "0xaA251a902B699935DfE0e6F784C6dB49043fcCd2",
      settlementToken: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      aaveYieldAdapter: "0x78694f4DE40B6E443f70F0E1E204833Be6D28143",
    },
  },
};

// This bundle belongs only to the X Layer carbon build.
let selectedNetwork = "xlayer_mainnet";
let walletProvider = null;
let walletAccount = null;
let modalReturnFocus = null;
let pendingService = null;
let consumerCapabilities = null;
let consumerCatalog = null;
let carbonInventory = null;
let consumerOrder = null;
let consumerBusy = false;
let consumerRefreshGeneration = 0;
const runtimeContracts = new Map();
const merchantOfferings = new Map();
let merchantBusy = false;
let merchantPermissionless = false;
const activeServiceRoles = { xlayer: "buyer" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function shortAddress(address) {
  const value = String(address ?? "");
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
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

function selected() {
  return NETWORKS[selectedNetwork];
}

// The static addresses are the safe first paint. Once the API has read the
// selected deployment, wallet writes must use that deployment's addresses too.
// This matters after the strategy-aware X Layer redeploy: the old escrow cannot
// be upgraded, so continuing to use these hardcoded addresses would make the
// Aave controls appear live while sending transactions to the old raw escrow.
function networkContracts(networkKey = selectedNetwork) {
  const network = NETWORKS[networkKey];
  if (!network?.contracts) return network?.contracts || null;
  const apiChain = consumerCapabilities?.chain;
  const apiContracts = consumerCapabilities?.contracts;
  const matchingConsumerContracts = apiChain && Number(apiChain.id) === network.chainId ? apiContracts : null;
  return { ...network.contracts, ...(runtimeContracts.get(networkKey) || {}), ...(matchingConsumerContracts || {}) };
}

function rememberRuntimeContracts(capabilities) {
  const chainId = Number(capabilities?.chain?.id ?? capabilities?.chainId);
  const key = chainKeyForId(chainId);
  const contracts = capabilities?.contracts;
  if (key && contracts && typeof contracts === "object") {
    runtimeContracts.set(key, { ...(runtimeContracts.get(key) || {}), ...contracts });
  }
}

function setMessage(message, target = $("network-message")) {
  if (target) target.textContent = message;
}

function updateSelection(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) return;
  selectedNetwork = networkKey;

  document.querySelectorAll(".network-choice").forEach((button) => {
    const active = button.dataset.network === networkKey;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });

  document.querySelectorAll("[data-select-network]").forEach((button) => {
    const active = button.dataset.selectNetwork === networkKey;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  document.querySelectorAll("[data-network-card]").forEach((card) => {
    card.classList.toggle("active", card.dataset.networkCard === "xlayer");
    const connect = card.querySelector("[data-connect-network]");
    if (connect) {
      connect.dataset.connectNetwork = networkKey;
      connect.innerHTML = `Open carbon retirement <span aria-hidden="true">↗</span>`;
    }
  });

  $("current-network").textContent = "Carbon retirement";
  updateServiceButtonLabels();
}

function updateServiceButtonLabels() {
  document.querySelectorAll("[data-connect-network]").forEach((button) => {
    button.innerHTML = "Open carbon retirement <span aria-hidden=\"true\">↗</span>";
  });
}

function showLanding() {
  document.querySelectorAll(".landing-view").forEach((element) => { element.hidden = false; });
  document.querySelectorAll(".service-view").forEach((element) => { element.hidden = true; });
}

function showServiceView(service) {
  if (service !== "xlayer") return;
  const view = $("xlayer-view");
  if (!view) return;
  document.querySelectorAll(".landing-view").forEach((element) => { element.hidden = true; });
  document.querySelectorAll(".service-view").forEach((element) => { element.hidden = element !== view; });
  view.hidden = false;
  setServiceRole("xlayer", activeServiceRoles.xlayer || "buyer");
  void loadMerchantData();
  requestAnimationFrame(() => view.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function openServiceView(service, networkKey) {
  if (service !== "xlayer") return;
  updateSelection(networkKey || "xlayer_mainnet");
  if (location.hash !== "#xlayer") location.hash = "xlayer";
  else showServiceView("xlayer");
}

function routeFromHash() {
  const hash = location.hash.replace(/^#/, "");
  if (hash === "xlayer") showServiceView(hash);
  else showLanding();
}

function setServiceRole(service, role) {
  if (service !== "xlayer") return;
  activeServiceRoles[service] = role === "merchant" ? "merchant" : "buyer";
  document.querySelectorAll(`[data-service-role="${service}"]`).forEach((button) => {
    const active = button.dataset.role === activeServiceRoles[service];
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  // Only role panels are toggled here. The service section itself remains
  // visible while the buyer/provider surface changes.
  document.querySelectorAll(`#${service}-buyer-view, #${service}-merchant-view`).forEach((element) => {
    element.hidden = element.id !== `${service}-${activeServiceRoles[service]}-view`;
  });
  if (service === "xlayer" && role === "merchant") void loadMerchantData();
}

function openWalletModal(networkKey = selectedNetwork) {
  updateSelection(networkKey);
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("wallet-modal").hidden = false;
  $("wallet-modal-message").textContent = "";
  requestAnimationFrame(() => $("wallet-close").focus());
}

function closeWalletModal() {
  $("wallet-modal").hidden = true;
  if (modalReturnFocus) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function updateWalletUi(chainIdHex) {
  const walletButton = $("wallet-button");
  const status = $("wallet-status");
  const network = selected();
  const matches = chainIdHex && chainIdHex.toLowerCase() === network.chainIdHex;

  walletButton.innerHTML = walletAccount
    ? `${esc(shortAddress(walletAccount))} <span aria-hidden="true">⌄</span>`
    : "Connect wallet <span aria-hidden=\"true\">↗</span>";
  updateServiceButtonLabels();

  if (!walletAccount) {
    status.innerHTML = `<span class="check-circle">✓</span> Your wallet is not connected.`;
    return;
  }

  status.innerHTML = matches
    ? `<span class="check-circle connected">✓</span> Connected to ${esc(network.name)} as <span class="wallet-address">${esc(shortAddress(walletAccount))}</span>.`
    : `<span class="check-circle warning">!</span> Connected, but your wallet is on another network. <button class="inline-switch" type="button" data-switch-network="${esc(selectedNetwork)}">Switch to ${esc(network.name)}</button>`;

  const switchButton = status.querySelector("[data-switch-network]");
  if (switchButton) switchButton.addEventListener("click", () => switchNetwork(selectedNetwork));
}

async function walletChainId() {
  if (!walletProvider) return null;
  return walletProvider.request({ method: "eth_chainId" });
}

async function switchNetwork(networkKey) {
  const network = NETWORKS[networkKey];
  if (!walletProvider) {
    openWalletModal(networkKey);
    return;
  }

  updateSelection(networkKey);
  try {
    await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: network.chainIdHex }] });
    setMessage("You are ready to start carbon retirement.");
    updateWalletUi(await walletChainId());
  } catch (error) {
    // EIP-1193 code 4902 means the wallet knows the request but not the chain.
    if (error?.code === 4902) {
      try {
        await walletProvider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: network.chainIdHex,
            chainName: network.name,
            nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
            rpcUrls: [network.rpcUrl],
            blockExplorerUrls: [network.explorer],
          }],
        });
        setMessage("Live X Layer was added. You are ready to start carbon retirement.");
        updateWalletUi(await walletChainId());
        return;
      } catch (addError) {
        setMessage(addError?.message || `Could not add ${network.name}.`, $("wallet-modal-message"));
        return;
      }
    }
    if (error?.code !== 4001) setMessage(error?.message || `Could not switch to ${network.name}.`);
  }
}

function attachProvider(provider) {
  if (!provider?.on) return;
  provider.on("accountsChanged", (accounts) => {
    walletAccount = accounts?.[0] ?? null;
    void walletChainId().then((chainId) => updateWalletUi(chainId));
  });
  provider.on("chainChanged", (chainId) => {
    updateWalletUi(chainId);
  });
}

async function connectWallet(kind) {
  const provider = providerFor(kind);
  const message = $("wallet-modal-message");
  if (!provider) {
    const label = kind === "okx" ? "OKX Wallet" : "MetaMask";
    message.innerHTML = `${label} was not found in this browser. Install it, then try again.`;
    return;
  }

  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    walletProvider = provider;
    walletAccount = accounts?.[0] ?? null;
    attachProvider(provider);
    await switchNetwork(selectedNetwork);
    updateWalletUi(await walletChainId());
    closeWalletModal();
    if (pendingService !== null) {
      const service = pendingService;
      pendingService = null;
      openServiceView(service);
    }
    void loadMerchantData();
  } catch (error) {
    if (error?.code !== 4001) message.textContent = error?.message || "Wallet connection failed.";
  }
}

async function api(path, options = {}) {
  const endpoint = path || "/";
  const response = await fetch(endpoint, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`${endpoint} answered ${response.status}`); }
  if (!response.ok) throw new Error(body.error || `${endpoint} answered ${response.status}`);
  return body;
}

function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function chainKeyForId(chainId) {
  return Object.keys(NETWORKS).find((key) => NETWORKS[key].chainId === Number(chainId)) || null;
}

function word(value) {
  const hex = String(value).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 64) throw new Error("invalid contract argument");
  return hex.padStart(64, "0").toLowerCase();
}

function addressWord(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error("invalid contract address");
  return word(String(address));
}

function bytes32Word(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value))) throw new Error("expected a bytes32 commitment");
  return word(String(value));
}

function uintWord(value) {
  const number = BigInt(value);
  if (number < 0n) throw new Error("contract integer cannot be negative");
  return word(number.toString(16));
}

function calldata(selector, ...args) {
  return `${selector}${args.join("")}`;
}

async function ensureConsumerWallet() {
  if (!walletProvider || !walletAccount) throw new Error("connect your wallet before starting a carbon retirement");
  const carbon = consumerCapabilities?.carbon;
  if (carbon?.checkoutEnabled !== true) {
    throw new Error("The live carbon service is not ready for a purchase right now. Choose Live X Layer and try again.");
  }
  const chain = consumerChain();
  if (!chain) throw new Error("the API has not reported its selected chain");
  const chainKey = chainKeyForId(chain.id);
  if (!chainKey) throw new Error(`the API selected an unsupported chain (${chain.id})`);
  const actual = await walletChainId();
  if (actual?.toLowerCase() !== NETWORKS[chainKey].chainIdHex) {
    await switchNetwork(chainKey);
    const switched = await walletChainId();
    if (switched?.toLowerCase() !== NETWORKS[chainKey].chainIdHex) {
      throw new Error(`switch your wallet to ${chain.name} before continuing`);
    }
  }
  return chain;
}

async function waitForWalletReceipt(hash) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const receipt = await walletProvider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (receipt !== null) {
      if (receipt.status !== undefined && receipt.status !== "0x1") {
        throw new Error(`transaction ${shortAddress(hash)} reverted`);
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`transaction ${shortAddress(hash)} was not confirmed within three minutes`);
}

async function sendWalletTransaction(to, data, label) {
  setConsumerMessage(`${label} — confirm it in your wallet…`, "pending");
  const hash = await walletProvider.request({
    method: "eth_sendTransaction",
    params: [{ from: walletAccount, to, data }],
  });
  setConsumerMessage(`${label} submitted. Waiting for the chain…`, "pending");
  await waitForWalletReceipt(hash);
  return hash;
}

async function readAllowance(token, owner, spender) {
  const result = await walletProvider.request({
    method: "eth_call",
    params: [{
      to: token,
      data: calldata("0xdd62ed3e", addressWord(owner), addressWord(spender)),
    }, "latest"],
  });
  return BigInt(result || "0x0");
}

async function approveEntitlementPayment(order) {
  const contracts = consumerContracts();
  const token = order.offering.settlementToken || contracts.settlementToken;
  const amount = BigInt(order.offering.priceAtomic);
  const allowance = await readAllowance(token, walletAccount, contracts.settlementEscrow);
  if (allowance >= amount) return null;
  return sendWalletTransaction(
    token,
    calldata("0x095ea7b3", addressWord(contracts.settlementEscrow), uintWord(amount)),
    `Approve ${order.offering.price} ${selected().settlement}`,
  );
}

async function mintOrder(order) {
  await ensureConsumerWallet();
  const contracts = consumerContracts();
  await approveEntitlementPayment(order);
  const hash = await sendWalletTransaction(
    contracts.entitlementFactory,
    calldata("0x293c6a3a", bytes32Word(order.classId), addressWord(walletAccount)),
    "Approve the service",
  );
  consumerOrder = await post(`/api/consumer/orders/${encodeURIComponent(order.id)}/minted`, { txHash: hash });
  renderConsumerOrder(consumerOrder);
  setConsumerMessage("Your service is reserved. Confirm the request next.", "success");
}

async function submitOrder(order) {
  await ensureConsumerWallet();
  const contracts = consumerContracts();
  const fields = order.attestation || {};
  const hash = await sendWalletTransaction(
    contracts.activationRegistry,
    calldata(
      "0x0086aa36",
      uintWord(order.tokenId),
      bytes32Word(fields.parcelHash),
      bytes32Word(fields.documentsHash),
    ),
    "Confirm the request",
  );
  consumerOrder = await post(`/api/consumer/orders/${encodeURIComponent(order.id)}/submitted`, { txHash: hash });
  renderConsumerOrder(consumerOrder);
  setConsumerMessage(
    consumerOrder.state === "refused"
      ? "RouteLock stopped this request because it could not be safely verified. Nothing was retired."
      : "The request passed review. Review payment next.",
    consumerOrder.state === "refused" ? "warning" : "success",
  );
}

async function prepareOrder(order) {
  await ensureConsumerWallet();
  consumerOrder = await post(`/api/consumer/orders/${encodeURIComponent(order.id)}/retirement/prepare`, {});
  renderConsumerOrder(consumerOrder);
  setConsumerMessage("Retirement details are ready. Confirm to let the RouteLock relayer pay Carbonmark on Base.", "success");
}

async function relayRetirement(order) {
  await ensureConsumerWallet();
  setConsumerMessage("RouteLock is submitting the issuer-side Base retirement…", "pending");
  consumerOrder = await post(`/api/consumer/orders/${encodeURIComponent(order.id)}/retirement/fulfil`, {});
  renderConsumerOrder(consumerOrder);
  setConsumerMessage(
    consumerOrder.state === "complete"
      ? "Complete. The public certificate and payment record are now linked to the service."
      : "Payment was accepted. The service record still needs its final proof.",
    consumerOrder.state === "complete" ? "success" : "warning",
  );
}

async function settleOrder(order) {
  await ensureConsumerWallet();
  consumerOrder = await post(`/api/consumer/orders/${encodeURIComponent(order.id)}/settle`, {});
  renderConsumerOrder(consumerOrder);
  setConsumerMessage("Complete. The work proof and payment record are saved.", "success");
}

async function runConsumerAction(action) {
  if (consumerBusy || !consumerOrder) return;
  consumerBusy = true;
  try {
    if (action === "mint") await mintOrder(consumerOrder);
    else if (action === "submit") await submitOrder(consumerOrder);
    else if (action === "prepare") await prepareOrder(consumerOrder);
    else if (action === "relay") await relayRetirement(consumerOrder);
    else if (action === "settle") await settleOrder(consumerOrder);
  } catch (error) {
    setConsumerMessage(error?.message || "That step was not completed.", "error");
  } finally {
    consumerBusy = false;
    renderConsumerOrder(consumerOrder);
  }
}

async function startConsumerOrder() {
  if (consumerBusy) return;
  consumerBusy = true;
  const button = $("carbon-start");
  if (button) button.disabled = true;
  try {
    await ensureConsumerWallet();
    const classId = $("offering-select").value;
    const carbonClass = $("carbon-class-select").value;
    const tonnes = Number($("carbon-tonnes").value);
    if (!classId || !carbonClass || !Number.isFinite(tonnes) || tonnes <= 0) {
      throw new Error("choose a service offer, a carbon credit and a positive amount");
    }
  setConsumerMessage("RouteLock Agent is checking the request and current carbon offer…", "pending");
    consumerOrder = await post("/api/consumer/carbon/preview", {
      buyer: walletAccount,
      beneficiaryAddress: walletAccount,
      classId,
      carbonClass,
      tonnes,
      beneficiaryString: $("carbon-beneficiary").value,
      retirementMessage: $("carbon-message").value,
    });
    renderConsumerOrder(consumerOrder);
    setConsumerMessage(
      consumerOrder.state === "refused"
        ? "RouteLock stopped this request because it could not be safely verified. No payment was made."
        : "The request passed its first check. Continue with the step shown below.",
      consumerOrder.state === "refused" ? "warning" : "success",
    );
  } catch (error) {
    setConsumerMessage(error?.message || "The request could not be checked.", "error");
  } finally {
    consumerBusy = false;
    if (button) button.disabled = false;
  }
}

async function loadConsumerData() {
  const generation = ++consumerRefreshGeneration;
  const panelState = $("carbon-panel-state");
  const form = $("carbon-form");
  const empty = $("carbon-empty");
  if (panelState) panelState.textContent = "LOADING";
  if (form) form.hidden = true;
  if (empty) {
    empty.hidden = false;
    empty.textContent = "Checking the live carbon offer…";
  }
  try {
    const capabilities = await api("/api/consumer/capabilities");
    const [catalog, inventory] = await Promise.all([
      api("/api/consumer/catalog"),
      capabilities.carbon?.supported
        ? api("/api/carbon/inventory")
        : Promise.resolve({ classes: [] }),
    ]);
    // A provider can fund an offer while the customer page is open. A slower
    // older request must never overwrite the newer read with stale state.
    if (generation !== consumerRefreshGeneration) return;
    rememberRuntimeContracts(capabilities);
    consumerCapabilities = capabilities;
    consumerCatalog = catalog;
    carbonInventory = inventory;
    renderConsumerCapability();
    renderConsumerCatalog();
    void loadMerchantData();
  } catch (error) {
    if (generation !== consumerRefreshGeneration) return;
    setConsumerMessage(`The live service could not be loaded: ${error?.message || "unknown error"}`, "error");
    if (panelState) panelState.textContent = "UNAVAILABLE";
    if (form) form.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.textContent = "The live carbon offer could not be loaded. Refresh this page and try again.";
    }
  }
}

function consumerChain() {
  return consumerCapabilities?.chain || null;
}

function consumerContracts() {
  return consumerCapabilities?.contracts || null;
}

function setConsumerMessage(message, tone = "") {
  const element = $("consumer-message");
  if (element) {
    element.textContent = message || "";
    element.dataset.tone = tone;
  }
}

function displayAmount(value, currency = "USDC") {
  if (value === null || value === undefined || value === "") return "—";
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`;
}

function displayAtomic(value, decimals = 6, currency = selected().settlement) {
  if (value === null || value === undefined || value === "") return "—";
  const raw = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${fraction ? `${whole}.${fraction}` : whole} ${currency}`;
}

function orderStateLabel(state) {
  return {
    awaiting_mint: "Ready to approve the service",
    awaiting_submit: "Ready to confirm the request",
    awaiting_decision: "Checking the request",
    awaiting_retirement: "Approved — ready to retire",
    awaiting_relayer: "Ready for RouteLock retirement relay",
    provider_settled: "Work complete — recording proof",
    complete: "Complete — proof recorded",
    refused: "Stopped — the request could not be verified",
  }[state] || state;
}

function readableVerdict(verdict) {
  return {
    APPROVED: "Approved",
    NEEDS_INFORMATION: "More information needed",
    REFUSED: "Not approved",
  }[verdict] || verdict || "Review returned";
}

function renderConsumerCapability() {
  const element = $("consumer-capability");
  const carbon = consumerCapabilities?.carbon;
  if (!element || !consumerCapabilities || !carbon) return;
  const chain = consumerChain();
  const enabled = carbon.checkoutEnabled === true;
  const productStatus = consumerCapabilities?.lanes?.carbon?.status === "active";
  const isMainnet = chain?.id === 196;
  element.className = `consumer-capability ${enabled ? "ready" : "warning"}`;
  element.innerHTML = enabled
    ? `<span class="status-dot live"></span> <strong>Carbon retirement is live on X Layer Mainnet.</strong> Your wallet approves the X Layer service steps; RouteLock pays the issuer-side retirement on Base.`
    : `<span class="status-dot ${productStatus ? "live" : "testing"}"></span> <strong>Carbon retirement is live on X Layer Mainnet.</strong> ${isMainnet ? "The service is live, but a purchase is not available at this moment." : "This is a read-only test view."}`;
  $("carbon-panel-state").textContent = enabled ? "READY" : productStatus ? "READ-ONLY" : "NOT AVAILABLE";
  $("carbon-form").hidden = !enabled;
  if (!enabled) $("carbon-empty").textContent = productStatus
    ? "A backed carbon offer is not available at this moment."
    : "The live carbon service is not available at this moment.";
}

function renderConsumerCatalog() {
  const offeringSelect = $("offering-select");
  const carbonSelect = $("carbon-class-select");
  const empty = $("carbon-empty");
  const offerings = consumerCatalog?.offerings || [];
  const availableOfferings = offerings.filter((offering) => offering.available);
  const classes = carbonInventory?.classes || [];
  if (!offeringSelect || !carbonSelect || !empty) return;

  offeringSelect.innerHTML = offerings.length
    ? offerings.map((offering) => `<option value="${esc(offering.classId)}" ${offering.available ? "" : "disabled"}>${esc(shortAddress(offering.issuer))} · ${esc(offering.price)} ${esc(selected().settlement)} · ${esc(offering.remainingSupply)} left${offering.available ? "" : " · not ready"}</option>`).join("")
    : `<option value="">No service offer has been published</option>`;
  offeringSelect.disabled = !availableOfferings.length;
  carbonSelect.innerHTML = classes.length
    ? classes.map((item) => `<option value="${esc(item.carbonClassId)}">${esc(item.name || shortAddress(item.carbonClassId))} · ${esc(item.carbonClassId)}${item.priceUsdcPerTonne == null ? "" : ` · ${esc(item.priceUsdcPerTonne)} USDC/t`}</option>`).join("")
    : "";
  const start = $("carbon-start");
  if (start) start.disabled = !availableOfferings.length || !classes.length;
  if (!availableOfferings.length || !classes.length) {
    empty.hidden = false;
    if (!offerings.length) {
      empty.textContent = "No service offer has been published yet. The carbon lane is live, but a provider must publish and back an offer before a customer can buy it.";
    } else if (!availableOfferings.length) {
      const reason = offerings[0]?.availabilityReason || "the provider has not deposited enough backing yet";
      empty.textContent = `The carbon service is live, but this offer cannot be bought yet: ${reason}. The offer is shown above so the provider can see exactly what must be fixed.`;
    } else {
      empty.textContent = "No live carbon credit is available from the provider right now.";
    }
  } else if (consumerCapabilities?.carbon?.retirementRelay) {
    empty.hidden = true;
  }
}

function renderConsumerOrder(order) {
  const element = $("consumer-order");
  if (!element) return;
  if (!order) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  const ruling = order.ruling || {};
  const quote = order.prepared?.quote || order.quote;
  const proof = order.receipt?.proofUrl;
  let action = "";
  if (order.state === "awaiting_mint") {
    action = `<button type="button" class="button button-dark" data-order-action="mint">Approve this service <span aria-hidden="true">↗</span></button>`;
  } else if (order.state === "awaiting_submit") {
    action = `<button type="button" class="button button-dark" data-order-action="submit">Confirm this request <span aria-hidden="true">↗</span></button>`;
  } else if (order.state === "awaiting_relayer") {
    action = `<button type="button" class="button button-dark" data-order-action="relay">Confirm retirement <span aria-hidden="true">↗</span></button>`;
  } else if (order.state === "awaiting_retirement") {
    action = `<button type="button" class="button button-dark" data-order-action="prepare">Review retirement <span aria-hidden="true">↗</span></button>`;
  } else if (order.state === "provider_settled") {
    action = `<button type="button" class="button button-dark" data-order-action="settle">Record proof and finish <span aria-hidden="true">↗</span></button>`;
  }
  element.innerHTML = `
    <div class="order-kicker">ORDER ${esc(shortAddress(order.id))} · ${esc(orderStateLabel(order.state))}</div>
    <h4 class="order-title">${esc(readableVerdict(ruling.verdict))}</h4>
    <p class="order-copy">${esc(String(ruling.ground?.detail || "RouteLock has returned a review of this request."))}</p>
    <div class="order-facts">
      <div class="order-fact">Review record<strong>${esc(shortAddress(ruling.decisionHash))}</strong></div>
      <div class="order-fact">Price<strong>${esc(quote ? displayAmount(quote.total ?? quote.authValue, quote.currency || "USDC") : "After approval")}</strong></div>
      <div class="order-fact">Service<strong>${esc(order.tokenId ? "Reserved" : "Not reserved")}</strong></div>
      <div class="order-fact">Amount<strong>${esc(order.tonnes)} tonnes</strong></div>
    </div>
    ${proof ? `<p class="order-copy"><a class="order-link" href="${esc(proof)}" target="_blank" rel="noreferrer">Open the public certificate ↗</a></p>` : ""}
    ${order.settlementTxHash ? `<p class="order-copy"><a class="order-link" href="${esc(order.chain.explorer)}/tx/${esc(order.settlementTxHash)}" target="_blank" rel="noreferrer">View the completed payment record ↗</a></p>` : ""}
    ${order.error ? `<p class="order-copy order-error">${esc(order.error)}</p>` : ""}
    ${action}`;
  const button = element.querySelector("[data-order-action]");
  if (button) {
    button.disabled = consumerBusy;
    button.addEventListener("click", () => runConsumerAction(button.dataset.orderAction));
  }
}

function setMerchantMessage(message, tone = "") {
  const element = $("merchant-message");
  if (element) {
    element.textContent = message || "";
    element.dataset.tone = tone;
  }
}

function merchantProvider() {
  return walletProvider || providerFor("okx") || providerFor("metamask");
}

async function merchantCall(to, data) {
  const provider = merchantProvider();
  if (!provider) throw new Error("connect the provider wallet first");
  return provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
}

async function merchantReadBool(to, data) {
  const result = await merchantCall(to, data);
  return BigInt(result || "0x0") !== 0n;
}

function merchantIdsStorageKey() {
  return `routelock:merchant-classes:${selectedNetwork}:${walletAccount?.toLowerCase() || "unknown"}`;
}

function readMerchantIds() {
  try {
    const value = JSON.parse(localStorage.getItem(merchantIdsStorageKey()) || "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rememberMerchantId(classId) {
  const ids = new Set(readMerchantIds());
  ids.add(classId);
  localStorage.setItem(merchantIdsStorageKey(), JSON.stringify([...ids]));
}

function renderMerchantOffers() {
  const list = $("merchant-offers");
  const select = $("merchant-class-select");
  if (!list || !select) return;
  const offerings = [...merchantOfferings.values()];
  if (!offerings.length) {
    list.innerHTML = `<p class="empty-state">No offer owned by this wallet was found. Create one on the right, or connect the wallet that created an existing offer.</p>`;
    select.innerHTML = `<option value="">No offer loaded</option>`;
    return;
  }
  list.innerHTML = offerings.map((offering) => `
    <div class="merchant-offer">
      <div class="merchant-offer-head"><span>${esc(shortAddress(offering.classId))}</span><span>${offering.available ? "READY FOR CUSTOMERS" : "NOT READY"}</span></div>
      <div class="merchant-offer-meta"><span>${esc(offering.price)} ${esc(selected().settlement)} customer price</span><span>${esc(displayAtomic(offering.payoutObligationAtomic, selected().settlementDecimals))} backing per unit</span><span>${esc(offering.remainingSupply)} units left</span><span>${esc(displayAtomic(offering.collateralAtomic, selected().settlementDecimals))} held directly</span><span>${esc(displayAtomic(offering.strategyAssetsAtomic, selected().settlementDecimals))} in Aave</span><span>${esc(displayAtomic(offering.totalBackingAtomic ?? offering.collateralAtomic, selected().settlementDecimals))} total backing</span><span>${offering.backed ? "backed" : "needs collateral"}</span></div>
      ${offering.availabilityReason ? `<p class="merchant-offer-note">${esc(offering.availabilityReason)}.</p>` : ""}
    </div>`).join("");
  select.innerHTML = offerings.map((offering) => `<option value="${esc(offering.classId)}">${esc(shortAddress(offering.classId))} · ${esc(offering.price)} ${esc(selected().settlement)}</option>`).join("");
}

function renderMerchantYield(yieldState) {
  const element = $("merchant-yield");
  const invest = $("merchant-invest");
  const withdraw = $("merchant-withdraw");
  if (!element) return;
  const enabled = yieldState?.enabled === true;
  element.dataset.tone = enabled ? "" : "warning";
  element.innerHTML = enabled
    ? `<span class="status-dot live"></span> <strong>Aave V3 is connected.</strong> Idle provider backing can earn yield. RouteLock still checks each offer's backing before allowing a withdrawal or new sale.`
    : `<span class="status-dot testing"></span> <strong>Aave yield is not enabled on this deployment.</strong> ${esc(yieldState?.reason || "The current escrow holds collateral directly.")}`;
  if (invest) invest.disabled = !enabled;
  if (withdraw) withdraw.disabled = !enabled;
}

async function loadMerchantData() {
  const capability = $("merchant-capability");
  if (!capability) return;
  const network = selected();
  if (!walletAccount) {
    merchantPermissionless = false;
    capability.className = "consumer-capability warning";
    capability.innerHTML = `<span class="status-dot testing"></span> <strong>Any wallet can be an issuer.</strong> Connect yours to sign the X Layer offer and collateral transactions; no admin approval is required.`;
    $("merchant-issuer-state").textContent = "CONNECT WALLET";
    return;
  }
  try {
    const merchantCapabilities = await api("/api/merchant/capabilities");
    if (Number(merchantCapabilities.chainId) !== network.chainId) {
      capability.className = "consumer-capability warning";
      capability.innerHTML = `<span class="status-dot testing"></span> <strong>The provider page and API are using different deployments.</strong> The API is serving ${esc(merchantCapabilities.chain || "another chain")}; restart it for ${esc(network.name)} before approving a provider transaction.`;
      $("merchant-issuer-state").textContent = "DEPLOYMENT MISMATCH";
      return;
    }
    rememberRuntimeContracts(merchantCapabilities);
    const contracts = networkContracts();
    if (!contracts) return;
    merchantPermissionless = merchantCapabilities.permissionlessIssuers === true;
    const actual = await walletChainId();
    if (actual?.toLowerCase() !== network.chainIdHex) {
      capability.className = "consumer-capability warning";
      capability.innerHTML = `<span class="status-dot testing"></span> <strong>Switch your wallet to X Layer Mainnet.</strong> Provider actions are disabled until the wallet and live service use the same chain.`;
      $("merchant-issuer-state").textContent = "WRONG NETWORK";
      return;
    }
    const registered = await merchantReadBool(contracts.entitlementFactory, calldata("0x2d33d7d5", addressWord(walletAccount)));
    const paused = await merchantReadBool(contracts.entitlementFactory, calldata("0xc7ca016c", addressWord(walletAccount)));
    const canPublish = !paused && (registered || merchantPermissionless);
    $("merchant-issuer-state").textContent = paused ? "PAUSED" : registered ? "REGISTERED" : merchantPermissionless ? "READY TO PUBLISH" : "NOT REGISTERED";
    capability.className = `consumer-capability ${canPublish ? "ready" : "warning"}`;
    capability.innerHTML = canPublish
      ? `<span class="status-dot live"></span> <strong>This wallet can publish offers on X Layer Mainnet.</strong> ${merchantPermissionless && !registered ? "Your first offer registers this wallet automatically — no admin approval is required. " : ""}Prices and collateral are read from the live contracts; your wallet approves every write.`
      : `<span class="status-dot testing"></span> <strong>${paused ? "This issuer is paused." : "This wallet is not registered as an issuer."}</strong> ${paused ? "New offers are disabled until the issuer is resumed." : "The deployment admin must register this wallet before it can create an offer."}`;

    renderMerchantYield(merchantCapabilities.yield);

    merchantOfferings.clear();
    const ids = new Set(readMerchantIds());
    const catalog = await api("/api/merchant/catalog");
    (catalog.offerings || []).filter((offering) => offering.issuer.toLowerCase() === walletAccount.toLowerCase()).forEach((offering) => ids.add(offering.classId));
    for (const classId of ids) {
      try {
        const result = await post("/api/merchant/discover", { classId });
        if (result.offering.issuer.toLowerCase() === walletAccount.toLowerCase()) merchantOfferings.set(result.offering.classId, result.offering);
      } catch {
        // A stale local class id is harmless; a later reload can try again.
      }
    }
    renderMerchantOffers();
  } catch (error) {
    setMerchantMessage(error?.message || "The provider controls could not be loaded.", "error");
  }
}

async function investMerchantCollateral() {
  if (merchantBusy) return;
  merchantBusy = true;
  const button = $("merchant-invest");
  if (button) button.disabled = true;
  try {
    const classId = $("merchant-class-select").value;
    if (!classId) throw new Error("choose an offer first");
    const network = await ensureMerchantWallet();
    const amount = decimalAtomic($("merchant-invest-amount").value, network.settlementDecimals);
    if (amount <= 0n) throw new Error("enter an amount greater than zero");
    await sendMerchantTransaction(
      network.contracts.settlementEscrow,
      calldata("0xeaaf2860", bytes32Word(classId), uintWord(amount)),
      "Put collateral to work in Aave",
    );
    setMerchantMessage("Collateral is earning yield through Aave. Rechecking the live offer…", "success");
    await loadConsumerData();
    await loadMerchantData();
  } catch (error) {
    setMerchantMessage(error?.message || "Collateral was not put to work.", "error");
  } finally {
    merchantBusy = false;
    if (button) button.disabled = false;
  }
}

async function withdrawMerchantCollateral() {
  if (merchantBusy) return;
  merchantBusy = true;
  const button = $("merchant-withdraw");
  if (button) button.disabled = true;
  try {
    const classId = $("merchant-class-select").value;
    if (!classId) throw new Error("choose an offer first");
    const network = await ensureMerchantWallet();
    const amount = decimalAtomic($("merchant-withdraw-amount").value, network.settlementDecimals);
    if (amount <= 0n) throw new Error("enter an amount greater than zero");
    await sendMerchantTransaction(
      network.contracts.settlementEscrow,
      calldata("0xa1e93482", bytes32Word(classId), uintWord(amount)),
      "Withdraw free collateral",
    );
    setMerchantMessage("Free collateral withdrawn. Rechecking the live offer…", "success");
    await loadConsumerData();
    await loadMerchantData();
  } catch (error) {
    setMerchantMessage(error?.message || "Collateral was not withdrawn.", "error");
  } finally {
    merchantBusy = false;
    if (button) button.disabled = false;
  }
}

function decimalAtomic(value, decimals = 6) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("enter a positive amount using numbers only");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals && /[^0]/.test(fraction.slice(decimals))) throw new Error(`amount supports at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0");
}

async function ensureMerchantWallet() {
  if (!walletProvider || !walletAccount) throw new Error("connect the provider wallet first");
  const network = selected();
  const contracts = networkContracts();
  if (!contracts) throw new Error(`${network.name} has no RouteLock deployment for provider actions`);
  const actual = await walletChainId();
  if (actual?.toLowerCase() !== network.chainIdHex) {
    await switchNetwork(selectedNetwork);
    const switched = await walletChainId();
    if (switched?.toLowerCase() !== network.chainIdHex) throw new Error(`switch your wallet to ${network.name} before continuing`);
  }
  return { ...network, contracts };
}

async function sendMerchantTransaction(to, data, label) {
  setMerchantMessage(`${label} — confirm it in your wallet…`, "pending");
  const hash = await walletProvider.request({ method: "eth_sendTransaction", params: [{ from: walletAccount, to, data }] });
  setMerchantMessage(`${label} submitted. Waiting for X Layer…`, "pending");
  await waitForWalletReceipt(hash);
  return hash;
}

async function postMerchantCollateral(classId, amount) {
  const network = await ensureMerchantWallet();
  const atomicAmount = decimalAtomic(amount, network.settlementDecimals);
  if (atomicAmount <= 0n) throw new Error("collateral must be greater than zero");
  const token = network.contracts.settlementToken;
  const escrow = network.contracts.settlementEscrow;
  const allowance = await readAllowance(token, walletAccount, escrow);
  if (allowance < atomicAmount) {
    await sendMerchantTransaction(token, calldata("0x095ea7b3", addressWord(escrow), uintWord(atomicAmount)), "Approve collateral");
  }
  await sendMerchantTransaction(escrow, calldata("0x36fa1bec", bytes32Word(classId), uintWord(atomicAmount)), "Back the offer");
}

async function createMerchantOffer(event) {
  event.preventDefault();
  if (merchantBusy) return;
  merchantBusy = true;
  const button = $("merchant-create");
  if (button) button.disabled = true;
  try {
    const network = await ensureMerchantWallet();
    const registered = await merchantReadBool(network.contracts.entitlementFactory, calldata("0x2d33d7d5", addressWord(walletAccount)));
    if (!registered && !merchantPermissionless) throw new Error("this wallet is not registered as an issuer on X Layer; connect the admin wallet first");
    const label = $("merchant-offer-label").value.trim();
    const terms = $("merchant-offer-terms").value.trim();
    const price = decimalAtomic($("merchant-price").value, network.settlementDecimals);
    const payout = decimalAtomic($("merchant-payout").value, network.settlementDecimals);
    const supply = Number($("merchant-supply").value);
    const validDays = Number($("merchant-valid-days").value);
    const initialCollateral = $("merchant-initial-collateral").value;
    if (!label || !terms || price < 0n || payout <= 0n || !Number.isInteger(supply) || supply <= 0 || !Number.isInteger(validDays) || validDays <= 0) {
      throw new Error("complete the offer details with a valid price, backing, supply and validity period");
    }
    const draft = await post("/api/merchant/draft", { label, terms, issuer: walletAccount });
    const classExists = await merchantReadBool(
      network.contracts.entitlementFactory,
      calldata("0x6caa4707", bytes32Word(draft.classId)),
    );
    if (classExists) {
      throw new Error("This wallet already has an offer with that name. Change the offer name before trying again.");
    }
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + validDays * 86400);
    await sendMerchantTransaction(
      network.contracts.entitlementFactory,
      calldata("0x0826d4eb", bytes32Word(draft.classId), bytes32Word(draft.termsHash), addressWord(network.contracts.settlementToken), uintWord(price), uintWord(payout), uintWord(validUntil), uintWord(supply)),
      "Create the service offer",
    );
    rememberMerchantId(draft.classId);
    // Persist the on-chain class in the API's discovery index before the
    // customer catalogue is refreshed. A class has not been minted yet, so
    // entitlement enumeration alone cannot make the first offer discoverable.
    await post("/api/merchant/discover", { classId: draft.classId });
    if (decimalAtomic(initialCollateral, network.settlementDecimals) > 0n) await postMerchantCollateral(draft.classId, initialCollateral);
    setMerchantMessage("Offer created and backed. It will appear for customers when the live backing check passes.", "success");
    await loadConsumerData();
    await loadMerchantData();
  } catch (error) {
    setMerchantMessage(error?.message || "The offer was not created.", "error");
  } finally {
    merchantBusy = false;
    if (button) button.disabled = false;
  }
}

async function fundMerchantOffer() {
  if (merchantBusy) return;
  merchantBusy = true;
  const button = $("merchant-fund");
  if (button) button.disabled = true;
  try {
    const classId = $("merchant-class-select").value;
    if (!classId) throw new Error("choose an offer to back first");
    await postMerchantCollateral(classId, $("merchant-collateral").value);
    setMerchantMessage("Collateral posted. Rechecking the live offer…", "success");
    // Refresh the customer selector after the provider transaction so it does
    // not keep the old unavailable state.
    await loadConsumerData();
  } catch (error) {
    setMerchantMessage(error?.message || "Collateral was not posted.", "error");
  } finally {
    merchantBusy = false;
    if (button) button.disabled = false;
  }
}

async function loadLiveStatus() {
  const details = $("live-details");
  try {
    const [state, capabilities] = await Promise.all([api("/api/state"), api("/api/consumer/capabilities")]);
    const fulfilment = capabilities.carbon?.supported ? await api("/api/fulfilment") : null;
    const records = Array.isArray(fulfilment?.records) ? fulfilment.records : [];
    const proofCount = records.length;
    const recentProofCount = records.filter((record) =>
      record?.recent === true && record?.providerFound === true && record?.providerState === "retired",
    ).length;
    const proofSummary = recentProofCount > 0
      ? `<strong>${esc(recentProofCount)}</strong> recent public certificate${recentProofCount === 1 ? "" : "s"} checked`
      : proofCount > 0
        ? `No recent proof — <strong>${esc(proofCount)}</strong> historical certificate${proofCount === 1 ? "" : "s"} marked stale`
        : "No public provider proof yet";
    $("live-read-at").textContent = `UPDATED ${new Date(state.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    details.innerHTML = `<div class="live-facts">
      <span class="live-fact">Service <strong>Carbon retirement</strong></span>
      <span class="live-fact">${proofSummary}</span>
      <span class="live-fact">Payment currency <strong>${esc(state.settlement.symbol)}</strong></span>
    </div>`;
    $("foot").textContent = walletAccount
      ? "Your wallet is connected. Choose a service above to continue."
      : "Choose a service above, then connect your wallet when you are ready.";
  } catch (error) {
    details.innerHTML = `<span>${esc(error.message)}</span>`;
    $("foot").textContent = "Live service status is temporarily unavailable.";
  }
}

document.querySelectorAll(".network-choice").forEach((button) => {
  button.addEventListener("click", () => {
    updateSelection(button.dataset.network);
    if (walletAccount) switchNetwork(button.dataset.network);
  });
});

document.querySelectorAll("[data-connect-network]").forEach((button) => {
  button.addEventListener("click", () => {
    openServiceView(button.dataset.service, button.dataset.connectNetwork);
  });
});

document.querySelectorAll("[data-select-network]").forEach((button) => {
  button.addEventListener("click", () => {
    updateSelection(button.dataset.selectNetwork);
    document.querySelector("#services")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

$("wallet-button")?.addEventListener("click", () => openWalletModal());
$("hero-connect")?.addEventListener("click", () => openWalletModal());
$("footer-connect")?.addEventListener("click", () => openWalletModal());
$("wallet-close")?.addEventListener("click", closeWalletModal);
$("wallet-modal")?.addEventListener("click", (event) => {
  if (event.target === $("wallet-modal")) closeWalletModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("wallet-modal").hidden) closeWalletModal();
});
document.querySelectorAll("[data-wallet-provider]").forEach((button) => {
  button.addEventListener("click", () => connectWallet(button.dataset.walletProvider));
});

$("carbon-start")?.addEventListener("click", startConsumerOrder);
$("merchant-offer-form")?.addEventListener("submit", createMerchantOffer);
$("merchant-fund")?.addEventListener("click", fundMerchantOffer);
$("merchant-invest")?.addEventListener("click", investMerchantCollateral);
$("merchant-withdraw")?.addEventListener("click", withdrawMerchantCollateral);
document.querySelectorAll("[data-service-role]").forEach((button) => {
  button.addEventListener("click", () => setServiceRole(button.dataset.serviceRole, button.dataset.role));
});
window.addEventListener("hashchange", routeFromHash);

updateSelection(selectedNetwork);
updateWalletUi();
routeFromHash();
loadLiveStatus();
loadConsumerData();
