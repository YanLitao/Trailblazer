// Node interface representing both invoking and result nodes
export interface Node {
    id: string;                  // Unique ID (e.g., fileUri + startLine)
    fileUri: string;
    startLine: number;
    endLine: number;
    variables: Set<string>;      // Variables in the statement (e.g., A, B, C)
    codeSnippet: string;         // Full statement as a code snippet
    isPlace: boolean;            // If true, the node is an invoking place
    edges: Set<string>;          // Set of edge IDs connected to this node
    origins: string[];           // Array of origin IDs for tracking multiple sub-graphs
}

// Edge interface with a `showEdge` flag for visibility in the visualization
export interface Edge {
    id: string;                  // Unique ID (e.g., `${sourceId}->${targetId}`)
    sourceId: string;            // ID of the source node
    targetId: string;            // ID of the target node
    stepNumber: number;          // Step in the exploration workflow
    showEdge: boolean;           // Indicates if the edge should be displayed in the visualization
}

// ExplorationGraph class managing nodes, edges, and graph operations
export class ExplorationGraph {
    private nodes: Map<string, Node>; // Map of nodes by their IDs
    private edges: Map<string, Edge>; // Map of edges by their unique edge IDs
    private graphOrigin: string[] = [];  // Main origin for the entire graph, typically the initial invoking place

    constructor() {
        this.nodes = new Map();
        this.edges = new Map();
    }

    public addGraphOrigin(nodeId: string) {
        if (this.nodes.has(nodeId) && !this.graphOrigin.includes(nodeId)) {
            this.graphOrigin.push(nodeId);
        }
    }

    /**
     * Adds a new node to the graph if it does not exist or updates an existing node's properties.
     */
    public upsertNode(nodeId: string, nodeData: Node, sourceId: string | null, stepNumber: number, toolType: number, isPlaceUpdate: boolean): Node {
        let existingNode = this.getNode(nodeId);

        if (existingNode) {
            // Update existing node properties without overwriting origins
            if (isPlaceUpdate && !existingNode.isPlace) {
                existingNode.isPlace = true;
            }
            nodeData.variables.forEach(variable => existingNode!.variables.add(variable));
            // Retain the original origins of the existing node
        } else {
            // Determine origins based on the source node's origins if a sourceId is provided
            if (sourceId && this.nodes.has(sourceId)) {
                const sourceNode = this.getNode(sourceId);
                nodeData.origins = sourceNode && sourceNode.origins.length > 0
                    ? [...sourceNode.origins]  // Inherit origins from source node if available
                    : [sourceId];              // Use sourceId as origin if source node has no origins
            } else {
                // If no sourceId is provided, default to the node itself as the origin
                nodeData.origins = [nodeId];
            }

            this.nodes.set(nodeId, nodeData);
            existingNode = nodeData;

            // If the node has no origin, add it to graphOrigin
            if (!existingNode.origins.length) {
                existingNode.origins.push(nodeId);
                this.addGraphOrigin(nodeId);
            }
        }

        // Add an edge if a sourceId is provided and the source node exists
        if (sourceId && this.nodes.has(sourceId)) {
            this.addEdge(sourceId, nodeId, stepNumber, toolType);
        }

        return existingNode;
    }

    /**
     * Adds a new edge between nodes if it doesn't already exist.
     */
    public addEdge(sourceId: string, targetId: string, stepNumber: number, toolType: number) {
        // Adjust source and target based on tool type
        const edgeSourceId = toolType === 0 ? targetId : sourceId;
        const edgeTargetId = toolType === 0 ? sourceId : targetId;
        const edgeId = `${edgeSourceId}->${edgeTargetId}`;

        if (this.edges.has(edgeId)) {
            // update the edge visibility
            this.updateEdgeVisibility(edgeSourceId);
            return;
        }

        const sourceNode = this.getNode(edgeSourceId);
        const targetNode = this.getNode(edgeTargetId);

        if (sourceNode && targetNode) {
            const showEdge = sourceNode.isPlace && targetNode.isPlace; // Only show if both are invoking nodes
            const edge: Edge = {
                id: edgeId,
                sourceId: edgeSourceId,
                targetId: edgeTargetId,
                stepNumber,
                showEdge
            };

            this.edges.set(edgeId, edge);
            sourceNode.edges.add(edgeId);
            targetNode.edges.add(edgeId);
        }
    }

    /**
     * Checks if an edge exists between two nodes by their IDs and step number.
     */
    public edgeExists(sourceId: string, targetId: string, stepNumber: number): boolean {
        const edgeId = `${sourceId}->${targetId}`;
        const edge = this.edges.get(edgeId);
        return !!edge && edge.stepNumber === stepNumber;
    }

    /**
     * Updates the visibility of all edges connected to a given node.
     */
    private updateEdgeVisibility(nodeId: string) {
        const node = this.getNode(nodeId);
        if (!node) return;

        // Update each connected edge's visibility based on whether source and target are invoking nodes
        node.edges.forEach(edgeId => {
            const edge = this.edges.get(edgeId);
            if (edge) {
                const sourceNode = this.getNode(edge.sourceId);
                const targetNode = this.getNode(edge.targetId);
                edge.showEdge = !!(sourceNode?.isPlace && targetNode?.isPlace);
            }
        });
    }

    /**
     * Converts nodes and edges to a format suitable for visualization, including only visible edges.
     */
    public toVisualizationData() {
        const nodesData = Array.from(this.nodes.values()).map(node => ({
            id: node.id,
            label: node.codeSnippet,
            isPlace: node.isPlace,
            fileUri: node.fileUri,  // Include fileUri for clustering
            // Additional properties as needed
        }));

        const edgesData = Array.from(this.edges.values())
            .filter(edge => edge.showEdge)  // Only include edges marked as visible
            .map(edge => ({
                source: edge.sourceId,
                target: edge.targetId,
                stepNumber: edge.stepNumber, // Include step number if needed for labeling
            }));
        // log the data
        const vizData = { nodes: nodesData, edges: edgesData };
        return vizData;
    }

