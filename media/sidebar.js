
const vscode = acquireVsCodeApi(); // This gives us access to the VSCode API

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
        case 'updatePreliminaryAnswer':
            const answerDiv = document.getElementById('preliminary-answer-text');

            // De-highlight previous findings
            if (message.answer) {
                answerDiv.innerHTML = message.answer;
                document.querySelectorAll('.additional-finding').forEach(finding => {
                    finding.addEventListener('click', function () {
                        const hiddenStatement = this.nextElementSibling;
                        if (hiddenStatement) {
                            hiddenStatement.style.display =
                                hiddenStatement.style.display === 'none' ? 'block' : 'none';
                        }
                    });
                });
            }
            break;
        case 'updateExplorationSummary':
            if (message.summary.includes("Final Answer: ")) {
                document.getElementById('still-to-be-found').innerHTML = message.summary;
            } else {
                document.getElementById('exploration-summary').innerText = message.summary;
            }
            break;
        case 'appendFindings':
            appendFindingsHtml(message.html);
            break;
        case 'renderGraph':
            renderGraph(message.data);
            break;
        case 'updateTitleQuestion':
            document.getElementById('title-question').innerText = message.question;
            break;
    }
});

document.getElementById('save-pdf').addEventListener('click', function () {
    var element = document.body;
    html2pdf().from(element).save('search-copilot.pdf');
});

// Add event listener for watch mode toggle switch
document.getElementById('watch-mode-toggle').addEventListener('change', (event) => {
    const isActive = event.target.checked;

    // Send a message to the extension to toggle watch mode
    vscode.postMessage({
        command: 'toggleWatchMode',
        isActive: isActive
    });
});

// Function to toggle the visibility of the exploration steps
document.getElementById('toggle-log').addEventListener('click', function () {
    const explorationSteps = document.getElementById('exploration-steps');

    if (explorationSteps.style.display === 'none' || explorationSteps.style.display === '') {
        // Show the exploration steps
        explorationSteps.style.display = 'block';
        document.getElementById('toggle-log').innerText = 'Hide full log';
    } else {
        // Hide the exploration steps
        explorationSteps.style.display = 'none';
        document.getElementById('toggle-log').innerText = 'See full log';
    }
});

document.getElementById('continue-agent').addEventListener('click', function () {
    vscode.postMessage({
        command: 'continueAgent'
    });
});

document.getElementById('pause-agent').addEventListener('click', function () {
    vscode.postMessage({
        command: 'pauseAgent'
    });
});

document.getElementById('stop-agent').addEventListener('click', function () {
    vscode.postMessage({
        command: 'stopAgent'
    });
});

document.addEventListener("click", function (event) {
    if (event.target.classList.contains("citation-ref")) {
        const refId = event.target.getAttribute("data-ref");
        const targetCodeBox = document.querySelector(`.code-box .code-index[data-ref="${refId}"]`);

        if (targetCodeBox) {
            targetCodeBox.scrollIntoView({ behavior: "smooth", block: "center" });
            targetCodeBox.classList.add("highlight");
            setTimeout(() => targetCodeBox.classList.remove("highlight"), 2000);
        }
    }
});

