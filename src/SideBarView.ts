import * as vscode from 'vscode';
import { getSurroundingCode, stripLineIndentation, alignCodeLeft } from './codeContextUtils';
import { Node, Edge } from './explorationGraph';

const allowedTools = {
    0: "Go to Definition",
    1: "Find References"
};

export class SidebarView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'search-copilot.sidebarView';
    private _view?: vscode.WebviewView;
    private _question: string = '';
    private _selectedCode: string = '';
    private _stepCounter: number = 1;
    private _initialFileUri: string = '';
    private _initialLineNumber: number = 0;
    private _displayQueue: Array<{ answer: string, nextStepSummary: string, findingsHtml: string, taskContentHtml: string, locations: Array<{ fileUri?: string, lineNumber?: number }> }> = [];
    private _isDisplaying: boolean = false;
    private _stayingTime: number = 10; // seconds
    private _watchMode: boolean = false;

    constructor(
        private readonly _context: vscode.ExtensionContext
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        // Set up the webview options
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };
        // Initial content for the sidebar
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Register message handler to handle messages from the webview
        webviewView.webview.onDidReceiveMessage((message) => {
            if (message.command === 'openFileAtLine') {
                const fileUri = vscode.Uri.parse(message.fileUri);
                const lineNumber = message.lineNumber;
                this.openFileAtLine(fileUri, lineNumber);
            } else if (message.command === 'stopAgent') {
                this.agentIsDone();
                vscode.commands.executeCommand('extension.stopAgent');
            } else if (message.command === 'pauseAgent') {
                vscode.commands.executeCommand('extension.pauseAgent');
            } else if (message.command === 'continueAgent') {
                vscode.commands.executeCommand('extension.continueAgent');
            } else if (message.command === 'toggleWatchMode') {
                this._watchMode = message.isActive;
            }
        });
    }

    // Enqueue new content
    public enqueueTaskResultUpdate(answer: string, nextStepSummary: string, findingsHtml: string, taskContentHtml: string, locations: Array<{ fileUri?: string, lineNumber?: number }> = []) {
        this._displayQueue.push({ answer, nextStepSummary, findingsHtml, taskContentHtml, locations });
        this.processQueue(); // Start processing the queue if not already in progress
    }

    // Process queue to display each item for at least 30 seconds
    private async processQueue() {
        if (this._isDisplaying || this._displayQueue.length === 0) {
            return; // Exit if already displaying or queue is empty
        }

        this._isDisplaying = true;

        // Dequeue and display the next item
        const { answer, nextStepSummary, findingsHtml, taskContentHtml, locations } = this._displayQueue.shift()!;

        // Send message to update preliminary answer and current task content
        this._view?.webview.postMessage({
            command: 'updatePreliminaryAnswer',
            answer: answer
        });

        this._view?.webview.postMessage({
            command: 'updateExplorationSummary',
            summary: nextStepSummary
        });

        this._view?.webview.postMessage({
            command: 'updateCurrentTaskContent',
            html: taskContentHtml
        });

        this._view?.webview.postMessage({
            command: 'appendFindings',
            html: findingsHtml
        });

        // Check if watch mode is active and extract the file URI and line number
        if (this._watchMode) {
            for (const location of locations) {
                if (location.fileUri && location.lineNumber !== undefined) {
                    await this.openFileAtLine(vscode.Uri.parse(location.fileUri), location.lineNumber);
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, this._stayingTime * 1000));

        this._isDisplaying = false;
        this.processQueue(); // Process the next item in the queue
    }

    // Function to open the file and jump to the specific line
    private async openFileAtLine(fileUri: vscode.Uri, lineNumber: number) {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const editor = await vscode.window.showTextDocument(document);

            const position = new vscode.Position(lineNumber, 0);
            const range = new vscode.Range(position, position);

            // Reveal the range in the editor
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(position, position);

            // Create a decoration type for highlighting the line
            const highlightDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(255, 255, 0, 0.3)' // Yellow background with some transparency
            });

            // Apply the decoration to the line
            const lineRange = new vscode.Range(lineNumber, 0, lineNumber, document.lineAt(lineNumber).range.end.character);
            editor.setDecorations(highlightDecoration, [lineRange]);

            // Optional: Clear the decoration after a delay
            setTimeout(() => {
                editor.setDecorations(highlightDecoration, []); // Clear the highlight
            }, 5000); // Adjust the delay as needed (e.g., 5 seconds)
        } catch (error) {
            console.error(`Error opening file at line ${lineNumber}: `, error);
        }
    }

    // Public method to update the content dynamically with the user question and selected code
    public updateWebviewContent(question: string, selectedCode: string, fileUri: string, lineNumber: number) {
        this._question = question;
        this._selectedCode = selectedCode;
        this._initialFileUri = fileUri;
        this._initialLineNumber = lineNumber;
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
        }
    }

    // Function to update agent status
    private _updateAgentStatus(status: string) {
        if (this._view) {
            this._view.webview.postMessage({ command: 'updateStatus', status: status });
        }
    }

    // Example usage: Set agent status to "Searching"
    public agentIsRunning() {
        this._updateAgentStatus('Searching');
    }

    // Example usage: Set agent status to "Finished"
    public agentIsDone() {
        this._updateAgentStatus('Finished');
    }

    public agentIsPaused() {
        this._updateAgentStatus('Paused');
    }

    public agentIsStopped() {
        this._updateAgentStatus('Stopped');
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sidebar.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sidebar.css'));
        //const prismCSS = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'prism.css'));
        const prismJS = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'prism.js'));
        const html2pdfJS = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.9.3/html2pdf.bundle.min.js';
        const d3Uri = 'https://d3js.org/d3.v7.min.js';

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Search Copilot</title>
                <link href="${styleUri}" rel="stylesheet">
                <link rel="preconnect" href="https://fonts.googleapis.com">
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                <link href="https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,100;0,300;0,400;0,700;0,900;1,100;1,300;1,400;1,700;1,900&display=swap" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/9000.0.1/themes/prism.min.css" />
                <script src="${d3Uri}"></script>
            </head>
            <body>
                <div id="header">
                    <p>Searching for answer to "<span class="title-question">${this._question}</span>"</p>
                    <p id="agent-status">
                        Status: <span id="agent-status-text" class="idle-status">Idle</span>
                    </p>
                    <div id="actions" style="display: flex; justify-content: space-around; padding: 10px;">
                        <button id="continue-agent" class="action-btn">Continue</button>
                        <button id="pause-agent" class="action-btn">Pause</button>
                        <button id="stop-agent" class="action-btn">Stop</button>
                        <button id="toggle-log" class="action-btn">See full log</button>
                        <button id="save-pdf" class="action-btn">Save Log</button>
                    </div>
                    <p id="preliminary-answer">
                        Findings:
                        <ul id="preliminary-answer-text"></ul>
                    </p>
                    <p>Snippets:</p>
                    <div id="findings"></div>
                    <p id="still-to-be-found">Still to be found: <span id="exploration-summary"></span></p>
                    <div id="button-container">
                        <label for="watch-mode-toggle" class="switch-label">Watch Mode</label>
                        <label class="switch">
                            <input type="checkbox" id="watch-mode-toggle">
                            <span class="slider round"></span>
                        </label>
                    </div>
                </div>
                <div id="current-task">
                    <div id="current-task-content">
                    </div>
                </div>
                <div id="graph-container" style="width: 100%; height: 400px;"></div>
                <div id="exploration-steps" style="display:none;">
                    <div class="task">
                        <div class="task-header">
                            <div class="step-circle">0</div>
                            <h3>Initial question: ${this._question}</h3>
                        </div>
                        <div class="task-content">
                            <p>Selected code in <a href="#" class="line-link" data-file-uri="${this._initialFileUri}" data-line="${this._initialLineNumber}">
                                    line ${this._initialLineNumber + 1}
                                </a>:
                            </p>
                            <div class="code-box">
                                <pre class="line-numbers language-ts"><code class="language-ts">${stripLineIndentation(this._selectedCode)}</code></pre>
                            </div>
                        </div>
                </div> <!-- This div will hold all exploration steps --> 
                <script src="${prismJS}"></script>
                <script src="${html2pdfJS}"></script>
                <script src="${scriptUri}"></script>
                <script>
                    Prism.highlightAll();
                </script>
            </body>
            </html>
        `;
    }

    // Function to add Task 1 results to the sidebar with surrounding code
    public async addTask1Results(task1Output: any) {
        if (this._view) {
            const webview = this._view.webview;
            const uniqueId = `task1-sub-questions-${this._stepCounter}`;
            const currentTaskUniqueId = `current-task1-results-${this._stepCounter}`;
            let task1Html = `
            <div class="task">
                <div class="task-header">
                    <div class="step-circle">${this._stepCounter}</div>
                    <h3>Refined question: ${task1Output.refined_question}</h3>
                </div>
                <div class="task-content">
            `;

            let currentTaskHtml = `<div class="task-content">`;

            if (task1Output.sub_problems.length > 0) {
                const firstSubProblem = task1Output.sub_problems[0];
                const codeContext = firstSubProblem.code_context;
                const fileName = this.getFileNameFromUri(codeContext.file_uri);
                const { contextText } = await getSurroundingCode(vscode.Uri.parse(codeContext.file_uri), codeContext.line_number, codeContext.line_number);

                // Build currentTaskHtml for the first sub-question in Task 3 style
                currentTaskHtml += `
                    <div class="sub-question">
                        <p><strong>Currently exploring:</strong> ${firstSubProblem.sub_question}</p>
                        <p class="code-info">
                            Exploring <strong>${codeContext.invoke_variable}</strong> in <strong>${fileName}, 
                            <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                                Line ${codeContext.line_number + 1}
                            </a></strong>:
                        </p>
                        <div class="code-box">
                            <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(contextText)}</code></pre>
                        </div>
                        <p class="code-info"><strong>Purpose:</strong> ${firstSubProblem.reason}</p>
                    </div>
                `;

                // If there are more sub-questions, add a "show more" section for additional ones
                if (task1Output.sub_problems.length > 1) {
                    const remainingCount = task1Output.sub_problems.length - 1;
                    currentTaskHtml += `
                        <p class="show-more-invocations" id="${currentTaskUniqueId}-show-more" onClick="toggleAdditionalInvocations('${currentTaskUniqueId}-show-more')">
                            ... also exploring <strong>${remainingCount}</strong> other places ...
                        </p>
                        <div id="${currentTaskUniqueId}-additional-invocations" style="display: none;">
                    `;

                    for (let i = 1; i < task1Output.sub_problems.length; i++) {
                        const subProblem = task1Output.sub_problems[i];
                        const otherCodeContext = subProblem.code_context;
                        const otherFileName = this.getFileNameFromUri(otherCodeContext.file_uri);
                        const { contextText: otherContextText } = await getSurroundingCode(vscode.Uri.parse(otherCodeContext.file_uri), otherCodeContext.line_number, otherCodeContext.line_number);

                        currentTaskHtml += `
                            <div class="sub-question additional-invocation">
                                <p><strong>Exploring:</strong> ${subProblem.sub_question}</p>
                                <p class="code-info">
                                    Exploring <strong>${otherCodeContext.invoke_variable}</strong> in <strong>${otherFileName}, 
                                    <a href="#" class="line-link" data-file-uri="${otherCodeContext.file_uri}" data-line="${otherCodeContext.line_number}">
                                        Line ${otherCodeContext.line_number + 1}
                                    </a></strong>:
                                </p>
                                <div class="code-box">
                                    <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(otherContextText)}</code></pre>
                                </div>
                                <p class="code-info"><strong>Purpose:</strong> ${subProblem.reason}</p>
                            </div>
                        `;
                    }
                    currentTaskHtml += `</div>`; // Close additional-invocations div
                }
                currentTaskHtml += `</div>`; // Close task-content div

                // Build task1Html for the full list of sub-questions in original Task 1 style
                task1Html += `
                    <p>Exploring <strong>${task1Output.sub_problems.length}</strong> sub-questions:</p>
                    <div class="sub-questions">
                `;
                for (let i = 0; i < task1Output.sub_problems.length; i++) {
                    const subProblem = task1Output.sub_problems[i];
                    const codeContext = subProblem.code_context;
                    const fileName = this.getFileNameFromUri(codeContext.file_uri);

                    task1Html += `
                        <div class="sub-question">
                            <p><strong>Sub-question:</strong> ${subProblem.sub_question}</p>
                            <p class="code-info">
                                Tool: <strong>${allowedTools[subProblem.tool as keyof typeof allowedTools]}</strong>, exploring <strong>${codeContext.invoke_variable}</strong> in <strong>${fileName}, 
                                <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                                    line ${codeContext.line_number + 1}
                                </a></strong>:
                            </p>
                            <div class="code-box">
                                <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(codeContext.full_statement)}</code></pre>
                            </div>
                        </div>
                    `;
                }
                task1Html += `</div></div></div>`; // Close task-content and task divs

                // Post the HTML updates for Task 1
                webview.postMessage({ command: 'appendHtml', html: task1Html, id: uniqueId });
                // Post the HTML for the current task in Task 3 format
                webview.postMessage({ command: 'updateCurrentTaskContent', html: currentTaskHtml, id: currentTaskUniqueId });
            } else {
                // If no sub-questions found, post a message
                task1Html += `<div class="task-content"><p>No sub-questions found.</p></div></div>`;
                webview.postMessage({ command: 'appendHtml', html: task1Html, id: uniqueId });
            }

            // Increment the step counter
            this._stepCounter++;
        }
    }

    public async addTask2Results(task2Output: any) {
        if (this._view) {
            const webview = this._view.webview;
            const uniqueId = `task2-results-${this._stepCounter}`; // Generate unique ID for Task 2
            var i = -1;

            let task2Html = `
            <div class="task">
                <div class="task-header">
                    <div class="step-circle">${this._stepCounter}</div> <!-- Circle with step count -->
                    <h3>Explored ${task2Output.questions_and_results.length} sub-questions.</h3>
                </div>
            `;
            if (task2Output.questions_and_results.length > 0) {
                task2Html += `
                <div class="task-content">
                `;
                for (const result of task2Output.questions_and_results) {
                    i++;
                    task2Html += `<div class="sub-question `;
                    if (result.code_context) {
                        task2Html += ` uncertain`;
                    }
                    let variable = "";
                    let line = 0;
                    let invokeFileName = "";
                    let codeLine = "";

                    if ("code_context" in result) {
                        variable = result.code_context.invoke_variable;
                        line = result.code_context.line_number;
                        invokeFileName = this.getFileNameFromUri(result.code_context.file_uri);
                        codeLine = result.code_context.code_line;
                    }

                    task2Html += `">
                        <div class="sub-question-header">
                            <button id="${uniqueId}-btn-${i}" class="toggle-button" data-target="${uniqueId}-sub-question-${i}">
                                <span class="triangle-right"></span>
                            </button>
                            <p class="code-info">Explored <strong>${variable}</strong> in ${invokeFileName}: line 
                                <a href="#" class="line-link" data-file-uri="${invokeFileName}" data-line="${line}">${line}</a>, 
                                using <strong>${allowedTools[result.tool as keyof typeof allowedTools]}</strong>:
                            </p>
                        </div>
                        <div id="${uniqueId}-sub-question-${i}" class="task-details" style="display: none">
                            <p class="before-hide"><strong>Sub-question:</strong> ${result.sub_question}</p>
                            <div class="code-box">
                                <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(codeLine)}</code></pre>
                            </div>
                            <p class="code-info">Found <strong>${result.filtered_results.length}</strong> results:</p>
                            <div class="filtered-results">
                    `;

                    for (const filteredResult of result.filtered_results) {
                        const fileName = this.getFileNameFromUri(filteredResult.file_uri);
                        const { contextText } = await getSurroundingCode(vscode.Uri.parse(filteredResult.file_uri), filteredResult.line_number, filteredResult.line_number);
                        const alignedCode = alignCodeLeft(contextText);

                        task2Html += `
                        <div class="result">
                            <p class="code-info">
                                In <strong>${fileName}, 
                                <a href="#" class="line-link" data-file-uri="${filteredResult.file_uri}" data-line="${filteredResult.line_number}">
                                    Line ${filteredResult.line_number + 1}
                                </a></strong>:
                            </p>
                            <div class="code-box">
                                <pre class="line-numbers language-ts" data-line="${filteredResult.line_number}"><code class="language-ts">${this.escapeHtml(alignedCode)}</code></pre>
                            </div>
                        </div>
                        `;
                    }

                    task2Html += `</div></div></div>`;

                }

                task2Html += `</div></div>`;

            } else {
                task2Html += `
                    <div class="task-content">
                        <p class="warning-text">
                            <span class="warning-icon">&#9888;</span>
                            No sub-questions explored.
                        </p>
                    </div>
                </div>`;
            }
            webview.postMessage({ command: 'appendHtml', html: task2Html, id: uniqueId, num: i });
            this._stepCounter++;
        }
    }

    // Function to add Task 3 results (final decision and explanation) with surrounding code
    public async addTask3Results(final_decision_sufficient: boolean, task3Output: any, importantCodeSnippets: any, importantCodePaths: any) {
        if (this._view) {
            const webview = this._view.webview;
            const explorationUniqueId = `exploration-task3-results-${this._stepCounter}`; // Unique ID for exploration steps
            const currentTaskUniqueId = `current-task3-results-${this._stepCounter}`; // Unique ID for current task
            var i = -1;

            // Update the preliminary answer text in the webview
            let answerText = "";
            if (task3Output.answer) {
                answerText = task3Output.answer;
            }

            const nextStepSummary = final_decision_sufficient
                ? ""
                : (task3Output.next_step_summary || "");

            let findingsHtml = "";
            if (importantCodeSnippets && importantCodePaths) {
                findingsHtml = await this.addTask5And6Results(importantCodeSnippets, importantCodePaths);
            }

            // Generate HTML for exploration steps
            let explorationStepsHtml = `
            <div class="task">
                <div class="task-header">
                    <div class="step-circle">${this._stepCounter}</div>
                    <h3>Explored code is ${final_decision_sufficient ? 'sufficient' : 'insufficient'} to answer the question.</h3>
                </div>
                <div class="task-content">
            `;

            // If sufficient, display the final answer
            if (final_decision_sufficient) {
                explorationStepsHtml += `<p><strong>Answer: </strong>${task3Output.answer}</p>`;
            } else if (task3Output.sub_problems.length > 0) {
                explorationStepsHtml += `<p>Propose <strong>${task3Output.sub_problems.length}</strong> sub-questions:</p>`;
                for (const subProblem of task3Output.sub_problems) {
                    i++;
                    const codeContext = subProblem.code_context;
                    const fileName = this.getFileNameFromUri(codeContext.file_uri);
                    const { contextText } = await getSurroundingCode(vscode.Uri.parse(codeContext.file_uri), codeContext.line_number, codeContext.line_number);

                    explorationStepsHtml += `
                        <div class="sub-question">
                            <div class="sub-question-header">
                                <button id="${explorationUniqueId}-btn-${i}" class="toggle-button" data-target="${explorationUniqueId}-sub-question-${i}">
                                    <span class="triangle-right"></span>
                                </button>
                                <p class="before-hide"><strong>Sub-question:</strong> ${subProblem.sub_question}</p>
                            </div>
                            <div id="${explorationUniqueId}-sub-question-${i}" class="task-details" style="display: none">
                                <p class="code-info">
                                    Going to use <strong>${allowedTools[subProblem.tool as keyof typeof allowedTools]}</strong> to explore <strong>${codeContext.invoke_variable}</strong> in <strong>${fileName}, 
                                    <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                                        Line ${codeContext.line_number + 1}
                                    </a></strong>:
                                </p>
                                <div class="code-box">
                                    <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(contextText)}</code></pre>
                                </div>
                            </div>
                        </div>
                    `;
                }
                explorationStepsHtml += `</div></div>`; // Close all divs
            } else {
                explorationStepsHtml += `<p>No sub-questions proposed.</p></div></div>`;
            }

            let currentTaskHtml = "";

            // Post the HTML to the exploration steps
            webview.postMessage({ command: 'appendHtml', html: explorationStepsHtml, id: explorationUniqueId, num: i });

            // Generate HTML for current task content (show only the first invocation place)

            if (task3Output.sub_problems.length > 0) {
                currentTaskHtml = `<div class="task-content">`;
                const firstSubProblem = task3Output.sub_problems[0];
                const codeContext = firstSubProblem.code_context;
                const fileName = this.getFileNameFromUri(codeContext.file_uri);
                const { contextText } = await getSurroundingCode(vscode.Uri.parse(codeContext.file_uri), codeContext.line_number, codeContext.line_number);

                // Show the first invocation place
                currentTaskHtml += `
                    <div class="sub-question">
                        <p><strong>Currently exploring:</strong> ${firstSubProblem.sub_question}</p>
                        <p class="code-info">
                            Exploring <strong>${codeContext.invoke_variable}</strong> in <strong>${fileName}, 
                            <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                                Line ${codeContext.line_number + 1}
                            </a></strong>:
                        </p>
                        <div class="code-box">
                            <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(contextText)}</code></pre>
                        </div>
                        <p class="code-info"><strong>Why to explore:</strong> ${firstSubProblem.reason}</p>
                    </div>
                `;

                // Show the clickable line to expand remaining invocation places
                if (task3Output.sub_problems.length > 1) {
                    const remainingCount = task3Output.sub_problems.length - 1;
                    currentTaskHtml += `
                        <p class="show-more-invocations" id="${currentTaskUniqueId}-show-more" onClick="toggleAdditionalInvocations('${currentTaskUniqueId}-show-more')">
                            ... also exploring <strong>${remainingCount}</strong> other places ...
                        </p>
                        <div id="${currentTaskUniqueId}-additional-invocations" style="display: none;">
                    `;

                    // Add remaining invocation places, hidden by default
                    for (let j = 1; j < task3Output.sub_problems.length; j++) {
                        const subProblem = task3Output.sub_problems[j];
                        const otherCodeContext = subProblem.code_context;
                        const otherFileName = this.getFileNameFromUri(otherCodeContext.file_uri);

                        currentTaskHtml += `
                            <div class="sub-question additional-invocation">
                                <p><strong>Exploring:</strong> ${subProblem.sub_question}</p>
                                <p class="code-info">
                                    Exploring <strong>${otherCodeContext.invoke_variable}</strong> in <strong>${otherFileName}, 
                                    <a href="#" class="line-link" data-file-uri="${otherCodeContext.file_uri}" data-line="${otherCodeContext.line_number}">
                                        Line ${otherCodeContext.line_number + 1}
                                    </a></strong>:
                                </p>
                                <div class="code-box">
                                    <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(otherCodeContext.full_statement)}</code></pre>
                                </div>
                                <p class="code-info"><strong>Why to explore:</strong> ${subProblem.reason}</p>
                            </div>
                        `;
                    }
                    currentTaskHtml += `</div>`; // Close additional-invocations div
                }
                currentTaskHtml += `</div>`; // Close task-content div

                // Post the HTML to the current task content
                //webview.postMessage({ command: 'updateCurrentTaskContent', html: currentTaskHtml, id: currentTaskUniqueId, num: i });
                // Only enqueue updates for non-empty answer or task content
                if (answerText || nextStepSummary || currentTaskHtml) {
                    const locations = [{ fileUri: firstSubProblem.code_context.file_uri, lineNumber: firstSubProblem.code_context.line_number }];
                    this.enqueueTaskResultUpdate(answerText || "", nextStepSummary || "", findingsHtml || "", currentTaskHtml || "", locations);
                }
            } else {
                if (answerText || nextStepSummary) {
                    this.enqueueTaskResultUpdate(answerText || "", nextStepSummary || "", findingsHtml || "", currentTaskHtml || "");
                }
            }

            // Increment the step counter
            this._stepCounter++;
        }
    }

    public async addTask5And6Results(importantCodeSnippets: Map<string, any>, importantCodePaths: Map<string, Array<{ nodes: Node[], edges: Edge[] }>>) {
        const visibleLimit = 15; // Show this many results initially
        const results = [...importantCodeSnippets.entries()].map(([index, result]) => ({ index, ...result }));
        const initialVisibleResults = results.slice(0, visibleLimit);
        const additionalResults = results.slice(visibleLimit);

        // HTML content for visible code boxes with index
        let findingsHtml = ``;

        // Display initial visible results directly with indices
        initialVisibleResults.forEach((result) => {
            const resultNodeId = result.file_uri + ':' + result.line_number;

            // Split the full statement into lines
            const lines = result.full_statement.split('\n');
            const codeLineIndex = lines.findIndex((line: string) => line.includes(result.code_line));

            // Calculate the range to display (3 lines above and 3 lines below the code_line)
            const startLine = Math.max(codeLineIndex - 3, 0);
            const endLine = Math.min(codeLineIndex + 3, lines.length - 1);

            // Extract the subset of lines and join them into a truncated statement
            const truncatedStatement = lines.slice(startLine, endLine + 1).join('\n');

            // Retrieve paths for the current node and generate HTML for each path
            const pathsHtml = this.constructPathsHtml(importantCodePaths.get(resultNodeId) || []);

            // Create HTML with a wrapper div that will contain the clickable area
            findingsHtml += `
                <div class="code-box">
                    <div class="code-wrapper" data-node-id="${resultNodeId}">
                        <span class="code-index" data-ref="${result.index}">[${result.index}]</span>
                        <pre class="line-numbers language-ts"><code class="language-ts">${this.escapeHtml(truncatedStatement)}</code></pre>
                        <a href="#" class="line-link" data-file-uri="${result.file_uri}" data-line="${result.line_number}">
                            open in editor.
                        </a>
                        <div class="parent-node-info" style="display: none;">
                            <p>Paths:</p>
                            ${pathsHtml}
                        </div>
                    </div>
                </div>
            `;
        });

        // Prepare "show more" button and hidden additional results if there are more than visibleLimit
        const remainingCount = additionalResults.length;
        if (remainingCount > 0) {
            findingsHtml += `
                <p class="show-more-results" id="findings-show-more" onclick="toggleAdditionalInvocations('findings-show-more')">
                    ... also showing <strong>${remainingCount}</strong> other relevant snippets ...
                </p>
                <div id="findings-additional-invocations" style="display: none;">
            `;

            // Add hidden additional results with indices
            additionalResults.forEach((result) => {
                const escapedCodeLine = this.escapeHtml(result.code_line);
                findingsHtml += `
                    <div class="code-box">
                        <span class="code-index">${result.index}</span>
                        <pre class="line-numbers language-ts"><code class="language-ts">${escapedCodeLine}</code></pre>
                    </div>
                `;
            });
            findingsHtml += `</div>`; // Close additional-results div
        }

        return findingsHtml;
    }

    // Helper function to construct the HTML for paths
    private constructPathsHtml(paths: Array<{ nodes: Node[], edges: (Edge | null)[] }>): string {

        return paths.map((path, pathIndex) => {
            const pathHtml = path.nodes.map((node, nodeIndex) => {
                const edge = path.edges[nodeIndex]; // Pair the current node with its corresponding edge
                let tool = "";
                if (edge?.tool) {
                    if (edge.tool == "definition") {
                        tool = "Go to definition";
                    } else if (edge.tool == "reference") {
                        tool = "Find references";
                    } else {
                        tool = "Get the assignment";
                    }
                }
                const invokingVariable = edge?.variable || "";
                const toolInfo = edge
                    ? `I used "<strong>${tool}</strong>" on "<strong>${invokingVariable}</strong>" here:`
                    : "That brought me to this snippet."; // If no edge or tool is available, leave it empty

                // Highlight the invokingVariable in the node's codeSnippet
                const highlightedCodeSnippet = invokingVariable
                    ? this.highlightVariableInSnippet(node.codeSnippet, invokingVariable)
                    : this.escapeHtml(node.codeSnippet);

                return `
                    <div class="code-box">
                        <div class="info-row">
                            <span class="styled-index">${nodeIndex + 1}</span> <!-- 1-based indexing -->
                            <span class="tool-info">${toolInfo}</span>
                        </div>
                        <div class="code-wrapper" data-node-id="${node.fileUri}:${node.lineNumber}">
                            <pre class="line-numbers language-ts"><code class="language-ts">${highlightedCodeSnippet}</code></pre>
                            <a href="#" class="line-link" data-file-uri="${node.fileUri}" data-line="${node.lineNumber}">
                                open in editor.
                            </a>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="path-box" aria-label="Path ${pathIndex + 1}">
                    ${pathHtml}
                </div>
            `;
        }).join('');
    }

    /**
     * Highlights a variable in the given code snippet.
     * Escapes the code snippet for HTML safety and wraps the variable with a span for highlighting.
     */
    private highlightVariableInSnippet(codeSnippet: string, variable: string): string {
        const escapedSnippet = this.escapeHtml(codeSnippet);
        const variableRegex = new RegExp(`\\b${this.escapeForRegex(variable)}\\b`, 'g'); // Match whole word
        return escapedSnippet.replace(variableRegex, `<span class="highlighted-variable">${variable}</span>`);
    }

    /**
     * Escapes a string for safe use in a regular expression.
     */
    private escapeForRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Helper function to extract the file name from the URI
    private getFileNameFromUri(uri: string): string {
        if (!uri) {
            return '';
        }
        const parts = uri.split('/');
        return parts[parts.length - 1];
    }

    // Escape HTML to prevent XSS or code rendering issues
    private escapeHtml(unsafe: string): string {
        unsafe = stripLineIndentation(unsafe);
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    public updateGraphVisualization(graphData: { nodes: any[], edges: any[] }) {
        // Send the graph data to the webview for visualization
        /* this._view?.webview.postMessage({
            command: 'renderGraph',
            data: graphData
        }); */
    }
}