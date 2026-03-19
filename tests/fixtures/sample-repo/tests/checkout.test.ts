import { describe, expect, it } from "vitest";
import { calculateTotal } from "../src/api/checkout-service.js";

describe("checkout", () => {
  it("calculates the total", () => {
    expect(calculateTotal(10, 5)).toBe(25);
  });
});
