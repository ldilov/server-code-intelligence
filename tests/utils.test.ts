import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, stableId } from "@local-engineering-brain/shared-utils";

describe("shared-utils", () => {
  it("normalizes windows-style paths into forward slashes", () => {
    const normalized = normalizePath("D:\\Workspace\\server-code-intelligence");
    assert.match(normalized, /D:\/Workspace\/server-code-intelligence/i);
  });

  it("creates stable identifiers", () => {
    assert.equal(stableId("module", "alpha", "beta"), stableId("module", "alpha", "beta"));
  });
});
