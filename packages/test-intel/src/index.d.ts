import type { ExtractedTestFact, ParserContext } from "@local-engineering-brain/core-types";
export declare function isLikelyTestFile(relativePath: string): boolean;
export declare class TestIntelExtractor {
    extract(context: ParserContext, sourceText: string): ExtractedTestFact | undefined;
}
//# sourceMappingURL=index.d.ts.map