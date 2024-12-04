import * as vscode from 'vscode';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { SidebarView } from './SideBarView';
import { getFileNameFromUri, getSurroundingCode, getAccurateLineNumber, searchVariableOffset, preProcessCodeLine, getDestructuringAssignment } from './codeContextUtils';
import { ExplorationGraph, Node, Edge } from './explorationGraph';
// API key for OpenAI
const API_KEY = process.env.OPENAI_TOKEN;

if (!API_KEY) {
    console.error("OpenAI API Key is missing. Please set the OPENAI_TOKEN environment variable.");
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize the SidebarView and Agent
    const sidebarViewProvider = new SidebarView(context);
    const agent = new Agent(sidebarViewProvider);

    // Register the webview provider for the sidebar
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarView.viewType, // Match with the "id" defined in package.json for the view
            sidebarViewProvider
        )
    );

    // Register the command to ask a question about code
    context.subscriptions.push(
        vscode.commands.registerCommand('search-copilot.askQuestion', () => {
            askQuestionAboutCode(context, sidebarViewProvider, agent);
        })
    );

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

    // Log a message to confirm activation
    console.log('Search Copilot extension is now active!');
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
                    reason: { type: "string" }
                },
                required: ["sub_question", "tool", "code_context", "reason"]
            }
        }
    },
    required: ["refined_question", "sub_problems"]
};

const task3JsonSchema = {
    type: "object",
    properties: {
        final_decision_sufficient: { type: "boolean" },
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
                        required: []
                    },
                    from_results: { type: "boolean" },
                    reason: { type: "string" }
                },
                required: ["sub_question", "tool", "from_results", "reason"]
            }
        },
        next_step_summary: { type: "string" }
    },
    required: ["final_decision_sufficient", "sub_problems", "next_step_summary"]
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
                    relevance_score: { type: "integer" },
                    finding: { type: "string" }
                },
                required: ["file_uri", "code_line", "line_number", "full_statement", "explanation", "relevance_score", "finding"]
            }
        }
    },
    required: ["ranked_results"]
};

const task6JsonSchema = {
    type: "object",
    properties: {
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
                        required: ["file_uri", "invoke_variable", "code_line", "line_number", "full_statement"]
                    },
                    from_results: { type: "boolean" },
                    reason: { type: "string" }
                },
                required: ["sub_question", "tool", "code_context", "from_results", "reason"]
            }
        }
    },
    required: ["sub_problems"]
};

class Agent {
    private _model: ChatOpenAI;
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
    private _importantCodeSnippets = new Map<string, { file_uri: string; code_line: string; line_number: number; full_statement: string; explanation: string; relevance_score: number }>();
    private _newImportantCodeSnippets: Map<string, any> = new Map();
    private _fileExtensionsToExclude = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js', '.test.jsx', '.spec.jsx', '.d.ts'];
    private _importantCodePaths: Map<string, Array<{ nodes: Node[], edges: (Edge | null)[] }>> = new Map();  // Map of nodeId to paths
    private _updateFindings: boolean = false;