    /**
     * Retrieves a node by its ID or by matching fileUri and line number range.
     * @param nodeId - The ID to retrieve (typically contains fileUri and line number).
     * @returns The matched Node if found, otherwise null.
     */
    public getNode(nodeId: string): Node | null {
        if (this.nodes.has(nodeId)) {
            return this.nodes.get(nodeId)!;
        }

        return null; // No matching node found
    }

    public toJSON() {
        return {
            nodes: Array.from(this.nodes.values()).map(node => ({
                id: node.id,
                fileUri: node.fileUri,
                startLine: node.startLine,
                endLine: node.endLine,
                isPlace: node.isPlace,
                variables: Array.from(node.variables),
                codeSnippet: node.codeSnippet
            })),
            edges: Array.from(this.edges.values()).map(edge => ({
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                stepNumber: edge.stepNumber,
                showEdge: edge.showEdge
            }))
        };
    }

    /**
     * Finds the shortest paths from relevant origins of the given nodeId to the node itself.
     * If any origin in the node's origins is found in `this.graphOrigin`, only paths from those origins are returned.
     * Otherwise, returns the shortest paths from all origins.
     * @param nodeId - The ID of the node to track paths back to its origins.
     * @returns An array of shortest paths, each being an array of Node objects from origin to nodeId.
     */
    public findShortestPathsToOrigins(nodeId: string): Node[][] {
        console.log(`All edges: `, this.edges);
        const targetNode = this.getNode(nodeId);
        if (!targetNode) {
            throw new Error(`Node ${nodeId} not found in the graph.`);
        }
        console.log(`node's edges: `, targetNode.edges);

        const paths: Node[][] = [];
        const relevantOrigins = targetNode.origins.filter(origin => this.graphOrigin.includes(origin));

        // Use relevant origins if any are found in graphOrigin, otherwise use all origins
        const originsToUse = relevantOrigins.length > 0 ? relevantOrigins : targetNode.origins;

        const originPaths: Map<string, Node[]> = new Map(); // Tracks shortest paths to unique origins

        // Find the shortest path for each origin in originsToUse
        for (const originId of originsToUse) {
            const path = this.findShortestPathWithNodes(nodeId, originId);
            console.log(`Path from ${originId} to ${nodeId}:`, path);
            if (path && path.length > 0) {
                const reachedOrigin = path[0].id; // The origin reached by this path

                // Check if this origin already has a path and if the new path is shorter
                if (!originPaths.has(reachedOrigin) || path.length < originPaths.get(reachedOrigin)!.length) {
                    originPaths.set(reachedOrigin, path);
                }
            }
        }

        // Convert originPaths to an array format
        for (const path of originPaths.values()) {
            paths.push(path);
        }

        // If no paths to target origins are found, keep the shortest paths to any reached origins
        if (paths.length === 0) {
            const fallbackPaths = new Map<string, Node[]>();

            // Traverse all paths to find the shortest to each unique origin reached
            for (const originId of targetNode.origins) {
                const path = this.findShortestPathWithNodes(nodeId, originId);
                if (path && path.length > 0) {
                    const reachedOrigin = path[0].id;
                    if (!fallbackPaths.has(reachedOrigin) || path.length < fallbackPaths.get(reachedOrigin)!.length) {
                        fallbackPaths.set(reachedOrigin, path);
                    }
                }
            }

            for (const path of fallbackPaths.values()) {
                paths.push(path);
            }
        }

        return paths;
    }

    /**
     * Helper function to find the shortest path between two nodes using BFS and return nodes along the path.
     * @param startId - The start node ID.
     * @param endId - The target node ID.
     * @returns An array representing the shortest path from startId to endId as Node objects, or null if no path exists.
     */
    private findShortestPathWithNodes(startId: string, endId: string): Node[] {
        console.log(`Finding path from ${startId} to ${endId} based on decreasing stepNumber`);
        if (startId === endId) return [this.getNode(startId)!];

        const queue: Array<{ node: Node, path: Node[], stepCount: number }> = [
            { node: this.getNode(startId)!, path: [this.getNode(startId)!], stepCount: 0 }
        ];
        const visited = new Set<string>([startId]);
        let closestPath: Node[] = [];  // Tracks the closest path found
        let minStepCount = Infinity;   // Tracks the minimum steps reached

        while (queue.length > 0) {
            const { node, path, stepCount } = queue.shift()!;

            for (const edgeId of node.edges) {
                const edge = this.edges.get(edgeId);
                if (!edge) continue;

                const nextNodeId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
                const nextNode = this.getNode(nextNodeId);

                if (!nextNode || visited.has(nextNodeId)) continue;

                // Only consider edges moving to earlier exploration steps
                if (edge.stepNumber < stepCount) {
                    const newPath = [...path, nextNode];
                    const newStepCount = stepCount + 1;

                    // Update closest path if the current path length is shorter
                    if (newStepCount < minStepCount) {
                        closestPath = newPath;
                        minStepCount = newStepCount;
                    }

                    // If we reached the endId, return the path immediately
                    if (nextNodeId === endId) {
                        return newPath;
                    }

                    // Continue searching if not yet reached the end
                    visited.add(nextNodeId);
                    queue.push({ node: nextNode, path: newPath, stepCount: newStepCount });
                }
            }
        }

        // Return the closest path found, even if it doesn’t reach endId
        console.log(`No direct path to ${endId} found. Returning closest path to the node with minimum steps: `, closestPath);
        return closestPath;
    }
}