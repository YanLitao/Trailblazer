import * as vscode from 'vscode';
import { getSurroundingCode, normalProcess } from './codeContextUtils';
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
    tool: "definition" | "reference" | "assignment";
    children: TreeNode[]; // Recursive definition
};

// ExplorationGraph class managing nodes, edges, and graph operations
export class ExplorationGraph {
    nodes: Map<string, Node>; // Map of node ID to Node
    edges: Set<Edge>; // Set of edges
    origins: Set<string>; // Set of origin node IDs
    fakeOriginId: string; // ID of the fake origin
    tree: TreeNode = {
        id: "fake-origin",
        snippetKey: -1,
        fileUri: "",
        lineNumber: -1,
        variable: "fakeOrigin",
        codeLine: "",
        codeSnippet: "",
        isIntermediate: false,
        statement: "",
        tool: "assignment",
        children: [],
    }

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

    updateFakeOrigin(fileUri: string, lineNumber: number, codeSnippet: string) {
        const fakeOriginNode: Node = {
            id: this.fakeOriginId,
            fileUri: fileUri,
            lineNumber: lineNumber,
            variable: "fakeOrigin",
            codeLine: "",
            codeSnippet: codeSnippet,
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
        const toVariables = normalProcess(toVariable, "", toUri, toLineNumber);
        const variables = toVariables.map((v) => v.variable);
        for (let i = 0; i < variables.length; i++) {
            if (variables[i] === "this") {
                continue;
            }
            const newNodeId = `${toUri}:${toLineNumber}:${variables[i]}`;
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
                variable: variables[i],
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

    findNodeByLine(fileUri: string, lineNumber: number, returnAll: boolean = false): string[] {
        let nodeIds: string[] = [];
        for (const node of this.nodes.values()) {
            if (node.fileUri == fileUri && node.lineNumber == lineNumber && node.id !== this.fakeOriginId) {
                if (returnAll) {
                    nodeIds.push(node.id);
                } else {
                    return [node.id]; // Return the first matching node
                }
            }
        }
        return nodeIds;
    }

    /**
     * Merges the children of an existing node with a newly encountered duplicate node.
     */
    private mergeChildren(existingNode: TreeNode, newNode: TreeNode) {
        const existingChildrenMap = new Map(existingNode.children.map(child => [child.id, child]));

        for (const newChild of newNode.children) {
            if (existingChildrenMap.has(newChild.id)) {
                // Merge recursively if child already exists
                this.mergeChildren(existingChildrenMap.get(newChild.id)!, newChild);
            } else {
                // Add new child if it doesn't exist
                existingNode.children.push(newChild);
            }
        }
    }

    /**
     * Removes duplicate nodes in the tree and merges their children to avoid data loss.
     */
    private removeDuplicatesAndMerge(node: TreeNode, ancestors: Set<string> = new Set(), nodeMap: Map<string, TreeNode> = new Map()): TreeNode | null {
        if (nodeMap.has(node.id)) {
            // Merge children into the existing node
            this.mergeChildren(nodeMap.get(node.id)!, node);
            return null; // Skip adding duplicate node in the parent's children list
        } else {
            nodeMap.set(node.id, node);
        }

        // Track ancestors to prevent cycles
        const newAncestors = new Set([...ancestors, node.id]);

        // Process children recursively, keeping only non-null nodes
        node.children = node.children
            .map(child => this.removeDuplicatesAndMerge(child, newAncestors, nodeMap))
            .filter(child => child !== null) as TreeNode[];

        return node;
    }

    /**
     * Finds the smallest tree to include all given nodes.
     * @param nodeIds - Array of node IDs to include in the tree.
     * @returns A tree structure ready for D3.js visualization.
     */
    findSmallestTree(nodeIds: { [key: number]: { nodeID: string; statement: string } } = {}): any {
        const nodeIdArray = Object.values(nodeIds).map((node) => node.nodeID);
        const shortestPathTree = new Map<string, { parent: string; tool: string }>(); // Stores parent-child relationships with tool
        const nodeMap = new Map<string, any>();

        // Step 1: Build the shortest path tree using Dijkstra's algorithm
        const computeShortestPathTree = (startNodeId: string) => {
            const distances = new Map<string, number>();
            const parents = new Map<string, { parent: string; tool: string } | null>();
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
                        parents.set(neighborId, { parent: nodeId, tool: edge.tool }); // Track parent and tool
                        priorityQueue.push({ nodeId: neighborId, cost: newDist });
                    }
                });
            }
            return parents;
        };

        const parents = computeShortestPathTree(this.fakeOriginId);

