/// Exercises the carrier adapter against the real Shipbubble API.
///
/// Everything here is free and consumes **no shipment quota**: address
/// validation and rate quotes only. `createShipment` is never called — buying a
/// shipment spends money and consumes one of a small number of live shipments,
/// so it does not belong in a script anyone might run twice.
///
///   pnpm --filter @routelock/carrier smoke
///
/// Reads SHIPBUBBLE_API_KEY from the environment. Pair it with a chain: the
/// adapter refuses to construct if the key and the chain disagree.

import { getChain } from "@routelock/chain";
import { ShipbubbleClient } from "../src/shipbubble.ts";
import { categoryForHs6 } from "../src/categories.ts";
import { isAcceptable } from "../src/policy.ts";
import { isCrossBorder, type Lane } from "../src/types.ts";

const CHAIN = process.env["ROUTELOCK_CHAIN"] ?? "xlayer_testnet";

/// Lanes chosen to prove the adapter is not route-bound: one domestic, two
/// crossing a customs border, on three different continents.
const LANES = [
  ["Aba Road, Port Harcourt, Rivers, Nigeria", "15 Babatunde Jose St, Victoria Island, Lagos, Nigeria"],
  ["15 Babatunde Jose St, Victoria Island, Lagos, Nigeria", "10 Downing Street, London, United Kingdom"],
  ["15 Babatunde Jose St, Victoria Island, Lagos, Nigeria", "1 Harbour View Street, Central, Hong Kong"],
] as const;

const CONSIGNMENT = {
  description: "Bluetooth over-ear headphones, retail packed",
  weightKg: 0.4,
  declaredValue: 25000,
  quantity: 1,
  lengthCm: 25,
  widthCm: 20,
  heightCm: 10,
};

/// The HS code a compliance engine would have produced for the consignment
/// above. Hardcoded here only because this script tests the *carrier*, not the
/// engine — the real pipeline takes this from a model decision.
const HS6 = "851830"; // headphones and earphones

async function main(): Promise<void> {
  const chain = getChain(CHAIN);
  const adapter = new ShipbubbleClient(chain, process.env["SHIPBUBBLE_API_KEY"]);

  process.stdout.write(
    `${adapter.name} against ${chain.name} — mode: ${adapter.live ? "LIVE" : "sandbox"}\n\n`,
  );

  const acceptance = isAcceptable(HS6);
  if (!acceptance.ok) {
    process.stdout.write(
      `HS ${HS6} REFUSED by carrier policy — "${acceptance.clause}"\n` +
        `  ${acceptance.reason}\n  source: ${acceptance.source}\n`,
    );
    return;
  }

  const category = categoryForHs6(HS6);
  if (!category.ok) {
    process.stdout.write(`HS ${HS6} → ${category.reason}: ${category.detail}\n`);
    return;
  }
  process.stdout.write(
    `HS ${HS6} → accepted by carrier policy, routed as "${category.category}"\n\n`,
  );

  for (const [from, to] of LANES) {
    const [origin, destination] = await Promise.all([
      adapter.validateAddress({
        name: "RouteLock Origin",
        email: "origin@routelock.example",
        phone: "+2348057575855",
        address: from,
      }),
      adapter.validateAddress({
        name: "RouteLock Destination",
        email: "destination@routelock.example",
        phone: "+2348057575855",
        address: to,
      }),
    ]);

    const lane: Lane = { origin, destination };
    const crossing = isCrossBorder(lane) ? "CROSS-BORDER" : "domestic";
    process.stdout.write(
      `${origin.countryCode} → ${destination.countryCode}  (${crossing})\n` +
        `  ${origin.formatted}\n  ${destination.formatted}\n`,
    );

    const quotes = await adapter.quote(lane, CONSIGNMENT, category.category);
    if (quotes.length === 0) {
      process.stdout.write("  no courier quoted this lane\n\n");
      continue;
    }
    for (const q of quotes) {
      process.stdout.write(
        `  ${q.courierName.padEnd(18)} ${q.currency} ${String(q.total).padStart(9)}` +
          `  ${q.serviceType.padEnd(8)} eta ${q.estimatedDelivery}` +
          `${q.live ? "" : "   [sandbox price]"}\n`,
      );
    }
    process.stdout.write("\n");
  }

  if (!adapter.live) {
    process.stdout.write(
      "NOTE: sandbox couriers are test fixtures. Their prices respond to weight\n" +
        "but not to destination — the same figure comes back for Lagos, London and\n" +
        "Hong Kong. Sandbox quotes are proof the integration works, never proof of\n" +
        "what a cross-border shipment costs.\n",
    );
  }
}

await main();
