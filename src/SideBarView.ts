import * as vscode from 'vscode';
import { getDestructuringAssignment, getSurroundingCode } from './extension';

export class SidebarView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'search-copilot.sidebarView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private _question: string,
        private _selectedCode: string
    ) { }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        // Initialize with the user question and selected code
        webviewView.webview.html = this.getHtmlForWebview();
    }

    private getHtmlForWebview(): string {
        const styleUri = this._context.extensionUri.with({ path: 'media/sidebar.css' });
        const prismJsUri = this._context.extensionUri.with({ path: 'media/prism.js' });
        const jsUri = this._context.extensionUri.with({ path: 'media/sidebar.js' });

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Search Copilot</title>
                <link href="${styleUri}" rel="stylesheet">
            </head>
            <body>
                <div id="user-question">
                    <h2>User Question: ${this._question}</h2>
                    <div class="code-box">
                        <pre><code class="language-javascript">${this._selectedCode}</code></pre>
                    </div>
                </div>
                <div id="exploration-steps"></div> <!-- This div will hold all exploration steps -->
                <script src="${prismJsUri}"></script>
                <script src="${jsUri}"></script>
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
                <p><strong>Refined Question:</strong> ${task1Output.refined_question}</p>
                <div id="task1-sub-questions">
            `;

            for (const subProblem of task1Output.sub_problems) {
                const codeContext = subProblem.code_context;
                const fileName = this.getFileNameFromUri(codeContext.file_uri);

                // Fetch surrounding code and destructuring assignment
                const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(codeContext.file_uri));
                const fullStatement = await getDestructuringAssignment(document, codeContext.line_number);
                const { contextText } = await getSurroundingCode(vscode.Uri.parse(codeContext.file_uri), codeContext.line_number, codeContext.line_number);

                task1Html += `
                <div class="sub-question">
                    <h4 class="code-title">
                        Invoke in ${fileName}, 
                        <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                            line ${codeContext.line_number}
                        </a>
                    </h4>
                    <div class="code-box">
                        <pre><code class="language-javascript">${this.escapeHtml(fullStatement)}\n\n${this.escapeHtml(contextText)}</code></pre>
                    </div>
                </div>
            `;
            }

            task1Html += `</div></div>`;
            console.warn("addTask1Results", task1Html);
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
                    <h4>Sub-question: ${result.sub_question}</h4>
                    <div class="code-box">
                        <pre><code class="language-javascript">${this.escapeHtml(result.code_context.full_statement)}</code></pre>
                    </div>
                    <div id="filtered-results">
            `;

                for (const filteredResult of result.filtered_results) {
                    const fileName = this.getFileNameFromUri(filteredResult.file_uri);

                    // Fetch surrounding code and destructuring assignment
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(filteredResult.file_uri));
                    const fullStatement = await getDestructuringAssignment(document, filteredResult.line_number);
                    const { contextText } = await getSurroundingCode(vscode.Uri.parse(filteredResult.file_uri), filteredResult.line_number, filteredResult.line_number);

                    task2Html += `
                    <div class="result">
                        <p>
                            File: ${fileName}, 
                            <a href="#" class="line-link" data-file-uri="${filteredResult.file_uri}" data-line="${filteredResult.line_number}">
                                Line: ${filteredResult.line_number}
                            </a>
                        </p>
                        <div class="code-box">
                            <pre><code class="language-javascript">${this.escapeHtml(fullStatement)}\n\n${this.escapeHtml(contextText)}</code></pre>
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
                <p><strong>Decision Sufficient:</strong> ${task3Output.final_decision_sufficient}</p>
                <p>${task3Output.final_answer}</p>
                <div id="task3-sub-questions">
        `;

            for (const subProblem of task3Output.sub_problems) {
                const codeContext = subProblem.code_context;
                const fileName = this.getFileNameFromUri(codeContext.file_uri);

                // Fetch surrounding code and destructuring assignment
                const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(codeContext.file_uri));
                const fullStatement = await getDestructuringAssignment(document, codeContext.line_number);
                const { contextText } = await getSurroundingCode(vscode.Uri.parse(codeContext.file_uri), codeContext.line_number, codeContext.line_number);

                task3Html += `
                <div class="sub-question">
                    <h4>Sub-question: ${subProblem.sub_question}</h4>
                    <p>
                        File: ${fileName}, 
                        <a href="#" class="line-link" data-file-uri="${codeContext.file_uri}" data-line="${codeContext.line_number}">
                            Line: ${codeContext.line_number}
                        </a>
                    </p>
                    <div class="code-box">
                        <pre><code class="language-javascript">${this.escapeHtml(fullStatement)}\n\n${this.escapeHtml(contextText)}</code></pre>
                    </div>
                </div>
            `;
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