import * as vscode from 'vscode';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { SidebarView } from './SideBarView';
import { getFileNameFromUri, getSurroundingCode, stripSingleLineIndentation, getAccurateLineNumber, searchVariableOffset, preProcessCodeLine, getDestructuringAssignment } from './codeContextUtils';
import { ExplorationGraph, Node, Edge } from './explorationGraph';
// API key for OpenAI
const API_KEY = process.env.OPENAI_TOKEN;

if (!API_KEY) {
    console.error("OpenAI API Key is missing. Please set the OPENAI_TOKEN environment variable.");
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize the SidebarView and Agent with only the context
    const sidebarViewProvider = new SidebarView(context);
    const agent = new Agent(sidebarViewProvider); // Instantiate Agent once here

    // Register the webview provider for the sidebar
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebarViewProvider)
    );

    // Register the command to ask a question about code
    const askQuestionDisposable = vscode.commands.registerCommand('search-copilot.helloWorld', () => {
        askQuestionAboutCode(context, sidebarViewProvider, agent); // Pass the Agent instance
    });
    context.subscriptions.push(askQuestionDisposable);

    // Register commands for pause, continue, and stop
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.pauseAgent', () => {
            agent.pause();
            vscode.window.showInformationMessage('Agent paused.');
        }),
        vscode.commands.registerCommand('extension.continueAgent', () => {
            agent.continue();
            vscode.window.showInformationMessage('Agent continued.');
        }),
        vscode.commands.registerCommand('extension.stopAgent', () => {
            agent.stop();
            vscode.window.showInformationMessage('Agent stopped.');
        })
    );
}

export async function getQuestion(code: string) {
    return vscode.window.showInputBox({
        placeHolder: "What do you want to ask about this code?",
        prompt: `The line of code is ${code}`
    });
}

async function askQuestionAboutCode(context: vscode.ExtensionContext, sidebarViewProvider: SidebarView, agent: Agent) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const selection = editor.selection;
    let selectedText = editor.document.getText(selection);
    if (selection.isEmpty) {
        selectedText = editor.document.lineAt(selection.start.line).text;
    }

    const startLine = selection.start.line;
    const endLine = selection.end.line;

    // Prompt user for the question
    const query = await getQuestion(selectedText);
    if (query === undefined) {
        return; // User canceled the input box
    }

    // Update the sidebar with the user question and selected code
    sidebarViewProvider.updateWebviewContent(query, selectedText, getFileNameFromUri(editor.document.uri.toString()), startLine);

    // Show the sidebar automatically once the question is received
    vscode.commands.executeCommand('workbench.view.extension.search-copilot-sidebar').then(() => {
        // Run the workflow using the persistent Agent instance
        agent.runWorkflow(query, editor.document.uri, startLine, endLine);
    });
}

const allowedTools = {
    0: "Go to Definition",
    1: "Find References"
};

const task1JsonSchema = {
    type: "object",
    properties: {
        refined_question: { type: "string" },
        sub_problems: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    sub_question: { type: "string" },
                    tool: { type: "integer" },
                    code_context: {
                        type: "object",
                        properties: {
                            file_uri: { type: "string" },
                            invoke_variable: { type: "string" },
                            code_line: { type: "string" },
                            line_number: { type: "integer" },
                            full_statement: { type: "string" }
                        },
                        required: ["file_uri", "invoke_variable", "code_line", "full_statement"]
                    },
                    num_results: { type: "integer" },
                    reason: { type: "string" }
                },
                required: ["sub_question", "tool", "code_context", "num_results", "reason"]
            }
        }
    },
    required: ["refined_question", "sub_problems"]
};

const task2JsonSchema = {
    type: "object",
    properties: {
        questions_and_results: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    sub_question: { type: "string" },
                    tool: { type: "integer" },
                    code_context: {
                        type: "object",
                        properties: {
                            file_uri: { type: "string" },
                            invoke_variable: { type: "string" },
                            code_line: { type: "string" },
                            line_number: { type: "integer" },
                            full_statement: { type: "string" }
                        },
                        required: ["file_uri", "invoke_variable", "code_line", "line_number", "full_statement"]
                    },
                    num_results: { type: "integer" },
                    filtered_results: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                file_uri: { type: "string" },
                                code_line: { type: "string" },
                                line_number: { type: "integer" },
                                full_statement: { type: "string" },
                                explanation: { type: "string" },
                                from_results: { type: "boolean" }
                            },
                            required: ["file_uri", "code_line", "line_number", "full_statement", "explanation", "from_results"]
                        }
                    }
                },
                required: ["sub_question", "filtered_results"]
            }
        }
    },
    required: ["questions_and_results"]
};

