import { double, sum } from "../lib/math.js";

export function calculateTotal(basePrice: number, fee: number): number {
  return sum(double(basePrice), fee);
}
