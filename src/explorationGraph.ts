import * as vscode from 'vscode';
import { getSurroundingCode } from './codeContextUtils';
// Node interface representing both invoking and result nodes
export interface Node {
    id: string; // Unique ID: `${fileUri}:${lineNumber}:${variable}`
    fileUri: string; // File where the node exists
    lineNumber: number; // Line number of the code
    variable: string; // The specific variable or symbol at this node
    codeLine: string; // Full line of code
    codeSnippet: string; // Relevant snippet from the line of code
    edges: Set<string>; // Connected node IDs from source to this node only
}

// Edge interface with a `showEdge` flag for visibility in the visualization
export interface Edge {
    from: string; // Source node ID
    to: string; // Target node ID
    tool: "definition" | "reference" | "assignment"; // Edge type
    variable: string;
}

export type TreeNode = {
    id: string;
    snippetKey: number;
    fileUri: string;
    lineNumber: number;
    variable: string;
    codeLine: string;
    codeSnippet: string;
    isIntermediate: boolean;
    statement: string;
    children: TreeNode[]; // Recursive definition
};

// ExplorationGraph class managing nodes, edges, and graph operations
export class ExplorationGraph {
    nodes: Map<string, Node>; // Map of node ID to Node
    edges: Set<Edge>; // Set of edges
    origins: Set<string>; // Set of origin node IDs
    fakeOriginId: string; // ID of the fake origin

    constructor() {
        this.nodes = new Map();
        this.edges = new Set();
        this.origins = new Set();
        this.fakeOriginId = "fake-origin"; // ID for the fake origin

        // Add the fake origin node
        const fakeOriginNode: Node = {
            id: this.fakeOriginId,
            fileUri: "",
            lineNumber: -1,
            variable: "fakeOrigin",
            codeLine: "",
            codeSnippet: "",
            edges: new Set(),
        };
        this.nodes.set(this.fakeOriginId, fakeOriginNode);
    }

    // Add a real origin and link it to the fake origin
    addOrigin(originNode: Node) {
        if (!this.nodes.has(originNode.id)) {
            this.nodes.set(originNode.id, originNode);
        }
        this.origins.add(originNode.id);

        // Link the fake origin to this origin
        const edge: Edge = {
            from: this.fakeOriginId,
            to: originNode.id,
            tool: "assignment",
            variable: "",
        };
        this.addEdge(edge);
    }

    /**
     * Upserts a node into the graph.
     * If the node already exists, updates its properties. Otherwise, adds a new node.
     */
    async upsertNode(fromId: string, toUri: string, toLineNumber: number, toVariable: string, tool: string) {
        const variables = toVariable.split(".");
        for (let i = 0; i < variables.length; i++) {
            const newNodeId = `${toUri}:${toLineNumber}:${toVariable}`;
            const existingNode = this.nodes.get(newNodeId);
            if (existingNode) {
                return;
            }

            const fileUri = vscode.Uri.parse(toUri);
            const document = await vscode.workspace.openTextDocument(fileUri);
            const lineText = document.lineAt(toLineNumber).text.trim();
            const { contextText, startContextLine } = await getSurroundingCode(fileUri, toLineNumber, toLineNumber);

            // Create the new node
            const newNode: Node = {
                id: newNodeId,
                fileUri: toUri,
                lineNumber: toLineNumber,
                variable: toVariable,
                codeLine: lineText,
                codeSnippet: contextText,
                edges: new Set(),
            };

            this.nodes.set(newNode.id, newNode);

            // Create the edge
            if (tool !== "origin" && fromId !== newNode.id) {
                const newEdge: Edge = {
                    from: fromId,
                    to: newNode.id,
                    tool: tool as "definition" | "reference" | "assignment",
                    variable: variables[i],
                };

                this.addEdge(newEdge);
            }
        }
        return;

    }

