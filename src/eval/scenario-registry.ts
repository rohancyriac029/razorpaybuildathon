// Shared between SimWorld and OracleStrategy — spec §5.6: "the oracle is
// just argmax over this function," which only holds if the oracle reads
// the exact same scenario data SimWorld resolves outcomes against. Two
// separate copies of "the scenario for this order" would risk drifting
// apart and silently invalidating that claim.
import type { Scenario } from "./scenario.js";

export class ScenarioRegistry {
  private byOrderId = new Map<string, Scenario>();

  register(orderId: string, scenario: Scenario): void {
    this.byOrderId.set(orderId, scenario);
  }

  get(orderId: string): Scenario {
    const s = this.byOrderId.get(orderId);
    if (!s) throw new Error(`ScenarioRegistry: no scenario registered for order ${orderId}`);
    return s;
  }

  has(orderId: string): boolean {
    return this.byOrderId.has(orderId);
  }
}
