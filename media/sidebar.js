const vscode = acquireVsCodeApi(); // This gives us access to the VSCode API
let messageQueue = [];
let graphData;
// Persistent storage for insights
const insightMap = new Map();

// Re-append insights after graph redraw
function reAppendInsights() {
    // Remove existing insight copies
    document.querySelectorAll('.insight-copy').forEach((insight) => {
        insight.remove();
    });

    insightMap.forEach((insightHTML, snippetKey) => {
        const insightContainer = document.querySelector(`.node-container-box[data-snippet-key="${snippetKey}"]`);
        if (insightContainer && !insightContainer.id.includes("fakeOrigin")) {
            // Create a new div for the insight copy
            const clonedInsightContainer = document.createElement('div');
            clonedInsightContainer.classList.add('insight-copy');
            clonedInsightContainer.innerHTML = insightHTML; // Set the innerHTML from the map

            // Remove all .citation-ref spans inside this cloned container
            clonedInsightContainer.querySelectorAll('.citation-ref').forEach((ref) => ref.remove());

            // Remove all buttons from this cloned container
            clonedInsightContainer.querySelectorAll('button').forEach((button) => button.remove());

            // Append the cleaned insight container
            const codeBox = insightContainer.querySelector('.tree-node.code-box');
            if (codeBox) {
                insightContainer.insertBefore(clonedInsightContainer, codeBox);
            } else {
                insightContainer.appendChild(clonedInsightContainer);
            }

            // Style the container as needed
            insightContainer.classList.add('insight-in-container');
            const parent = insightContainer.parentElement;
            clonedInsightContainer.style.height = `${parent.offsetHeight}px`;
        }
    });
}

// Listen to messages from the VSCode extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'updateStatus':
            updateStatus(message.status);
            break;
        case 'updateAnswer':
            const answerDiv = document.getElementById('answer-div');

            if (message.answer) {
                answerDiv.innerHTML = message.answer;

                // Process each insight from the lifecycle section
                const lifecycleInsights = document.querySelectorAll('.lifecycle .insight'); // Restrict to .lifecycle
                lifecycleInsights.forEach((insight) => {
                    const snippetKey = insight.getAttribute('data-ref');

                    // Update the persistent map to store the innerHTML of the original insight
                    if (snippetKey) {
                        insightHTML = insight.innerHTML.replace(/\[<span class="citation-ref"[^>]*>.*?<\/span>\]/g, "");
                        insightMap.set(snippetKey, insightHTML);
                    }
                });

                reAppendInsights();

                if (message.answer.includes("Answer")) {
                    document.querySelectorAll('.removable').forEach((element) => {
                        element.style.display = 'none';
                    });
                    const searchingContentDiv = document.getElementById('searching-content');
                    searchingContentDiv.style.display = 'none';
                    document.getElementById('new-info').style.display = "none";
                }
            }
            break;
        case 'renderGraph':
            graphData = initializeHiddenField(message.data);
            renderGraph(graphData);
            break;
        case 'updateTitleQuestion':
            document.getElementById('title-question').innerText = message.question;
            followUpQuestionInput();
            break;
        case 'updateSearchingContent':
            updateSearchingContent(message.content);
            break;
        case 'newInformationAvailable':
            document.getElementById('new-info').style.display = "block";
            document.getElementById('new-info-btn').addEventListener('click', function () {
                vscode.postMessage({
                    command: 'showNewInformation'
                });
                document.getElementById('new-info').style.display = "none";
            });
            console.log("New information available:", message);
            break;
    }
});

document.querySelectorAll(".jump-btn").forEach((element) => {
    element.addEventListener("click", function () {
        const fileUri = element.getAttribute("data-file-uri");
        const lineNumber = element.getAttribute("data-line-number");
        vscode.postMessage({
            command: 'openFileAtLine',
            fileUri: fileUri,
            lineNumber: parseInt(lineNumber, 10)
        });
    });
});

function updateSearchingContent(content) {
    const searchingContentDiv = document.getElementById('searching-content');
    const maxMessages = 1; // Change this if you want more messages
    const fadeOutTime = 15000; // Time before fading out (15s)

    // Create new message element
    const newMessage = document.createElement('div');
    newMessage.className = 'search-message fade-in';
    newMessage.textContent = content;

    // Add the new message to the queue
    searchingContentDiv.appendChild(newMessage);
    messageQueue.push(newMessage);

    // Only fade out if there's more than one message AFTER an old message is removed
    setTimeout(() => {
        if (messageQueue.length > 1) {
            newMessage.classList.add('fade-out');
            setTimeout(() => {
                newMessage.remove();
                messageQueue.shift(); // Ensure it's removed from queue only after it's gone
            }, 500); // Allow fade-out animation to complete
        }
    }, fadeOutTime);

    // Ensure we only keep the last `maxMessages`
    if (messageQueue.length > maxMessages) {
        const oldMessage = messageQueue.shift();
        oldMessage.classList.add('fade-out');
        setTimeout(() => oldMessage.remove(), 500);
    }
}