const task3JsonSchema = {
    type: "object",
    properties: {
        final_decision_sufficient: { type: "boolean" },
        answer: { type: "string" },
        sub_problems: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    sub_question: { type: "string" },
                    tool: { type: "integer" },
                    code_context: {
                        type: "object",
                        properties: {
                            file_uri: { type: "string" },
                            invoke_variable: { type: "string" },
                            code_line: { type: "string" },
                            line_number: { type: "integer" },
                            full_statement: { type: "string" },
                            from_results: { type: "boolean" }
                        },
                        required: ["file_uri", "invoke_variable", "code_line", "line_number", "full_statement", "from_results"]
                    },
                    num_results: { type: "integer" },
                    reason: { type: "string" }
                },
                required: ["sub_question", "tool", "code_context", "num_results", "reason"]
            }
        }
    },
    required: ["final_decision_sufficient", "answer", "sub_problems"]
};

const task4JsonSchema = {
    type: "object",
    properties: {
        ranked_results: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    file_uri: { type: "string" },
                    code_line: { type: "string" },
                    line_number: { type: "integer" },
                    full_statement: { type: "string" },
                    explanation: { type: "string" },    // Explanation of why this result is helpful
                    relevance_score: { type: "integer" } // Relevance score, e.g., 1-5 where 5 is most relevant
                },
                required: ["file_uri", "code_line", "line_number", "full_statement", "explanation", "relevance_score"]
            }
        }
    },
    required: ["ranked_results"]
};

class Agent {
    private _model: ChatOpenAI;
    private _explorationHistory: any[] = [];
    private _stepCounter: number = 0;
    private _refined_question: string | null = null;
    private _sidebarViewProvider: SidebarView;
    private _exploredVariables: any[] = [];
    private _exploredFiles: { file_uri: string, file_content: string }[] = []; // Simplified _exploredFiles
    private _exploredSubQuestions: string[] = [];
    private _exploredCodeLines: { file_uri: string, start_line: number, end_line: number, code_snippet: string }[] = [];
    private _explorationGraph: ExplorationGraph;
    private isPaused: boolean = false;     // Track if the agent is paused
    private isStopped: boolean = false;    // Track if the agent is stopped
    private _importantResults: Array<{ file_uri: string; code_line: string; line_number: number; full_statement: string; explanation: string; relevance_score: number }> = [];
    private _lastTask4Promise = Promise.resolve(); // Initialize a placeholder Promise

    constructor(sidebarViewProvider: SidebarView) {
        this._model = new ChatOpenAI({
            model: "gpt-4o-mini",
            apiKey: API_KEY,
            maxTokens: 16384,
            temperature: 0.5,
            topP: 1,
        });
        this._sidebarViewProvider = sidebarViewProvider;
        this._explorationGraph = new ExplorationGraph();
    }

    // New methods to handle pause, continue, and stop
    pause() {
        this.isPaused = true;
        this.isStopped = false;
    }

    continue() {
        this.isPaused = false;
    }

    stop() {
        this.isPaused = false;
        this.isStopped = true;
    }

