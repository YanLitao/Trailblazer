// Node interface representing both invoking and result nodes
export interface Node {
    id: string;                  // Unique ID (e.g., fileUri + startLine)
    fileUri: string;
    lineNumber: number;
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
    tool: number;                // Tool type (0: go to definitions, 1: find all references)
    invokingVariable: string;    // Variable that invokes the target node
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
    public upsertNode(nodeId: string, nodeData: Node, sourceId: string | null, stepNumber: number, toolType: number, isPlaceUpdate: boolean, invokeVariable: string): Node {
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
                console.log("No sourceId provided for node", nodeId);
                // log all existing node IDs
                console.log("Node IDs:", Array.from(this.nodes.keys()));
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
            this.addEdge(sourceId, nodeId, stepNumber, toolType, invokeVariable);
        }

        return existingNode;
    }

    /**
     * Adds a new edge between nodes if it doesn't already exist.
     */
    public addEdge(sourceId: string, targetId: string, stepNumber: number, toolType: number, invokingVariable: string) {
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
                showEdge,
                tool: toolType,
                invokingVariable: invokingVariable
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
                lineNumber: node.lineNumber,
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
    public findShortestPathsToOrigins(nodeId: string) {
        const targetNode = this.getNode(nodeId);
        if (!targetNode) {
            throw new Error(`Node ${nodeId} not found in the graph.`);
        }

        // Step 1: Traverse all paths from the starting node
        const allPaths = this.traversePathsFromNode(nodeId);

        // Step 2: Filter paths to only those containing origins or graphOrigin
        const relevantOrigins = [...targetNode.origins, ...this.graphOrigin];
        const pathsContainingOrigins = allPaths.filter(path =>
            path.nodes.some(node => relevantOrigins.includes(node.id))
        );

        const filteredPaths = pathsContainingOrigins.length > 0 ? pathsContainingOrigins : allPaths;

        // Step 3: Keep only the shortest path for each unique source (last node in the path)
        const shortestPathsMap = new Map<string, { nodes: Node[], edges: Edge[] }>();
        filteredPaths.forEach(path => {
            const sourceNodeId = path.nodes[path.nodes.length - 1].id;
            if (!shortestPathsMap.has(sourceNodeId) || path.nodes.length < shortestPathsMap.get(sourceNodeId)!.nodes.length) {
                shortestPathsMap.set(sourceNodeId, path);
            }
        });

        // Step 4: Remove the starting node (index 0) from each path
        const resultPaths = Array.from(shortestPathsMap.values()).map(path => ({
            nodes: path.nodes.reverse(),
            edges: [...path.edges.reverse(), null] // Include edges as they are
        }));

        return resultPaths;
    }

    private traversePathsFromNode(startId: string): Array<{ nodes: Node[], edges: Edge[] }> {

        const startNode = this.getNode(startId);
        if (!startNode) {
            console.error(`Node ${startId} not found in the graph.`);
            return [];
        }

        const paths: Array<{ nodes: Node[], edges: Edge[] }> = [];
        const visited = new Set<string>();

        const isSourceNode = (node: Node): boolean => {
            if (node.origins.length === 0 || this.graphOrigin.includes(node.id)) {
                return true;
            }
            if (node.edges.size === 0) {
                return true;
            }
            for (const edgeId of node.edges) {
                const edge = this.edges.get(edgeId);
                if (edge && edge.targetId === node.id && !visited.has(edge.sourceId)) {
                    return false;
                }
            }
            return true;
        };

        const traverse = (currentNode: Node, currentPath: Node[], currentEdges: Edge[]) => {
            currentPath.push(currentNode);
            visited.add(currentNode.id);

            if (isSourceNode(currentNode)) {
                paths.push({ nodes: [...currentPath], edges: [...currentEdges] });
            } else {
                for (const edgeId of currentNode.edges) {
                    const edge = this.edges.get(edgeId);
                    if (!edge) continue;

                    if (edge.targetId === currentNode.id) {
                        const nextNodeId = edge.sourceId;
                        const nextNode = this.getNode(nextNodeId);

                        if (nextNode && !visited.has(nextNodeId)) {
                            traverse(nextNode, [...currentPath], [...currentEdges, edge]);
                        }
                    }
                }
            }

            visited.delete(currentNode.id);
        };

        traverse(startNode, [], []);
        return paths;
    }
}