        // Step 2: Build the tree from paths
        const createOrGetNode = (nodeId: string, tool: string | null = null): any => {
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
                    tool: tool || "assignment", // Use the provided tool or a default value
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
                const parentData = parents.get(currentNodeId);

                if (parentData) {
                    shortestPathTree.set(currentNodeId, { parent: parentData.parent, tool: parentData.tool }); // Record parent-child relationship
                }
                currentNodeId = parentData?.parent!;
            }
        });

        shortestPathTree.forEach((data, childId) => {
            const parentNode = createOrGetNode(data.parent);
            const childNode = createOrGetNode(childId, data.tool);

            if (!parentNode.children.some((child: any) => child.id === childNode.id)) {
                parentNode.children.push(childNode);
            }
        });

        this.tree = this.removeDuplicatesAndMerge(root)!;

        return root;
    }

    appendOrAddNodesToTree(
        nodeIds: { [key: number]: { nodeID: string; statement: string } } = {},
        branchNodeId?: string // Optional: Specify a branch to append to
    ) {
        if (!this.tree) {
            console.warn("Tree does not exist. Initializing the tree.");
            this.tree = this.findSmallestTree(nodeIds);
            return this.tree;
        }

        const nodeIdArray = Object.values(nodeIds).map((node) => node.nodeID);
        const nodeMap = new Map<string, TreeNode>();
        const buildNodeMap = (node: TreeNode) => {
            nodeMap.set(node.id, node);
            node.children.forEach(buildNodeMap);
        };
        buildNodeMap(this.tree); // Populate the node map

        const findBranchNode = (node: TreeNode, targetId: string): TreeNode | null => {
            if (node.id === targetId) return node;
            for (const child of node.children) {
                const result = findBranchNode(child, targetId);
                if (result) return result;
            }
            return this.tree;
        };

        const branchNode = branchNodeId ? findBranchNode(this.tree, branchNodeId) : this.tree;
        if (branchNodeId && !branchNode) {
            console.warn(`Branch node ${branchNodeId} not found in the tree.`);
            return this.tree;
        }

        nodeIdArray.forEach((newNodeId) => {
            const newNode = this.getNode(newNodeId);
            if (!newNode) {
                console.warn(`Node ${newNodeId} not found in the graph.`);
                return this.tree;
            }

            const statement = Object.values(nodeIds).find((n) => n.nodeID === newNodeId)?.statement || "";
            const snippetKey = parseInt(
                Object.keys(nodeIds).find((key: any) => nodeIds[key].nodeID === newNodeId) || "-1",
                10
            );

            // Find the shortest path to the branch or tree
            const pathToTree = this.findShortestPathToTree(newNodeId, nodeMap, branchNodeId);

            if (pathToTree.length === 0) {
                console.warn(`Could not find a path to integrate node ${newNodeId} into the tree.`);
                return;
            }

            const reversedPath = pathToTree.reverse();

            // Integrate the path into the branch or tree
            let parentNode = branchNode!;
            for (const { node, edge } of reversedPath) {
                if (!nodeMap.has(node.id)) {
                    const newChild: TreeNode = {
                        id: node.id,
                        snippetKey: node.id === newNodeId ? snippetKey : -1,
                        fileUri: node.fileUri,
                        lineNumber: node.lineNumber,
                        variable: node.variable,
                        codeLine: node.codeLine,
                        codeSnippet: node.codeSnippet,
                        isIntermediate: node.id !== newNodeId,
                        statement: node.id === newNodeId ? statement : "",
                        tool: edge?.tool || "assignment",
                        children: [],
                    };
                    parentNode.children.push(newChild);
                    nodeMap.set(node.id, newChild);
                    parentNode = newChild; // Update the parent for the next iteration
                } else {
                    parentNode = nodeMap.get(node.id)!; // Move to the next existing node
                }
            }
        });

        this.tree = this.removeDuplicatesAndMerge(this.tree)!;

        return this.tree;
    }

    findShortestPathToTree(
        startNodeId: string,
        nodeMap: Map<string, TreeNode>,
        branchNodeId?: string
    ): { node: Node; edge?: Edge }[] {
        if (!this.nodes.has(startNodeId)) {
            console.warn(`Node with ID ${startNodeId} does not exist in the graph.`);
            return [];
        }

        const visited = new Set<string>();
        const queue: { path: { node: Node; edge?: Edge }[] }[] = [
            { path: [{ node: this.getNode(startNodeId)! }] },
        ];

        let prioritizedConnection: { path: { node: Node; edge?: Edge }[] } | null = null;
        let fakeOriginPath: { path: { node: Node; edge?: Edge }[] } | null = null;

        while (queue.length > 0) {
            const { path } = queue.shift()!;
            const currentNodeId = path[path.length - 1].node.id;

            // Check if the current node is in the tree
            if (nodeMap.has(currentNodeId)) {
                const treeNode = nodeMap.get(currentNodeId)!;

                // If a branchNodeId is provided, prioritize connecting to its parent node
                if (branchNodeId && treeNode.id === branchNodeId) {
                    return path; // Found the branch node
                }

                // Avoid directly connecting to the fake-origin if other nodes are available
                if (!prioritizedConnection && currentNodeId !== "fake-origin") {
                    prioritizedConnection = { path }; // Keep track of the first non-fake-origin connection
                }

                // Track connection to the fake-origin as a fallback
                if (currentNodeId === "fake-origin" && !fakeOriginPath) {
                    fakeOriginPath = { path };
                }
            }

            visited.add(currentNodeId);

            // Explore backward edges to find parent nodes
            const backwardEdges = Array.from(this.edges).filter((edge) => edge.to === currentNodeId);
            for (const edge of backwardEdges) {
                const fromNode = this.getNode(edge.from);
                if (!fromNode) continue;

                if (!visited.has(fromNode.id)) {
                    queue.push({
                        path: [...path, { node: fromNode, edge }],
                    });
                }
            }
        }

        // Return the prioritized non-fake-origin connection if found
        if (prioritizedConnection) {
            console.log("Prioritized connection found.");
            return prioritizedConnection.path;
        }

        // Fallback to fake-origin connection if no other connections are found
        if (fakeOriginPath) {
            console.log("Fallback to fake-origin connection.");
            return fakeOriginPath.path;
        }

        return []; // No path found
    }

    getNumberOfNodesInTree(): number {
        let count = 0;
        const countNodes = (node: TreeNode) => {
            count++;
            node.children.forEach(countNodes);
        };
        countNodes(this.tree);
        return count;
    }

}