    constructor(sidebarViewProvider: SidebarView) {
        this._model = new ChatOpenAI({
            model: "gpt-4o-mini",
            apiKey: API_KEY,
            maxTokens: 16384,
            temperature: 1.0,
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
            const startStep = new Date().getTime();

            if (!refinedOutput || !refinedOutput.sub_problems) {
                console.error("Error: No sub-problems returned.");
                break;
            }

            if (this.isPaused) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait if paused
                continue;
            }

            this._stepCounter++;

            // Task 2: Explore sub-problems
            const task2Results = await this.runTask2(refinedOutput.sub_problems);

            // Run Task 4 and Task 3 concurrently
            const [answerHtml, task3Output] = await Promise.all([
                this.runTask4(task2Results), // Task 4: Decide the importance of results
                this.runTask3()             // Task 3: Propose next steps
            ]);

            refinedOutput = task3Output;
            refinedOutput.final_decision_sufficient = task3Output.final_decision_sufficient;
            refinedOutput.answer = answerHtml;

            this._updateStepResults(refinedOutput);

            const endStep = new Date().getTime();
            console.log(`Step ${this._stepCounter} took ${endStep - startStep}ms`);

            if (task3Output.final_decision_sufficient || refinedOutput.sub_problems.length === 0) {
                break;
            }
        }

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
            if (subProblem && "code_context" in subProblem && uri && "file_uri" in subProblem.code_context) {
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
                        endLine: accurateLineNumber,
                        variables: new Set([subProblem.code_context.invoke_variable]),
                        codeSnippet: fullStatement,
                        isPlace: true,  // Mark as invoking place
                        edges: new Set(),
                        origins: [nodeId]
                    };
                    this._explorationGraph.upsertNode(nodeId, newNode, null, this._stepCounter, subProblem.tool, true, subProblem.code_context.invoke_variable);
                    this._explorationGraph.addGraphOrigin(nodeId);
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

        /* const task2Input: any = {
            task: 2,
            refined_question: this._refined_question,
            questions_and_results: [] // Only includes sub-problems that need further filtering by the agent
        }; */

        const task2Results: any[] = []; // Stores final results to display in the sidebar
        const newtask2Results: any[] = [];

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
                    codeSnippet: result.full_statement,
                    isPlace: false, // Result nodes are not invoking places
                    edges: new Set(),
                    origins: []
                };

                this._explorationGraph.upsertNode(resultNodeId, resultNode, sourceId, this._stepCounter, subProblem.tool, false, variableName);
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
            /* if (results.length > subProblem.num_results) {
                task2Input.questions_and_results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    num_results: subProblem.num_results,
                    results: results
                });
            } else { */
            // If no agent involvement is needed, add the filtered results directly
            // New code: directly append the results to the task2Results
            task2Results.push({
                sub_question: subProblem.sub_question,
                tool: subProblem.tool,
                code_context: subProblem.code_context,
                filtered_results: results
            });

