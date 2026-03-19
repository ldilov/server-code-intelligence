import { sha256 } from "./hash.js";
export function stableId(prefix, ...parts) {
    return `${prefix}_${sha256(parts.join("::")).slice(0, 24)}`;
}
//# sourceMappingURL=ids.js.map