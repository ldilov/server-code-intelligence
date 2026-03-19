import { sha256 } from "./hash.js";

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(parts.join("::")).slice(0, 24)}`;
}
