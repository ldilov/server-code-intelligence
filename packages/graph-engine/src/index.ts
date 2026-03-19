import type { DependencyPathResult, EdgeRecord, EdgeType, ModuleRecord } from "@local-engineering-brain/core-types";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";

export interface GraphTraversalResult {
  nodeIds: string[];
  modules: ModuleRecord[];
  edges: EdgeRecord[];
}

export interface EdgeWeightedPathResult {
  nodeIds: string[];
  edges: EdgeRecord[];
  totalWeight: number;
}

export class GraphEngine {
  public constructor(private readonly database: BrainDatabase) {}

  public getModuleDependencies(workspaceId: string, moduleId: string, maxDepth = 3): GraphTraversalResult {
    return this.walk(workspaceId, [moduleId], maxDepth, "forward", ["imports"]);
  }

  public getReverseDependencies(workspaceId: string, moduleId: string, maxDepth = 3): GraphTraversalResult {
    return this.walk(workspaceId, [moduleId], maxDepth, "reverse", ["imports"]);
  }

  public getSymbolCallees(workspaceId: string, symbolId: string, maxDepth = 2): GraphTraversalResult {
    return this.walk(workspaceId, [symbolId], maxDepth, "forward", ["calls", "references"]);
  }

  public getSymbolCallers(workspaceId: string, symbolId: string, maxDepth = 2): GraphTraversalResult {
    return this.walk(workspaceId, [symbolId], maxDepth, "reverse", ["calls", "references"]);
  }

  public traceShortestPath(workspaceId: string, sourceModuleId: string, targetModuleId: string): DependencyPathResult | undefined {
    const path = this.traceWeightedPath(workspaceId, sourceModuleId, targetModuleId, ["imports"]);
    if (!path) {
      return undefined;
    }

    return {
      sourceModuleId,
      targetModuleId,
      moduleIds: path.nodeIds,
      edges: path.edges
    };
  }

  public traceWeightedPath(
    workspaceId: string,
    sourceId: string,
    targetId: string,
    edgeTypes: EdgeType[],
    edgeWeights: Partial<Record<EdgeType, number>> = {}
  ): EdgeWeightedPathResult | undefined {
    const defaultWeights: Record<EdgeType, number> = {
      contains: 3,
      belongs_to_package: 3,
      declares: 2,
      exports: 2,
      imports: 1,
      references: 2,
      calls: 1,
      changed_in: 2,
      tests: 2,
      failed_after_change: 3
    };
    const distances = new Map<string, number>([[sourceId, 0]]);
    const previous = new Map<string, { parent: string; edge: EdgeRecord }>();
    const queue = new Set<string>([sourceId]);

    while (queue.size > 0) {
      const current = [...queue].sort((left, right) => (distances.get(left) ?? Number.POSITIVE_INFINITY) - (distances.get(right) ?? Number.POSITIVE_INFINITY))[0]!;
      queue.delete(current);

      if (current === targetId) {
        break;
      }

      for (const edge of this.database.listEdgesFrom(workspaceId, current).filter((candidate) => edgeTypes.includes(candidate.type))) {
        const weight = edgeWeights[edge.type] ?? defaultWeights[edge.type] ?? 1;
        const nextDistance = (distances.get(current) ?? Number.POSITIVE_INFINITY) + weight;
        if (nextDistance >= (distances.get(edge.targetId) ?? Number.POSITIVE_INFINITY)) {
          continue;
        }
        distances.set(edge.targetId, nextDistance);
        previous.set(edge.targetId, { parent: current, edge });
        queue.add(edge.targetId);
      }
    }

    if (!previous.has(targetId) && sourceId !== targetId) {
      return undefined;
    }

    const nodeIds: string[] = [targetId];
    const edges: EdgeRecord[] = [];
    let cursor = targetId;
    while (cursor !== sourceId) {
      const step = previous.get(cursor);
      if (!step) {
        break;
      }
      edges.unshift(step.edge);
      nodeIds.unshift(step.parent);
      cursor = step.parent;
    }

    return {
      nodeIds,
      edges,
      totalWeight: distances.get(targetId) ?? 0
    };
  }

  private walk(workspaceId: string, startingIds: string[], maxDepth: number, direction: "forward" | "reverse", edgeTypes: EdgeType[]): GraphTraversalResult {
    const visited = new Set<string>(startingIds);
    const depthById = new Map<string, number>(startingIds.map((id) => [id, 0]));
    const queue = [...startingIds];
    const edges = new Map<string, EdgeRecord>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDepth = depthById.get(current) ?? 0;
      if (currentDepth >= maxDepth) {
        continue;
      }

      const nextEdges =
        direction === "forward"
          ? this.database.listEdgesFrom(workspaceId, current).filter((edge) => edgeTypes.includes(edge.type))
          : this.database.listEdgesTo(workspaceId, current).filter((edge) => edgeTypes.includes(edge.type));

      for (const edge of nextEdges) {
        const nextId = direction === "forward" ? edge.targetId : edge.sourceId;
        edges.set(edge.id, edge);
        if (!visited.has(nextId)) {
          visited.add(nextId);
          depthById.set(nextId, currentDepth + 1);
          queue.push(nextId);
        }
      }
    }

    return {
      nodeIds: [...visited],
      modules: this.database.listModulesByIds([...visited]),
      edges: [...edges.values()]
    };
  }
}