    async runWorkflow(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        const MAX_STEPS = 30;
        let sufficient = false;
        let refinedOutput;

        // Fetch the file content and add it to _exploredFiles if not already present
        const document = await vscode.workspace.openTextDocument(uri);
        const fileUriString = uri.toString();
        const fileContent = document.getText();

        // Add the file content only if it hasn't been explored before
        if (!this._exploredFiles.some(file => file.file_uri === fileUriString)) {
            this._exploredFiles.push({
                file_uri: fileUriString,
                file_content: fileContent
            });
        }

        // Add the selected code into _exploredCodeLines
        const selectedCodeSnippet = document.getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character));
        this._exploredCodeLines.push({
            file_uri: fileUriString,
            start_line: startLine,
            end_line: endLine,
            code_snippet: selectedCodeSnippet
        });

        this._sidebarViewProvider.agentIsRunning();

        // Task 1: Refine the question and identify sub-problems
        refinedOutput = await this.runTask1(question, uri, startLine, endLine);

        // Loop to explore sub-problems
        while (!sufficient && this._stepCounter < MAX_STEPS && !this.isStopped) {
            if (!refinedOutput || !refinedOutput.sub_problems) {
                console.error("Error: No sub-problems returned.");
                break;
            }

            if (this.isPaused) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait if paused
                continue;
            }

            this._stepCounter++;

            // Ensure Task 4 from previous cycle completes before starting this cycle
            if (this._lastTask4Promise) {
                await this._lastTask4Promise;
            }

            // Task 2: Explore sub-problems
            await this.runTask2(refinedOutput.sub_problems);

            // Task 3: Evaluate if the question is sufficiently answered
            const task3Output = await this.runTask3();
            sufficient = task3Output.final_decision_sufficient;
            refinedOutput = task3Output;

            if (sufficient || task3Output.sub_problems.length === 0) {
                break;
            }
        }

        // Ensure final ranking is completed
        await this._lastTask4Promise;

        this._sidebarViewProvider.agentIsDone();

        if (this._stepCounter >= MAX_STEPS) {
            console.log("Reached maximum exploration steps.");
        }
    }

    async runTask1(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        const document = await vscode.workspace.openTextDocument(uri);
        console.warn("Running Task 1");
        const { contextText: surroundingCode, startContextLine } = await getSurroundingCode(uri, startLine, endLine);

        const inputJson = {
            "task": 1,
            "question": question,
            "surrounding_code": surroundingCode,
            "file_uri": uri.toString(),
            "line_number": startLine,
            "allowed_tools": allowedTools
        };

        //console.log(`Task 1 Input: ${JSON.stringify(inputJson)}`);

        const response = await this._callAgentAPI(inputJson, 1, task1JsonSchema);
        const task1Output = JSON.parse(response);

        //console.log(`Task 1 Output: ${JSON.stringify(task1Output)}`);

        this._refined_question = task1Output.refined_question;

        for (const subProblem of task1Output.sub_problems) {
            if (uri && "file_uri" in subProblem.code_context) {
                subProblem.code_context.file_uri = uri.toString();
            } else {
                console.log(subProblem);
                continue;
            }

            //const invokeVariable = subProblem.code_context.invoke_variable;
            const codeLine = preProcessCodeLine(subProblem, surroundingCode);

            if (codeLine) {
                const accurateLineNumber = getAccurateLineNumber(surroundingCode, codeLine, subProblem.code_context.line_number, startContextLine);

                if (accurateLineNumber !== null) {
                    subProblem.code_context.line_number = accurateLineNumber;
                    const fullStatement = await getDestructuringAssignment(document, accurateLineNumber);
                    subProblem.code_context.full_statement = fullStatement;

                    // Create a node for each sub-problem and mark it as an invoking place
                    const nodeId = `${uri.toString()}:${accurateLineNumber}`;
                    const newNode: Node = {
                        id: nodeId,
                        fileUri: uri.toString(),
                        startLine: accurateLineNumber,
                        endLine: accurateLineNumber + fullStatement.split('\n').length - 1,
                        variables: new Set([subProblem.code_context.invoke_variable]),
                        codeSnippet: fullStatement,
                        isPlace: true,  // Mark as invoking place
                        edges: new Set()
                    };
                    this._explorationGraph.upsertNode(nodeId, newNode, null, this._stepCounter, subProblem.tool, true);
                }
            }
        }

        // Update the sidebar view with Task 1 results after processing
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider.addTask1Results(task1Output);  // Add the Task 1 results to the sidebar
        }

        return task1Output;
    }

    async runTask2(subProblems: any[]) {
        console.warn("Running Task 2");

        const task2Input: any = {
            task: 2,
            refined_question: this._refined_question,
            questions_and_results: [] // Only includes sub-problems that need further filtering by the agent
        };

        const task2Results: any[] = []; // Stores final results to display in the sidebar

        for (const subProblem of subProblems) {
            const variableName = subProblem.code_context.invoke_variable;
            let initialLineNumber = subProblem.code_context.line_number;
            const fileUri = vscode.Uri.parse(subProblem.code_context.file_uri);

            // Open the document at the specified fileUri
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Ensure the file is added to _exploredFiles if not already added
            this._addToExploredFiles(fileUri, document);

            // Get code of the line
            const codeLine = document.lineAt(initialLineNumber).text.trim();

            if (!codeLine.includes(variableName)) {
                const accurateLineNumber = getAccurateLineNumber(document.getText(), variableName, initialLineNumber, 0);
                if (!accurateLineNumber) {
                    continue;
                } else {
                    subProblem.code_context.line_number = accurateLineNumber;
                    initialLineNumber = accurateLineNumber;
                }
            }
            // Find the variable's offset in the document
            const offsetResult = await searchVariableOffset(document, variableName, initialLineNumber);

            if (!offsetResult) {
                console.error(`Variable "${variableName}" not found near line ${initialLineNumber}.`);
                task2Results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    filtered_results: [],
                    reason: "Variable not found in code"
                });
                continue;
            }

            const { line, offset } = offsetResult;

            // Track explored sub-questions
            this._exploredSubQuestions.push(subProblem.sub_question);

            // Check if the variable has already been explored
            const existingVariable = this._exploredVariables.find(
                v => v.invoke_variable === variableName && v.line_number === line && v.file_uri === fileUri.toString() && v.tool === subProblem.tool
            );

            if (existingVariable && existingVariable.results.length > 0) {
                task2Results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    filtered_results: existingVariable.results
                });
                continue;
            }

            // Perform the selected tool action (Go to Definition or Find References)
            const results = await this._runTool(fileUri, line, offset, subProblem);

            if (results.length === 0) {
                console.warn(`No results were found for sub-problem "${subProblem.sub_question}".`);
                task2Results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    filtered_results: [],
                    reason: "No results found"
                });
                continue;
            }

            // Process each result as a node in the exploration graph
            const sourceId = `${subProblem.code_context.file_uri}:${subProblem.code_context.line_number}`;

            results.forEach(result => {
                const resultNodeId = `${result.file_uri}:${result.line_number}`;

                // Create result node if it doesn't already exist in the graph
                const resultNode: Node = {
                    id: resultNodeId,
                    fileUri: result.file_uri,
                    startLine: result.line_number,
                    endLine: result.line_number, // Assuming single line, adjust if multiline
                    variables: new Set([variableName]),
                    codeSnippet: result.code_line,
                    isPlace: false, // Result nodes are not invoking places
                    edges: new Set()
                };

                this._explorationGraph.upsertNode(resultNodeId, resultNode, sourceId, this._stepCounter, subProblem.tool, false);
            });

            // Add the variable and results to _exploredVariables
            this._exploredVariables.push({
                invoke_variable: variableName,
                line_number: line,
                file_uri: fileUri.toString(),
                results: results,
                tool: subProblem.tool
            });

            // Check if the number of results exceeds the threshold for agent involvement
            if (results.length > subProblem.num_results) {
                task2Input.questions_and_results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    num_results: subProblem.num_results,
                    results: results
                });
            } else {
                // If no agent involvement is needed, add the filtered results directly
                task2Results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    num_results: results.length,
                    filtered_results: results
                });
            }
        }

        // If any sub-questions need agent filtering, call the agent
        if (task2Input.questions_and_results.length > 0) {
            const agentResults = await this._callAgentAPI(task2Input, 2, task2JsonSchema);
            this._processAgentResults(JSON.parse(agentResults), task2Results);
        }

        // Run task 4 to rank the exploration results
        await this.runTask4(task2Results);

        // Update the sidebar with the final Task 2 results
        this._sidebarViewProvider.addTask2Results({ questions_and_results: task2Results });
    }

    // Helper function to add document content to _exploredFiles if not already present
    private _addToExploredFiles(fileUri: vscode.Uri, document: vscode.TextDocument) {
        const fileUriString = fileUri.toString();
        if (!this._exploredFiles.some(file => file.file_uri === fileUriString)) {
            this._exploredFiles.push({
                file_uri: fileUriString,
                file_content: document.getText()
            });
        }
    }

    // Helper function to run the selected tool and get results
    private async _runTool(fileUri: vscode.Uri, line: number, offset: number, subProblem: any): Promise<any[]> {
        const pos = new vscode.Position(line, offset);
        const loc = new vscode.Location(fileUri, pos);
        let results = [];

        if (subProblem.tool === 0) { // Go to Definition
            const definitionLocations = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
                'vscode.executeDefinitionProvider', loc.uri, loc.range.start
            );
            results = await this._prepareResults(definitionLocations, subProblem);
        } else if (subProblem.tool === 1) { // Find References
            const referenceLocations = await vscode.commands.executeCommand(
                'vscode.executeReferenceProvider', loc.uri, loc.range.start
            );
            results = await this._prepareResults(referenceLocations as vscode.Location[] | vscode.LocationLink[], subProblem);
        }

        return results;
    }

    // Helper function to process agent results and integrate them into task2Results
    private _processAgentResults(agentResults: any, task2Results: any[]) {
        if (Array.isArray(agentResults.questions_and_results)) {
            for (const subProblem of agentResults.questions_and_results) {
                if ("results" in subProblem) {
                    subProblem.filtered_results = subProblem.results;
                    delete subProblem.results;
                }
                task2Results.push(subProblem);
            }
        } else if (agentResults.questions_and_results && typeof agentResults.questions_and_results === 'object') {
            if ("results" in agentResults.questions_and_results) {
                agentResults.questions_and_results.filtered_results = agentResults.questions_and_results.results;
                delete agentResults.questions_and_results.results;
            }
            task2Results.push(agentResults.questions_and_results);
        }
    }

    // Helper function to add or update explored code lines
    private _addOrUpdateExploredCodeLines(fileUri: string, lineNumber: number, fullStatement: string, subProblem: any) {
        const linesInStatement = fullStatement.split('\n');
        const endLineOfStatement = lineNumber + linesInStatement.length - 1;

        // Check if the line is already covered in an existing code line
        const existingCode = this._exploredCodeLines.find(
            code => code.file_uri === fileUri &&
                ((code.start_line <= lineNumber && code.end_line >= lineNumber) ||
                    (code.start_line <= endLineOfStatement && code.end_line >= endLineOfStatement) ||
                    (code.start_line >= lineNumber && code.end_line <= endLineOfStatement))
        );

        if (!existingCode) {
            // Add the new code to _exploredCodeLines if it’s unique
            this._exploredCodeLines.push({
                file_uri: fileUri,
                start_line: lineNumber,
                end_line: endLineOfStatement,
                code_snippet: fullStatement
            });

        } else {
            // If there’s an overlap, extend the existing node if necessary
            existingCode.start_line = Math.min(existingCode.start_line, lineNumber);
            existingCode.end_line = Math.max(existingCode.end_line, endLineOfStatement);
            existingCode.code_snippet = `${existingCode.code_snippet}\n${fullStatement}`.trim();
        }
    }

    async _prepareResults(locations: vscode.Location[] | vscode.LocationLink[], subProblem: any) {
        const results: any[] = [];
        if (!locations || locations.length === 0) {
            console.warn(`No locations found for sub-problem: ${subProblem.sub_question}`);
            return results;
        }

        for (const location of locations) {
            const lineNumber = location instanceof vscode.Location ? location.range.start.line : (location as vscode.LocationLink).targetRange.start.line;
            const fileUri = location instanceof vscode.Location ? location.uri.toString() : (location as vscode.LocationLink).targetUri.toString();

            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(fileUri));

            const fullStatement = await getDestructuringAssignment(document, lineNumber);

            //console.log(`Result found at file: ${fileUri}, line: ${lineNumber}`);
            //console.log(`Full statement retrieved: ${fullStatement}`);

            // Add or update the explored code lines
            this._addOrUpdateExploredCodeLines(fileUri, lineNumber, fullStatement, subProblem);
            // Add or update the explored files
            this._addToExploredFiles(vscode.Uri.parse(fileUri), document);

            results.push({
                file_uri: fileUri,
                line_number: lineNumber,
                code_line: document.lineAt(lineNumber).text.trim(),
                full_statement: fullStatement
            });
        }

        return results;
    }

    async runTask3() {
        console.warn("Running Task 3");
        // Create a clean exploration history without explanations for Task 3 input
        const cleanExplorationHistory = {
            exploredSubQuestions: this._exploredSubQuestions,
            exploredCodeLines: this._exploredCodeLines,
            exploredFiles: this._exploredFiles // Now includes only URI and file content
        };

        // log exploredCodeLines in json format
        //console.log(`Explored Code Lines: ${JSON.stringify(this._exploredCodeLines, null, 2)})`);
        //console.log("Explored Files: ", this._exploredFiles.map(file => file.file_uri));

        const inputJson = {
            task: 3,
            refined_question: this._refined_question ?? "",
            exploration_history: cleanExplorationHistory
        };

        //console.log("Task 3 Input:\n", JSON.stringify(inputJson));

        const response = await this._callAgentAPI(inputJson, 3, task3JsonSchema);
        const task3Output = JSON.parse(response);

        this._sidebarViewProvider.addTask3Results(task3Output);
        this.updateGraphVisualization();

        return task3Output;
    }

    private async fuzzyMatchCode(fileUri: string, lineNumber: number, invokeVariable: string): Promise<{ fileUri: string; lineNumber: number; fullStatement: string } | null> {
        const inputFileName = getFileNameFromUri(fileUri);

        // Step 1: Filter matching files by file name
        const matchingFiles = this._exploredFiles.filter(file => getFileNameFromUri(file.file_uri) === inputFileName);
        if (matchingFiles.length === 0) {
            console.warn(`No matching files found for "${inputFileName}".`);
            return null;
        }

        // Step 2: Verify the content includes the variable or code line
        let matchedFile: any = null;
        for (const file of matchingFiles) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(file.file_uri));
            const fileContent = document.getText();
            if (fileContent.includes(invokeVariable)) {
                matchedFile = file;
                break;
            }
        }
        if (!matchedFile) {
            console.error(`Variable "${invokeVariable}" not found in any matching files for "${inputFileName}".`);
            return null;
        }

        // Step 3: Find the accurate line number using `getAccurateLineNumber`
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(matchedFile.file_uri));
        const preciseLineNumber = getAccurateLineNumber(document.getText(), invokeVariable, lineNumber, 0);
        if (preciseLineNumber === null) {
            console.error(`Accurate line number for "${invokeVariable}" not found in "${matchedFile.file_uri}".`);
            return null;
        }

        // Step 4: Retrieve the full code statement at the matched line
        const fullStatement = await getDestructuringAssignment(document, preciseLineNumber);

        return {
            fileUri: matchedFile.file_uri,
            lineNumber: preciseLineNumber,
            fullStatement
        };
    }

    async runTask4(task2Results: any[]): Promise<void> {
        console.warn("Running Task 4 - Ranking Task");

        // Prepare input with refined question and results from task2
        const filteredResults = task2Results.flatMap(result =>
            result.filtered_results.map((res: { file_uri: string; line_number: number; code_line: string; full_statement: string }) => ({
                file_uri: res.file_uri,
                line_number: res.line_number,
                code_line: res.code_line,
                full_statement: res.full_statement,
                explanation: "", // Default placeholder
                relevance_score: 0 // Default placeholder
            }))
        );

        const inputJson = {
            task: 4,
            refined_question: this._refined_question ?? "",
            explored_code_lines: filteredResults
        };

        const response = await this._callAgentAPI(inputJson, 4, task4JsonSchema);
        const task4Output = JSON.parse(response);

        // Filter for only relevance score 3 results and remove duplicates before adding
        const highRelevanceResults = task4Output.ranked_results
            .filter((result: { relevance_score: number }) => result.relevance_score === 3)
            .map((result: { relevance_score: number, code_line: string, line_number: number, explanation: string, file_uri: string }) => {
                const verifiedCode = this._exploredCodeLines.find(
                    code =>
                        code.file_uri === result.file_uri &&
                        code.start_line <= result.line_number &&
                        code.end_line >= result.line_number
                );

                // Only include results that match verified code in _exploredCodeLines
                if (verifiedCode) {
                    return {
                        file_uri: verifiedCode.file_uri,
                        code_line: result.code_line,
                        line_number: result.line_number,
                        full_statement: verifiedCode.code_snippet,
                        explanation: result.explanation,
                        relevance_score: result.relevance_score
                    };
                }
            })
            .filter(Boolean); // Remove any null results

        // Identify new results that are not already in _importantResults
        const newResults = highRelevanceResults.filter((result: { file_uri: string; code_line: string; line_number: number; full_statement: string; explanation: string; relevance_score: number }) =>
            !this._importantResults.some(r =>
                r.file_uri === result!.file_uri &&
                r.line_number === result!.line_number
            )
        );

        // Append only new unique results to _importantResults
        this._importantResults.push(...newResults);

        // Update the sidebar with only the new relevant results (score = 3)
        this._sidebarViewProvider.addTask4Results({ ranked_results: newResults });
    }

    async _callAgentAPI(inputJson: any, taskNumber: number, selectedSchema: any): Promise<string> {
        let taskInstructions = "";

        switch (taskNumber) {
            case 1:
                taskInstructions = `
                    Task 1: Refine the user's question and break it into actionable sub-questions using VSCode tools.
                    Ensure that each sub-question can be answered using a single VSCode tool on the invoke_variable. 
                    And you can choose the tool from the following list by providing the corresponding integer value:
                    - 0: Go to Definition
                    - 1: Find References
                    
                    When specifying the 'code_line', only include the specific line of code that contains the 'invoke_variable'. 
                    The 'code_line' should not span multiple lines, and must include the exact line that contains the 'invoke_variable' being explored.
    
                    The output format should strictly follow the JSON schema provided, where the tool should be represented as an integer.

                    For each sub-question, provide a clear and specific “reason” explaining the goal of exploring this sub-question. Describe exactly what we aim to uncover, such as particular methods, patterns, or code structures relevant to the exploration. Be as precise as possible in defining what we are looking for and why it is essential to the investigation.
                `;
                break;
            case 2:
                taskInstructions = `
                    Task 2: Filter and rank the exploration results for each sub-question.
                    Pick the most relevant results (up to num_results) for each sub-question based on their usefulness in answering the refined question.
                    Ensure that the output follows the provided JSON schema for questions_and_results, which should include file uri, line number, code, explanation, and from_result.
                `;
                break;
            case 3:
                taskInstructions = `
                    Task 3: Assess whether the refined question has been sufficiently answered based on the explored sub-questions and explored code lines.
                    
                    - Always provide an **answer** in the "answer" field. If the question is sufficiently answered, this will be the final answer. If not, provide a short **preliminary answer** summarizing the progress made from the current exploration (one or two sentences).
                    
                    - If the question is sufficiently answered, set "final_decision_sufficient" to true and provide an insightful, beginner-friendly explanation in the "answer" field that helps the user understand how the question was addressed.
                    
                    - If the question is not sufficiently answered, set "final_decision_sufficient" to false and include the **preliminary answer** in the "answer" field. Then, propose additional sub-questions that can further explore the question.
            
                    When proposing sub-questions:
                    - Search through the exploredCodeLines first to check if any of the existing invoke_variables have already been explored.
                    - If an "invoke_variable" is found within exploredCodeLines, set the "from_results" field in code_context to true.
                    - If no "invoke_variable" is found in exploredCodeLines, search the entire file content (exploredFiles) to identify relevant code areas for exploration. Set the "from_results" field to false in this case.
                    - Ensure that each sub-question can be answered using a single VSCode tool on the invoke_variable.
                    - Ensure that each sub-question is unique and similar questions have not been explored before (please refer to exploredSubQuestions).
                    - Choose the tool to explore the sub-question from the following list by providing the corresponding integer value and add it in the output:
                        -- 0: Go to Definition
                        -- 1: Find References
                    - For each sub-question, provide a clear and specific “reason” explaining the goal of exploring this sub-question. Describe exactly what we aim to uncover, such as particular methods, patterns, or code structures relevant to the exploration. Be as precise as possible in defining what we are looking for and why it is essential to the investigation.
                    - Include the file_uri, invoke_variable, code_line, line_number, and full_statement in the code context output, and reason for each sub-question with a valid starting point. 
                    - Ensure all these properties are filled in every case.
            
                    The output format must strictly follow the provided JSON schema:
                    - "final_decision_sufficient" should be a boolean indicating whether the question was fully answered.
                    - "answer" should always contain either the final answer (if sufficiently answered) or a **preliminary answer** (if more exploration is needed).
                    - "sub_problems" should contain any sub-questions and code contexts for further exploration if the question was not sufficiently answered.
                    - If there are any new sub-problems, the corresponding "code_context" should never be left empty and must contain all fields.
                `;
                break;
            case 4:
                taskInstructions = `
                    Task 4: Rank the exploration results based on relevance to the refined question.

                    For each result, assign a "relevance_score" from 0 to 3, where:
                        - 0: Not relevant - Do not include in the selected results.
                        - 1: Slightly relevant - The result has minor relevance but is unlikely to significantly help in answering the question.
                        - 2: Moderately relevant - The result provides some useful context or partial insight related to the question.
                        - 3: Highly relevant - The result is essential or very informative for answering the question.

                    The output should include only results with scores of 1 or higher, ranked by "relevance_score" (highest to lowest).
                    
                    For each result, provide an "explanation" of why it is helpful or how it contributes to understanding the question.
                    
                    Important: Do not modify the values of "file_uri", "code_line", "line_number", or "full_statement" for each result.
                `;
                break;
            case 5:
                taskInstructions = `
                    Task 5: Modify previous outputs based on user feedback.
                    Incorporate user feedback into the previous output, and ensure that the modified output still follows the original task's schema.
                `;
                break;
            default:
                throw new Error("Unknown task number provided.");
        }

        const systemMessage = new SystemMessage(`
            You are Agent 0, an assistant designed to help users explore and understand codebases by performing tasks using VSCode tools. 
            Your role depends on the task in the input, and you must carefully follow task-specific instructions and formats.
            
            General Instructions:
            - Understand the Input: Read the input carefully to determine which task to perform.
            - Maintain Consistency: The refined_question should remain consistent across all tasks and throughout the entire exploration process.
            - Ensure Thorough Exploration: Explore the codebase deeply enough to fully answer the refined question. Consider related functions, classes, or files that may be necessary to examine. 
            - Generate Additional Sub-Questions When Necessary: If initial explorations are insufficient, create further sub-questions to delve deeper into the code.
            - Avoid Redundancy: Always consider the explored sub-questions to prevent redundant efforts.
            - Professionalism: Use clear, concise, and professional language in your responses.
            - Strict Formats: Adhere strictly to the output JSON schemas specified for each task.
    
            ${taskInstructions}
            
            Ensure that your output matches the provided JSON schema.
        `);

        const prompt = JSON.stringify(inputJson);
        const messages = [
            systemMessage,
            new HumanMessage(prompt)
        ];

        const result = await this._model.invoke(messages, {
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: `task_${taskNumber}_schema`,
                    schema: selectedSchema
                }
            }
        });

        const parser = new StringOutputParser();
        const response = await parser.invoke(result);

        // log the response in json format
        console.log(`Task ${taskNumber} Response: ${JSON.stringify(response, null, 2)}`);

        let processedResponse;
        if (taskNumber === 3) {
            processedResponse = await this.postProcessResults(response);
        } else {
            processedResponse = response;
        }
        return processedResponse;
    }

    private async postProcessResults(response: string) {
        const task3Output = JSON.parse(response);

        task3Output.sub_problems = await Promise.all(
            task3Output.sub_problems.map(async (subProblem: any) => {
                const { file_uri, invoke_variable, line_number } = subProblem.code_context;

                // Use fuzzyMatchCode to get the most accurate file URI, line number, and full statement
                const matchedCode = await this.fuzzyMatchCode(file_uri, line_number, invoke_variable);

                // If no match is found, skip this sub-problem
                if (!matchedCode) {
                    console.warn(`No matched code found for file: "${file_uri}" with variable: "${invoke_variable}".`);
                    return null;
                }

                // Step 4: Update the exploration graph with the new node as an invoking place
                const nodeId = `${matchedCode.fileUri}:${matchedCode.lineNumber}`;
                const fromResults = this._exploredCodeLines.some(code => code.file_uri === matchedCode.fileUri && code.start_line <= matchedCode.lineNumber && code.end_line >= matchedCode.lineNumber);

                // Create a new node or update an existing one in the graph
                const newNode: Node = {
                    id: nodeId,
                    fileUri: matchedCode.fileUri,
                    startLine: matchedCode.lineNumber,
                    endLine: matchedCode.lineNumber + matchedCode.fullStatement.split('\n').length - 1,
                    variables: new Set([invoke_variable]),
                    codeSnippet: matchedCode.fullStatement,
                    isPlace: true,
                    edges: new Set()
                };
                this._explorationGraph.upsertNode(nodeId, newNode, null, this._stepCounter, subProblem.tool, true);

                // Update `code_context` with matched details
                subProblem.code_context.file_uri = matchedCode.fileUri;
                subProblem.code_context.line_number = matchedCode.lineNumber;
                subProblem.code_context.full_statement = matchedCode.fullStatement;
                subProblem.code_context.from_results = fromResults;

                return subProblem;
            })
        );

        // Filter out any null sub-problems that couldn't be matched
        task3Output.sub_problems = task3Output.sub_problems.filter((subProblem: any) => subProblem !== null);

        return JSON.stringify(task3Output);
    }

    // Method to update the exploration graph and pass visualization data to SidebarView
    private updateGraphVisualization() {
        const graphData = this._explorationGraph.toVisualizationData();
        this._sidebarViewProvider.updateGraphVisualization(graphData); // Pass nodes and edges data directly
    }

}

export function deactivate() { }