document.getElementById('save-pdf').addEventListener('click', function () {
    var element = document.body;
    html2pdf().from(element).save('search-copilot.pdf');
});

document.getElementById('pause-agent').addEventListener('click', function () {
    const pauseButton = this; // Get the button element
    const icon = pauseButton.querySelector("i"); // Get the icon inside the button

    if (icon.classList.contains("fa-pause")) {
        // Change to Play Button
        icon.classList.remove("fa-pause");
        icon.classList.add("fa-play");

        // Send message to pause the agent
        vscode.postMessage({
            command: 'pauseAgent'
        });

    } else {
        // Change back to Pause Button
        icon.classList.remove("fa-play");
        icon.classList.add("fa-pause");

        // Send message to resume the agent
        vscode.postMessage({
            command: 'continueAgent'
        });
    }
});

document.getElementById('stop-agent').addEventListener('click', function () {
    vscode.postMessage({
        command: 'stopAgent'
    });
});

function followUpQuestionInput() {
    document.querySelectorAll('.removable').forEach((element) => {
        element.style.display = 'block';
    });
    const searchingContentDiv = document.getElementById('searching-content');
    searchingContentDiv.style.display = 'none';
    document.getElementById('final-answer-header').innerHTML = 'Preliminary answer';
    document.getElementById('searching-content').style.display = 'block';
    updateStatus('Searching');
    const pauseButton = document.getElementById('pause-agent');
    const icon = pauseButton.querySelector('i');
    icon.classList.remove('fa-play');
    icon.classList.add('fa-pause');
}

function findNodeBySnippetKey(node, snippetKey) {
    if (node.snippetKey === snippetKey) {
        return node;
    }
    if (node.children && node.children.length > 0) {
        for (const child of node.children) {
            const foundNode = findNodeBySnippetKey(child, snippetKey);
            if (foundNode) {
                return foundNode;
            }
        }
    }
    return null; // Node not found
}

function updateNodeAndAncestors(treeNode, targetSnippetKey) {
    // Base case: If the current node matches the snippetKey, set hidden = 2
    if (treeNode.snippetKey === targetSnippetKey) {
        treeNode.hidden = 2;
        return true; // Indicate that this node is an ancestor or itself
    }

    let isAncestor = false;

    // Recursively check children
    if (treeNode.children && treeNode.children.length > 0) {
        treeNode.children.forEach(child => {
            const childResult = updateNodeAndAncestors(child, targetSnippetKey);
            if (childResult) {
                isAncestor = true;
            }
        });

        // After recursion: Set hidden = 1 for direct children of an ancestor node
        treeNode.children.forEach(child => {
            if (isAncestor && child.hidden !== 2) {
                child.hidden = 1; // Mark direct children of an ancestor
            }
        });
    }

    // If any child matched, this node is an ancestor, so update it
    treeNode.hidden = isAncestor ? 2 : 0;

    return isAncestor; // Indicate whether this node or its descendants matched
}

document.addEventListener("click", function (event) {
    let insightElement = event.target.closest(".jump-btn");
    let citationRefElement = event.target.closest(".citation-ref");

    // If the clicked element is within an `.insight`, trigger the file open event
    if (insightElement) {
        const fileUri = insightElement.getAttribute("data-file-uri");
        const lineNumber = insightElement.getAttribute("data-line-number");

        if (fileUri && lineNumber) {
            vscode.postMessage({
                command: 'openFileAtLine',
                fileUri: fileUri,
                lineNumber: parseInt(lineNumber, 10)
            });
        }
    }

    // If the clicked element is a `.citation-ref`, trigger the graph update AND file open event
    if (citationRefElement) {
        const refId = parseInt(citationRefElement.getAttribute("data-ref"), 10);

        // Update the target node and its ancestors in the graph
        const updated = updateNodeAndAncestors(graphData, refId);

        if (!updated) {
            graphData = initializeHiddenField(graphData); // Reset hidden states if not found
            console.warn(`Node with snippetKey "${refId}" not found in graphData:`, graphData);
        }

        // Redraw the graph
        const nodeData = findNodeBySnippetKey(graphData, refId);
        renderGraph(graphData, nodeData.id);

        // Also trigger file open if possible (using the closest `.insight` container)
        let closestInsight = citationRefElement.closest(".insight");
        if (closestInsight) {
            const fileUri = closestInsight.getAttribute("data-file-uri");
            const lineNumber = closestInsight.getAttribute("data-line-number");

            if (fileUri && lineNumber) {
                vscode.postMessage({
                    command: 'openFileAtLine',
                    fileUri: fileUri,
                    lineNumber: parseInt(lineNumber, 10)
                });
            }
        }
    }
});

