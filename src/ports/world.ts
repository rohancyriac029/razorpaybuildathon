// Spec §3.1 [v2.1]. RazorpayWorld (live test mode) and SimWorld (generator +
// counterfactual) both satisfy this. run() calls the same executor against
// either — this is what makes "the eval tests the code you ship" true of the
// whole pipeline, not just the clock (§3.1 point 1).

import type { ExecResult, Intent, Order } from "../types.js";

export interface World {
  getOrder(id: string): Promise<Order>;
  createPaymentLink(i: Intent): Promise<ExecResult>;
  sendNudge(i: Intent): Promise<ExecResult>;
  chargeToken(i: Intent): Promise<ExecResult>;
}
