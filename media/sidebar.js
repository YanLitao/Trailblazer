
const vscode = acquireVsCodeApi(); // This gives us access to the VSCode API

// Listen to messages from the VSCode extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'appendHtml':
            appendHtml(message.html, message.id);
            break;
    }
});

// Function to append HTML content dynamically
function appendHtml(html, id) {
    const explorationSteps = document.getElementById('exploration-steps');
    explorationSteps.insertAdjacentHTML('beforeend', html);
    Prism.highlightAll(); // Highlight the newly added code using Prism.js
    setupJumpToLine(); // Set up the jump-to-line functionality
    setupToggleDetails(id); // Set up the toggle details functionality
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

function setupToggleDetails(id) {
    document.getElementById(id + "-btn").addEventListener('click', function () {
        const targetId = this.getAttribute('data-target'); // 'this' refers to the clicked button
        const targetElement = document.getElementById(targetId);

        console.log("Finding target element with id: " + targetId + " and found:");
        console.log(targetElement);

        if (targetElement.style.display === 'none') {
            targetElement.style.display = 'block';
            this.innerHTML = '&#9660;'; // Change the triangle to point downwards
        } else {
            targetElement.style.display = 'none';
            this.innerHTML = '&#9654;'; // Change the triangle to point rightwards
        }
    });
}