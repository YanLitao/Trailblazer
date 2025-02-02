import * as vscode from 'vscode';
import { getSurroundingCode, stripLineIndentation } from './codeContextUtils';
import { Node, Edge, TreeNode } from './explorationGraph';

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
    private _stayingTime: number = 5; // seconds
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
            } else if (message.command === 'openZoneWidget') {
                const { fileUri, lineNumber, variable } = message;
                this.createZoneWidget(fileUri, lineNumber, true, variable);
            } else if (message.command === 'replaySnippet') {
                const { fileUri, lineNumber, variable, finding, incomingMessage, outgoingMessage } = message;
                this.createZoneWidget(fileUri, lineNumber, false, variable, finding, incomingMessage, outgoingMessage);
            } else if (message.command === 'stopAgent') {
                this.agentIsDone();
                vscode.commands.executeCommand('extension.stopAgent');
            } else if (message.command === 'pauseAgent') {
                vscode.commands.executeCommand('extension.pauseAgent');
            } else if (message.command === 'continueAgent') {
                vscode.commands.executeCommand('extension.continueAgent');
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
            command: 'updateAnswer',
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

    /**
     * Highlights a line in the editor.
     * @param editor The text editor instance.
     * @param lineNumber The line number to highlight.
     * @param color The background color for the highlight.
     * @param duration Optional duration (in milliseconds) for the highlight to persist.
     * @returns A promise that resolves when the highlight is cleared, or immediately if no duration is provided.
     */
    private highlightLineInEditor(
        editor: vscode.TextEditor,
        lineNumber: number,
        duration: number = 0,
        color: string = "rgba(173, 216, 230, 0.5)",
    ): Promise<void> {
        return new Promise((resolve) => {
            const lineRange = editor.document.lineAt(lineNumber).range;
            const highlightDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: color,
            });

            // Apply the decoration to the line
            editor.setDecorations(highlightDecoration, [lineRange]);

            if (duration > 0) {
                // Clear the decoration after the specified duration
                setTimeout(() => {
                    editor.setDecorations(highlightDecoration, []);
                    highlightDecoration.dispose();
                    resolve();
                }, duration);
            } else {
                resolve();
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

            // Reveal the range in the editor
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(position, position);

            // Highlight the line
            await this.highlightLineInEditor(editor, lineNumber, 3000);
        } catch (error) {
            console.error(`Error opening file at line ${lineNumber}: `, error);
        }
    }

    async createZoneWidget(
        fileUri: string,
        lineNumber: number,
        questionFlag: boolean = false,
        variable: string = "",
        finding: string = "",
        incomingMessage: string = "",
        outgoingMessage: string = ""
    ) {
        if (fileUri === "" || lineNumber === -1) {
            return;
        }
        try {
            const uri = vscode.Uri.parse(fileUri);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document);

            // Move the cursor to the specified line
            const position = new vscode.Position(lineNumber, 0); // Start of the line
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

            // Function to highlight the line
            const highlightLine = (): vscode.TextEditorDecorationType => {
                const lineRange = document.lineAt(lineNumber).range;
                const lineDecoration = vscode.window.createTextEditorDecorationType({
                    backgroundColor: "rgba(173, 216, 230)", // Light blue background
                });
                editor.setDecorations(lineDecoration, [lineRange]);
                return lineDecoration;
            };

            // Always highlight the line
            const lineDecoration = highlightLine();

            if (!questionFlag) {
                // Highlight the variable in the line if it exists
                let variableDecoration: vscode.TextEditorDecorationType | undefined;
                if (variable && variable.trim() !== "") {
                    const lineText = document.lineAt(lineNumber).text;
                    const variableIndex = lineText.indexOf(variable);

                    if (variableIndex !== -1) {
                        const variableStart = new vscode.Position(lineNumber, variableIndex);
                        const variableEnd = new vscode.Position(lineNumber, variableIndex + variable.length);
                        const variableRange = new vscode.Range(variableStart, variableEnd);

                        variableDecoration = vscode.window.createTextEditorDecorationType({
                            backgroundColor: "rgba(255, 223, 186)", // Light orange background
                            borderRadius: "3px",
                        });
                        editor.setDecorations(variableDecoration, [variableRange]);
                    }
                }

                // Helper to get indents from a line
                const getIndent = (line: string): string => {
                    return line.match(/^\s*/)?.[0] || "";
                };

                const lineText = document.lineAt(lineNumber).text;
                const indent = getIndent(lineText);

                // Add finding text below the target line if not empty
                let findingTextDecoration: vscode.TextEditorDecorationType | undefined;
                if (finding) {
                    const findingPosition = new vscode.Position(lineNumber + 1, 0);
                    const findingRange = new vscode.Range(findingPosition, findingPosition);
                    findingTextDecoration = vscode.window.createTextEditorDecorationType({
                        after: {
                            contentText: `${indent}Finding: ${finding}`,
                            backgroundColor: "lightyellow",
                            margin: "4px 0",
                            border: "1px solid lightgray",
                        },
                    });
                    editor.setDecorations(findingTextDecoration, [findingRange]);
                }

                // Add incoming text above the target line
                let incomingTextDecoration: vscode.TextEditorDecorationType | undefined;
                if (incomingMessage) {
                    const incomingPosition = new vscode.Position(lineNumber - 1, 0);
                    const incomingRange = new vscode.Range(incomingPosition, incomingPosition);
                    incomingTextDecoration = vscode.window.createTextEditorDecorationType({
                        after: {
                            contentText: `${indent}${incomingMessage}`,
                            backgroundColor: "lightyellow",
                            margin: "4px 0",
                            border: "1px solid lightgray",
                        },
                    });
                    editor.setDecorations(incomingTextDecoration, [incomingRange]);
                }

                // Add outgoing text two lines below the target line if not empty
                let outgoingTextDecoration: vscode.TextEditorDecorationType | undefined;
                if (outgoingMessage) {
                    const outgoingPosition = finding ? new vscode.Position(lineNumber + 2, 0) : new vscode.Position(lineNumber + 1, 0);
                    const outgoingRange = new vscode.Range(outgoingPosition, outgoingPosition);
                    outgoingTextDecoration = vscode.window.createTextEditorDecorationType({
                        after: {
                            contentText: `${indent}${outgoingMessage}`,
                            backgroundColor: "lightyellow",
                            margin: "4px 0",
                            border: "1px solid lightgray",
                        },
                    });
                    editor.setDecorations(outgoingTextDecoration, [outgoingRange]);
                }

                // Wait for 8 seconds
                await new Promise((resolve) => setTimeout(resolve, 8000));

                // Clean up all decorations
                lineDecoration.dispose();
                if (variableDecoration) variableDecoration.dispose();
                if (findingTextDecoration) findingTextDecoration.dispose();
                if (incomingTextDecoration) incomingTextDecoration.dispose();
                if (outgoingTextDecoration) outgoingTextDecoration.dispose();
            } else {
                // Show an input box and highlight until it is closed
                try {
                    const userInput = await vscode.window.showInputBox({
                        prompt: `Enter text below line ${lineNumber + 1}`,
                        placeHolder: "Type your input here...",
                    });

                    if (userInput !== undefined) {
                        vscode.window.showInformationMessage(`You entered: ${userInput}`);
                        vscode.commands.executeCommand(
                            "extension.followUpQuestion",
                            userInput,
                            fileUri,
                            lineNumber,
                            variable
                        );
                    }
                } finally {
                    // Clean up the line highlight when the input box is dismissed
                    lineDecoration.dispose();
                    vscode.commands.executeCommand('extension.continueAgent');

                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create zone widget: ${String(error)}`);
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
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
                <script src="${d3Uri}"></script>
            </head>
            <body>
                <div id="header">
                    <div class="header-divs">Searching for answer to "<span id="title-question">${this._question}</span>"</div>
                    <div class="code-box header-divs">
                        Selected code:
                        <br>
                        <code>${stripLineIndentation(this._selectedCode)}</code>
                    </div>
                    <div id="agent-status" class="header-divs">
                        Status: <span id="agent-status-text" class="idle-status">Idle</span>
                    </div>
                    <div id="searching-content" class="header-divs"></div>
                    <div id="actions" style="display: flex; justify-content: space-around; padding: 10px;">
                        <button id="pause-agent" class="action-btn"><i class="fa-solid fa-pause"></i></button>
                        <button id="stop-agent" class="action-btn"><i class="fa-solid fa-stop"></i></button>
                        <button id="save-pdf" class="action-btn"><i class="fa-solid fa-file-pdf"></i></button>
                    </div>
                    <div id="answer-div"></div>
                    <div id="still-to-be-found" class="header-divs">Still to be found: <span id="exploration-summary"></span></div>
                </div>
                <h1>Exploration Steps 
                    <span class="info-icon" id="info-icon">i</span>
                </h1>
                <div id="info-box" class="info-box">
                    This visualization shows how your AI agent explores the codebase using VSCode tools of 
                    <strong>"Go to Definition"</strong> and <strong>"Find References"</strong>, along with AST analysis. 
                    The agent only decides the next steps and summarizes findings to build an answer.  
                    <br><br>
                    This is <strong>not</strong> a call graph or dependency graph—it's a guided code exploration using standard developer tools.
                </div>
                <div id="graph-container"></div>
                <div id="current-task">
                    <div id="current-task-content"></div>
                </div>
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
                </div> 
                <script src="${prismJS}"></script>
                <script src="${html2pdfJS}"></script>
                <script src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }

    public updateSearchingContent(content: string) {
        this._view?.webview.postMessage({
            command: 'updateSearchingContent',
            content: content
        });
    }

    public updatetitleQuestion(newQuestion: string) {
        if (this._view) {
            this._view.webview.postMessage({ command: 'updateTitleQuestion', question: newQuestion });
        }
    }

    public async addTask3Results(final_decision_sufficient: boolean, task3Output: any) {
        if (this._view) {
            /* const webview = this._view.webview;
            const explorationUniqueId = `exploration-task3-results-${this._stepCounter}`; // Unique ID for exploration steps
             */
            const currentTaskUniqueId = `current-task3-results-${this._stepCounter}`; // Unique ID for current task
            //var i = -1;

            // Update the preliminary answer text in the webview
            let answerText = "";
            if (task3Output.answer) {
                answerText = task3Output.answer;
            }

            const nextStepSummary = final_decision_sufficient
                ? ""
                : (task3Output.next_step_summary || "");

            let findingsHtml = "";

            let currentTaskHtml = "";

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

    public async addAnswer(answer: string) {
        this._view?.webview.postMessage({
            command: 'updateAnswer',
            answer: answer
        });
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

    private removeCircularReferences(node: TreeNode, seen = new Set()): any {
        if (seen.has(node)) {
            return null; // Avoid circular references
        }
        node.codeSnippet = stripLineIndentation(node.codeSnippet);
        seen.add(node);

        const { children, ...rest } = node; // Exclude children to prevent infinite recursion

        // Recursively process children and filter out null values
        const sanitizedChildren = children
            ? children
                .map(child => this.removeCircularReferences(child, seen))
                .filter(child => child !== null) // Remove null entries
            : [];

        return {
            ...rest,
            children: sanitizedChildren
        };
    }

    public updateGraphVisualization(tree: TreeNode) {
        const treeWithoutCircularReferences = this.removeCircularReferences(tree);
        this._view?.webview.postMessage({
            command: 'renderGraph',
            data: treeWithoutCircularReferences
        });
    }
}