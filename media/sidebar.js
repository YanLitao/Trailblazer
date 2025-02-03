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

            // Append the cleaned insight container
            insightContainer.appendChild(clonedInsightContainer);

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
        case 'appendHtml':
            appendHtml(message.html, message.id, message.num);
            break;
        case 'updateStatus':
            updateStatus(message.status);
            break;
        case 'updateCurrentTaskContent':
            updateCurrentTaskContent(message.html, message.id, message.num);
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
                    if (snippetKey && snippetKey !== -1) {
                        insightHTML = insight.innerHTML.replace(/\[<span class="citation-ref"[^>]*>.*?<\/span>\]/g, "");
                        insightMap.set(snippetKey, insightHTML);
                    }
                });

                reAppendInsights();

                if (message.answer.includes("Final Answer")) {
                    document.getElementById('still-to-be-found').style.display = 'none';
                    document.getElementById('actions').style.display = 'none';
                    document.getElementById('current-task').display = 'none';
                }

            }
            break;
        case 'updateExplorationSummary':
            if (message.summary.includes("Final Answer: ")) {
                document.getElementById('still-to-be-found').innerHTML = message.summary;
                document.getElementById('searching-content').style.display = 'none';
            } else {
                document.getElementById('exploration-summary').innerText = message.summary;
            }
            break;
        case 'appendFindings':
            appendFindingsHtml(message.html);
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
    }
});

function updateSearchingContent(content) {
    const searchingContentDiv = document.getElementById('searching-content');
    const maxMessages = 1;
    // Create new message element
    const newMessage = document.createElement('div');
    newMessage.className = 'search-message fade-in';
    newMessage.textContent = content;

    // Add the new message to the queue
    searchingContentDiv.appendChild(newMessage);
    messageQueue.push(newMessage);

    setTimeout(() => {
        newMessage.classList.add('fade-out');
    }, 15000);

    // Ensure we only keep the last 3 messages
    if (messageQueue.length > maxMessages) {
        const oldMessage = messageQueue.shift();
        setTimeout(() => oldMessage.remove(), 500); // Remove after fade-out
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
    document.getElementById('still-to-be-found').style.display = 'block';
    document.getElementById('actions').style.display = 'block';
    document.getElementById('final-answer-header').innerHTML = 'Preliminary Answer';
    document.getElementById('searching-content').style.display = 'block';
    document.getElementById('current-task').style.display = 'block';
    updateStatus('Searching');
    const pauseButton = document.getElementById('pause-agent');
    const icon = pauseButton.querySelector('i');
    icon.classList.remove('fa-play');
    icon.classList.add('fa-pause');
}

const infoIcon = document.getElementById('info-icon');
const infoContainer = document.getElementById('info-box');

infoIcon.addEventListener("mouseover", function () {
    // Get the bounding box of the info-icon
    const iconRect = infoIcon.getBoundingClientRect();

    // Position the info-box just below the info-icon
    infoContainer.style.top = `${iconRect.bottom + 5}px`; // 5px margin below the icon
    infoContainer.style.left = `${iconRect.left}px`;

    // Show the info-box
    infoContainer.style.display = "block";
});

infoIcon.addEventListener("mouseout", function (event) {
    // Check if the mouse is moving to the info-box itself
    if (!infoContainer.contains(event.relatedTarget)) {
        infoContainer.style.display = "none";
    }
});

infoContainer.addEventListener("mouseleave", function () {
    infoContainer.style.display = "none";
});

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
        return true; // Indicate that this node or its descendant matches
    }

    // Recursively check children
    let isAncestor = false;
    if (treeNode.children && treeNode.children.length > 0) {
        treeNode.children.forEach(child => {
            const childResult = updateNodeAndAncestors(child, targetSnippetKey);
            if (childResult) {
                isAncestor = true;
            }
        });
    }

    // If any child matched, this node is an ancestor, so update it
    if (isAncestor) {
        treeNode.hidden = 2;
    }

    return isAncestor; // Indicate whether this node or its descendants matched
}