    /**
     * Adds an edge between two nodes in the graph.
     */
    addEdge(edge: Edge) {
        // Check whether the edge already exists
        if (this.edges.has(edge)) {
            return;
        }

        this.edges.add(edge);

        // Update the target node's edge list
        const toNode = this.nodes.get(edge.to);
        if (toNode) {
            toNode.edges.add(edge.from);
        } else {
            console.warn(`Target node ${edge.to} not found in graph.`);
        }

        // Ensure the source node exists
        const fromNode = this.nodes.get(edge.from);
        if (!fromNode) {
            console.warn(`Source node ${edge.from} not found in graph. The edge is to ${edge.to} with tool ${edge.tool}`);
        }
    }

    /**
     * Retrieves a node by its ID.
     */
    getNode(nodeId: string): Node | undefined {
        return this.nodes.get(nodeId);
    }

    findNodeByLine(fileUri: string, lineNumber: number): string | null {
        for (const node of this.nodes.values()) {
            if (node.fileUri == fileUri && node.lineNumber == lineNumber) {
                return node.id; // Return the first matching node
            }
        }
        return null;
    }

    /**
     * Finds the shortest paths from a given node to all origin nodes.
     * Paths are represented as arrays of node IDs.
     */
    findShortestPathFromNode(startNodeId: string, maxPaths: number = 1): { node: Node; edge?: Edge }[][] {
        if (!this.nodes.has(startNodeId)) {
            console.warn(`Node with ID ${startNodeId} not found.`);
            return [];
        }

        const originNodeIds = Array.from(this.origins);
        const isFakeOrigin = (nodeId: string) => nodeId === "fake-origin"; // Helper to check fake origin

        // Map to track the shortest paths to each origin
        const shortestPathsMap: Map<string, { node: Node; edge?: Edge }[]> = new Map();

        // Perform BFS in reverse
        const queue: { path: { node: Node; edge?: Edge }[]; visited: Set<string> }[] = [
            { path: [{ node: this.nodes.get(startNodeId)! }], visited: new Set([startNodeId]) },
        ];

        while (queue.length > 0) {
            const { path, visited } = queue.shift()!;
            const currentNodeId = path[path.length - 1].node.id;

            // If the current node is an origin, check if it’s the shortest path
            if (originNodeIds.includes(currentNodeId)) {
                if (!shortestPathsMap.has(currentNodeId)) {
                    shortestPathsMap.set(currentNodeId, [...path]);
                }
                continue; // Do not explore further from this origin
            }

            // Avoid prioritizing paths through the fake origin unless explicitly needed
            if (isFakeOrigin(currentNodeId) && path.length > 1) {
                continue;
            }

            // Explore backward edges
            const backwardEdges = Array.from(this.edges).filter((edge) => edge.to === currentNodeId);

            for (const edge of backwardEdges) {
                const fromNode = this.getNode(edge.from);
                if (!fromNode) continue;

                // Avoid revisiting nodes
                if (!visited.has(fromNode.id)) {
                    queue.push({
                        path: [...path, { node: fromNode, edge }],
                        visited: new Set([...visited, fromNode.id]),
                    });
                }
            }
        }

        // Collect the shortest paths for up to `maxPaths` origins
        const shortestPaths: { node: Node; edge?: Edge }[][] = Array.from(shortestPathsMap.values())
            .filter(path => path.length >= 1)
            .slice(0, maxPaths)
            .map(path => path.reverse()); // Reverse each path so origin is first and startNode is last

        return shortestPaths;
    }

    findShortestPathFromNodeToFakeOrigin(startNodeId: string): { node: Node; edge?: Edge }[] {
        if (!this.nodes.has(startNodeId)) {
            console.warn(`Node with ID ${startNodeId} not found.`);
            return [];
        }

        // BFS initialization
        const queue: { path: { node: Node; edge?: Edge }[]; visited: Set<string> }[] = [
            { path: [{ node: this.nodes.get(startNodeId)! }], visited: new Set([startNodeId]) },
        ];

        while (queue.length > 0) {
            const { path, visited } = queue.shift()!;
            const currentNodeId = path[path.length - 1].node.id;

            // Stop if the current node is the fake origin
            if (currentNodeId === this.fakeOriginId) {
                return path.reverse(); // Reverse the path for consistency
            }

            // Explore backward edges
            const backwardEdges = Array.from(this.edges).filter((edge) => edge.to === currentNodeId);

            for (const edge of backwardEdges) {
                const fromNode = this.getNode(edge.from);
                if (!fromNode) continue;

                // Avoid revisiting nodes
                if (!visited.has(fromNode.id)) {
                    queue.push({
                        path: [...path, { node: fromNode, edge }],
                        visited: new Set([...visited, fromNode.id]),
                    });
                }
            }
        }

        return []; // Return an empty array if no path is found
    }

