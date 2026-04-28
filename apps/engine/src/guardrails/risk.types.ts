import type { PlaceOrderParams } from "../brokers/broker.interface.js";

export interface RiskDecision {
  approved: boolean;
  reason: string;
  params?: PlaceOrderParams;
}
