import * as vscode from 'vscode';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { SidebarView } from './SideBarView';
import { getFileNameFromUri, getSurroundingCode, getAccurateLineNumber, searchVariableOffset, preProcessCodeLine, analyze, findCompleteStatementText } from './codeContextUtils';
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
    "type": "object",
    "properties": {
        "final_decision_sufficient": { "type": "boolean" },
        "evaluations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file_uri": { "type": "string" },
                    "line_number": { "type": "integer" },
                    "valuable": { "type": "boolean" },
                    "next_step": {
                        "type": ["object", "null"],
                        "properties": {
                            "variable": { "type": "string" },
                            "tool": { "type": "integer", "enum": [0, 1] },
                            "reason": { "type": "string" }
                        },
                        "required": ["variable", "tool", "reason"]
                    }
                },
                "required": ["file_uri", "line_number", "valuable", "next_step"]
            }
        },
        "next_step_summary": { "type": "string" }
    },
    "required": ["final_decision_sufficient", "evaluations", "next_step_summary"]
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
                    finding: { type: "string" },
                    variable: { type: "string" }        // New: Variable to track for the result
                },
                required: ["file_uri", "code_line", "line_number", "full_statement", "explanation", "relevance_score", "finding", "variable"]
            }
        }
    },
    required: ["ranked_results"]
};

const task5JsonSchema = {
    "type": "object",
    "properties": {
        "filtered_findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "snippetKey": {
                        "type": "array",
                        "items": {
                            "type": "number"
                        },
                        "description": "Array of snippet keys referencing the finding"
                    },
                    "statement": {
                        "type": "string",
                        "description": "Consolidated or elided finding statement"
                    },
                    "outOfDate": {
                        "type": "boolean",
                        "description": "Marks if the finding is outdated or meaningless"
                    }
                },
                "required": ["snippetKey", "statement", "outOfDate"]
            }
        }
    },
    "required": ["filtered_findings"]
};

const task6JsonSchema = {
    "type": "object",
    "properties": {
        "final_decision_sufficient": { "type": "boolean" },
        "evaluations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file_uri": { "type": "string" },
                    "line_number": { "type": "integer" },
                    "valuable": { "type": "boolean" },
                    "next_step": {
                        "type": ["object", "null"],
                        "properties": {
                            "variable": { "type": "string" },
                            "tool": { "type": "integer", "enum": [0, 1] },
                            "reason": { "type": "string" }
                        },
                        "required": ["variable", "tool", "reason"]
                    }
                },
                "required": ["file_uri", "line_number", "valuable", "next_step"]
            }
        },
        "next_step_summary": { "type": "string" }
    },
    "required": ["final_decision_sufficient", "evaluations", "next_step_summary"]
};

class Agent {
    private _model: ChatOpenAI;
    private _stepCounter: number = 0;
    private _refined_question: string | null = null;
    private _sidebarViewProvider: SidebarView;
    private _exploredVariables: any[] = [];
    private _exploredFiles: { file_uri: string, file_content: string }[] = []; // Simplified _exploredFiles
    private _exploredSubQuestions: string[] = [];
    private _exploredCodeLines: { file_uri: string, start_line: number, end_line: number; code_snippet: string; variables: Set<string> }[] = [];
    private _newExploredCodeLines: { file_uri: string, start_line: number, end_line: number; code_snippet: string; variables: Set<string> }[] = [];
    private _explorationGraph: ExplorationGraph;
    private isPaused: boolean = false;     // Track if the agent is paused
    private isStopped: boolean = false;    // Track if the agent is stopped
    private _importantCodeSnippets = new Map<number, { file_uri: string; code_line: string; line_number: number; full_statement: string; explanation: string; relevance_score: number }>();
    private _newImportantCodeSnippets: Map<number, { file_uri: string; code_line: string; line_number: number; full_statement: string; explanation: string; relevance_score: number }> = new Map();
    private _fileExtensionsToExclude = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js', '.test.jsx', '.spec.jsx', '.d.ts'];
    private _importantCodePaths: Map<string, Array<{ nodes: Node[]; edges: (Edge | null)[] }>> = new Map();
    private _findingsSummary: { snippetKey: number[], statement: string, outOfDate: boolean }[] = [];
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
                    const { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, accurateLineNumber);
                    subProblem.code_context.full_statement = statementText;

