
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
            document.getElementById('preliminary-answer-text').innerText = message.answer;
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

document.getElementById('stop-agent').addEventListener('click', function () {
    vscode.postMessage({
        command: 'stopAgent'
    });
});

// JavaScript to toggle additional invocations
function toggleAdditionalInvocations(elementId) {
    const element = document.getElementById(elementId);
    const currentTaskUniqueId = elementId.split('-show-more')[0]; // Get unique ID part
    const additionalInvocations = document.getElementById(`${currentTaskUniqueId}-additional-invocations`);

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
    document.getElementById('agent-status-text').innerText = status;
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

    const svg = d3.select("#graph-container")
        .append("svg")
        .attr("width", width)
        .attr("height", height);

    const linkGroup = svg.append("g")
        .attr("class", "links")
        .selectAll("line")
        .data(data.edges, d => `${d.source}-${d.target}`) // Unique key based on source-target IDs
        .join("line")
        .style("stroke", "#aaa");

    const nodeGroup = svg.append("g")
        .attr("class", "nodes")
        .selectAll("circle")
        .data(data.nodes, d => d.id) // Unique key based on node ID
        .join("circle")
        .attr("r", 8)
        .style("fill", d => d.isPlace ? "blue" : "grey");

    const nodeLabels = svg.append("g") // Renamed from labelGroup to nodeLabels
        .attr("class", "labels")
        .selectAll("text")
        .data(data.nodes, d => d.id)
        .join("text")
        .attr("dx", 12)
        .attr("dy", ".35em")
        .text(d => {
            // Extract the last segment after '/' as the file name and line number
            const parts = d.id.split('/');
            const fileNameAndLine = parts[parts.length - 1]; // e.g., 'fileName.js:10'
            return fileNameAndLine;
        });

    const stepLabelGroup = svg.append("g")
        .attr("class", "step-labels")
        .selectAll("text")
        .data(data.edges, d => `${d.source}-${d.target}`)
        .join("text")
        .attr("class", "step-label")
        .attr("dx", d => (d.source.x + d.target.x) / 2)
        .attr("dy", d => (d.source.y + d.target.y) / 2)
        .text(d => `Step ${d.stepNumber}`);

    const simulation = d3.forceSimulation(data.nodes)
        .force("link", d3.forceLink(data.edges).id(d => d.id).distance(50))
        .force("charge", d3.forceManyBody().strength(-200))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .alphaDecay(0.05); // Slows down the simulation for more stability

    simulation.on("tick", () => {
        linkGroup
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        nodeGroup
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);

        nodeLabels // Updated here to use nodeLabels instead of labelGroup
            .attr("x", d => d.x)
            .attr("y", d => d.y);

        stepLabelGroup
            .attr("x", d => (d.source.x + d.target.x) / 2)
            .attr("y", d => (d.source.y + d.target.y) / 2);
    });

    // Remove drag events to prevent nodes from moving
    svg.selectAll("circle").on(".drag", null);
}