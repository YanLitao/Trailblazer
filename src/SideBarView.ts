import * as vscode from 'vscode';
import { stripLineIndentation } from './codeContextUtils';
import { TreeNode } from './explorationGraph';

export class SidebarView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'search-copilot.sidebarView';
    private _view?: vscode.WebviewView;
    private _question: string = '';
    private _selectedCode: string = '';
    private _stepCounter: number = 1;
    private _initialFileUri: string = '';
    private _initialLineNumber: number = 0;
    private _prelimaryAnswer: string = '';

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
            } else if (message.command === 'showNewInformation') {
                this.addAnswer("", true);
                vscode.commands.executeCommand('extension.showNewInformation');
            }
        });
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

                // Wait for 8 seconds
                await new Promise((resolve) => setTimeout(resolve, 8000));

                // Clean up all decorations
                lineDecoration.dispose();
                if (variableDecoration) variableDecoration.dispose();
            } else {
                // Show an input box and highlight until it is closed
                try {
                    const userInput = await vscode.window.showInputBox({
                        prompt: ``,
                        placeHolder: "Ask a follow-up question...",
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
        } else {
            console.warn("Retrying to update agent status...");
            setTimeout(() => this._updateAgentStatus(status), 1000);
        }
    }

    // Example usage: Set agent status to "Searching"
    public agentIsRunning() {
        console.warn("Agent is running");
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
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
                <script src="${d3Uri}"></script>
            </head>
            <body>
                <div id="header">
                    <div class="header-divs">Searching for answer to "<span id="title-question">${this._question}</span>"</div>
                    <div id="agent-status" class="header-divs">
                        <div id="actions">
                            <div id="status">Status: <span id="agent-status-text" class="idle-status">Idle</span></div>
                            <button id="pause-agent" title="Pause agent" class="action-btn removable"><i class="fa-solid fa-pause"></i></button>
                            <button id="stop-agent" title="Stop agent" class="action-btn removable"><i class="fa-solid fa-stop"></i></button>
                            <button id="save-pdf" title="Save log of agent action" class="action-btn removable"><i class="fa-solid fa-file-pdf"></i></button>
                        </div>
                    </div>
                    <div class="code-box header-divs">
                        Starting point
                        <code>${stripLineIndentation(this._selectedCode)}</code>
                        <button class="jump-btn" title="Open in code editor" data-file-uri="${this._initialFileUri}" data-line-number="${this._initialLineNumber}">
                            <i class="fa-solid fa-file-import"></i>
                        </button>
                    </div>
                    <div id="searching-content" class="header-divs"></div>
                    <div id="new-info" class="header-divs">
                        I found new information. <button id="new-info-btn" title="Click to see new information">Update display below?</button>
                    </div>
                    <div id="answer-div"></div>
                </div>
                <div id="walkthrough">
                    <h1>My walkthrough of the code</h1>
                    <div id="info-box" class="info-box">
                        Below, you will see all of the things I found as I walked through the code base to answer your question. I found all of these things using code analysis (e.g., jumping to definitions or references).
                    </div>
                    <div id="graph-container"></div>
                    <script src="${html2pdfJS}"></script>
                    <script src="${scriptUri}"></script>
                </div>
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

    public async showAnswer(answerText: string) {
        const isFinalAnswer = answerText.includes('<h1 id="final-answer-header">Answer</h1>');
        if (isFinalAnswer) {
            // Show the answer immediately if it's the final answer or if there's no preliminary answer yet
            this.addAnswer(answerText);
        } else if (this._prelimaryAnswer === '') {
            this._prelimaryAnswer = answerText;
            this.addAnswer(answerText);
        } else {
            this._prelimaryAnswer = answerText;
            this._view?.webview.postMessage({
                command: 'newInformationAvailable'
            });
        }
        this._stepCounter++;
    }

    public async addAnswer(answer: string, updateFlag: boolean = false) {
        if (updateFlag) {
            this._view?.webview.postMessage({
                command: 'updateAnswer',
                answer: this._prelimaryAnswer
            });
        } else {
            this._view?.webview.postMessage({
                command: 'updateAnswer',
                answer: answer
            });
        }
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

    public disposePreliminaryAnswer() {
        this._prelimaryAnswer = '';
    }
}