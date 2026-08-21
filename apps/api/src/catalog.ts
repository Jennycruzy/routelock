/// Persistent discovery index for provider-created service classes.
///
/// The factory is intentionally not an enumerable marketplace: its source of
/// truth is the class mapping on chain. This file is only a discovery cache so
/// a newly created offer can be found before its first entitlement is minted.
/// Every id is re-read from the factory and escrow before it is served.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const CLASS_ID = /^0x[0-9a-fA-F]{64}$/;

export class OfferCatalog {
  readonly #path: string;
  readonly #ids = new Set<string>();

  constructor(path: string) {
    this.#path = path;
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        const id = line.trim();
        if (CLASS_ID.test(id)) this.#ids.add(id.toLowerCase());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  ids(): readonly string[] {
    return [...this.#ids];
  }

  remember(classId: string): void {
    if (!CLASS_ID.test(classId)) throw new Error("classId must be a 32-byte service offer id");
    const normalized = classId.toLowerCase();
    if (this.#ids.has(normalized)) return;

    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, `${normalized}\n`, "utf8");
    this.#ids.add(normalized);
  }
}