                    // Create a node for each sub-problem and mark it as an invoking place
                    const nodeId = `${uri.toString()}:${accurateLineNumber}:${subProblem.code_context.invoke_variable}`;
                    const newNode: Node = {
                        id: nodeId,
                        fileUri: uri.toString(),
                        lineNumber: accurateLineNumber,
                        variable: subProblem.code_context.invoke_variable,
                        codeSnippet: statementText,
                        edges: new Set(),
                    };
                    this._explorationGraph.addOrigin(newNode);

                    const relevantVariables = await analyze(uri, accurateLineNumber, subProblem.code_context.invoke_variable);
                    relevantVariables.forEach((variableInfo: any) => {
                        const relevantNodeId = `${variableInfo.fileUri}:${variableInfo.lineNumber}:${variableInfo.variable}`;
                        const lineText = document.lineAt(variableInfo.lineNumber).text.trim();
                        const relevantNode: Node = {
                            id: relevantNodeId,
                            fileUri: variableInfo.fileUri,
                            lineNumber: variableInfo.lineNumber,
                            variable: variableInfo.variable,
                            codeSnippet: lineText,
                            edges: new Set(),
                        };
                        this._explorationGraph.upsertNode(relevantNode);
                        this._explorationGraph.addEdge({ from: nodeId, to: relevantNodeId, variable: variableInfo.variable, tool: "assignment" });
                    });

                    const variables = [subProblem.code_context.invoke_variable, ...relevantVariables.map((variableInfo: any) => variableInfo.variable)];
                    this._addOrUpdateExploredCodeLines(uri.toString(), startLineNum, endLineNum, statementText, variables);
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
        const newExploredLines: Array<{ file_uri: string, line_number: number, code_line: string, full_statement: string, variables: Set<string> }> = [];

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

            // Add the variable and results to _exploredVariables
            this._exploredVariables.push({
                invoke_variable: variableName,
                line_number: line,
                file_uri: fileUri.toString(),
                results: results,
                tool: subProblem.tool
            });

            task2Results.push({
                sub_question: subProblem.sub_question,
                tool: subProblem.tool,
                code_context: subProblem.code_context,
                filtered_results: results
            });

