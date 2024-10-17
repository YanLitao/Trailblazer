import * as vscode from 'vscode';
import { getSurroundingCode } from './extension';

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

    private _stripSingleLineIndentation(code: string): string {
        // decide if the code is single line
        if (code.includes('\n')) {
            return code;
        }
        return code.replace(/\s+/g, ' ').trim();
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sidebar.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sidebar.css'));
        const prismCSS = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'prism.css'));
        const prismJS = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'prism.js'));

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
                <div id="user-question">
                    <h2>User Question: ${this._question}</h2>
                    <div class="code-box">
                        <pre class="line-numbers"><code class="language-ts">${this._stripSingleLineIndentation(this._selectedCode)}</code></pre>
                    </div>
                </div>
                <div id="exploration-steps"></div> <!-- This div will hold all exploration steps -->
                <script src="${scriptUri}"></script>
                <script src="${prismJS}"></script>
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
            const uniqueId = `task1-sub-questions-${this._stepCounter}`; // Generate unique ID for Task 1

            let task1Html = `
            <div class="task">
                <div class="task-header">
                    <div class="step-circle">${this._stepCounter}</div> <!-- Circle with step count -->
                    <h3>Refined question: ${task1Output.refined_question}</h3>
                </div>
            `;
            if (task1Output.sub_problems.length > 0) {
                task1Html += `
                <div class="task-content">
                <p>
                    <button id="${uniqueId}-btn" class="toggle-button" data-target="${uniqueId}">&#9654;</button> <!-- Unique Button for toggling -->
                    Going to explore <strong>${task1Output.sub_problems.length}</strong> sub-questions:
                </p>
                <div id="${uniqueId}" class="task-details" style="display: none;"> <!-- Unique ID -->
                `;

                for (const subProblem of task1Output.sub_problems) {
                    const codeContext = subProblem.code_context;
                    const fileName = this.getFileNameFromUri(codeContext.file_uri);

                    task1Html += `
            <div class="sub-question">
                <p><strong>Sub-question: ${subProblem.sub_question}</strong></p>
                <p class="code-info">
                    Going to use <strong>${allowedTools[subProblem.tool as keyof typeof allowedTools]}</strong> to explore <strong>${subProblem.invoke_variable}</strong> in <strong>${fileName}, 
                    <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                        line ${codeContext.line_number + 1}
                    </a></strong>:
                </p>
                <div class="code-box">
                    <pre class="line-numbers"><code class="language-ts">${this.escapeHtml(this._stripSingleLineIndentation(codeContext.full_statement))}</code></pre>
                </div>
            </div>
            `;
                }

                task1Html += `</div></div></div>`; // Close all divs correctly
            } else {
                task1Html += `<div class="task-content"><p>No sub-questions found.</p></div></div>`;
            }
            webview.postMessage({ command: 'appendHtml', html: task1Html, id: uniqueId });
            this._stepCounter++;
        }
    }

    // Function to add Task 2 results to the sidebar with surrounding code
    public async addTask2Results(task2Output: any) {
        if (this._view) {
            const webview = this._view.webview;
            const uniqueId = `task2-results-${this._stepCounter}`; // Generate unique ID for Task 2

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
                <button id="${uniqueId}-btn" class="toggle-button" data-target="${uniqueId}">&#9654;</button> <!-- Unique Button for toggling -->
                <div id="${uniqueId}" class="task-details" style="display: none;"> <!-- Unique ID -->
            `;

                for (const result of task2Output.questions_and_results) {
                    task2Html += `
                <div class="sub-question">
                    <p><strong>Sub-question:</strong> ${result.sub_question}</p>
                    <p class="code-info">Explored <strong>${result.invoke_variable}</strong> using <strong>${allowedTools[result.tool as keyof typeof allowedTools]}</strong>:</p>
                    <div class="code-box">
                        <pre class="line-numbers"><code class="language-ts">${this.escapeHtml(this._stripSingleLineIndentation(result.code_context.code_line))}</code></pre>
                    </div>
                    <p class="code-info">Found <strong>${result.filtered_results.length}</strong> results:</p>
                    <div class="filtered-results">
                `;

                    for (const filteredResult of result.filtered_results) {
                        const fileName = this.getFileNameFromUri(filteredResult.file_uri);
                        const { contextText } = await getSurroundingCode(vscode.Uri.parse(filteredResult.file_uri), filteredResult.line_number, filteredResult.line_number);

                        task2Html += `
                    <div class="result">
                        <p class="code-info">
                            In <strong>${fileName}, 
                            <a href="#" class="line-link" data-file-uri="${filteredResult.file_uri}" data-line="${filteredResult.line_number}">
                                Line ${filteredResult.line_number + 1}
                            </a></strong>:
                        </p>
                        <div class="code-box">
                            <pre class="line-numbers" data-line="${filteredResult.line_number}"><code class="language-ts">${this.escapeHtml(contextText)}</code></pre>
                        </div>
                    </div>
                    `;
                    }

                    task2Html += `</div></div>`;
                }

                task2Html += `</div></div></div>`;
            } else {
                task2Html += `<div class="task-content"><p>No sub-questions explored.</p></div></div>`;
            }
            webview.postMessage({ command: 'appendHtml', html: task2Html, id: uniqueId });
            this._stepCounter++;
        }
    }

    // Function to add Task 3 results (final decision and explanation) with surrounding code
    public async addTask3Results(task3Output: any) {
        if (this._view) {
            const webview = this._view.webview;
            const uniqueId = `task3-sub-questions-${this._stepCounter}`; // Generate unique ID for Task 3

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
                <button id="${uniqueId}-btn" class="toggle-button" data-target="${uniqueId}">&#9654;</button> <!-- Unique Button for toggling -->
                Propose <strong>${task3Output.sub_problems.length}</strong> sub-questions:
            </p>
            <div id="${uniqueId}" class="task-details" style="display: none;"> <!-- Unique ID -->
            `;

                for (const subProblem of task3Output.sub_problems) {
                    const codeContext = subProblem.code_context;
                    const fileName = this.getFileNameFromUri(codeContext.file_uri);

                    task3Html += `
                <div class="sub-question">
                    <p><strong>Sub-question:</strong> ${subProblem.sub_question}</p>
                    <p class="code-info">
                        Going to use <strong>${allowedTools[subProblem.tool as keyof typeof allowedTools]}</strong> to explore <strong>${subProblem.invoke_variable}</strong> in <strong>${fileName}, 
                        <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                            Line ${codeContext.line_number + 1}
                        </a></strong>:
                    </p>
                    <div class="code-box">
                        <pre class="line-numbers"><code class="language-ts">${this.escapeHtml(this._stripSingleLineIndentation(codeContext.full_statement))}</code></pre>
                    </div>
                </div>
                `;
                }

                task3Html += `</div></div>`; // Close all divs correctly
            } else {
                task3Html += `<p>No sub-questions proposed.</p></div></div>`;
            }
            webview.postMessage({ command: 'appendHtml', html: task3Html, id: uniqueId });
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