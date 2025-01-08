import * as vscode from 'vscode';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { SidebarView } from './SideBarView';
import { getLineText, getLineNumber, getFileNameFromUri, getLineTextFromRange, getAccurateLineNumber, searchVariableOffset, preProcessCodeLine, analyze, findCompleteStatementText } from './codeContextUtils';
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
    let query = await getQuestion(selectedText);
    if (query === undefined) {
        return; // User canceled the input box
    } else if (query === "") {
        query = "What does this code do?";
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
    "required": ["evaluations", "next_step_summary"]
};

const task4JsonSchema = {
    "type": "object",
    "properties": {
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
    "required": ["evaluations", "next_step_summary"]
};

const task5JsonSchema = {
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

const task6JsonSchema = {
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
        },
        "final_decision_sufficient": { "type": "boolean" },
        "final_answer": { "type": "string" }
    },
    "required": ["filtered_findings", "final_decision_sufficient", "final_answer"]
};

class Agent {
    private _model: ChatOpenAI;
    private _fasterModel: ChatOpenAI
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
    private _fileExtensionsToExclude = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js', '.test.jsx', '.spec.jsx', '.d.ts'];
    private _importantCodePaths: Map<string, Array<{ nodes: Node[]; edges: (Edge | null)[] }>> = new Map();
    private _findingsSummary: { snippetKey: number[], statement: string, outOfDate: boolean }[] = [];
    private _lastFindingSummary: { snippetKey: number[], statement: string, outOfDate: boolean }[] = [];
    private _updateFindings: boolean = false;
    private _final_decision_sufficient: boolean = false;

