import * as vscode from 'vscode';
import { getSurroundingCode, stripSingleLineIndentation } from './codeContextUtils';

const allowedTools = {
    0: "Go to Definition",
    1: "Find References"
};

function alignCodeLeft(code: string): string {
    // Split the code into lines
    const lines = code.split('\n');

    // Find the minimum indent by looking for the non-empty line with the least leading whitespace
    let minIndent = Infinity;
    for (let line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.length > 0) {
            const match = line.match(/^\s*/);
            const leadingWhitespace = match ? match[0].length : 0;
            minIndent = Math.min(minIndent, leadingWhitespace);
        }
    }

    // If there is no indent, we return the code as it is
    if (minIndent === Infinity) {
        return code;
    }

    // Remove the indent from each line
    const alignedLines = lines.map(line => line.startsWith(' '.repeat(minIndent)) || line.startsWith('\t'.repeat(minIndent))
        ? line.slice(minIndent)
        : line
    );

    // Join the lines back into a single string
    return alignedLines.join('\n');
}

export class SidebarView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'search-copilot.sidebarView';
    private _view?: vscode.WebviewView;
    private _question: string = '';
    private _selectedCode: string = '';
    private _stepCounter: number = 1;

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
            }
        });
    }

    // Function to open the file and jump to the specific line
    private async openFileAtLine(fileUri: vscode.Uri, lineNumber: number) {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const editor = await vscode.window.showTextDocument(document);

            const position = new vscode.Position(lineNumber, 0);
            const range = new vscode.Range(position, position);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(position, position);
        } catch (error) {
            console.error(`Error opening file at line ${lineNumber}: `, error);
        }
    }

    // Public method to update the content dynamically with the user question and selected code
    public updateWebviewContent(question: string, selectedCode: string) {
        this._question = question;
        this._selectedCode = selectedCode;
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

    // Example usage: Set agent status to "Running"
    public agentIsRunning() {
        this._updateAgentStatus('Running');
    }

    // Example usage: Set agent status to "Finished"
    public agentIsDone() {
        this._updateAgentStatus('Finished');
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sidebar.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sidebar.css'));
        const prismCSS = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'prism.css'));
        const prismJS = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'prism.js'));
        const html2pdfJS = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.9.3/html2pdf.bundle.min.js'; // Use external CDN

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
            </head>
            <body>
                <div id="header" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #ccc;">
                    <div id="agent-status" style="padding: 10px; border-bottom: 1px solid #ccc;">
                        <strong>Status:</strong> <span id="agent-status-text">Idle</span>
                    </div>
                    <button id="save-pdf" style="padding: 5px 10px; background-color: #4CAF50; color: white; border: none; cursor: pointer;">Save as PDF</button>
                </div>
                <div id="user-question">
                    <h2>User Question: ${this._question}</h2>
                    <div class="code-box">
                        <pre class="line-numbers"><code class="language-ts">${stripSingleLineIndentation(this._selectedCode)}</code></pre>
                    </div>
                </div>
                <div id="exploration-steps"></div> <!-- This div will hold all exploration steps -->
                <script src="${scriptUri}"></script>
                <script src="${prismJS}"></script>
                <script src="${html2pdfJS}"></script>
                <script>
                    Prism.highlightAll();

                    // Save as PDF function
                    document.getElementById('save-pdf').addEventListener('click', function () {
                        var element = document.body;
                        html2pdf().from(element).save('search-copilot.pdf');
                    });
                </script>
            </body>
            </html>
        `;
    }

    // Function to add Task 1 results to the sidebar with surrounding code
    public async addTask1Results(task1Output: any) {
        if (this._view) {
            const webview = this._view.webview;
            const uniqueId = `task1-sub-questions-${this._stepCounter}`; // Generate unique ID for Task 1
            var i = -1;

            let task1Html = `
            <div class="task">
                <div class="task-header">
                    <div class="step-circle">${this._stepCounter}</div> <!-- Circle with step count -->
                    <h3>Refined question: ${task1Output.refined_question}</h3>
                </div>
            `;
            if (task1Output.sub_problems.length > 0) {
                /* task1Html += `
                <div class="task-content">
                <p>
                    Going to explore <strong>${task1Output.sub_problems.length}</strong> sub-questions:
                </p>
                `;

                for (const subProblem of task1Output.sub_problems) {
                    i++;
                    const codeContext = subProblem.code_context;
                    const fileName = this.getFileNameFromUri(codeContext.file_uri);

                    task1Html += `
                    <div class="sub-question">
                        <div class="sub-question-header">
                            <button id="${uniqueId}-btn-${i}" class="toggle-button" data-target="${uniqueId}-sub-question-${i}"><span class="triangle-right"></span></button>
                            <p class="before-hide"><strong>Sub-question: </strong>${subProblem.sub_question}</p>
                        </div>
                        <div id="${uniqueId}-sub-question-${i}" class="task-details" style="display: none">
                            <p class="code-info">
                                Going to use <strong>${allowedTools[subProblem.tool as keyof typeof allowedTools]}</strong> to explore <strong>${codeContext.invoke_variable}</strong> in <strong>${fileName}, 
                                <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                                    line ${codeContext.line_number + 1}
                                </a></strong>:
                            </p>
                            <div class="code-box">
                                <pre class="line-numbers"><code class="language-ts">${this.escapeHtml(stripSingleLineIndentation(codeContext.full_statement))}</code></pre>
                            </div>
                        </div>
                    </div>
                    `;
                }

                task1Html += `</div></div>`; // Close all divs correctly */
            } else {
                task1Html += `<div class="task-content"><p>No sub-questions found.</p></div></div>`;
            }
            webview.postMessage({ command: 'appendHtml', html: task1Html, id: uniqueId, num: i });
            this._stepCounter++;
        }
    }

    // Function to add Task 2 results to the sidebar with surrounding code
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
                    task2Html += `
                <div class="sub-question
                `;
                    if (!result.code_context.from_results) {
                        task2Html += ` uncertain`;
                    }
                    const invokeFileName = this.getFileNameFromUri(result.code_context.file_uri);
                    task2Html += `">
                    <div class="sub-question-header">
                        <button id="${uniqueId}-btn-${i}" class="toggle-button" data-target="${uniqueId}-sub-question-${i}">
                            <span class="triangle-right"></span>
                        </button>
                        <p class="code-info">Explored <strong>${result.code_context.invoke_variable}</strong> in ${invokeFileName}: line <a href="#" class="line-link" data-file-uri="${invokeFileName}" data-line="${result.code_context.line_number}">${result.code_context.line_number}</a>, using <strong>${allowedTools[result.tool as keyof typeof allowedTools]}</strong>:</p>
                    </div>
                    
                    <div id="${uniqueId}-sub-question-${i}" class="task-details" style="display: none">
                        <p class="before-hide"><strong>Sub-question:</strong> ${result.sub_question}</p>
                        <div class="code-box">
                            <pre class="line-numbers"><code class="language-ts">${this.escapeHtml(stripSingleLineIndentation(result.code_context.code_line))}</code></pre>
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
                            <pre class="line-numbers" data-line="${filteredResult.line_number}"><code class="language-ts">${this.escapeHtml(alignedCode)}</code></pre>
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
    public async addTask3Results(task3Output: any) {
        if (this._view) {
            const webview = this._view.webview;
            const uniqueId = `task3-sub-questions-${this._stepCounter}`; // Generate unique ID for Task 3
            var i = -1;

            let task3Html = `
        <div class="task">
            <div class="task-header">
                <div class="step-circle">${this._stepCounter}</div>
                <h3>Explored code is ${task3Output.final_decision_sufficient ? 'sufficient' : 'insufficient'} to answer the question.</h3>
            </div>
            <div class="task-content">
        `;
            if (task3Output.final_decision_sufficient === true) {
                task3Html += `
            <p><strong>Answer: </strong>${task3Output.final_answer}</p>
            `;
            } else if (task3Output.sub_problems.length > 0) {
                task3Html += `
            <p>
                Propose <strong>${task3Output.sub_problems.length}</strong> sub-questions:
            </p>
            `;
                for (const subProblem of task3Output.sub_problems) {
                    i++;
                    const codeContext = subProblem.code_context;
                    const fileName = this.getFileNameFromUri(codeContext.file_uri);

                    task3Html += `
                    <div class="sub-question">
                        <div class="sub-question-header">
                            <button id="${uniqueId}-btn-${i}" class="toggle-button" data-target="${uniqueId}-sub-question-${i}"><span class="triangle-right"></span></button>
                            <p class="before-hide"><strong>Sub-question:</strong> ${subProblem.sub_question}</p>
                        </div>
                        <div id="${uniqueId}-sub-question-${i}" class="task-details" style="display: none">
                            <p class="code-info">
                                Going to use <strong>${allowedTools[subProblem.tool as keyof typeof allowedTools]}</strong> to explore <strong>${codeContext.invoke_variable}</strong> in <strong>${fileName}, 
                                <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                                    Line ${codeContext.line_number + 1}
                                </a></strong>:
                            </p>
                            <div class="code-box">
                                <pre class="line-numbers"><code class="language-ts">${this.escapeHtml(stripSingleLineIndentation(codeContext.full_statement))}</code></pre>
                            </div>
                        </div>
                    </div>
                    `;
                }

                task3Html += `</div></div>`; // Close all divs correctly
            } else {
                task3Html += `<p>No sub-questions proposed.</p></div></div>`;
            }
            webview.postMessage({ command: 'appendHtml', html: task3Html, id: uniqueId, num: i });
            this._stepCounter++;
        }
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
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}