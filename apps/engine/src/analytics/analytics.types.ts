export interface SignalValidation {
  approved: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}
