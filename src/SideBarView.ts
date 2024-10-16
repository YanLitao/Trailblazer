import * as vscode from 'vscode';
import { getDestructuringAssignment, getSurroundingCode } from './extension';

const allowedTools = {
    0: "Go to Definition",
    1: "Find References"
};

export class SidebarView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'search-copilot.sidebarView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private _question: string,
        private _selectedCode: string
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        // Set up the webview options
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        // Initial content for the sidebar
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
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
                <link href="${prismCSS}">
            </head>
            <body>
                <div id="user-question">
                    <h2>User Question: ${this._question}</h2>
                    <div class="code-box">
                        <pre class="language-javascript line-numbers"><code>${this._stripSingleLineIndentation(this._selectedCode)}</code></pre>
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

            let task1Html = `
            <div class="task">
                <h3>Task 1: Refined Question and Sub-questions</h3>
                <p><strong>Refined Question: ${task1Output.refined_question}</strong></p>
                <div id="task1-sub-questions">
                <p>Going to explore <strong>${task1Output.sub_problems.length}</strong> sub-questions:</p>
            `;

            for (const subProblem of task1Output.sub_problems) {
                const codeContext = subProblem.code_context;
                const fileName = this.getFileNameFromUri(codeContext.file_uri);

                task1Html += `
                <div class="sub-question">
                    <p><strong>Sub-question: ${subProblem.sub_question}</strong></p>
                    <p class="code-info">
                        Going to use <strong>${allowedTools[subProblem.tool as keyof typeof allowedTools]}</strong> to explore <strong>${subProblem.invoke_variable}</strong> in  <strong>${fileName}, 
                        <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                            line ${codeContext.line_number}
                        </a></strong>:
                    </p>
                    <div class="code-box">
                        <pre class="language-typescript line-numbers"><code>${this.escapeHtml(this._stripSingleLineIndentation(codeContext.full_statement))}</code></pre>
                    </div>
                </div>
            `;
            }

            task1Html += `</div></div>`;
            webview.postMessage({ command: 'appendHtml', html: task1Html });
        }
    }

    // Function to add Task 2 results to the sidebar with surrounding code
    public async addTask2Results(task2Output: any) {
        if (this._view) {
            const webview = this._view.webview;

            let task2Html = `
            <div class="task">
                <h3>Task 2: Exploration Results</h3>
                <div id="task2-results">
        `;

            for (const result of task2Output.questions_and_results) {
                task2Html += `
                <div class="sub-question">
                    <p><strong>Sub-question:</strong> ${result.sub_question}</p>
                    <p class="code-info">Used <strong>${allowedTools[result.tool as keyof typeof allowedTools]}</strong> to explore <strong>${result.invoke_variable}</strong> in:</p>
                    <div class="code-box">
                        <pre class="language-typescript line-numbers"><code>${this.escapeHtml(this._stripSingleLineIndentation(result.code_context.code_line))}</code></pre>
                    </div>
                    <p class="code-info">Find <strong>${result.filtered_results.length}</strong> results:</p>
                    <div id="filtered-results">
            `;

                for (const filteredResult of result.filtered_results) {
                    const fileName = this.getFileNameFromUri(filteredResult.file_uri);

                    // Fetch surrounding code and destructuring assignment
                    const { contextText } = await getSurroundingCode(vscode.Uri.parse(filteredResult.file_uri), filteredResult.line_number, filteredResult.line_number);

                    task2Html += `
                    <div class="result">
                        <p class="code-info">
                            In <strong>${fileName}, 
                            <a href="#" class="line-link" data-file-uri="${filteredResult.file_uri}" data-line="${filteredResult.line_number}">
                                Line ${filteredResult.line_number}
                            </a></strong>:
                        </p>
                        <div class="code-box">
                            <pre class="language-typescript line-numbers" data-line="${filteredResult.line_number}"><code>${this.escapeHtml(contextText)}</code></pre>
                        </div>
                    </div>
                `;
                }

                task2Html += `</div></div>`;
            }

            task2Html += `</div></div>`;

            webview.postMessage({ command: 'appendHtml', html: task2Html });
        }
    }

    // Function to add Task 3 results (final decision and explanation) with surrounding code
    public async addTask3Results(task3Output: any) {
        if (this._view) {
            const webview = this._view.webview;

            let task3Html = `
            <div class="task">
                <h3>Task 3: Final Decision</h3>
                <p><strong>Decision Sufficient: ${task3Output.final_decision_sufficient}</strong></p>
            `;
            if (task3Output.final_decision_sufficient === true) {
                task3Html += `
                <p>${task3Output.final_answer}</p>
                <div id="task3-sub-questions">
                `;
            } else {
                task3Html += `
                <p>Going to explore <strong>${task3Output.sub_problems.length}</strong> sub-questions:</p>
                <div id="task3-sub-questions">
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
                                Line ${codeContext.line_number}
                            </a></strong>:
                        </p>
                        <div class="code-box">
                            <pre class="language-typescript line-numbers"><code>${this.escapeHtml(this._stripSingleLineIndentation(codeContext.full_statement))}}</code></pre>
                        </div>
                    </div>
                    `;
                }
            }

            task3Html += `</div></div>`;

            webview.postMessage({ command: 'appendHtml', html: task3Html });
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