document.addEventListener("click", function (event) {
    if (event.target.classList.contains("citation-ref")) {
        const refId = parseInt(event.target.getAttribute("data-ref"), 10); // Get the snippetKey from the clicked element

        // Update the target node and its ancestors
        const updated = updateNodeAndAncestors(graphData, refId);

        if (!updated) {
            console.warn(`Node with snippetKey "${refId}" not found in graphData.`);
            return;
        }

        // Redraw the graph to reflect the changes
        renderGraph(graphData);

        // Scroll to the updated node
        const updatedNode = document.getElementById(`node-${generateNodeId(findNodeBySnippetKey(graphData, refId))}`);
        if (updatedNode) {
            updatedNode.scrollIntoView({ behavior: "smooth" });
        }
    } else if (event.target.classList.contains("insight")) {
        const fileUri = event.target.getAttribute("data-file-uri");
        const lineNumber = event.target.getAttribute("data-line-number");

        if (fileUri && lineNumber) {
            vscode.postMessage({
                command: 'openFileAtLine',
                fileUri: fileUri,
                lineNumber: parseInt(lineNumber, 10)
            });
        }
    }
});

document.addEventListener("mouseover", function (event) {
    if (event.target.classList.contains("citation-ref")) {
        const refId = parseInt(event.target.getAttribute("data-ref"), 10); // Get the snippetKey
        const node = findNodeBySnippetKey(graphData, refId); // Find the node in graphData

        if (!node) {
            console.warn(`Node with snippetKey "${refId}" not found in graphData.`);
            return;
        }

        // Extract file URI, line number, and code snippet
        const { fileUri, lineNumber, codeSnippet } = node;

        // Create tooltip element
        const tooltip = document.createElement("div");
        tooltip.classList.add("tooltip");

        // Add a header with file and line information
        const fileName = fileUri ? fileUri.split("/").pop() : "Unknown file";
        const header = `<div class="tooltip-header">
                            ${fileName}, line ${lineNumber}:
                        </div>`;

        // Add the code content
        const codeContent = `<div class="tooltip-content">${codeSnippet}</div>`;

        // Combine header and code content
        tooltip.innerHTML = header + codeContent;

        // Style and append the tooltip
        document.body.appendChild(tooltip);

        // Calculate position
        const rect = event.target.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;

        if (spaceBelow >= tooltipRect.height || spaceBelow > spaceAbove) {
            // Position below the citation-ref
            tooltip.style.top = `${rect.bottom + window.scrollY + 5}px`;
            tooltip.style.left = `${rect.left + window.scrollX}px`;
        } else {
            // Position above the citation-ref
            tooltip.style.top = `${rect.top + window.scrollY - tooltipRect.height - 5}px`;
            tooltip.style.left = `${rect.left + window.scrollX}px`;
        }

        // Show the tooltip
        tooltip.style.position = "absolute";
        tooltip.style.zIndex = "1000";

        // Add event to remove tooltip on mouseout
        event.target.addEventListener("mouseout", function hideTooltip() {
            tooltip.remove();
            event.target.removeEventListener("mouseout", hideTooltip);
        });
    }
});

// control showing the preliminary answer
function toggleDetails() {
    const container = document.getElementById("details-container");
    const button = document.getElementById("toggle-details-btn");

    if (container.style.display === "none") {
        container.style.display = "block";
        button.textContent = "Hide Details";
    } else {
        container.style.display = "none";
        button.textContent = "Show Details";
    }
}

// JavaScript to toggle additional invocations
function toggleAdditionalInvocations(elementId) {
    const element = document.getElementById(elementId);
    const currentTaskUniqueId = elementId.split('-show-more')[0]; // Get unique ID part
    const additionalInvocations = document.getElementById(`${currentTaskUniqueId}-additional-invocations`);

    if (!additionalInvocations) {
        return;
    }

    if (additionalInvocations.style.display === 'none') {
        additionalInvocations.style.display = 'block';
        element.style.display = 'none'; // Hide the "show more" link after clicking
    } else {
        additionalInvocations.style.display = 'none';
        element.style.display = 'block';
    }
}