            // add each result to the newExploredLines by file_uri and line_number. Add the variables to the variables array and remove duplicates
            results.forEach(result => {
                const existingLine = newExploredLines.find(line => line.file_uri === result.file_uri && line.line_number === result.line_number);
                if (existingLine) {
                    existingLine.variables.add(result.variable);
                } else {
                    newExploredLines.push({
                        file_uri: result.file_uri,
                        code_line: result.code_line,
                        line_number: result.line_number,
                        full_statement: result.full_statement,
                        variables: new Set([result.variable])
                    });
                }
            });
        }

        // Update the sidebar with the final Task 2 results
        this._sidebarViewProvider.addTask2Results({ questions_and_results: task2Results });

        return newExploredLines;
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
        let results: Array<{ file_uri: string, line_number: number, code_line: string, full_statement: string, variable: string }> = [];

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

    // Helper function to add or update explored code lines
    private _addOrUpdateExploredCodeLines(fileUri: string, startLine: number, endLine: number, fullStatement: string, variables: string[] = []) {

        // Check if the line is already covered in an existing code line
        const existingCode = this._exploredCodeLines.find(
            code => code.file_uri === fileUri && code.start_line == startLine && code.end_line == endLine
        );

        if (!existingCode) {
            // Add the new code to _exploredCodeLines if it's unique
            this._exploredCodeLines.push({
                file_uri: fileUri,
                start_line: startLine,
                end_line: endLine,
                code_snippet: fullStatement,
                variables: new Set(variables)
            });
        } else {
            // If the code already exists, update the variables
            variables.forEach(variable => {
                existingCode.variables.add(variable);
            });
        }

        // For each loop, add the new code to _newExploredCodeLines if it's unique
        const existingNewCode = this._newExploredCodeLines.find(
            code => code.file_uri === fileUri && code.start_line == startLine && code.end_line == endLine
        );

        if (!existingNewCode) {
            this._newExploredCodeLines.push({
                file_uri: fileUri,
                start_line: startLine,
                end_line: endLine,
                code_snippet: fullStatement,
                variables: new Set(variables)
            });
        } else {
            variables.forEach(variable => {
                existingNewCode.variables.add(variable);
            });
        }
    }

    async _prepareResults(locations: vscode.Location[] | vscode.LocationLink[], subProblem: any) {
        const results: Array<{ file_uri: string, line_number: number, code_line: string, full_statement: string, variable: string }> = [];
        if (!locations || locations.length === 0) {
            console.warn(`No locations found for sub-problem: ${subProblem.sub_question}`);
            return results;
        }

        // Filter locations to exclude unwanted file extensions
        const filteredLocations = locations.filter(location => {
            const fileUri = location instanceof vscode.Location ? location.uri.toString() : (location as vscode.LocationLink).targetUri.toString();
            return !this._fileExtensionsToExclude.some(ext => fileUri.includes(ext));
        });

        for (const location of filteredLocations) {
            const lineNumber = location instanceof vscode.Location ? location.range.start.line : (location as vscode.LocationLink).targetRange.start.line;
            const uri = location instanceof vscode.Location ? location.uri : location.targetUri;
            const fileUri = uri.toString();

            // Open document to retrieve code content and statements
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(fileUri));
            const { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, lineNumber);

            if (lineNumber == subProblem.code_context.line_number && fileUri == subProblem.code_context.file_uri) {
                // we don't want to add the same line and same variable as a result, since using either Go to Definition or Find References on the variable will return the same variable name.
                continue;
            }
            const variable = subProblem.code_context.invoke_variable;
            const codeLine = document.lineAt(lineNumber).text.trim();

            // Construct the original result object
            const baseResult = {
                file_uri: fileUri,
                line_number: lineNumber,
                code_line: codeLine,
                full_statement: statementText,
                variable: variable
            };
            results.push(baseResult);

            const sourceId = `${subProblem.code_context.file_uri}:${subProblem.code_context.line_number}:${variable}`;
            const resultNodeId = `${fileUri}:${lineNumber}:${variable}`;
            // Create result node if it doesn't already exist in the graph
            const resultNode: Node = {
                id: resultNodeId,
                fileUri: fileUri,
                lineNumber: lineNumber,
                variable: variable,
                codeSnippet: baseResult.full_statement,
                edges: new Set([])
            };

            const resultEdge: Edge = {
                from: sourceId,
                to: resultNodeId,
                variable: variable,
                tool: subProblem.tool == 0 ? "definition" : "reference",
            }

            this._explorationGraph.upsertNode(resultNode);
            this._explorationGraph.addEdge(resultEdge);

            // Analyze the code context for relevant variables
            const relevantVariables = await analyze(uri, lineNumber, variable);
            // Add each relevant variable as a separate result
            relevantVariables.forEach((variableInfo: any) => {
                const relevantResultNodeId = `${variableInfo.fileUri}:${variableInfo.lineNumber}:${variableInfo.variable}`;
                if (relevantResultNodeId === resultNodeId) {
                    return;
                }
                const lineText = document.lineAt(variableInfo.lineNumber).text.trim();
                results.push({
                    file_uri: variableInfo.fileUri,
                    line_number: variableInfo.lineNumber,
                    code_line: lineText,
                    full_statement: statementText,
                    variable: variableInfo.variable // Include the relevant variable
                });
                // Create result node if it doesn't already exist in the graph

                const relevantResultNode: Node = {
                    id: relevantResultNodeId,
                    fileUri: variableInfo.fileUri,
                    lineNumber: variableInfo.line_number,
                    variable: variableInfo.variable,
                    codeSnippet: lineText,
                    edges: new Set([]),
                };

                const relevantResultEdge: Edge = {
                    from: resultNodeId,
                    to: relevantResultNodeId,
                    variable: variableInfo.variable,
                    tool: "assignment",
                }
                this._explorationGraph.upsertNode(relevantResultNode);
                this._explorationGraph.addEdge(relevantResultEdge);

            });
            // Add both the base result variable and the relevant variables to the variable name list
            const variables = [variable, ...relevantVariables.map((variableInfo: any) => variableInfo.variable)];
            this._addOrUpdateExploredCodeLines(fileUri, startLineNum, endLineNum, statementText, variables);
            this._addToExploredFiles(vscode.Uri.parse(fileUri), document);
        }

        return results;
    }

    private async processTask3andTask6Output(agentOutput: any) {

        interface SubProblem {
            sub_question: string;
            tool: number;
            code_context: {
                file_uri: string;
                invoke_variable: string;
                code_line: string;
                line_number: number;
                full_statement: string;
            };
            from_results: boolean;
            reason: string;
        }

        const taskOutput: { sub_problems: SubProblem[], final_decision_sufficient: boolean, next_step_summary: string, answer: string } = {
            sub_problems: [],
            final_decision_sufficient: agentOutput.final_decision_sufficient,
            next_step_summary: agentOutput.next_step_summary,
            answer: ""
        };

        for (const item of agentOutput.evaluations) {
            if (item.valuable && item.next_step) {

                try {
                    let full_statement = await findCompleteStatementText(vscode.Uri.parse(item.file_uri), item.line_number);
                    // get the line of code with the line_number and the file_uri
                    const code_document = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.file_uri));
                    let codeLine = code_document.lineAt(item.line_number).text.trim();
                    // check if the code line is not empty and variable is in the code line
                    if (!codeLine || !codeLine.includes(item.next_step.variable)) {
                        // find the accurate line number
                        const accurateLineNumber = getAccurateLineNumber(code_document.getText(), item.next_step.variable, item.line_number, 0);
                        if (accurateLineNumber !== null) {
                            item.line_number = accurateLineNumber;
                            full_statement = await findCompleteStatementText(vscode.Uri.parse(item.file_uri), accurateLineNumber);
                            codeLine = code_document.lineAt(accurateLineNumber).text.trim();
                        }
                    }
                    const matchedCode = this._exploredCodeLines.find(
                        code => code.file_uri === item.file_uri && (code.start_line <= item.line_number && code.end_line >= item.line_number)
                    );

                    if (!matchedCode) {
                        continue;
                    }

                    // Determine if the result is from explored code or matched using fuzzy matching
                    const from_results = !!matchedCode || !!(await this.fuzzyMatchCode(item.file_uri, item.line_number, item.next_step.variable));

                    let taskItem = {
                        sub_question: "",
                        tool: item.next_step.tool,
                        code_context: {
                            file_uri: item.file_uri,
                            invoke_variable: item.next_step.variable,
                            code_line: codeLine, // get the code line from the file
                            line_number: item.line_number,
                            full_statement: full_statement.statementText
                        },
                        from_results: from_results,
                        reason: item.next_step.reason
                    };
                    taskOutput.sub_problems.push(taskItem);
                } catch (error) {
                    console.error(`Error finding complete line text for ${item.file_uri}:${item.line_number}`);
                }
            }
        }

        return taskOutput;
    }

    async runTask3() {
        console.warn("Running Task 3");

        const inputJson = {
            task: 3,
            refined_question: this._refined_question ?? "",
            explored_code: this._newExploredCodeLines
        };

        const response = await this._callAgentAPI(inputJson, 3, task3JsonSchema);
        const agentOutput = JSON.parse(response);

        const task3Output = await this.processTask3andTask6Output(agentOutput);

        // check the number of valuable results if it is greater than 0 when the final decision is not sufficient
        if (task3Output.sub_problems.length == 0 && !task3Output.final_decision_sufficient) {
            // run task 6
            const task6Output = await this.runTask6();
            if ("sub_problems" in task6Output) {
                task3Output.sub_problems = task6Output.sub_problems;
            }
        }

        console.log(`Task 3 Output: ${JSON.stringify(task3Output, null, 2)}`);
        this._newExploredCodeLines = []; // Reset the new explored code lines
        return task3Output;
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
        const uri = vscode.Uri.parse(matchedFile.file_uri);
        const document = await vscode.workspace.openTextDocument(uri);
        const preciseLineNumber = getAccurateLineNumber(document.getText(), invokeVariable, lineNumber, 0);
        if (preciseLineNumber === null) {
            console.error(`Accurate line number for "${invokeVariable}" not found in "${matchedFile.file_uri}".`);
            return null;
        }

        // Step 4: Retrieve the full code statement at the matched line
        const { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, preciseLineNumber);

        return {
            fileUri: matchedFile.file_uri,
            lineNumber: preciseLineNumber,
            fullStatement: statementText
        };
    }

    async runTask4(task2Results: Array<{ file_uri: string; line_number: number; code_line: string; full_statement: string; variables: Set<string> }>) {
        console.warn("Running Task 4");

        const filteredResults = task2Results.filter(
            result =>
                !Array.from(this._importantCodeSnippets.values()).some(
                    r => r.file_uri === result.file_uri && r.line_number === result.line_number
                )
        );

        const inputJson = {
            task: 4,
            refined_question: this._refined_question ?? "",
            results: filteredResults.map(result => ({
                file_uri: result.file_uri,
                line_number: result.line_number,
                code_line: result.code_line,
                full_statement: result.full_statement,
                variables: Array.from(result.variables),
                explanation: "",
                relevance_score: 0,
                findings: ""
            }))
        };

        const response = await this._callAgentAPI(inputJson, 4, task4JsonSchema);
        const task4Output = JSON.parse(response);


        task4Output.ranked_results.forEach((result: {
            file_uri: string;
            line_number: number;
            code_line: string;
            full_statement: string;
            variable: string;
            explanation: string;
            relevance_score: number;
            finding: string;
        }) => {
            if (result.relevance_score < 0) {
                return;
            }
            // Define the path key and node ID
            const pathId = `${result.file_uri}:${result.line_number}`;

            // Check if the snippet already exists
            const existingEntry = Array.from(this._importantCodeSnippets.entries()).find(
                ([, value]) => value.file_uri === result.file_uri && value.line_number === result.line_number
            );

            let snippetKey: number;

            if (!existingEntry) {
                snippetKey = this._importantCodeSnippets.size;
                this._importantCodeSnippets.set(snippetKey, {
                    file_uri: result.file_uri,
                    code_line: result.code_line,
                    line_number: result.line_number,
                    full_statement: result.full_statement,
                    explanation: result.explanation,
                    relevance_score: result.relevance_score
                });

                this._newImportantCodeSnippets.set(snippetKey, result);

                this._findingsSummary.push({
                    snippetKey: [snippetKey],
                    statement: result.finding ?? result.explanation,
                    outOfDate: false
                });
            } else {
                snippetKey = existingEntry[0];
            }

            // Find the path for this variable only if not already stored
            if (!this._importantCodePaths.has(pathId)) {
                const nodeId = this._explorationGraph.findNodeByLine(result.file_uri, result.line_number);
                if (nodeId === null) {
                    console.error(`Node ID not found for line ${result.line_number} in ${result.file_uri}`);
                    return {};
                }
                const paths = this._explorationGraph.findShortestPathFromNode(nodeId);

                if (paths.length > 0) {
                    this._importantCodePaths.set(pathId, paths.map(path => {
                        const nodes: Node[] = [];
                        const edges: (Edge | null)[] = [];

                        for (const entry of path) {
                            nodes.push(entry.node);
                            edges.push(entry.edge || null);
                        }

                        return { nodes, edges };
                    }));
                }
            }
        });

        const task5Output = await this.runTask5();
        return task5Output;
    }

    updateFindingsSummary = (newFindings: any[]): any[] => {
        const updatedFindings: { snippetKey: number[], statement: string, outOfDate: boolean, isUpdated?: boolean }[] = []; // To store the updated findings with `isUpdated` key

        // Match and compare existing findings
        newFindings.forEach(newFinding => {
            const existingFinding = this._findingsSummary.find(existing =>
                JSON.stringify(existing.snippetKey.sort()) === JSON.stringify(newFinding.snippetKey.sort())
            );

            if (existingFinding) {
                // Detect updates if the statement is different or the finding is not out of date
                const isUpdated =
                    existingFinding.statement !== newFinding.statement || !newFinding.outOfDate;

                // Add the `isUpdated` key
                updatedFindings.push({
                    ...newFinding,
                    isUpdated
                });

                // Update the existing finding
                if (isUpdated) {
                    this._updateFindings = true;
                    existingFinding.statement = newFinding.statement;
                    existingFinding.outOfDate = newFinding.outOfDate;
                }
            } else {
                this._updateFindings = true;
                const isUpdated = !newFinding.outOfDate;
                // Mark new findings as updated
                updatedFindings.push({
                    ...newFinding,
                    isUpdated: isUpdated
                });
            }
        });

        // Sort the new findings by the smallest snippetKey
        updatedFindings.sort((a, b) => Math.min(...a.snippetKey) - Math.min(...b.snippetKey));

        // Update the findings summary without the `isUpdated` key
        this._findingsSummary = updatedFindings.map(({ isUpdated, ...rest }) => rest);

        // Return the updated findings with the `isUpdated` key
        return updatedFindings;
    };

    async runTask5(): Promise<string> {
        console.warn("Running Task 5");

        const inputJson = {
            task: 5,
            refined_question: this._refined_question ?? "",
            findings: this._findingsSummary
        };

        console.log("finding summary", this._findingsSummary);

        const response = await this._callAgentAPI(inputJson, 5, task5JsonSchema);
        const task5Output = JSON.parse(response);

        if (!task5Output || !task5Output.filtered_findings) {
            console.error("Invalid output from Task 5.");
            return "";
        }

        // Update the findings summary
        const updatedFindings = this.updateFindingsSummary(task5Output.filtered_findings);

        // Generate the HTML for the findings
        let concatenatedHtml = "";
        updatedFindings.forEach(finding => {
            const snippetKeys = `[${finding.snippetKey.map((key: number) => `<span class="citation-ref" data-ref="${key}">${key}</span>`).join(", ")}]`;

            const statementHtml = finding.outOfDate
                ? `<span class="additional-finding">[1 additional finding]</span>
                   <span class="hidden-statement" style="display: none;">${snippetKeys} ${finding.statement}</span>`
                : `${snippetKeys} ${finding.statement}`;

            concatenatedHtml += `
                <li class="${finding.isUpdated ? "highlight-new finding-summary" : "finding-summary"}">
                    ${statementHtml}
                </li>
            `;
        });

        return concatenatedHtml;
    }

    async runTask6() {
        console.warn("Running Task 6");

        const inputJson = {
            task: 6,
            refined_question: this._refined_question ?? "",
            explored_code_lines: this._exploredCodeLines,
        };

        const response = await this._callAgentAPI(inputJson, 6, task6JsonSchema);

        // Validate JSON format
        let agentOutput;
        try {
            agentOutput = JSON.parse(response);
        } catch (e) {
            console.error("Failed to parse JSON response for Task 6:", e, response);
            return [];
        }

        const task6Output = await this.processTask3andTask6Output(agentOutput);

        return task6Output;
    }

    private async _updateStepResults(refinedOutput: any) {
        // Update sidebar and graph visualization with refinedOutput and important code snippets
        if (this._updateFindings) {
            this._sidebarViewProvider.addTask3Results(refinedOutput, this._importantCodeSnippets, this._importantCodePaths);
        } else {
            this._sidebarViewProvider.addTask3Results(refinedOutput, null, null);
        }
        this._updateFindings = false;
        //this.updateGraphVisualization();
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
                    Task 3: Evaluate the explored code lines based on the refined question and determine the next steps for further exploration or provide the final answer if exploration is sufficient.

                    ### Instructions:

                    1. **Input Evaluation**:
                    - You are given a refined question and a list of explored code lines.
                    - Assess whether the explored lines collectively provide a sufficient answer to the refined question.

                    2. **Output Requirements**:
                    - If the explored lines are sufficient:
                        - Set "final_decision_sufficient" to true.
                        - Provide the final answer in "next_step_summary" based on the explored lines.
                    - If the explored lines are insufficient:
                        - Set "final_decision_sufficient" to false.
                        - Provide evaluations for each explored line:
                        - For each line, specify if it is valuable for further exploration.
                        - If valuable, specify at least one variables from the variables array in the input explored code lines, the exploration tool, and a reason.
                        - Ensure at least one line is marked as valuable to explore next.
                        - Summarize the proposed next steps in "next_step_summary".

                    3. **Line-by-Line Evaluation**:
                    - For each explored code line:
                        - Specify whether the line is valuable for further exploration.
                        - If valuable:
                        - Identify the variable to explore next.
                        - Select the appropriate tool:
                            - **0**: Go to Definition
                            - **1**: Find References
                        - Provide a reason for choosing the variable and tool.

                    4. **Output Format**:

                    {
                        "final_decision_sufficient": true or false, // Whether the explored lines sufficiently answer the question
                        "evaluations": [ // Evaluations of explored code lines
                            {
                                "file_uri": "string", // File URI of the code line
                                "line_number": number, // Line number of the code line
                                "valuable": true or false, // Whether the code line is valuable for further exploration
                                "next_step": {
                                    "variable": "string", // Variable to explore next, pick from the input explored code lines
                                    "tool": 0 or 1, // Tool to explore the variable
                                    "reason": "string" // Reason for choosing the variable and tool
                                } or null // Null if the line is not valuable for further exploration
                            },
                            ...
                        ],
                        "next_step_summary": "string" // Summary of the final answer or proposed next steps
                    }
                `;
                break;
            case 4:
                taskInstructions = `
                    Task 4: Rank the exploration results based on relevance to the refined question and summarize findings.

                    Assign a "relevance_score" of 0 or 1 to each result, where:
                    - 0: Not relevant - The result is not useful or does not contribute to the understanding of the refined question. Exclude this result.
                    - 1: Worth showing - The result contains valuable findings that provide meaningful insights for the programmer to understand the important aspects of the exploration.

                    For each result in the "results" array:
                    - Provide an "explanation" of why it is helpful or how it contributes to understanding the question.
                    - Summarize the finding in one sentence under the "finding" field. Use the structure: 
                        "Function/Field/Variable ... + Verb + Function/Field/Variable ...", e.g., ".innerHTML sets the content of HTML as 'ABC'".
                        Ensure the sentence is concise, informative, and clear. Do not include a clause.
                    - Add the **specific variable** being tracked for this result under the "variable" field. Only select one variable. 
                        **Important**: The variable must be selected only from the "variables" array provided in the result. Do not use or infer any other variables.

                    Important:
                    - Do not modify the values of "file_uri", "code_line", "line_number", "full_statement", or "variables" for each result.

                    Input example:
                    {
                        "results": [
                            {
                                "file_uri": "Original file URI",
                                "line_number": 123, // Line number
                                "code_line": "Original code line",
                                "full_statement": "Original full statement",
                                "variables": ["variable1", "variable2"] // List of variables in this result
                            },
                            ...
                        ]
                    }

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
                                "finding": "One-sentence summary of the result in the specified structure",
                                "variable": "One selected variable from the 'variables' array"
                            },
                            ...
                        ]
                    }
                `;
                break;
            case 5:
                taskInstructions = `
                Task 5: Filter, consolidate, and refine findings based on the exploration results.

                Input:
                - A collection of findings, where each finding is associated with references (snippet keys).
                - Findings may contain overlapping, outdated, or redundant information.
                
                Instructions:
                1. **Filter Findings:**
                   - Review all input findings.
                   - Mark any finding that is outdated or meaningless as outOfDate: true.
                   - Retain all findings in the output, even those marked as outOfDate.
                
                2. **Consolidate Findings:**
                   - Combine findings that describe similar or related concepts **only if they follow the same structure**.
                   - A structure is defined as a shared grammatical pattern or template (e.g., "XX sets width to XXpx" in the example below).
                   - Consolidate findings by combining their snippet keys and creating a concise statement that adheres to the original structure. Do not introduce new grammatical patterns or combine findings with differing structures. Do not include any clauses in the consolidated statement.
                   - For example:
                     - Input:
                       [
                           {
                               "snippetKey": [0],
                               "statement": "'sm' sets width to 24px.",
                               "outOfDate": false
                           },
                           {
                               "snippetKey": [1],
                               "statement": "'md' sets width to 48px.",
                               "outOfDate": false
                           },
                           {
                               "snippetKey": [2],
                               "statement": "'lg' sets width to 72px.",
                               "outOfDate": false
                           }
                       ]
                     - Consolidated Output:
                       {
                           "snippetKey": [0, 1, 2],
                           "statement": "'sm', 'md', 'lg' sets width to 24, 48, 72px.",
                           "outOfDate": false
                       }
                
                3. **Elide Findings:**
                   - Mark findings as outOfDate: true if they are irrelevant to the refined_question, redundant, or do not contribute meaningful insight.
                   - For example:
                     - Input:
                       {
                           "snippetKey": [3],
                           "statement": "size is used to set icon size.",
                           "outOfDate": false
                       }
                     - Output:
                       {
                           "snippetKey": [3],
                           "statement": "size is used to set icon size.",
                           "outOfDate": true
                       }
                
                4. **Output Requirements:**
                   - Include all input findings in the output, either consolidated or retained as-is.
                   - Use a single sentence for each statement, avoiding clauses except for listing.
                   - Retain meaningful numbers or unique information in statement.
                   - Ensure consolidated findings follow the shared structure of the input findings.
                
                Output Format:
                {
                    "filtered_findings": [
                        {
                            "snippetKey": ["array of snippet keys referencing the finding"],
                            "statement": "Consolidated or original finding statement",
                            "outOfDate": true or false
                        },
                        ...
                    ]
                }
                    `;
                break;
            case 6:
                taskInstructions = taskInstructions = `
                Task 6: Evaluate the explored code lines based on the refined question and determine the next steps for further exploration or provide the final answer if exploration is sufficient.

                ### Instructions:

                1. **Input Evaluation**:
                - You are given a refined question and a list of explored code lines.
                - Assess whether the explored lines collectively provide a sufficient answer to the refined question.

                2. **Output Requirements**:
                - If the explored lines are sufficient:
                    - Set "final_decision_sufficient" to true.
                    - Provide the final answer in "next_step_summary" based on the explored lines.
                - If the explored lines are insufficient:
                    - Set "final_decision_sufficient" to false.
                    - Provide evaluations for each explored line:
                    - For each line, specify if it is valuable for further exploration.
                    - If valuable, specify at least one variables, the exploration tool, and a reason.
                    - Ensure at least one line is marked as valuable to explore next.
                    - Summarize the proposed next steps in "next_step_summary".

                3. **Line-by-Line Evaluation**:
                - For each explored code line:
                    - Specify whether the line is valuable for further exploration.
                    - If valuable:
                    - Identify the variable to explore next.
                    - Select the appropriate tool:
                        - **0**: Go to Definition
                        - **1**: Find References
                    - Provide a reason for choosing the variable and tool.

                4. **Output Format**:

                {
                    "final_decision_sufficient": true or false, // Whether the explored lines sufficiently answer the question
                    "evaluations": [ // Evaluations of explored code lines
                        {
                            "file_uri": "string", // File URI of the code line
                            "line_number": number, // Line number of the code line
                            "valuable": true or false, // Whether the code line is valuable for further exploration
                            "next_step": {
                                "variable": "string", // Variable to explore next
                                "tool": 0 or 1, // Tool to explore the variable
                                "reason": "string" // Reason for choosing the variable and tool
                            } or null // Null if the line is not valuable for further exploration
                        },
                        ...
                    ],
                    "next_step_summary": "string" // Summary of the final answer or proposed next steps
                }
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
    /* private updateGraphVisualization() {
        const graphData = this._explorationGraph.toVisualizationData();
        this._sidebarViewProvider.updateGraphVisualization(graphData); // Pass nodes and edges data directly
    }
 */
}

export function deactivate() { }