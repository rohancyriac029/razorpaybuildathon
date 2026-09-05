// v3 agentic-commerce surface (salvage-v3-agentic-commerce-spec.md §3/§5).
// The merchant's agent-readable catalog — a buyer agent's `searchCatalog`
// tool reads from this, and it is served raw at GET /api/catalog so an
// external agent could too. Pure, no DB: prices live here, never on a
// Proposal, so the executor reading price "from the catalog, never the
// model" (spec §3) is a structural fact, not a convention.
import { readFileSync } from "node:fs";

export interface CatalogItem {
  sku: string;
  name: string;
  pricePaise: number;
  category: string;
  inStock: boolean;
}

export interface Catalog {
  currency: string;
  items: CatalogItem[];
}

let cached: Catalog | null = null;

/** Reads catalog.json once per process; cheap enough to not bother invalidating. */
export function loadCatalog(path = "catalog.json"): Catalog {
  if (cached) return cached;
  const raw = readFileSync(path, "utf-8");
  cached = JSON.parse(raw) as Catalog;
  return cached;
}

export function getItem(sku: string, path = "catalog.json"): CatalogItem | null {
  const catalog = loadCatalog(path);
  return catalog.items.find((i) => i.sku === sku) ?? null;
}

/** Throws rather than returning 0 for an unknown sku — a proposal referencing
 * a sku that doesn't exist must never silently price at zero. */
export function priceOf(sku: string, path = "catalog.json"): number {
  const item = getItem(sku, path);
  if (!item) throw new Error(`priceOf: unknown sku "${sku}"`);
  return item.pricePaise;
}
