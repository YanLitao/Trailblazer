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

    constructor() {
        this.nodes = new Map();
        this.edges = new Map();
    }

    /**
     * Adds a new node to the graph if it does not exist or updates an existing node's properties.
     */
    public upsertNode(nodeId: string, nodeData: Node, sourceId: string | null, stepNumber: number): Node {
        let existingNode = this.nodes.get(nodeId);

        if (existingNode) {
            // Update existing node to an invoking place if necessary
            if (!existingNode.isPlace) {
                existingNode.isPlace = true;
                this.updateEdgeVisibility(nodeId); // Update edges if isPlace status changes
            }
            // Merge new variables with existing variables
            nodeData.variables.forEach(variable => existingNode!.variables.add(variable));
        } else {
            // Add a new node
            this.nodes.set(nodeId, nodeData);
            existingNode = nodeData;
        }

        // Add edge if a sourceId is provided and valid
        if (sourceId && this.nodes.has(sourceId)) {
            this.addEdge(sourceId, nodeId, stepNumber);
        }

        return existingNode;
    }

    /**
     * Adds a new edge between nodes if it doesn't already exist.
     */
    public addEdge(sourceId: string, targetId: string, stepNumber: number) {
        const edgeId = `${sourceId}->${targetId}`;
        if (this.edges.has(edgeId)) return; // Avoid duplicate edges

        const sourceNode = this.nodes.get(sourceId);
        const targetNode = this.nodes.get(targetId);

        if (sourceNode && targetNode) {
            const showEdge = sourceNode.isPlace && targetNode.isPlace; // Only show if both are invoking nodes
            const edge: Edge = {
                id: edgeId,
                sourceId,
                targetId,
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
        const node = this.nodes.get(nodeId);
        if (!node) return;

        // Update each connected edge's visibility based on whether source and target are invoking nodes
        node.edges.forEach(edgeId => {
            const edge = this.edges.get(edgeId);
            if (edge) {
                const sourceNode = this.nodes.get(edge.sourceId);
                const targetNode = this.nodes.get(edge.targetId);
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
            // Additional properties as needed
        }));

        const edgesData = Array.from(this.edges.values())
            .filter(edge => edge.showEdge)  // Only include edges marked as visible
            .map(edge => ({
                source: edge.sourceId,
                target: edge.targetId,
                // Additional edge properties if required
            }));

        console.log({ nodesData, edgesData });
        return { nodes: nodesData, edges: edgesData };
    }

    /**
     * Retrieves a node by its ID.
     */
    public getNode(id: string): Node | null {
        return this.nodes.get(id) || null;
    }
}