    /**
     * Finds the smallest tree to include all given nodes.
     * @param nodeIds - Array of node IDs to include in the tree.
     * @returns A tree structure ready for D3.js visualization.
     */
    findSmallestTree(nodeIds: { [key: number]: { nodeID: string; statement: string } } = {}): any {
        const nodeIdArray = Object.values(nodeIds).map((node) => node.nodeID);
        const shortestPathTree = new Map<string, string>(); // Stores parent-child relationships
        const nodeMap = new Map<string, any>();

        // Step 1: Build the shortest path tree using Dijkstra's algorithm
        const computeShortestPathTree = (startNodeId: string) => {
            const distances = new Map<string, number>();
            const parents = new Map<string, string | null>();
            const visited = new Set<string>();
            const priorityQueue: { nodeId: string; cost: number }[] = [];

            // Initialize distances and priority queue
            distances.set(startNodeId, 0);
            priorityQueue.push({ nodeId: startNodeId, cost: 0 });

            while (priorityQueue.length > 0) {
                priorityQueue.sort((a, b) => a.cost - b.cost);
                const { nodeId } = priorityQueue.shift()!;
                if (visited.has(nodeId)) continue;
                visited.add(nodeId);

                // Relax edges
                const neighbors = Array.from(this.edges).filter(edge => edge.from === nodeId);
                neighbors.forEach(edge => {
                    const neighborId = edge.to;
                    const newDist = (distances.get(nodeId) || Infinity) + 1;
                    if (!distances.has(neighborId) || newDist < distances.get(neighborId)!) {
                        distances.set(neighborId, newDist);
                        parents.set(neighborId, nodeId);
                        priorityQueue.push({ nodeId: neighborId, cost: newDist });
                    }
                });
            }
            return parents;
        };

        const parents = computeShortestPathTree(this.fakeOriginId);

        // Step 2: Build the tree from paths
        const createOrGetNode = (nodeId: string): any => {
            if (!nodeMap.has(nodeId)) {
                const node = this.nodes.get(nodeId)!;
                let isIntermediate = true;
                let snippetKey = -1;
                let statement = "";
                // Find the snippet key and statement for the node if it is in the nodeIds
                if (nodeIds) {
                    const key = Object.keys(nodeIds).find((key: any) => nodeIds[key].nodeID === node.id);
                    if (key) {
                        snippetKey = parseInt(key, 10);
                        statement = nodeIds[snippetKey].statement;
                        isIntermediate = false;
                    }
                }

                const newNode = {
                    id: node.id,
                    snippetKey: snippetKey,
                    fileUri: node.fileUri,
                    lineNumber: node.lineNumber,
                    variable: node.variable,
                    codeLine: node.codeLine,
                    codeSnippet: node.codeSnippet,
                    isIntermediate: isIntermediate,
                    statement: statement,
                    children: [],
                };

                nodeMap.set(nodeId, newNode);
            }

            return nodeMap.get(nodeId);
        };

        const root = createOrGetNode(this.fakeOriginId);

        nodeIdArray.forEach(nodeId => {
            let currentNodeId = nodeId;

            while (currentNodeId && !shortestPathTree.has(currentNodeId)) {
                const parentId = parents.get(currentNodeId);

                if (parentId) {
                    shortestPathTree.set(currentNodeId, parentId); // Record parent-child relationship
                }
                currentNodeId = parentId!;
            }
        });

        shortestPathTree.forEach((parentId, childId) => {
            const parentNode = createOrGetNode(parentId);
            const childNode = createOrGetNode(childId);

            if (!parentNode.children.some((child: any) => child.id === childNode.id)) {
                parentNode.children.push(childNode);
            }
        });
        return root;
    }

}