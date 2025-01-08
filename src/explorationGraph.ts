import * as vscode from 'vscode';
// Node interface representing both invoking and result nodes
export interface Node {
    id: string; // Unique ID: `${fileUri}:${lineNumber}:${variable}`
    fileUri: string; // File where the node exists
    lineNumber: number; // Line number of the code
    variable: string; // The specific variable or symbol at this node
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

// ExplorationGraph class managing nodes, edges, and graph operations
export class ExplorationGraph {
    nodes: Map<string, Node>; // Map of node ID to Node
    edges: Set<Edge>; // Set of edges
    origins: Set<string>; // Set of origin node IDs

    constructor() {
        this.nodes = new Map();
        this.edges = new Set([]);
        this.origins = new Set();
    }

    /**
     * Adds origin nodes to the graph.
     * Origin nodes are starting points with no incoming edges.
     */
    addOrigin(originNode: Node) {
        if (!this.nodes.has(originNode.id)) {
            this.upsertNode("", originNode.fileUri, originNode.lineNumber, originNode.variable, "origin");
        }
        this.origins.add(originNode.id);
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
            console.log(`Adding node from ${toUri.split('/').pop()}:${toLineNumber}:${toVariable}`);
            const fileUri = vscode.Uri.parse(toUri);
            const document = await vscode.workspace.openTextDocument(fileUri);
            const lineText = document.lineAt(toLineNumber).text.trim();

            // Create the new node
            const newNode: Node = {
                id: newNodeId,
                fileUri: toUri,
                lineNumber: toLineNumber,
                variable: toVariable,
                codeSnippet: lineText,
                edges: new Set(),
            };

            this.nodes.set(newNode.id, newNode);

            // Create the edge
            if (tool !== "origin") {
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

        /* // Log the nodes and edges of each path
        console.log(`Top ${maxPaths} shortest paths from node ${startNodeId}:`);
        shortestPaths.forEach((path, pathIndex) => {
            console.log(`Path ${pathIndex + 1}:`);
            path.forEach((entry, idx) => {
                const edgeInfo = entry.edge
                    ? ` --[${entry.edge.tool}]--> ${entry.node.id}`
                    : ` (Node: ${entry.node.id})`;
                console.log(`  Step ${idx + 1}: ${entry.node.id}${edgeInfo}`);
            });
        }); */

        return shortestPaths;
    }
}