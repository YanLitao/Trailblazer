
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
            const highlightedElements = answerDiv.querySelectorAll('.highlight-new');
            highlightedElements.forEach(element => {
                // Remove the highlight-new class
                element.classList.remove('highlight-new');
            });

            // Prepend the new findings to the existing content
            answerDiv.innerHTML = message.answer + answerDiv.innerHTML;
            break;
        case 'updateExplorationSummary':
            document.getElementById('exploration-summary').innerText = message.summary;
            break;
        case 'appendFindings':
            appendFindingsHtml(message.html);
            break;
        case 'renderGraph':
            renderGraph(message.data);
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
        case 'Finished': // Treat both as "Finished"
            statusText.textContent = 'Finished';
            statusText.className = 'finished-status';
            break;
        default: // Default to "Idle"
            statusText.textContent = 'Idle';
            statusText.className = 'idle-status';
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

    const width = container.offsetWidth;
    const height = container.offsetHeight;
    const radius = Math.min(width, height) / 2 - 40;

    // Filter nodes to only include those marked as invoking places (isPlace=true)
    const filteredNodes = data.nodes.filter(node => node.isPlace);
    const filteredEdges = data.edges.filter(edge =>
        filteredNodes.some(node => node.id === edge.source) &&
        filteredNodes.some(node => node.id === edge.target)
    );

    const svg = d3.select("#graph-container")
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .append("g")
        .attr("transform", `translate(${width / 2}, ${height / 2})`);

    const colorScale = d3.scaleOrdinal(d3.schemeCategory10);

    const groupedNodes = d3.group(filteredNodes, d => d.fileUri);

    const rootData = {
        name: "root",
        children: Array.from(groupedNodes, ([fileUri, nodes]) => ({
            fileUri,
            children: nodes
        }))
    };

    const root = d3.hierarchy(rootData).sum(d => d.children ? 0 : 1);
    const clusterLayout = d3.cluster().size([2 * Math.PI, radius]);
    clusterLayout(root);

    const line = d3.lineRadial()
        .curve(d3.curveBundle.beta(0.85))
        .radius(d => d.y)
        .angle(d => d.x);

    svg.append("defs").append("marker")
        .attr("id", "arrowhead")
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", "#aaa");

    const nodeColors = new Map();
    root.leaves().forEach(leaf => {
        nodeColors.set(leaf.data.id, colorScale(leaf.data.fileUri));
    });

    svg.append("g")
        .selectAll("path")
        .data(filteredEdges)
        .join("path")
        .attr("class", "link")
        .attr("d", d => {
            const sourceNode = root.descendants().find(node => node.data.id === d.source);
            const targetNode = root.descendants().find(node => node.data.id === d.target);
            return line(sourceNode.path(targetNode));
        })
        .attr("stroke", d => nodeColors.get(d.source))
        .attr("stroke-width", 1.5)
        .attr("marker-end", "url(#arrowhead)")
        .style("fill", "none");

    svg.append("g")
        .selectAll("circle")
        .data(root.leaves())
        .join("circle")
        .attr("transform", d => `rotate(${(d.x * 180 / Math.PI - 90)}) translate(${d.y},0)`)
        .attr("r", 5)
        .style("fill", d => colorScale(d.data.fileUri));

    svg.append("g")
        .selectAll("text")
        .data(root.leaves())
        .join("text")
        .attr("transform", d => `
            rotate(${(d.x * 180 / Math.PI - 90)})
            translate(${d.y + 8}, 0)
            ${d.x < Math.PI ? "" : "rotate(180)"}
        `)
        .attr("text-anchor", d => d.x < Math.PI ? "start" : "end")
        .text(d => {
            const parts = d.data.id ? d.data.id.split('/') : ["unknown"];
            return parts[parts.length - 1];
        })
        .style("font-size", "10px");
}