// control showing the preliminary answer
function toggleDetails() {
    const container = document.getElementById("details-container");
    const button = document.getElementById("toggle-details-btn");

    if (container.style.display === "none") {
        container.style.display = "block";
        button.textContent = "Hide tour";
    } else {
        container.style.display = "none";
        button.textContent = "Toggle descriptive tour of code";
    }
}

function updateStatus(status) {
    const statusText = document.getElementById('agent-status-text');

    if (!statusText) return;

    // Update text and class based on status
    switch (status) {
        case 'Searching':
            statusText.textContent = 'Searching...';
            statusText.className = 'searching-status';
            break;
        case 'Paused':
            statusText.textContent = 'Paused';
            statusText.className = 'paused-status';

            // Select the pause button and its icon
            const pauseButton = document.getElementById('pause-agent');
            const icon = pauseButton.querySelector('i');

            // Toggle the icon between play and pause
            if (icon.classList.contains('fa-pause')) {
                icon.classList.remove('fa-pause');
                icon.classList.add('fa-play');

            } else {
                icon.classList.remove('fa-play');
                icon.classList.add('fa-pause');
            }
            break;
        case 'Stopped':
            statusText.textContent = 'Stopped';
            statusText.className = 'stopped-status';
            break;
        case 'Finished': // Treat both as "Finished"
            statusText.textContent = 'Finished';
            statusText.className = 'finished-status';
            break;
        default: // Default to "Idle"
            statusText.textContent = 'Idle';
            statusText.className = 'idle-status';
            break;
    }
}

function initializeHiddenField(treeNode, hidden = 2) {
    // Set the hidden state based on the node's relationship to the root
    if (treeNode.id === "fake-origin") {
        treeNode.hidden = 2; // The root node is fully visible
    } else if (hidden === 2) {
        treeNode.hidden = 1; // Immediate children of the root are partially visible
    } else {
        treeNode.hidden = 0; // Other nodes are hidden by default
    }

    // Recursively initialize children
    if (treeNode.children && treeNode.children.length > 0) {
        treeNode.children.forEach(child => initializeHiddenField(child, treeNode.hidden));
    }
    return treeNode;
}

function generateNodeId(data) {
    if (!data || !data.fileUri || !data.lineNumber || !data.variable) {
        console.warn("Invalid data object:", data);
        return "";
    }
    const fileName = data.fileUri.split('/').pop(); // Get the file name
    return `${fileName}_${data.lineNumber}_${data.variable}`.replace(/[^\w-]/g, "_");
}

// Function to calculate the height of a code snippet rectangle
function getCodeSnippetHeight(snippetKey, codeSnippet, hidden = false) {
    if (hidden == 0) {
        return 0; // Return 0 height for hidden nodes
    }
    const container = document.getElementById("graph-container");
    const tempDiv = document.createElement("div");
    tempDiv.style.visibility = "hidden";
    tempDiv.style.position = "absolute";
    tempDiv.style.font = "12px monospace";
    tempDiv.style.width = `${container.offsetWidth - 60 - 30}px`;

    // Include both the code snippet and statement in the temporary div
    let htmlContent = `
        <div class="tree-node">
            <div class="node-description">Node description</div>
        </div>
    `;

    if (hidden == 2) {
        const snippetKeyStr = String(snippetKey);
        if (insightMap.has(snippetKeyStr)) {
            htmlContent += `
            <div class="insight-copy">
                ${insightMap.get(snippetKeyStr)}
            </div>`;
        }
        htmlContent += `
        <div class="node-container-box">
            <div class="tree-node code-box">
                <div class="code-container">
                    <code style="white-space: pre;">${codeSnippet}</code>
                </div>
                <div class="tree-node-button-container">
                    <button class="replay-btn" title="Replay"><i class="fas fa-undo-alt"></i> Replay</button>
                    <button class="search-btn" title="Search"><i class="fas fa-search"></i> Search</button>
                </div>
            </div>
        </div>`;
    }
    tempDiv.innerHTML = htmlContent;

    document.body.appendChild(tempDiv);
    let height = tempDiv.getBoundingClientRect().height + 20; // Measure total height
    document.body.removeChild(tempDiv); // Clean up

    if (height < 50) {
        return 50; // Minimum height
    }
    return height;
}