    constructor(sidebarViewProvider: SidebarView) {
        this._model = new ChatOpenAI({
            model: "gpt-4o",
            apiKey: API_KEY,
            maxTokens: 16384,
            temperature: 1.0,
            topP: 1,
        });

        this._fasterModel = new ChatOpenAI({
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

            // Run task 5 and Task 3 concurrently
            const [task3Output, answerHtml] = await Promise.all([
                this.runTask3(),// Task 3: Propose next steps
                this.runTask5(task2Results)// task 5: Decide the importance of results
            ]);

            refinedOutput = task3Output;
            refinedOutput.answer = answerHtml;
            this._updateStepResults(refinedOutput);

            if (this._final_decision_sufficient || refinedOutput.sub_problems.length === 0) {
                break;
            }

            const endStep = new Date().getTime();
            console.log(`Step ${this._stepCounter} took ${endStep - startStep}ms`);
        }

        this._sidebarViewProvider.agentIsDone();

        if (this._stepCounter >= MAX_STEPS) {
            console.log("Reached maximum exploration steps.");
        }
    }

    async runTask1(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        const document = await vscode.workspace.openTextDocument(uri);
        console.warn("Running Task 1");
        const surroundingCode = await getLineTextFromRange(uri, startLine, endLine);

        const inputJson = {
            "task": 1,
            "question": question,
            "surrounding_code": surroundingCode,
            "file_uri": uri.toString(),
            "line_number": startLine,
            "allowed_tools": allowedTools
        };

        const response = await this._callAgentAPI(inputJson, 1, task1JsonSchema);
        const task1Output = JSON.parse(response);
        this._refined_question = task1Output.refined_question;

        for (const subProblem of task1Output.sub_problems) {
            if (subProblem && "code_context" in subProblem && uri && "file_uri" in subProblem.code_context) {
                subProblem.code_context.file_uri = uri.toString();
            } else {
                console.warn("Incomplete subProblem: ", subProblem);
                continue;
            }

            //const invokeVariable = subProblem.code_context.invoke_variable;
            const codeLine = preProcessCodeLine(subProblem, surroundingCode);

            if (codeLine) {
                const accurateLineNumber = getLineNumber(surroundingCode, subProblem.code_context.invoke_variable, startLine);
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
                        this._explorationGraph.upsertNode(nodeId, variableInfo.fileUri, variableInfo.lineNumber, variableInfo.variable, "assignment");
                    });

                    const variables = [subProblem.code_context.invoke_variable, ...relevantVariables.map((variableInfo: any) => variableInfo.variable)];
                    this._addOrUpdateExploredCodeLines(uri.toString(), startLineNum, endLineNum, statementText, variables);
                    console.log(`Adding ${variables} from ${startLineNum} to ${endLineNum} to explored code lines`);
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
        console.warn("Running Task 2, processing ", subProblems.length, " sub-problems.");

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
                const accurateLineNumber = getAccurateLineNumber(document.getText(), subProblem.code_context.full_statement, variableName, initialLineNumber);
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
                full_statement: (codeLine.includes(variable) && codeLine.includes(";")) ? codeLine : statementText,
                variable: variable
            };
            results.push(baseResult);

            const sourceId = `${subProblem.code_context.file_uri}:${subProblem.code_context.line_number}:${variable}`;
            const resultNodeId = `${fileUri}:${lineNumber}:${variable}`;

            this._explorationGraph.upsertNode(sourceId, fileUri, lineNumber, variable, subProblem.tool == 0 ? "definition" : "reference");

            // Analyze the code context for relevant variables
            const relevantVariables = await analyze(uri, lineNumber, variable); // after supporting class/function definitions, the full statement text could be different here.
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
                    full_statement: (lineText.includes(variableInfo.variable) && lineText.includes(";")) ? lineText : statementText,
                    variable: variableInfo.variable // Include the relevant variable
                });
                // Create result node if it doesn't already exist in the graph
                this._explorationGraph.upsertNode(resultNodeId, variableInfo.fileUri, variableInfo.lineNumber, variableInfo.variable, "assignment");

            });
            // Add both the base result variable and the relevant variables to the variable name list
            const variables = [variable, ...relevantVariables.map((variableInfo: any) => variableInfo.variable)];
            this._addOrUpdateExploredCodeLines(fileUri, startLineNum, endLineNum, statementText, variables);
            this._addToExploredFiles(vscode.Uri.parse(fileUri), document);
        }

        return results;
    }

    private async processTask3andTask4Output(agentOutput: any) {

        const taskOutput: {
            sub_problems: {
                sub_question: string;
                tool: number;
                code_context: {
                    file_uri: string;
                    invoke_variable: string;
                    code_line: string;
                    line_number: number;
                    full_statement: string;
                };
                reason: string;
            }[];
            next_step_summary: string;
            answer: string;
        } = {
            sub_problems: [],
            next_step_summary: agentOutput.next_step_summary,
            answer: ""
        };

        for (const item of agentOutput.evaluations) {
            if (item.valuable && item.next_step) {
                const variables = item.next_step.variable.split(".");
                for (const variable of variables) {
                    try {
                        let full_statement = await findCompleteStatementText(vscode.Uri.parse(item.file_uri), item.line_number);
                        let codeLine = await getLineText(vscode.Uri.parse(item.file_uri), item.line_number);

                        if (!codeLine || !codeLine.includes(variable)) {
                            // find the accurate line number
                            const accurateLineNumber = getLineNumber(full_statement.statementText, variable, full_statement.startLineNum);
                            if (accurateLineNumber !== null) {
                                item.line_number = accurateLineNumber;
                                full_statement = await findCompleteStatementText(vscode.Uri.parse(item.file_uri), accurateLineNumber);
                                codeLine = await getLineText(vscode.Uri.parse(item.file_uri), accurateLineNumber);
                            }
                        }
                        const matchedCode = this._exploredCodeLines.find(
                            code => code.file_uri === item.file_uri && (code.start_line <= item.line_number && code.end_line >= item.line_number)
                        );

                        if (!matchedCode) {
                            continue;
                        }

                        let taskItem = {
                            sub_question: "",
                            tool: item.next_step.tool,
                            code_context: {
                                file_uri: item.file_uri,
                                invoke_variable: variable,
                                code_line: codeLine, // get the code line from the file
                                line_number: item.line_number,
                                full_statement: full_statement.statementText
                            },
                            reason: item.next_step.reason
                        };
                        taskOutput.sub_problems.push(taskItem);
                    } catch (error) {
                        console.error(`Error finding complete line text for ${item.file_uri}:${item.line_number}`);
                    }
                }
            }
        }

        return taskOutput;
    }

    async runTask3() {
        console.warn("Running Task 3, processing ", this._newExploredCodeLines.length, " new code lines.");

        let task3Output: {
            sub_problems: {
                sub_question: string;
                tool: number;
                code_context: {
                    file_uri: string;
                    invoke_variable: string;
                    code_line: string;
                    line_number: number;
                    full_statement: string;
                };
                reason: string;
            }[];
            next_step_summary: string;
            answer: string;
        } = {
            sub_problems: [],
            next_step_summary: "",
            answer: ""
        };

        // If there are no new code lines to explore, directly run Task 4
        if (this._newExploredCodeLines.length === 0) {
            console.warn("No new code lines to explore. Running Task 4.");
            const task4Output = await this.runTask4() as {
                sub_problems: {
                    sub_question: string;
                    tool: number;
                    code_context: {
                        file_uri: string;
                        invoke_variable: string;
                        code_line: string;
                        line_number: number;
                        full_statement: string;
                    };
                    reason: string;
                }[];
                final_decision_sufficient: boolean;
                next_step_summary: string;
                answer: string;
            };
            task3Output = task4Output;
        } else {
            const totalVariables = this._newExploredCodeLines.reduce(
                (acc, code) => acc + code.variables.size,
                0
            );

            if (totalVariables <= 10) {
                // If the total number of variables is less than or equal to 5, add both tools for each variable to the output
                task3Output.sub_problems = this._newExploredCodeLines.flatMap(code =>
                    Array.from(code.variables).flatMap(variable => {
                        const accurateLineNumber = getLineNumber(code.code_snippet, variable, code.start_line);
                        return [
                            {
                                sub_question: "",
                                tool: 1, // Use Find References
                                code_context: {
                                    file_uri: code.file_uri,
                                    invoke_variable: variable,
                                    code_line: code.code_snippet,
                                    line_number: accurateLineNumber ?? code.start_line,
                                    full_statement: code.code_snippet
                                },
                                reason: "Explore the last reached variables in the code line using Find References"
                            },
                            {
                                sub_question: "",
                                tool: 0, // Use Go to Definition
                                code_context: {
                                    file_uri: code.file_uri,
                                    invoke_variable: variable,
                                    code_line: code.code_snippet,
                                    line_number: accurateLineNumber ?? code.start_line,
                                    full_statement: code.code_snippet
                                },
                                reason: "Explore the last reached variables in the code line using Go to Definition"
                            }
                        ];
                    })
                );
            } else {
                const inputJson = {
                    task: 3,
                    refined_question: this._refined_question ?? "",
                    explored_code: this._newExploredCodeLines
                };

                const response = await this._callAgentAPI(inputJson, 3, task3JsonSchema);
                const agentOutput = JSON.parse(response);

                task3Output = await this.processTask3andTask4Output(agentOutput);
            }

            // If Task 3 output is insufficient, run Task 4
            if (task3Output.sub_problems.length === 0) {
                console.warn("Task 3 output insufficient. Running Task 4.");
                const task4Output = await this.runTask4() as {
                    sub_problems: {
                        sub_question: string;
                        tool: number;
                        code_context: {
                            file_uri: string;
                            invoke_variable: string;
                            code_line: string;
                            line_number: number;
                            full_statement: string;
                        };
                        reason: string;
                    }[];
                    final_decision_sufficient: boolean;
                    next_step_summary: string;
                    answer: string;
                };
                task3Output = task4Output;
            }
        }
        this._newExploredCodeLines = []; // Reset the new explored code lines
        // log the task3Output
        return task3Output;
    }

    async runTask4() {
        console.warn("Running task 4, processing ", this._exploredCodeLines.length, " code lines.");

        const inputJson = {
            task: 4,
            refined_question: this._refined_question ?? "",
            explored_code_lines: this._exploredCodeLines,
        };

        const response = await this._callAgentAPI(inputJson, 4, task4JsonSchema);

        // Validate JSON format
        let agentOutput;
        try {
            agentOutput = JSON.parse(response);
        } catch (e) {
            console.error("Failed to parse JSON response for task 4:", e, response);
            return [];
        }

        const task4Output = await this.processTask3andTask4Output(agentOutput);

        return task4Output;
    }

    async runTask5(task2Results: Array<{ file_uri: string; line_number: number; code_line: string; full_statement: string; variables: Set<string> }>) {
        console.warn("Running task 5, processing ", task2Results.length, " results.");

        const filteredResults = task2Results.filter(
            result =>
                !Array.from(this._importantCodeSnippets.values()).some(
                    r => r.file_uri === result.file_uri && r.line_number === result.line_number
                )
        );

        const inputJson = {
            task: 5,
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

        const response = await this._callAgentAPI(inputJson, 5, task5JsonSchema);
        const task5Output = JSON.parse(response);

        task5Output.ranked_results.forEach((result: {
            file_uri: string;
            line_number: number;
            code_line: string;
            full_statement: string;
            variable: string;
            explanation: string;
            relevance_score: number;
            finding: string;
        }) => {
            if (result.relevance_score <= 0) {
                return;
            }
            // Define the path key and node ID
            const pathId = `${result.file_uri}:${result.line_number}`;

            // Check if the snippet already exists
            const existingEntry = Array.from(this._importantCodeSnippets.entries()).find(
                ([, value]) => value.file_uri === result.file_uri && value.line_number === result.line_number
            );

            /* // Check if the snippet already in this._exploredCodeLines
            const matchedCode = this._exploredCodeLines.find(
                code => code.file_uri === result.file_uri && (code.start_line <= result.line_number && code.end_line >= result.line_number)
            ); */

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

                this._findingsSummary.push({
                    snippetKey: [snippetKey],
                    statement: result.finding ?? result.explanation,
                    outOfDate: false
                });

                this._updateFindings = true;
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

        let task6Output = "";
        if (this._updateFindings) {
            task6Output = await this.runTask6();
        }
        return task6Output;
    }

    updateFindingsSummary = (newFindings: any[]): any[] => {
        const updatedFindings: { snippetKey: number[], statement: string, outOfDate: boolean, isUpdated?: boolean }[] = []; // To store the updated findings with `isUpdated` key

        // Match and compare existing findings
        newFindings.forEach(newFinding => {
            const existingFinding = this._lastFindingSummary.find(existing =>
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
                    existingFinding.statement = newFinding.statement;
                    existingFinding.outOfDate = newFinding.outOfDate;
                }
            } else {
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
        this._lastFindingSummary = updatedFindings;

        // Return the updated findings with the `isUpdated` key
        return updatedFindings;
    };

    async runTask6(): Promise<string> {
        console.warn("Running Task 6, processing ", this._findingsSummary.length, " findings.");

        if (this._findingsSummary.length === 0 || !this._updateFindings) {
            return "";
        }

        let findingAndCode: { snippetKey: number[], statement: string, outOfDate: boolean, codeSnippet: { snippetKey: number, codeLine: string }[] }[] = [];
        this._findingsSummary.forEach(finding => {
            findingAndCode.push({
                snippetKey: finding.snippetKey,
                statement: finding.statement,
                outOfDate: finding.outOfDate,
                codeSnippet: finding.snippetKey.map(key => {
                    const entry = this._importantCodeSnippets.get(key);
                    return { snippetKey: key, codeLine: entry?.code_line ?? "" };
                })
            });
        });


        const inputJson = {
            task: 6,
            refined_question: this._refined_question ?? "",
            findings: findingAndCode
        };

        const response = await this._callAgentAPI(inputJson, 6, task6JsonSchema);
        const task6Output = JSON.parse(response);

        if (!task6Output || !task6Output.filtered_findings) {
            console.error("Invalid output from task 6.");
            return "";
        }

        this._final_decision_sufficient = task6Output.final_decision_sufficient;

        // Update the findings summary
        const updatedFindings = this.updateFindingsSummary(task6Output.filtered_findings);

        // Generate the HTML for the findings
        let concatenatedHtml = "";
        if (task6Output.final_decision_sufficient) {
            concatenatedHtml = `
                <p class="final-answer"><span style="font-weight: bold;">Final Answer:</span> ${task6Output.final_answer}</p>
            `;
        }
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

    private async _updateStepResults(refinedOutput: any) {
        // Update sidebar and graph visualization with refinedOutput and important code snippets
        if (this._updateFindings) {
            this._sidebarViewProvider.addTask3Results(this._final_decision_sufficient, refinedOutput, this._importantCodeSnippets, this._importantCodePaths);
        } else {
            this._sidebarViewProvider.addTask3Results(this._final_decision_sufficient, refinedOutput, null, null);
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
                    Task 3: Evaluate the explored code lines based on the refined question and determine the next steps for further exploration.

                    ### Instructions:

                    1. **Input Evaluation**:
                    - You are given a refined question and a list of explored code lines.
                    - Assess what variables in each explored code lines are worth exploring next.

                    2. **Output Requirements**:
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
                taskInstructions = taskInstructions = `
                    task 4: Evaluate the explored code lines based on the refined question and determine the next steps for further exploration.
    
                    ### Instructions:
    
                    1. **Input Evaluation**:
                    - You are given a refined question and a list of explored code lines.
                    - Assess what variables are worth exploring next.
    
                    2. **Output Requirements**:
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
            case 5:
                taskInstructions = `
                    task 5: Rank the exploration results based on relevance to the refined question and summarize findings.

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
            case 6:
                taskInstructions = taskInstructions = `
                Task 6: Evaluate findings and their associated code snippets to provide a comprehensive, implementation-focused answer to the refined question.
                
                ### Input:
                - A collection of findings where each finding contains:
                    - snippetKey: Array of reference keys
                    - statement: The finding statement
                    - outOfDate: Boolean flag for relevance
                    - codeSnippet: Array of corresponding code lines with their keys
                - The refined question to be answered
                
                ### Instructions:
                
                1. **Code-Implementation Analysis:**
                - For each finding, analyze its associated code snippets to verify:
                    - The finding accurately reflects the actual implementation
                    - The code demonstrates concrete behavior
                    - The implementation details support the finding's statement
                - Distinguish between documentation-level findings and implementation-proven findings
                
                2. **Depth Verification:**
                - For each code-backed finding, assess:
                    - Does the code show the complete implementation?
                    - Are there important related code sections missing?
                    - Do the code snippets reveal internal mechanics?
                    - Is the implementation context clear?
                - Consider exploration insufficient if code snippets don't demonstrate the full picture
                
                3. **Implementation Coverage Assessment:**
                - Evaluate if the collected code snippets show:
                    - Primary implementation logic
                    - Supporting utility functions
                    - Usage patterns
                    - Error handling
                    - Integration points
                - Set final_decision_sufficient: false if key implementation aspects are missing
                
                4. **Evidence-Based Answer Formation:**
                When final_decision_sufficient is true, structure the final_answer to include:
                    a. High-level implementation overview
                    b. Specific code patterns found
                    c. Technical constraints revealed by the code
                    d. Real usage examples from the codebase
                    e. Internal implementation details
                
                5. **Finding Consolidation Rules:**
                - When consolidating findings:
                    - Only combine findings if their code snippets demonstrate the same pattern
                    - Preserve specific implementation details
                    - Maintain all snippet references
                    - Example:
                        Original findings with code:
                        - Finding 1: "Method accepts options parameter" [code: function test(options: Config)]
                        - Finding 2: "Method validates options object" [code: validateConfig(options)]
                        Consolidated:
                        - "Method accepts and validates options parameter of type Config"
                
                6. **Insufficient Exploration Guidance:**
                If setting final_decision_sufficient: false, specify:
                    - Which implementation aspects need further investigation
                    - What specific code patterns to look for
                    - Areas where implementation details are unclear
                    - Required technical context missing from current findings
                
                7. **Output Processing:**
                - Remove duplicate code references while preserving unique implementation details
                - Prioritize findings with concrete code evidence
                - Mark findings as outOfDate: true if:
                    - Code snippets contradict the finding
                    - Implementation details are missing
                    - Finding is too generic without code support
                
                ### Output Format:
                {
                    "filtered_findings": [
                        {
                            "snippetKey": ["array of snippet keys"],
                            "statement": "Implementation-specific finding",
                            "outOfDate": boolean
                        }
                    ],
                    "final_decision_sufficient": boolean,
                    "final_answer": "Comprehensive answer based on code implementation evidence"
                }
                
                ### Sufficiency Criteria:
                1. Do code snippets prove each major claim?
                2. Is the implementation flow clear from the collected code?
                3. Are concrete usage patterns demonstrated?
                4. Are technical limitations visible in the code?
                5. Does the code reveal internal behavior?
                
                Remember: The final answer must be grounded in the actual code implementation, not general knowledge or documentation. Every significant claim should be supported by observed code patterns.
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
        const messages = [systemMessage, new HumanMessage(prompt)];

        let result: any;
        let valid = false;

        while (!valid) {
            // Time the agent's response
            const start = new Date().getTime();
            const model = taskNumber === 3 || taskNumber === 4 || taskNumber === 6 ? this._model : this._fasterModel;

            const rawResponse = await model.invoke(messages, {
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: `task_${taskNumber}_schema`,
                        schema: selectedSchema,
                    },
                },
            });

            const end = new Date().getTime();
            console.log(`Task ${taskNumber} Response Time: ${end - start} ms`);

            const parser = new StringOutputParser();
            const response = await parser.invoke(rawResponse);

            try {
                result = JSON.parse(response);

                // Validate the result against the schema
                valid = true;
            } catch (error) {
                console.error(`Failed to parse JSON response for Task ${taskNumber}:`, error);
                valid = false;
            }

            // If validation fails, provide feedback to the agent
            if (!valid) {
                console.warn(`Re-invoking agent for Task ${taskNumber} due to validation errors.`);
            }
        }

        // Log and return the validated result
        console.log(`Validated Task ${taskNumber} Output:`, result);
        return JSON.stringify(result);
    }

    // Method to update the exploration graph and pass visualization data to SidebarView
    /* private updateGraphVisualization() {
        const graphData = this._explorationGraph.toVisualizationData();
        this._sidebarViewProvider.updateGraphVisualization(graphData); // Pass nodes and edges data directly
    }
 */
}

export function deactivate() { }