// Function to append HTML content dynamically
function appendHtml(html, id, num) {
    const explorationSteps = document.getElementById('exploration-steps');
    explorationSteps.insertAdjacentHTML('beforeend', html);
    setupJumpToLine(); // Set up the jump-to-line functionality
    if (num >= 0) {
        setupToggleDetails(id, num); // Set up the toggle details functionality
    }

}

function appendFindingsHtml(html) {
    // Append the HTML content to findings
    if (!html) {
        return;
    }
    const findingsContainer = document.getElementById('findings');
    findingsContainer.innerHTML = html;

    // Add click event listeners for the .code-wrapper elements
    findingsContainer.querySelectorAll('.code-wrapper').forEach((wrapper) => {
        wrapper.addEventListener('click', (event) => {
            event.stopPropagation();  // Stop the event from bubbling up

            // Toggle visibility of the .parent-node-info div
            const parentNodeInfo = wrapper.querySelector('.parent-node-info');
            if (parentNodeInfo) {
                // Toggle display between 'none' and 'block'
                parentNodeInfo.style.display = parentNodeInfo.style.display === 'none' ? 'block' : 'none';
            }
        });
    });

    setupJumpToLine();
}

function appendPath(pathHtml, nodeId) {
    // Find the code-wrapper div by data-node-id attribute
    const codeWrapper = document.querySelector(`.code-wrapper[data-node-id="${nodeId}"]`);

    if (!codeWrapper) {
        console.warn(`No code-wrapper found with data-node-id: ${nodeId}`);
        return;
    }

    // Get the .parent-node-info div within the selected code-wrapper
    const parentNodeInfo = codeWrapper.querySelector('.parent-node-info');

    if (!parentNodeInfo) {
        console.warn(`No .parent-node-info found within code-wrapper with data-node-id: ${nodeId}`);
        return;
    }

    // Set the HTML content of .parent-node-info to the pathHtml
    parentNodeInfo.innerHTML = pathHtml;
    parentNodeInfo.style.display = 'block';  // Make sure it is visible
}

// Add click event listeners to the titles that contain line numbers
function setupJumpToLine() {
    document.querySelectorAll('.line-link').forEach(element => {
        element.addEventListener('click', () => {
            const fileUri = element.getAttribute('data-file-uri');
            const lineNumber = parseInt(element.getAttribute('data-line'));

            // Send a message to VSCode to jump to the line in the given file
            vscode.postMessage({
                command: 'openFileAtLine',
                fileUri: fileUri,
                lineNumber: lineNumber
            });
        });
    });
}

function setupToggleDetails(id, num) {
    for (let i = 0; i <= num; i++) {
        document.getElementById(id + "-btn-" + i).addEventListener('click', function () {
            const targetId = this.getAttribute('data-target'); // 'this' refers to the clicked button
            const targetElement = document.getElementById(targetId);
            const triangle = this.querySelector('.triangle-right, .triangle-down'); // Select the triangle

            if (targetElement.style.display === 'none') {
                targetElement.style.display = 'block';
                triangle.classList.remove('triangle-right');
                triangle.classList.add('triangle-down'); // Change to down-pointing triangle
            } else {
                targetElement.style.display = 'none';
                triangle.classList.remove('triangle-down');
                triangle.classList.add('triangle-right'); // Change to right-pointing triangle
            }
        });
    }
}