function renderGraph(data, startWalkthrough = "") {
    const container = document.getElementById("graph-container");
    container.innerHTML = ""; // Clear previous graph

    // Create the replay control panel
    const controlPanel = document.createElement("div");
    controlPanel.id = "control-panel";
    controlPanel.style.display = "none"; // Initially hidden
    controlPanel.innerHTML = `
        <button id="prev-step"><i class="fa-solid fa-backward-step"></i> previous step</button>
        <button id="next-step"><i class="fa-solid fa-forward-step"></i> next step</button>
        <button id="exit-replay"><i class="fa-solid fa-times"></i></button>
    `;
    container.appendChild(controlPanel);

    const margin = { top: 10, right: 0, bottom: 20, left: 10 };

    // Create the SVG container
    const svg = d3.select(container)
        .append("svg")
        .style("font", "12px sans-serif");

    let isPaused = false;
    let replayMode = false;
    let currentTimeout = null;
    let currentNodes = [];
    let currentStepIndex = 0;
    let nodeSize = 20;

    function toggleNode(d) {
        // Toggle `hidden` state for the current node
        if (d.data.hidden === 0) {
            d.data.hidden = 1; // Make partially visible
        } else if (d.data.hidden === 1) {
            d.data.hidden = 2; // Fully visible
        } else if (d.data.hidden === 2) {
            d.data.hidden = 1; // Back to partially visible
        }
        // If fully visible (`hidden = 2`), propagate to children
        if (d.data.hidden === 2 && d.children) {
            d.children.forEach(child => {
                child.data.hidden = 1; // Children become partially visible
            });
        }
        drawGraph(); // Redraw the graph with updated states
    }

    function drawGraph() {
        const width = container.offsetWidth;

        // Clear existing content in SVG
        svg.selectAll("*").remove();

        const root = d3.hierarchy(data);

        let yOffset = margin.top;
        const gapSpace = 10;

        root.eachBefore(d => {
            if (d.parent && (d.parent.data.hidden === 0 || d.parent.data.hidden === 1)) {
                d.data.hidden = 0; // If the parent is hidden or partially visible, hide this node
            }
            if (d.data.hidden !== 0) {
                const snippetHeight = getCodeSnippetHeight(d.data.snippetKey, d.data.codeSnippet, d.data.hidden);
                d.yOffset = yOffset;
                yOffset += snippetHeight + gapSpace;
            }
        });

        const nodes = root.descendants().filter(d => d.data.hidden !== 0); // Show only non-hidden nodes
        const links = root.links().filter(link =>
            link.source.data.hidden !== 0 && link.target.data.hidden !== 0
        );

        svg.attr("width", width);
        svg.attr("height", yOffset + margin.bottom);

        const g = svg.append("g")
            .attr("transform", `translate(${margin.left}, ${margin.top})`); // Apply margin

        // Add links (connecting lines)
        g.append("g")
            .attr("fill", "none")
            .attr("stroke", "#ccc")
            .attr("stroke-width", 1.5)
            .selectAll("path")
            .data(links)
            .join("path")
            .attr("class", "link") // Add a class for consistent styling
            .attr("id", (d, i) => `link-${generateNodeId(d.source.data)}-${generateNodeId(d.target.data)}`)
            .attr("d", d => {
                const path = d3.path();
                path.moveTo(d.source.depth * nodeSize, d.source.yOffset);
                path.lineTo(d.source.depth * nodeSize, d.target.yOffset);
                path.lineTo((d.source.depth + 1) * nodeSize, d.target.yOffset);
                return path.toString();
            });

        // Add nodes
        const nodeGroup = g.append("g")
            .selectAll("g")
            .data(nodes)
            .join("g")
            .attr("class", "node")
            .attr("id", d => `node-${generateNodeId(d.data)}`)
            .attr("transform", d => `translate(0,${d.yOffset})`);

        // Add circles for nodes
        nodeGroup.append("circle")
            .attr("cx", d => d.depth * nodeSize)
            .attr("r", 10)
            .attr("fill", "#aaa")
            .attr("stroke", "#333")
            .on("click", function (event, d) {
                toggleNode(d); // Call the same function used for circles
            });

        // Add text inside circles to indicate visibility state
        nodeGroup.append("text")
            .attr("id", d => `toggle-symbol-${generateNodeId(d.data)}`) // Add an ID for easier selection
            .attr("x", d => d.depth * nodeSize)
            .attr("dy", "0.32em")
            .attr("text-anchor", "middle")
            .attr("fill", "black")
            .style("font-size", "14px")
            .style("font-weight", "bold")
            .text(d => {
                if (d.data.hidden === 1) return "▸"; // Expand indicator
                if (d.data.hidden === 2) return "▾"; // Collapse indicator
                return ""; // No text if hidden = 0
            })
            .on("click", function (event, d) {
                toggleNode(d); // Call the same function used for circles
            });

        nodeGroup.append("foreignObject")
            .attr("id", d => `box-${generateNodeId(d.data)}`) // Use sanitized ID for toggling visibility
            .attr("x", d => d.depth * nodeSize + 20)
            .attr("y", -10)
            .attr("width", d => {
                const xPosition = d.depth * nodeSize + 20; // Calculate x position
                const availableWidth = width - margin.right - margin.left; // Total available width
                return availableWidth - xPosition; // Adjust width to align right edge
            })
            .attr("height", d => getCodeSnippetHeight(d.data.snippetKey, d.data.codeSnippet, d.data.hidden))
            .html(d => {
                // Description Text for Each Node
                let descriptionHTML = "";
                if (d.data.id === "fake-origin") {
                    descriptionHTML = `<div class="node-description">I started here. Then I started to look for information.</div>
                    `;
                } else if (d.parent && d.parent.data.id === "fake-origin") {
                    // Node with fake-origin as parent
                    descriptionHTML = `
                        <div class="node-description">
                            I decided to look for more information about <span class="inline-code">${d.data.variable}.
                        </div>
                    `;
                } else if (d.data.tool === "reference") {
                    // Reference Node
                    descriptionHTML = `
                        <div class="node-description">
                            This led me to this reference of <span class="inline-code">${d.data.variable}</span>.
                        </div>
                    `;
                } else if (d.data.tool === "assignment") {
                    const parentInfo = d.parent.data.variable;
                    descriptionHTML = `
                        <div class="node-description">
                            I found <span class="inline-code">${d.data.variable}</span>, which looked important and is based on ${parentInfo}.
                        </div>
                    `;
                } else {
                    // Default Case
                    descriptionHTML = `
                        <div class="node-description">
                            This led me to this definition of <span class="inline-code">${d.data.variable}</span>.
                        </div>
                    `;
                }

                let borderStyle = "1px solid #aaa";
                let displayment = (d.data.hidden !== 2) ? "display: none" : "";

                let snippetLines = d.data.codeSnippet;
                // Highlight the line containing `codeLine` and the `variable`
                if (d.data.id !== "fake-origin") {
                    let stopInspectionFlag = false;

                    snippetLines = d.data.codeSnippet.split("\n").reduce((processedLines, line) => {
                        // Trim the line to check for meaningful content
                        const trimmedLine = line.trim();

                        // Skip meaningless lines at the beginning
                        if (!stopInspectionFlag) {
                            if (/[a-zA-Z]/.test(trimmedLine)) {
                                stopInspectionFlag = true; // Start processing lines with meaningful content
                            } else {
                                return processedLines; // Skip the line
                            }
                        }

                        // Add the line to processedLines
                        processedLines.push(line);
                        return processedLines;
                    }, []);

                    // Remove empty lines at the end
                    while (snippetLines.length > 0 && snippetLines[snippetLines.length - 1].trim() === "") {
                        snippetLines.pop();
                    }

                    // Highlight the variable and the code line
                    snippetLines = snippetLines.map((line, index) => {
                        if (line.trim() === d.data.codeLine.trim()) {
                            // Highlight the variable within the line
                            const highlightedVariable = `<span class="inline-code">${d.data.variable}</span>`;
                            const highlightedLine = line.replace(
                                new RegExp(`\\b${d.data.variable}\\b`, "g"),
                                highlightedVariable
                            );

                            // Highlight the full line
                            return `<span class="code-line">${highlightedLine}</span>`;
                        }
                        return line;
                    }).join("\n");
                }

                let htmlContent = `
                    ${descriptionHTML}
                    <div class="node-container-box" id="container-${generateNodeId(d.data)}" data-snippet-key="${d.data.snippetKey}" style="border: ${borderStyle}; ${displayment};">
                        <div id="code-box-${generateNodeId(d.data)}" class="tree-node code-box" data-ref="${d.data.snippetKey}">
                            <div class="code-container">
                                <code style="white-space: pre;" data-file-uri="${d.data.fileUri}" data-line-number="${d.data.lineNumber}">${snippetLines}</code>
                            </div>
                            <div class="tree-node-button-container">
                                <div class="code-info">
                                    ${d.data.fileUri.split('/').pop()}, line ${d.data.lineNumber + 1}
                                    <button class="jump-btn" title="Open in code editor" data-file-uri="${d.data.fileUri}" data-line-number="${d.data.lineNumber}">
                                        <i class="fa-solid fa-file-import"></i>
                                    </button>
                                    <button class="replay-btn" title="Step to here" data-node-id="${d.data.id}">
                                        <i class="fa-solid fa-forward-step"></i></button>
                                    </button>
                                    <button class="search-btn" title="Continue search from here" data-node-id="${d.data.id}">
                                        <i class="fas fa-search"></i>
                                    </button>
                                </div>                                
                            </div>
                        </div>
                    </div>
                `;
                return htmlContent;
            });

        nodeGroup.selectAll(".replay-btn").on("click", function (event) {
            let target = event.target;
            if (target.tagName.toLowerCase() === 'i') {
                // Redirect the event to the parent button
                target = target.closest('button');
            }
            const nodeId = target.getAttribute("data-node-id");
            replayFromANode(nodeId);

        });

        nodeGroup.selectAll(".jump-btn").on("click", function (event) {
            const fileUri = event.target.getAttribute("data-file-uri");
            const lineNumber = event.target.getAttribute("data-line-number");
            vscode.postMessage({
                command: 'openFileAtLine',
                fileUri: fileUri,
                lineNumber: parseInt(lineNumber, 10)
            });
        });

        nodeGroup.selectAll(".search-btn").on("click", function (event) {
            let target = event.target;
            // Check if the clicked element is an <i> tag
            if (target.tagName.toLowerCase() === 'i') {
                // Redirect the event to the parent button
                target = target.closest('button');
            }
            const nodeId = target.getAttribute("data-node-id");
            // Find the clicked node by its ID
            const clickedNode = nodes.find((node) => node.data.id === nodeId);
            const fileUri = clickedNode.data.fileUri;
            const lineNumber = clickedNode.data.lineNumber;
            const variable = clickedNode.data.variable;
            vscode.postMessage({
                command: 'openZoneWidget',
                fileUri: fileUri,
                lineNumber: parseInt(lineNumber, 10),
                variable: variable
            });
        });

        reAppendInsights();
    }

    function addStickyScroll() {
        // Create a sticky header if it doesn't exist
        let stickyHeader = document.getElementById("sticky-header");
        if (!stickyHeader) {
            stickyHeader = document.createElement("div");
            stickyHeader.id = "sticky-header";
            stickyHeader.style.position = "sticky";
            stickyHeader.style.top = "0";
            stickyHeader.style.background = "white";
            stickyHeader.style.padding = "10px";
            stickyHeader.style.boxShadow = "0 2px 4px rgba(0,0,0,0.1)";
            stickyHeader.style.zIndex = "1000";
            stickyHeader.style.display = "none"; // Initially hidden
            document.body.prepend(stickyHeader);
        }

        const nodeElements = Array.from(document.querySelectorAll(".node"));

        // Add scroll listener
        window.addEventListener("scroll", () => {
            const containerRect = container.getBoundingClientRect();
            const isVisible = containerRect.top < 0;
            if (isVisible) {
                stickyHeader.style.display = "block";
            } else {
                stickyHeader.style.display = "none";
            }
            // Find the first visible node
            const visibleNode = nodeElements.find((node) => {
                let stickyHeaderRect = stickyHeader.getBoundingClientRect();
                const rect = node.getBoundingClientRect();
                return rect.top < stickyHeaderRect.bottom && rect.bottom > stickyHeaderRect.bottom;
            });

            if (visibleNode) {
                // Collect data for the visible node and its ancestors
                const ancestors = [];
                let currentNode = visibleNode.__data__;

                while (currentNode) {
                    ancestors.push(currentNode.data); // Push the ancestor's data
                    currentNode = currentNode.parent; // Move to the parent
                }

                ancestors.reverse();

                // Generate sticky header content with indents
                stickyHeader.innerHTML = ancestors
                    .map((ancestor, index) => {
                        const indent = "&nbsp;".repeat(index * 4); // Add indent for hierarchy
                        if (ancestor.id === "fake-origin") {
                            return `
                                <div class="sticky-header-item"
                                    data-node-id="${generateNodeId(ancestor)}">
                                    <strong>Exploration start point</strong>
                                </div>`;
                        }
                        // highlight the variable in the code line
                        const highlightedLine = ancestor.codeLine.replace(
                            new RegExp(`\\b${ancestor.variable}\\b`, "g"),
                            `<span class="inline-code">${ancestor.variable}</span>`
                        );

                        return `
                            <div 
                                class="sticky-header-item"
                                data-node-id="${generateNodeId(ancestor)}">
                                ${indent}<span class="scroll-header-code">${highlightedLine}</span> in ${ancestor.fileUri.split('/').pop()}, line ${ancestor.lineNumber + 1} 
                            </div>`;
                    })
                    .join("");

                // Add click event listeners to each sticky header item
                document.querySelectorAll(".sticky-header-item").forEach((item) => {
                    item.addEventListener("click", (event) => {
                        const targetNodeId = event.target.getAttribute("data-node-id");
                        const targetNodeElement = document.querySelector(`#node-${targetNodeId}`);
                        if (targetNodeElement) {
                            // Dynamically get the current height of the sticky header
                            const stickyHeader = document.querySelector("#sticky-header");
                            const stickyHeaderHeight = stickyHeader ? stickyHeader.offsetHeight : 0;

                            // Calculate the scroll position, accounting for the sticky header height
                            const targetOffset = targetNodeElement.getBoundingClientRect().top + window.scrollY - stickyHeaderHeight;

                            // Scroll to the calculated position
                            window.scrollTo({
                                top: targetOffset,
                                behavior: "smooth",
                            });
                        }
                    });
                });
            }
        });
    }

    function findParentNodes(root, targetNodeId) {
        function traverse(node, path) {
            if (node.id === targetNodeId) {
                return [...path, node]; // Return full path when the node is found
            }
            for (const child of node.children || []) {
                const result = traverse(child, [...path, node]);
                if (result) return result; // Return immediately when found
            }
            return null;
        }

        return traverse(root, []) || []; // Return an empty array if node not found
    }

    function ensureControlPanelVisibility() {
        if (!replayMode) {
            controlPanel.style.display = "none"; // Hide the control panel if not in replay mode
            return;
        }

        // Get the container's bounding rectangle
        const containerRect = container.getBoundingClientRect();
        const isVisible =
            containerRect.top < window.innerHeight &&
            containerRect.bottom > 0;

        if (isVisible) {
            controlPanel.style.display = "flex"; // Show the control panel when the container is visible
        } else {
            controlPanel.style.display = "none"; // Hide the control panel when the container is not visible
        }
    }

    // Add a scroll event listener to dynamically adjust control panel visibility
    window.addEventListener("scroll", ensureControlPanelVisibility);

    function updateButtonStates() {
        document.getElementById("prev-step").disabled = (currentStepIndex === 0);
        document.getElementById("next-step").disabled = (currentStepIndex >= currentNodes.length - 1);

        document.getElementById("prev-step").style.backgroundColor = (currentStepIndex === 0) ? "#d3d3d3" : "#007acc";
        document.getElementById("next-step").style.backgroundColor = (currentStepIndex >= currentNodes.length - 1) ? "#d3d3d3" : "#007acc";
    }

    function replayFromANode(nodeId) {
        replayMode = true;

        currentNodes = findParentNodes(data, nodeId);
        if (currentNodes.length === 0) {
            console.warn("Node not found in the tree:", nodeId);
            return;
        }

        currentStepIndex = 0;
        ensureControlPanelVisibility();
        animateLines(currentNodes);
    }

    function animateLines(nodes) {
        svg.selectAll(".node, .link").style("opacity", 0.2);
        stepThroughNodes(nodes, 0);
    }

    function stepThroughNodes(nodes, index) {
        if (isPaused) return;
        currentStepIndex = index;
        updateButtonStates();
        const sourceNode = nodes[index];
        // Reset all node-container-box elements: hide nodes and remove border highlights
        document.querySelectorAll(".node").forEach(node => {
            node.style.opacity = "0.2";
            node.style.border = "none";
        });
        document.querySelectorAll(".link").forEach(node => {
            node.style.opacity = "0.2";
        });
        document.querySelectorAll(".node-container-box").forEach(nodeContainer => {
            nodeContainer.style.border = "1px solid #ddd";
        });
        document.getElementById(`node-${generateNodeId(nodes[0])}`).style.opacity = "1";
        // Make visible all nodes from the root up to the current node
        for (let i = 1; i <= index; i++) {
            const nodeContainer = document.getElementById(`node-${generateNodeId(nodes[i])}`);
            if (nodeContainer) {
                nodeContainer.style.opacity = "1";
            }
            const link = d3.select(`#link-${generateNodeId(nodes[i - 1])}-${generateNodeId(nodes[i])}`);
            link.style("opacity", 1);
        }

        // Highlight the border of the current (source) node
        const sourceNodeContainer = document.getElementById(`container-${generateNodeId(sourceNode)}`);
        if (sourceNodeContainer) {
            sourceNodeContainer.style.border = "2px solid #007acc";

            // Scroll to the current node
            const nodeEle = document.getElementById(`node-${generateNodeId(sourceNode)}`);
            if (nodeEle) {
                nodeEle.scrollIntoView({ behavior: "smooth", block: "center" });
            }

            // Generate messages for replay
            const { incomingMessage, outgoingMessage } = generateMessages(nodes, index);
            postReplayMessage(sourceNode, incomingMessage, outgoingMessage);
        }
    }

    function generateMessages(nodes, index) {
        let incomingMessage = "";
        let outgoingMessage = "";

        // Generate incoming message
        if (index === 0 || nodes[index - 1].id === "fake-origin") {
            incomingMessage = "";
        } else {
            const previousNode = nodes[index - 1];
            const currentNode = nodes[index];
            if (currentNode.tool === "definition") {
                incomingMessage = `Found the definition of ${previousNode.variable}`;
            } else if (currentNode.tool === "reference") {
                incomingMessage = `Found another reference of ${previousNode.variable}`;
            } else if (currentNode.tool === "assignment") {
                incomingMessage = `${previousNode.variable} is assigned to ${currentNode.variable}.`;
            }
        }

        // Generate outgoing message
        if (index + 1 >= nodes.length) {
            outgoingMessage = "";
        } else {
            const nextNode = nodes[index + 1];
            const currentNode = nodes[index];
            if (currentNode.id === "fake-origin") {
                outgoingMessage = `Next, explore ${nextNode.variable} from your selected code.`;
            } else if (nextNode.tool === "definition") {
                outgoingMessage = `Next, find the definition of ${currentNode.variable}`;
            } else if (nextNode.tool === "reference") {
                outgoingMessage = `Next, find another reference of ${currentNode.variable}`;
            } else if (nextNode.tool === "assignment") {
                outgoingMessage = `Next, find another variable that ${currentNode.variable} is assigned to.`;
            }
        }

        return { incomingMessage, outgoingMessage };
    }

    document.getElementById("prev-step").addEventListener("click", function () {
        if (currentStepIndex <= 0) return; // No previous step
        currentStepIndex--; // Move back one step
        stepThroughNodes(currentNodes, currentStepIndex);
    });

    document.getElementById("next-step").addEventListener("click", function () {
        if (currentStepIndex < 0) return; // No previous step
        currentStepIndex++; // Move back one step
        stepThroughNodes(currentNodes, currentStepIndex);
    });

    // Define the exit-replay functionality
    document.getElementById("exit-replay").addEventListener("click", function () {
        // 1. Hide the control panel
        controlPanel.style.display = "none";

        // 2. Reset the opacity of all nodes and links
        svg.selectAll(".node, .link").style("opacity", 1);

        // 3. Reset the border of all node-container-box elements
        document.querySelectorAll(".node-container-box").forEach(nodeContainer => {
            nodeContainer.style.border = "1px solid #ddd";
        });

        // 4. Handle replay variables
        replayMode = false; // Reset the replay mode
        currentNodes = []; // Clear the current replay nodes
        currentStepIndex = 0; // Reset the replay step index
    });

    function postReplayMessage(node, incomingMessage, outgoingMessage) {
        vscode.postMessage({
            command: "replaySnippet",
            fileUri: node.fileUri,
            lineNumber: node.lineNumber,
            variable: node.variable,
            finding: node.statement,
            incomingMessage: incomingMessage,
            outgoingMessage: outgoingMessage
        });
    }

    // Initial render
    drawGraph();
    addStickyScroll();

    if (startWalkthrough) {
        replayFromANode(startWalkthrough);
    }

    // Make the graph responsive
    window.addEventListener("resize", () => {
        drawGraph(); // Redraw the graph on resize
        reAppendInsights(); // Re-append insights to their containers
    });
}