document.addEventListener("mouseover", function (event) {
    if (event.target.classList.contains("citation-ref")) {
        const refId = event.target.getAttribute("data-ref");
        const targetCodeBox = document.querySelector(`.code-box .code-index[data-ref="${refId}"]`);

        if (targetCodeBox) {
            // Create tooltip element
            let tooltip = document.createElement("div");
            tooltip.classList.add("tooltip");
            tooltip.innerHTML = targetCodeBox.parentElement.innerHTML; // Set tooltip content
            document.body.appendChild(tooltip);

            // Calculate position
            const rect = event.target.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const spaceAbove = rect.top;
            const spaceBelow = window.innerHeight - rect.bottom;

            if (spaceBelow >= tooltipRect.height || spaceBelow > spaceAbove) {
                // Position below
                tooltip.style.top = `${rect.bottom + window.scrollY + 5}px`;
                tooltip.style.left = `${rect.left + window.scrollX}px`;
            } else {
                // Position above
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
    }
});

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
    Prism.highlightAll(); // Highlight the newly added code using Prism.js
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
    Prism.highlightAll(); // Highlight the newly added code using Prism.js
    setupJumpToLine(); // Set up the jump-to-line functionality
    if (num >= 0) {
        setupToggleDetails(id, num); // Set up the toggle details functionality
    }
}

function renderGraph(data) {
    const container = document.getElementById("graph-container");
    container.innerHTML = ""; // Clear previous graph

    const margin = { top: 20, right: 80, bottom: 20, left: 80 };

    // Create the SVG container
    const svg = d3.select(container)
        .append("svg")
        .style("font", "12px sans-serif");

    console.log("we get a tree data: ", data);

    function drawGraph() {
        const width = container.offsetWidth;
        const nodeSize = 30;

        // Clear existing content in SVG
        svg.selectAll("*").remove();

        const root = d3.hierarchy(data);

        // Calculate vertical positions dynamically based on rectangle heights
        let yOffset = margin.top; // Initial y-offset
        root.eachBefore(d => {
            const snippetHeight = getCodeSnippetHeight(d.data.codeSnippet);
            const labelHeight = 20; // Approximate label height
            d.yOffset = yOffset; // Store yOffset for the node
            yOffset += snippetHeight + labelHeight + 20; // Add spacing between nodes
        });

        const nodes = root.descendants();
        const links = root.links();
        const height = yOffset + margin.bottom; // Total height of the graph

        svg.attr("width", width).attr("height", height);

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
            .attr("id", (d, i) => `link-${generateNodeId(d.source.data)}-${generateNodeId(d.target.data)}`) // Unique ID for each link
            .attr("d", d => {
                const path = d3.path(); // Create a new path object
                path.moveTo(d.source.depth * nodeSize, d.source.yOffset); // Move to source
                path.lineTo(d.source.depth * nodeSize, d.target.yOffset); // Vertical line to target's level
                path.lineTo((d.source.depth + 1) * nodeSize, d.target.yOffset); // Horizontal line to target's depth
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
            .attr("r", 10) // Larger circle for better display
            .attr("fill", "#aaa")
            .attr("stroke", "#333");

        nodeGroup.append("text")
            .attr("x", d => d.depth * nodeSize)
            .attr("dy", "0.32em")
            .attr("text-anchor", "middle")
            .attr("fill", "white")
            .style("font-size", "10px")
            .text(d => {
                if (d.data.snippetKey !== -1) return d.data.snippetKey; // Add snippetKey for labeled nodes
                if (d.data.isIntermediate) return "";
                return "";
            });
        /* .on("click", function (event, d) {
            if (d.data.isIntermediate) {
                const rect = d3.select(`#${generateNodeId(d.data)}`); // Use sanitized ID
                const isVisible = rect.attr("display") === "block";
                rect.attr("display", isVisible ? "none" : "block");
                d3.select(this).text(isVisible ? "+" : "-"); // Toggle sign
            }
        }); */

        // Add text labels
        nodeGroup.append("text")
            .attr("x", d => d.depth * nodeSize + 20)
            .attr("dy", "0.32em")
            .text(d => {
                if (d.data.id === "fake-origin") {
                    return "Exploration start point"; // Label for fake origin
                }
                return `${d.data.fileUri.split('/').pop()}:${d.data.lineNumber + 1}:${d.data.variable}`;
            });

        // Add code snippets as rectangles
        nodeGroup.append("foreignObject")
            .attr("id", d => `box-${generateNodeId(d.data)}`) // Use sanitized ID for toggling visibility
            .attr("x", d => d.depth * nodeSize + 10)
            .attr("y", 20) // Position below the text label
            .attr("width", width - margin.right - margin.left - 30) // Adjust for container size
            .attr("height", d => getCodeSnippetHeight(d.data.codeSnippet) + 50) // Add space for buttons
            .html(d => {
                if (d.data.id === "fake-origin") return ""; // No rect for fake origin
                return `
            <div class="tree-node code-box" style="border: ${d.data.isIntermediate ? "1px dashed #aaa" : "1px solid #aaa"}">
                <code style="white-space: pre;">${d.data.codeSnippet}</code>
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
                    <button class="search-btn" title="Search" data-file-uri="${d.data.fileUri}" data-line-number="${d.data.lineNumber}">
                        <i class="fas fa-search"></i> Search
                    </button>
                </div>
            </div>
        `;
            });

        nodeGroup.selectAll(".replay-btn").on("click", function (event) {
            const nodeId = event.target.getAttribute("data-node-id");

            // Find the clicked node by its ID
            const clickedNode = nodes.find((node) => node.data.id === nodeId);

            if (!clickedNode) {
                console.error("Node not found!");
                return;
            }

            // Find all parent nodes including the starting point
            const parentNodes = findParentNodes(clickedNode);
            console.log("Parent nodes: ", parentNodes);

            // Animate the lines connecting these nodes
            animateLines(parentNodes);
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
            const fileUri = event.target.getAttribute("data-file-uri");
            const lineNumber = event.target.getAttribute("data-line-number");
            vscode.postMessage({
                command: 'openZoneWidget',
                fileUri: fileUri,
                lineNumber: parseInt(lineNumber, 10)
            });
        });

    }

    // Function to calculate the height of a code snippet rectangle
    function getCodeSnippetHeight(codeSnippet) {
        const tempDiv = document.createElement("div");
        tempDiv.style.visibility = "hidden";
        tempDiv.style.position = "absolute";
        tempDiv.style.font = "12px monospace";
        tempDiv.style.width = `${container.offsetWidth - margin.right - margin.left - 30}px`;
        tempDiv.innerHTML = `<code style="white-space: pre;">${codeSnippet}</code>`;
        document.body.appendChild(tempDiv);
        const height = tempDiv.getBoundingClientRect().height;
        document.body.removeChild(tempDiv);
        return height + 42; // Add padding for the buttons
    }

    function generateNodeId(data) {
        const fileName = data.fileUri.split('/').pop(); // Get the file name
        return `${fileName}_${data.lineNumber}_${data.variable}`.replace(/[^\w-]/g, "_");
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

    function animateLines(nodes) {
        // Step 1: Dim unrelated nodes and links
        svg.selectAll(".node, .link").style("opacity", 0.2);

        // Step 3: Start stepwise animation
        stepThroughNodes(nodes, 0);
    }

    function stepThroughNodes(nodes, index) {
        const sourceNode = nodes[index];
        console.log("Source node: ", generateNodeId(sourceNode.data));
        d3.select(`#node-${generateNodeId(sourceNode.data)}`).style("opacity", 1);
        // scroll to the node in the graph
        const nodeEle = document.getElementById(`node-${generateNodeId(sourceNode.data)}`);
        nodeEle.scrollIntoView({ behavior: "smooth", block: "center" });

        if (index >= nodes.length - 1) return; // Stop if we've reached the last node

        const targetNode = nodes[index + 1];
        d3.select(`#link-${generateNodeId(sourceNode.data)}-${generateNodeId(targetNode.data)}`).style("opacity", 1);

        // Post a message to VSCode on the 8th second
        setTimeout(() => {
            vscode.postMessage({
                command: "replaySnippet",
                fileUri: targetNode.data.fileUri,
                lineNumber: targetNode.data.lineNumber,
            });
        }, 8000);

        // Schedule the next step
        setTimeout(() => {
            stepThroughNodes(nodes, index + 1);
        }, 10000); // Wait for the current animation to complete
    }

    // Initial render
    drawGraph();

    // Make the graph responsive
    window.addEventListener("resize", () => {
        drawGraph(); // Redraw the graph on resize
    });
}