function updateStatus(status) {
    const statusText = document.getElementById('agent-status-text');

    if (!statusText) return;

    // Update text and class based on status
    switch (status) {
        case 'Searching':
            statusText.textContent = 'Searching';
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

function updateCurrentTaskContent(html, id, num) {
    document.getElementById('current-task-content').innerHTML = html;
    setupJumpToLine(); // Set up the jump-to-line functionality
    if (num >= 0) {
        setupToggleDetails(id, num); // Set up the toggle details functionality
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
    const fileName = data.fileUri.split('/').pop(); // Get the file name
    return `${fileName}_${data.lineNumber}_${data.variable}`.replace(/[^\w-]/g, "_");
}

function renderGraph(data) {
    const container = document.getElementById("graph-container");
    container.innerHTML = ""; // Clear previous graph

    // Create the replay control panel
    const controlPanel = document.createElement("div");
    controlPanel.id = "control-panel";
    controlPanel.style.display = "none"; // Initially hidden
    controlPanel.innerHTML = `
        <button id="start-over"><i class="fa-solid fa-backward-fast"></i></button>
        <button id="prev-step"><i class="fa-solid fa-backward-step"></i></button>
        <button id="play-pause"><i class="fa-solid fa-pause"></i></button>
        <button id="next-step"><i class="fa-solid fa-forward-step"></i></button>
        <button id="jump-to-end"><i class="fa-solid fa-forward-fast"></i></button>
        <button id="exit-replay"><i class="fa-solid fa-times"></i></button>
    `;
    container.appendChild(controlPanel);

    const margin = { top: 20, right: 30, bottom: 20, left: 30 };

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
                const snippetHeight = getCodeSnippetHeight(d.data.codeSnippet, d.data.statement, d.data.hidden);
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
            .on("click", (event, d) => {
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
                if (d.data.hidden === 1) return "+"; // Expand indicator
                if (d.data.hidden === 2) return "-"; // Collapse indicator
                return ""; // No text if hidden = 0
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
            .attr("height", d => getCodeSnippetHeight(d.data.codeSnippet, d.data.statement, d.data.hidden))
            .html(d => {
                // Description Text for Each Node
                let descriptionHTML = "";
                if (d.data.id === "fake-origin") {
                    descriptionHTML = `<div class="node-description">Selected the code snippet: ${d.data.fileUri.split('/').pop()}, line ${d.data.lineNumber + 1}.</div>
                    `;
                } else if (d.parent && d.parent.data.id === "fake-origin") {
                    // Node with fake-origin as parent
                    descriptionHTML = `
                        <div class="node-description">
                            I explored <span class="inline-code">${d.data.variable}</span> 
                            in ${d.data.fileUri.split('/').pop()}, line ${d.data.lineNumber + 1} 
                            from your selected code snippet.
                        </div>
                    `;
                } else if (d.data.tool === "reference") {
                    // Reference Node
                    const parentInfo = d.parent.data.variable;
                    descriptionHTML = `
                        <div class="node-description">
                            I found <span class="inline-code">${d.data.variable}</span> 
                            in ${d.data.fileUri.split('/').pop()}, line ${d.data.lineNumber + 1}
                            is another reference to ${parentInfo}.
                        </div>
                    `;
                } else if (d.data.tool === "assignment") {
                    const parentInfo = d.parent.data.variable;
                    descriptionHTML = `
                        <div class="node-description">
                            I found the derivation of <span class="inline-code">${d.data.variable}</span>
                            in ${d.data.fileUri.split('/').pop()}, line ${d.data.lineNumber + 1}, related to ${parentInfo}.
                        </div>
                    `;
                } else {
                    // Default Case
                    descriptionHTML = `
                        <div class="node-description">
                            I found the definition of <span class="inline-code">${d.data.variable}</span>
                            in ${d.data.fileUri.split('/').pop()}, line ${d.data.lineNumber + 1}.
                        </div>
                    `;
                }

                let borderStyle = d.data.isIntermediate ? "1px dashed #aaa" : "1px solid #aaa";
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
                            return `<span class="code-line" style="background-color: #f9f9f9;">${highlightedLine}</span>`;
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
                                <!-- Replay Button -->
                                <button class="replay-btn" title="Replay" data-node-id="${d.data.id}">
                                    <i class="fas fa-undo-alt"></i> Replay
                                </button>
                                <!-- Jump to Line Button -->
                                <button class="jump-btn" title="Jump to Editor" data-file-uri="${d.data.fileUri}" data-line-number="${d.data.lineNumber}">
                                    <i class="fas fa-arrow-right"></i> Go to line
                                </button>
                                <!-- Search Button -->
                                <button class="search-btn" title="Search" data-node-id="${d.data.id}">
                                    <i class="fas fa-search"></i> Search
                                </button>
                            </div>
                        </div>
                    </div>
                `;
                if (!d.data.isIntermediate) {
                    htmlContent += `
                        <div class="tree-node-finding">
                            <strong>Finding:</strong> ${d.data.statement}
                        </div>
                    `;
                }
                return htmlContent;
            });

        nodeGroup.selectAll(".replay-btn").on("click", function (event) {
            replayMode = true;
            const nodeId = event.target.getAttribute("data-node-id");

            // Find the clicked node by its ID
            const clickedNode = nodes.find((node) => node.data.id === nodeId);

            if (!clickedNode) {
                console.error("Node not found!");
                return;
            }

            currentNodes = findParentNodes(clickedNode);
            currentStepIndex = 0;
            ensureControlPanelVisibility();
            animateLines(currentNodes);
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
            const nodeId = event.target.getAttribute("data-node-id");
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

    // Function to calculate the height of a code snippet rectangle
    function getCodeSnippetHeight(codeSnippet, statement, hidden = false) {

        if (hidden == 0) {
            return 0; // Return 0 height for hidden nodes
        }

        const tempDiv = document.createElement("div");
        tempDiv.style.visibility = "hidden";
        tempDiv.style.position = "absolute";
        tempDiv.style.font = "12px monospace";
        tempDiv.style.width = `${container.offsetWidth - margin.right - margin.left - 30}px`;

        // Include both the code snippet and statement in the temporary div
        let htmlContent = `
            <div class="tree-node">
                <div class="node-description">Node description</div>
            </div>
        `;

        if (hidden == 2) {
            htmlContent += `
            <div class="node-container-box">
                <div class="tree-node code-box">
                    <div class="code-container">
                        <code style="white-space: pre;">${codeSnippet}</code>
                    </div>
                    <div class="tree-node-button-container">
                        <button class="replay-btn" title="Replay"><i class="fas fa-undo-alt"></i> Replay</button>
                        <button class="jump-btn" title="Jump to Editor"><i class="fas fa-arrow-right"></i> Go to line</button>
                        <button class="search-btn" title="Search"><i class="fas fa-search"></i> Search</button>
                    </div>
                </div>
            </div>`;
            if (statement !== "") {
                htmlContent += `
                <div class="tree-node-finding">
                    <strong>Finding:</strong> ${statement}
                </div>
            `;
            }
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
                            `<span class="inline-variable">${ancestor.variable}</span>`
                        );

                        return `
                            <div 
                                class="sticky-header-item"
                                data-node-id="${generateNodeId(ancestor)}">
                                ${indent}${ancestor.fileUri.split('/').pop()}, line ${ancestor.lineNumber + 1}: <span class="inline-code">${highlightedLine}</span>
                            </div>`;
                    })
                    .join("");

                // Add click event listeners to each sticky header item
                document.querySelectorAll(".sticky-header-item").forEach((item) => {
                    item.addEventListener("click", (event) => {
                        const targetNodeId = event.target.getAttribute("data-node-id");
                        const targetNodeElement = document.querySelector(`#node-${targetNodeId}`);
                        if (targetNodeElement) {
                            console.log("targetNodeElement: ", targetNodeElement);

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

    function findParentNodes(node) {
        const parents = [];
        let current = node;

        while (current) {
            parents.push(current);
            current = current.parent || null; // Ensure `parent` is checked
        }

        return parents.reverse(); // Reverse to get top-down order
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

    function animateLines(nodes) {
        svg.selectAll(".node, .link").style("opacity", 0.2);
        stepThroughNodes(nodes, 0);
    }

    function stepThroughNodes(nodes, index) {
        if (isPaused) return;
        currentStepIndex = index;
        const sourceNode = nodes[index];
        d3.select(`#node-${generateNodeId(sourceNode.data)}`).style("opacity", 1);
        // scroll to the node in the graph
        const nodeEle = document.getElementById(`node-${generateNodeId(sourceNode.data)}`);
        nodeEle.scrollIntoView({ behavior: "smooth", block: "center" });

        if (index >= nodes.length - 1) return; // Stop if we've reached the last node

        const targetNode = nodes[index + 1];
        d3.select(`#link-${generateNodeId(sourceNode.data)}-${generateNodeId(targetNode.data)}`).style("opacity", 1);

        // Generate incoming and outgoing messages
        const { incomingMessage, outgoingMessage } = generateMessages(nodes, index);

        // Schedule the next step
        let timeout = 8000; // Default timeout
        if (index === 0) timeout = 5000;
        currentTimeout = setTimeout(() => {
            postReplayMessage(targetNode, incomingMessage, outgoingMessage);
            stepThroughNodes(nodes, index + 1);
        }, timeout);
    }

    function generateMessages(nodes, index) {
        let incomingMessage = "";
        let outgoingMessage = "";

        // Generate incoming message
        if (index === 0 || nodes[index - 1].data.id === "fake-origin") {
            incomingMessage = "";
        } else {
            const previousNode = nodes[index - 1];
            const currentNode = nodes[index];
            if (currentNode.data.tool === "definition") {
                incomingMessage = `Found the definition of ${previousNode.data.variable}`;
            } else if (currentNode.data.tool === "reference") {
                incomingMessage = `Found another reference of ${previousNode.data.variable}`;
            } else if (currentNode.data.tool === "assignment") {
                incomingMessage = `${previousNode.data.variable} is assigned to ${currentNode.data.variable}.`;
            }
        }

        // Generate outgoing message
        if (index + 1 >= nodes.length) {
            outgoingMessage = "";
        } else {
            const nextNode = nodes[index + 1];
            const currentNode = nodes[index];
            if (currentNode.data.id === "fake-origin") {
                outgoingMessage = `Next, explore ${nextNode.data.variable} from your selected code.`;
            } else if (nextNode.data.tool === "definition") {
                outgoingMessage = `Next, find the definition of ${currentNode.data.variable}`;
            } else if (nextNode.data.tool === "reference") {
                outgoingMessage = `Next, find another reference of ${currentNode.data.variable}`;
            } else if (nextNode.data.tool === "assignment") {
                outgoingMessage = `Next, find another variable that ${currentNode.data.variable} is assigned to.`;
            }
        }

        return { incomingMessage, outgoingMessage };
    }

    document.getElementById("play-pause").addEventListener("click", function () {
        isPaused = !isPaused;

        const icon = this.querySelector("i");
        if (isPaused) {
            icon.classList.remove("fa-pause");
            icon.classList.add("fa-play");
            if (currentTimeout) clearTimeout(currentTimeout); // Pause the animation
        } else {
            icon.classList.remove("fa-play");
            icon.classList.add("fa-pause");

            // Generate messages for the current step
            const { incomingMessage, outgoingMessage } = generateMessages(currentNodes, currentStepIndex);
            postReplayMessage(currentNodes[currentStepIndex], incomingMessage, outgoingMessage);
            stepThroughNodes(currentNodes, currentStepIndex); // Resume the animation
        }
    });

    document.getElementById("prev-step").addEventListener("click", function () {
        if (currentStepIndex <= 0) return; // No previous step

        // Reset opacity of the current node and link
        const currentNode = currentNodes[currentStepIndex];
        const previousNode = currentNodes[currentStepIndex - 1];
        d3.select(`#node-${generateNodeId(currentNode.data)}`).style("opacity", 0.2);
        d3.select(`#link-${generateNodeId(previousNode.data)}-${generateNodeId(currentNode.data)}`).style("opacity", 0.2);

        currentStepIndex--; // Move back one step

        // Restore opacity for the previous step
        d3.select(`#node-${generateNodeId(previousNode.data)}`).style("opacity", 1);
        if (currentStepIndex > 0) {
            const secondPreviousNode = currentNodes[currentStepIndex - 1];
            d3.select(`#link-${generateNodeId(secondPreviousNode.data)}-${generateNodeId(previousNode.data)}`).style("opacity", 1);
        }

        // Generate messages for the previous step
        const { incomingMessage, outgoingMessage } = generateMessages(currentNodes, currentStepIndex);
        postReplayMessage(previousNode, incomingMessage, outgoingMessage);

        // Scroll to the previous node
        document.getElementById(`node-${generateNodeId(previousNode.data)}`).scrollIntoView({ behavior: "smooth", block: "center" });
    });

    document.getElementById("next-step").addEventListener("click", function () {
        if (currentStepIndex >= currentNodes.length - 1) return; // No next step

        const currentNode = currentNodes[currentStepIndex];
        const nextNode = currentNodes[currentStepIndex + 1];

        // Update opacity for the current step and next step
        d3.select(`#node-${generateNodeId(currentNode.data)}`).style("opacity", 1);
        d3.select(`#link-${generateNodeId(currentNode.data)}-${generateNodeId(nextNode.data)}`).style("opacity", 1);
        d3.select(`#node-${generateNodeId(nextNode.data)}`).style("opacity", 1);

        currentStepIndex++; // Move forward one step

        // Generate messages for the next step
        const { incomingMessage, outgoingMessage } = generateMessages(currentNodes, currentStepIndex);
        postReplayMessage(nextNode, incomingMessage, outgoingMessage);

        // Scroll to the next node
        document.getElementById(`node-${generateNodeId(nextNode.data)}`).scrollIntoView({ behavior: "smooth", block: "center" });
    });

    document.getElementById("start-over").addEventListener("click", function () {
        if (!currentNodes.length) return; // No nodes to process

        const firstNode = currentNodes[0]; // Get the first node

        // Reset opacity for all nodes and links
        svg.selectAll(".node, .link").style("opacity", 0.2);

        // Generate messages for the first step
        const { incomingMessage, outgoingMessage } = generateMessages(currentNodes, 0);
        postReplayMessage(firstNode, incomingMessage, outgoingMessage);

        // Restart the animation
        currentStepIndex = 0; // Reset the step index
        stepThroughNodes(currentNodes, currentStepIndex);
    });

    document.getElementById("jump-to-end").addEventListener("click", function () {
        if (!currentNodes.length) return; // No nodes to process

        const lastNode = currentNodes[currentNodes.length - 1]; // Get the last node

        // Set opacity for all nodes and links in the path
        currentNodes.forEach((node, index) => {
            d3.select(`#node-${generateNodeId(node.data)}`).style("opacity", 1); // Highlight node
            if (index > 0) {
                const previousNode = currentNodes[index - 1];
                d3.select(`#link-${generateNodeId(previousNode.data)}-${generateNodeId(node.data)}`).style("opacity", 1); // Highlight link
            }
        });

        // Generate messages for the last step
        const { incomingMessage, outgoingMessage } = generateMessages(currentNodes, currentNodes.length - 1);
        postReplayMessage(lastNode, incomingMessage, outgoingMessage);

        // Update the step index to the last node
        currentStepIndex = currentNodes.length - 1;

        // Scroll to the last node
        document.getElementById(`node-${generateNodeId(lastNode.data)}`).scrollIntoView({ behavior: "smooth", block: "center" });
    });

    // Define the exit-replay functionality
    document.getElementById("exit-replay").addEventListener("click", function () {
        // 1. Hide the control panel
        controlPanel.style.display = "none";

        // 2. Reset the opacity of all nodes and links
        svg.selectAll(".node, .link").style("opacity", 1);

        // 3. Handle replay variables
        isPaused = false; // Reset the pause state
        replayMode = false; // Reset the replay mode
        if (currentTimeout) {
            clearTimeout(currentTimeout); // Clear any ongoing timeout to stop replay
            currentTimeout = null; // Reset the timeout reference
        }
        currentNodes = []; // Clear the current replay nodes
        currentStepIndex = 0; // Reset the replay step index
    });

    function postReplayMessage(node, incomingMessage, outgoingMessage) {
        vscode.postMessage({
            command: "replaySnippet",
            fileUri: node.data.fileUri,
            lineNumber: node.data.lineNumber,
            variable: node.data.variable,
            finding: node.data.statement,
            incomingMessage: incomingMessage,
            outgoingMessage: outgoingMessage
        });
    }

    // Initial render
    drawGraph();
    addStickyScroll();

    // Make the graph responsive
    window.addEventListener("resize", () => {
        drawGraph(); // Redraw the graph on resize
        reAppendInsights(); // Re-append insights to their containers
    });
}