            newtask2Results.push({
                sub_question: subProblem.sub_question,
                tool: subProblem.tool,
                code_context: subProblem.code_context,
                filtered_results: results
            });
            /* } */
        }

        // If any sub-questions need agent filtering, call the agent
        /* if (task2Input.questions_and_results.length > 0) {
            const agentResults = await this._callAgentAPI(task2Input, 2, task2JsonSchema);
            this._processAgentResults(JSON.parse(agentResults), task2Results);
        } */

        // Update the sidebar with the final Task 2 results
        this._sidebarViewProvider.addTask2Results({ questions_and_results: task2Results });

        return newtask2Results;
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
    /* private _processAgentResults(agentResults: any, task2Results: any[]) {
        if (Array.isArray(agentResults.questions_and_results)) {
            for (const subProblem of agentResults.questions_and_results) {
                if (subProblem && "results" in subProblem) {
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
    } */

    // Helper function to add or update explored code lines
    private _addOrUpdateExploredCodeLines(fileUri: string, lineNumber: number, fullStatement: string) {
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
            // Add the new code to _exploredCodeLines if it's unique
            this._exploredCodeLines.push({
                file_uri: fileUri,
                start_line: lineNumber,
                end_line: endLineOfStatement,
                code_snippet: fullStatement
            });

        } else {
            // If there's an overlap, extend the existing node if necessary
            existingCode.start_line = Math.min(existingCode.start_line, lineNumber);
            existingCode.end_line = Math.max(existingCode.end_line, endLineOfStatement);
            existingCode.code_snippet = fullStatement.trim(); // this line has a problem
        }
    }

    async _prepareResults(locations: vscode.Location[] | vscode.LocationLink[], subProblem: any) {
        const results: any[] = [];
        if (!locations || locations.length === 0) {
            console.warn(`No locations found for sub-problem: ${subProblem.sub_question}`);
            return results;
        }

        // Filter locations to exclude unwanted file extensions
        const filteredLocations = locations.filter(location => {
            const fileUri = location instanceof vscode.Location ? location.uri.toString() : (location as vscode.LocationLink).targetUri.toString();
            // if the string in the _fileExtensionsToExclude is found in the fileUri, exclude it
            return !this._fileExtensionsToExclude.some(ext => fileUri.includes(ext));
        });

        /* const primaryResults: any[] = [];
        const secondaryResults: any[] = [];
        const entireResults: any[] = []; */

        for (const location of filteredLocations) {
            const lineNumber = location instanceof vscode.Location ? location.range.start.line : (location as vscode.LocationLink).targetRange.start.line;
            const fileUri = location instanceof vscode.Location ? location.uri.toString() : (location as vscode.LocationLink).targetUri.toString();

            // Open document to retrieve code content and statements
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(fileUri));
            const fullStatement = await getDestructuringAssignment(document, lineNumber);

            const result = {
                file_uri: fileUri,
                line_number: lineNumber,
                code_line: document.lineAt(lineNumber).text.trim(),
                full_statement: fullStatement
            };

            // Add or update the explored code lines and files
            this._addOrUpdateExploredCodeLines(fileUri, lineNumber, fullStatement);
            this._addToExploredFiles(vscode.Uri.parse(fileUri), document);

            /* // Categorize based on folder priority
            if (fileUri.startsWith(this._primarySearchFolder)) {
                primaryResults.push(result);
            } else if (fileUri.startsWith(this._secondarySearchFolder)) {
                secondaryResults.push(result);
            } else if (fileUri.startsWith(this._entireFolder)) {
                entireResults.push(result);
            } */
            results.push(result);
        }

        // Build final results based on folder priority and num_results constraint
        /* results.push(...primaryResults);
        if (subProblem.num_results && results.length >= subProblem.num_results) {
            return results.slice(0, subProblem.num_results);
        }

        results.push(...secondaryResults);
        if (subProblem.num_results && results.length >= subProblem.num_results) {
            return results.slice(0, subProblem.num_results);
        }

        results.push(...entireResults);
        if (subProblem.num_results && results.length >= subProblem.num_results) {
            return results.slice(0, subProblem.num_results);
        } */

        // Return all results if they are still below num_results
        return results;
    }

    async runTask3() {
        console.warn("Running Task 3");

        const cleanExplorationHistory = {
            exploredSubQuestions: this._exploredSubQuestions,
            exploredCodeLines: this._exploredCodeLines
        };

        const inputJson = {
            task: 3,
            refined_question: this._refined_question ?? "",
            exploration_history: cleanExplorationHistory
        };

        const response = await this._callAgentAPI(inputJson, 3, task3JsonSchema);
        const task3Output = JSON.parse(response);

        const unresolvedSubProblems: any[] = [];

        // Process sub-problems to either set code context or add to unresolved list
        task3Output.sub_problems.forEach((subProblem: any) => {
            const matchingCodeLine = this._exploredCodeLines.find(
                line => line.code_snippet.includes(subProblem.invoke_variable)
            );

            if ("invoke_variable" in subProblem && subProblem.invoke_variable && matchingCodeLine) {
                subProblem.code_context = {
                    file_uri: matchingCodeLine.file_uri,
                    invoke_variable: subProblem.invoke_variable,
                    code_line: matchingCodeLine.code_snippet,
                    line_number: matchingCodeLine.start_line,
                    full_statement: matchingCodeLine.code_snippet
                };
                subProblem.from_results = true;
            } else {
                unresolvedSubProblems.push(subProblem);
                // remove the subProblem from the task3Output
                task3Output.sub_problems = task3Output.sub_problems.filter((sp: any) => sp.sub_question !== subProblem.sub_question);
            }
        });

        // Run Task 6 if there are unresolved sub-problems
        if (unresolvedSubProblems.length > 0) {
            const task6Results = await this.runTask6(unresolvedSubProblems);
            task3Output.sub_problems.push(...task6Results);
        }
        const processedResponse = await this.postProcessResults(task3Output);
        return processedResponse;
    }

    private async fuzzyMatchCode(fileUri: string, lineNumber: number, invokeVariable: string): Promise<{ fileUri: string; lineNumber: number; fullStatement: string } | null> {
        const inputFileName = getFileNameFromUri(fileUri);

        // Step 1: Filter matching files by file name
        const matchingFiles = this._exploredFiles.filter(file => getFileNameFromUri(file.file_uri) === inputFileName);
        if (matchingFiles.length === 0) {
            console.warn(`No matching files found for "${fileUri}".`);
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
            console.error(`Variable "${invokeVariable}" not found in any matching files for "${fileUri}".`);
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

    private async postProcessResults(response: any) {

        response.sub_problems = await Promise.all(
            response.sub_problems.map(async (subProblem: any) => {
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
                    endLine: matchedCode.lineNumber,
                    variables: new Set([invoke_variable]),
                    codeSnippet: matchedCode.fullStatement,
                    isPlace: true,
                    edges: new Set(),
                    origins: []
                };
                this._explorationGraph.upsertNode(nodeId, newNode, null, this._stepCounter, subProblem.tool, true, invoke_variable);

                // Update `code_context` with matched details
                subProblem.code_context.file_uri = matchedCode.fileUri;
                subProblem.code_context.line_number = matchedCode.lineNumber;
                subProblem.code_context.full_statement = matchedCode.fullStatement;
                subProblem.code_context.from_results = fromResults;

                return subProblem;
            })
        );

        // Filter out any null sub-problems that couldn't be matched
        response.sub_problems = response.sub_problems.filter((subProblem: any) => subProblem !== null);

        return response;
    }

    async runTask4(task2Results: any[]): Promise<string> {
        console.warn("Running Task 4");

        const filteredResults = task2Results.flatMap(result =>
            result.filtered_results
                .filter((res: { file_uri: string; line_number: number }) =>
                    !this._importantResults.some(r =>
                        r.file_uri === res.file_uri &&
                        r.line_number === res.line_number
                    )
                )
                .map((res: { file_uri: string; line_number: number; code_line: string; full_statement: string }) => ({
                    file_uri: res.file_uri,
                    line_number: res.line_number,
                    code_line: res.code_line,
                    full_statement: res.full_statement,
                    explanation: "",
                    relevance_score: 0,
                    findings: ""
                }))
        );

        const inputJson = {
            task: 4,
            refined_question: this._refined_question ?? "",
            explored_code_lines: filteredResults
        };

        const response = await this._callAgentAPI(inputJson, 4, task4JsonSchema);
        const task4Output = JSON.parse(response);

        const highRelevanceResults = task4Output.ranked_results
            .filter((result: { relevance_score: number }) => result.relevance_score > 0)
            .map((result: any) => {
                const verifiedCode = this._exploredCodeLines.find(
                    code =>
                        code.file_uri === result.file_uri &&
                        code.start_line <= result.line_number &&
                        code.end_line >= result.line_number
                );

                if (verifiedCode) {
                    return {
                        file_uri: verifiedCode.file_uri,
                        code_line: result.code_line,
                        line_number: result.line_number,
                        full_statement: verifiedCode.code_snippet,
                        explanation: result.explanation,
                        relevance_score: result.relevance_score,
                        finding: result.finding ?? result.explanation
                    };
                }
            })
            .filter(Boolean);

        let concatenatedHtml = '';

        highRelevanceResults.forEach((result: any) => {
            if (!result) return;

            const isNotInImportantResults = !this._importantResults.some(r =>
                r.file_uri === result.file_uri &&
                r.line_number === result.line_number
            );

            if (isNotInImportantResults) {
                this._importantResults.push(result);
            }

            if (result.relevance_score > 0) {
                const snippetKey = Array.from(this._importantCodeSnippets.entries()).find(
                    ([_, snippet]) =>
                        snippet.file_uri === result.file_uri &&
                        snippet.line_number === result.line_number
                )?.[0] ?? this._importantCodeSnippets.size.toString();

                this._importantCodeSnippets.set(snippetKey, result);
                this._newImportantCodeSnippets.set(snippetKey, result);

                concatenatedHtml += `
                    <li class="highlight-new finding-summary">
                        ${result.finding}
                        <span class="citation-ref" data-ref="${snippetKey}">[${snippetKey}]</span>
                    </li>
                `;

                const nodeId = `${result.file_uri}:${result.line_number}`;
                const node = this._explorationGraph.getNode(nodeId);

                if (node && !this._importantCodePaths.has(nodeId)) {
                    const paths = this._explorationGraph.findShortestPathsToOrigins(nodeId);
                    if (paths.length > 0) {
                        this._importantCodePaths.set(nodeId, paths);
                    }
                }
            }
        });

        if (highRelevanceResults.length > 0 && concatenatedHtml.length > 0) {
            this._updateFindings = true;
        } else {
            this._updateFindings = false;
        }

        return concatenatedHtml;
    }

    async runTask6(unresolvedSubProblems: any[]) {
        console.warn("Running Task 6");

        const inputJson = {
            task: 6,
            explored_files: this._exploredFiles,
            unresolved_sub_problems: unresolvedSubProblems
        };

        const response = await this._callAgentAPI(inputJson, 6, task6JsonSchema);

        // Validate JSON format
        let task6Output;
        try {
            task6Output = JSON.parse(response);
        } catch (e) {
            console.error("Failed to parse JSON response for Task 6:", e, response);
            return [];
        }

        // Check if sub_problems exists in task6Output
        if (!task6Output || !Array.isArray(task6Output.sub_problems)) {
            console.error("Expected sub_problems array is missing in task6Output:", task6Output);
            return []; // Return an empty array or handle this error as needed
        }

        // Apply fallback handling for undefined fields within verifiedResults filter
        const verifiedResults = task6Output.sub_problems.filter((subProblem: any) => {
            const code_context = subProblem?.code_context || {};
            const isContextComplete = code_context.file_uri && code_context.code_line && code_context.line_number !== undefined;

            // If code_context is incomplete, log a warning and skip this sub_problem
            if (!isContextComplete) {
                console.warn("Incomplete code_context in sub_problem:", subProblem);
                return false;
            }

            /* // Check that the code context is not in exploredCodeLines
            const isNotInExplored = !this._exploredCodeLines.some(
                (line) => line.file_uri === code_context.file_uri && line.start_line <= code_context.line_number && line.end_line >= code_context.line_number 
            ); */
            return true;
        });

        return verifiedResults;
    }

    private async _updateStepResults(refinedOutput: any) {
        // Update sidebar and graph visualization with refinedOutput and important code snippets
        if (this._updateFindings) {
            this._sidebarViewProvider.addTask3Results(refinedOutput, this._importantCodeSnippets, this._importantCodePaths);
        } else {
            this._sidebarViewProvider.addTask3Results(refinedOutput, null, null);
        }
        this.updateGraphVisualization();
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
                    Task 3: Based on the refined question and exploration history, evaluate whether the current exploration sufficiently answers the question. If it is insufficient, propose additional sub-questions to guide further exploration.

                    Evaluation:
                    - Assess whether the current explored sub-questions and exploredCodeLines sufficiently address the refined question.
                    - If sufficient, set "final_decision_sufficient" to true and do not propose new sub-questions.
                    - If insufficient, set "final_decision_sufficient" to false and propose additional sub-questions to continue the exploration.

                    Sub-Questions (if needed):
                    - Generate sub-questions that target specific areas relevant to the refined question.
                    - Ensure each sub-question can be answered with a single VSCode tool, either by exploring a code variable or structure.
                    - Avoid duplicating sub-questions from exploredSubQuestions.

                    For each sub-question:
                    - Search exploredCodeLines to identify an invoke_variable that has been previously explored:
                        - If a relevant invoking location is found, complete the code_context fields (file_uri, invoke_variable, code_line, line_number, full_statement) for the sub-question and set "from_results" to true.
                        - If no invoking place is found, leave code_context empty and set "from_results" to false.
                    - Specify a "reason" for each sub-question, clarifying the goal of exploration and identifying specific methods, patterns, or code structures needed to answer the refined question.
                    - Assign the appropriate tool for each sub-question from the following options:
                        - 0: Go to Definition
                        - 1: Find References

                    Output Format:
                    {
                        "final_decision_sufficient": true or false, // Whether the current exploration is sufficient
                        "sub_problems": [ // List of additional sub-questions, if needed. Otherwise, an empty array.
                            {
                                "sub_question": "Describe the proposed sub-question...",
                                "tool": 0 or 1, // The selected tool for exploration
                                "code_context": {
                                    "file_uri": "file URI if applicable",
                                    "invoke_variable": "Variable to explore",
                                    "code_line": "The line containing the invoke_variable",
                                    "line_number": 123, // The line number
                                    "full_statement": "Full statement from the code line"
                                },
                                "from_results": true or false, // Whether the code context is derived from exploredCodeLines
                                "reason": "Clarify why this sub-question is needed"
                            },
                            ...
                        ],
                        "next_step_summary": "Brief summary of suggested next steps based on sub_problems, if applicable."
                    }
                `;
                break;
            case 4:
                taskInstructions = `
                    Task 4: Rank the exploration results based on relevance to the refined question and summarize findings.

                    Assign a "relevance_score" of 0 or 1 to each result, where:
                    - 0: Not relevant - The result is not useful or does not contribute to the understanding of the refined question. Exclude this result.
                    - 1: Worth showing - The result contains valuable findings that provide meaningful insights for the programmer to understand the important aspects of the exploration.
                    
                    For each result:
                    - Provide an "explanation" of why it is helpful or how it contributes to understanding the question.
                    - Summarize the finding in one sentence under the "finding" field. Use the structure: 
                        "Function/Field/Variable ... + Verb + Function/Field/Variable ...", e.g., ".innerHTML sets the content of HTML as 'ABC'".
                        Ensure the sentence is concise, informative, and clear.

                    Important: Do not modify the values of "file_uri", "code_line", "line_number", or "full_statement" for each result.

                    Output format:
                    {
                        "ranked_results": [
                            {
                                "file_uri": "Original file URI",
                                "line_number": 123, // Line number
                                "code_line": "Original code line",
                                "full_statement": "Original full statement",
                                "relevance_score": 0 or 1,
                                "explanation": "Explanation of why this result is helpful",
                                "finding": "One-sentence summary of the result in the specified structure"
                            },
                            ...
                        ]
                    }
                `;
                break;
            case 6:
                taskInstructions = `
                    Task 6: Identify relevant invoking locations for unresolved sub-questions from previously explored files.

                    Input:
                    - A list of unresolved sub-questions with empty code contexts (code_context: empty, from_results: false).
                    - A collection of explored files, each containing the file URI and file content.

                    Goal:
                    - For each unresolved sub-question, locate a relevant code context (e.g., a line or function) within the explored files that aligns with the sub-question.
                    
                    Instructions:
                    - Strictly follow JSON format in the output, ensuring that every item adheres to the specified schema.
                    - Ensure the output has:
                    - A top-level object with a "sub_problems" array, containing each sub-question as an object.
                    - Each "sub_problem" object with a "sub_question", "tool", and "code_context" that includes:
                        - "file_uri": URI of the file containing the context.
                        - "invoke_variable": The relevant variable or function.
                        - "code_line": The exact line containing the "invoke_variable".
                        - "line_number": The line number of "code_line".
                        - "full_statement": The complete statement where the invoke_variable is located.
                    - The field "from_results" should remain false for each sub_problem.
                    - All fields in "code_context" must be correctly filled with valid values. Use null only if absolutely no match is found.
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

        // time the agent's response
        const start = new Date().getTime();
        const result = await this._model.invoke(messages, {
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: `task_${taskNumber}_schema`,
                    schema: selectedSchema
                }
            }
        });
        const end = new Date().getTime();
        console.log(`Task ${taskNumber} Response Time: ${end - start} ms`);

        const parser = new StringOutputParser();
        const response = await parser.invoke(result);

        // log the response in json format
        console.log(`Task ${taskNumber} Response: ${JSON.stringify(JSON.parse(response), null, 2)}`);

        return response;
    }

    // Method to update the exploration graph and pass visualization data to SidebarView
    private updateGraphVisualization() {
        const graphData = this._explorationGraph.toVisualizationData();
        this._sidebarViewProvider.updateGraphVisualization(graphData); // Pass nodes and edges data directly
    }

}

export function deactivate() { }