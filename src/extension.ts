import * as vscode from 'vscode';
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { SidebarView } from './SideBarView';
import { test, getLineText, getSurroundingCode, getLineNumber, Result, getLineTextFromRange, getAccurateLineNumber, searchVariableOffset, processMarkdown, analyze, findCompleteStatementText } from './codeContextUtils';
import { ExplorationGraph, Node, TreeNode } from './explorationGraph';

// API key for OpenAI
const API_KEY = process.env.OPENAI_TOKEN;

if (!API_KEY) {
    console.error("OpenAI API Key is missing. Please set the OPENAI_TOKEN environment variable.");
}

let sidebarViewProvider: SidebarView | undefined;
let agent: Agent | undefined;
let sidebarDisposable: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
    test();

    // Initialize and register the SidebarView once
    sidebarViewProvider = new SidebarView(context);
    sidebarDisposable = vscode.window.registerWebviewViewProvider(
        SidebarView.viewType,
        sidebarViewProvider,
        {
            webviewOptions: {
                retainContextWhenHidden: true // Set this option here
            }
        }
    );
    context.subscriptions.push(sidebarDisposable);

    // Register the command to ask a question about code
    context.subscriptions.push(
        vscode.commands.registerCommand('search-copilot.askQuestion', async () => {
            // Dispose the agent, but keep the sidebar view
            disposeAgentOnly();

            // Reuse existing sidebarViewProvider instead of creating a new one
            if (!sidebarViewProvider) {
                console.error("SidebarViewProvider is missing! It should not be reinitialized.");
                return;
            }

            // Initialize a new agent
            agent = new Agent(sidebarViewProvider);

            // Run the main function after reinitialization
            await askQuestionAboutCode(context, sidebarViewProvider, agent);
        })
    );

    // Register commands for pause, continue, stop, and follow-up
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.pauseAgent', () => {
            agent?.pause();
            vscode.window.showInformationMessage('Agent paused.');
        }),
        vscode.commands.registerCommand('extension.continueAgent', () => {
            agent?.continue();
            vscode.window.showInformationMessage('Agent continued.');
        }),
        vscode.commands.registerCommand('extension.stopAgent', () => {
            agent?.stop();
            vscode.window.showInformationMessage('Agent stopped.');
        }),
        vscode.commands.registerCommand('extension.followUpQuestion', (userInput, fileUri, lineNumber, variable) => {
            agent?.followUpQuestion(userInput, fileUri, lineNumber, variable);
        }),
        vscode.commands.registerCommand('extension.showNewInformation', () => {
            agent?.showTree();
        })
    );

    console.log('Search Copilot extension is now active, waiting for user input.');
}

// Dispose only the agent, keeping the sidebarViewProvider intact
function disposeAgentOnly() {
    console.log("Disposing Agent...");

    if (agent) {
        agent.dispose();
        agent = undefined;
    }

    console.log("Agent disposed, SidebarViewProvider is still active.");
}

export async function getQuestion() {
    return vscode.window.showInputBox({
        placeHolder: "What do you want to ask about this code?",
        prompt: ``
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
    let query = await getQuestion();
    if (query === undefined) {
        return; // User canceled the input box
    } else if (query === "") {
        query = "What does this code do?";
    }
    // Update the sidebar with the user question and selected code
    sidebarViewProvider.updateWebviewContent(query, selectedText, editor.document.uri.toString(), startLine);

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


const task1Schema = z.object({
    refined_question: z.string(),
    sub_problems: z.array(
        z.object({
            sub_question: z.string(),
            tool: z.number(),
            code_context: z.object({
                file_uri: z.string(),
                invoke_variable: z.string(),
                code_line: z.string(),
                line_number: z.number(),
                full_statement: z.string(),
            }).strict(),
            reason: z.string(),
        }).strict()
    ),
});

const task3Schema = z.object({
    evaluations: z.array(
        z.object({
            file_uri: z.string(),
            line_number: z.number(),
            valuable: z.boolean(),
            next_step: z
                .object({
                    variable: z.string(),
                    tool: z.union([z.literal(0), z.literal(1)]),
                    reason: z.string(),
                })
                .nullable(),
        }).strict()
    ),
    next_step_summary: z.string(),
});

const task5Schema = z.object({
    ranked_results: z.array(
        z.object({
            file_uri: z.string(),
            code_line: z.string(),
            line_number: z.number(),
            explanation: z.string(),
            relevance_score: z.number(),
            finding: z.string(),
            variable: z.string(),
        }).strict()
    ),
});

const task7Schema = z.object({
    answer: z.object({
        overview: z.string(), // High-level summary of the question and findings.
        code_insight: z.array(
            z.object({
                insightName: z.string(), // Name of the lifecycle stage or behavior.
                details: z.string(), // Explanation of the stage's role or function.
                reference: z.number(),
            })
        )
    }),
    final_decision_sufficient: z.boolean(),
    new_exploration_questions: z.array(z.string()).optional()
}).strict();

class Agent {
    private _model: ChatOpenAI;
    private _fasterModel: ChatOpenAI;
    private _reasoningModel: ChatOpenAI;
    private _openai: OpenAI;
    private _stepCounter: number = 0;
    private _question: string = "";
    private _refined_question: string | null = null;
    private _numberOfVariablesThreshold: number = 25; // If the collection of variables is less than this threshold, explore them directly without using LLMs to choose the next steps
    private _batchSize: number = 10; // Number of variables to process in a single batch
    private _sidebarViewProvider: SidebarView;
    private _exploredVariables: any[] = [];
    private _exploredFiles: { file_uri: string, file_content: string }[] = []; // Simplified _exploredFiles
    private _exploredSubQuestions: string[] = [];
    private _exploredCodeLines: { file_uri: string, start_line: number, end_line: number; code_snippet: string; variables: Set<string> }[] = [];
    private _newExploredCodeLines: { file_uri: string, start_line: number, end_line: number; code_snippet: string; variables: Set<string> }[] = [];
    private _explorationGraph: ExplorationGraph;
    private isPaused: boolean = false;     // Track if the agent is paused
    private isStopped: boolean = false;    // Track if the agent is stopped
    private _importantCodeSnippets: { file_uri: string, code_line: string, line_number: number, explanation: string, relevance_score: number, snippetKey: number }[] = [];
    private _fileExtensionsToExclude = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js', '.test.jsx', '.spec.jsx', '.d.ts'];
    private _primaryFolder: string = "";
    private _previousParsedNodes: { [key: number]: { nodeID: string; statement: string } } = {};
    private _tree: TreeNode = {
        id: "root",
        snippetKey: 0,
        fileUri: "",
        lineNumber: 0,
        variable: "",
        codeLine: "",
        codeSnippet: "",
        statement: "",
        tool: "assignment",
        children: []
    };
    private _followUpBranchNodeId: string = "";
    private _findingsSummary: { snippetKey: number[], statement: string, outOfDate: boolean }[] = [];
    private _updateFindings: boolean = false;
    private _final_decision_sufficient: boolean = false;

    constructor(sidebarViewProvider: SidebarView) {

        this._model = new ChatOpenAI({
            model: "gpt-4o",
            apiKey: API_KEY,
            temperature: 0,
            topP: 0.1,
        });

        this._fasterModel = new ChatOpenAI({
            model: "gpt-4o-mini",
            apiKey: API_KEY,
            temperature: 0,
            topP: 0.1,
        });

        this._reasoningModel = new ChatOpenAI({
            model: "o3-mini",
            apiKey: API_KEY,
            temperature: 0,
            topP: 0.1,
        });

        this._openai = new OpenAI({
            apiKey: API_KEY, // Your API key
        });

        this._sidebarViewProvider = sidebarViewProvider;
        this._sidebarViewProvider.disposePreliminaryAnswer();
        this._explorationGraph = new ExplorationGraph();
    }

    // New methods to handle pause, continue, and stop
    pause() {
        this.isPaused = true;
        this.isStopped = false;
    }

    continue() {
        this.isPaused = false;
        this.isStopped = false;
    }

    stop() {
        this.isPaused = false;
        this.isStopped = true;
        this.terminateAgent();
    }

    dispose() {
        console.log("Disposing Agent...");

        // Step 1: Stop agent activity
        this.isPaused = false;
        this.isStopped = true;

        // Step 2: Ensure any ongoing tasks are aborted
        if (this._openai) {
            try {
                this._openai = null as any; // Remove reference to API client
            } catch (error) {
                console.error("Error disposing OpenAI API instance:", error);
            }
        }

        // Step 3: Clear exploration data
        this._exploredVariables = [];
        this._exploredFiles = [];
        this._exploredSubQuestions = [];
        this._exploredCodeLines = [];
        this._newExploredCodeLines = [];
        this._previousParsedNodes = {};
        this._tree = {
            id: "root",
            snippetKey: 0,
            fileUri: "",
            lineNumber: 0,
            variable: "",
            codeLine: "",
            codeSnippet: "",
            statement: "",
            tool: "assignment",
            children: []
        };

        // Step 4: Reset findings and exploration graph
        this._explorationGraph = new ExplorationGraph();
        this._findingsSummary = [];
        this._updateFindings = false;
        this._final_decision_sufficient = false;

        // Step 5: Remove references to SidebarViewProvider
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider = null as any; // Clear reference
        }

        console.log("Agent disposed successfully.");
    }

    async terminateAgent() {
        await this.runTask7();
    }

    followUpQuestion(userInput: string, fileUri: string, lineNumber: number, variable: string) {
        this.isPaused = false;
        this.isStopped = false;
        this._final_decision_sufficient = false;
        this._question += " " + userInput;
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider.updatetitleQuestion(this._question);
        }
        this._followUpBranchNodeId = `${fileUri}:${lineNumber}:${variable}`;
        this.runWorkflow(this._question, vscode.Uri.parse(fileUri), lineNumber, lineNumber);
    }

    showTree() {
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider.updateGraphVisualization(this._tree);
        }
    }

    async runWorkflow(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        this.isPaused = false;
        this.isStopped = false;
        this._final_decision_sufficient = false;
        this._question = question;
        const MAX_STEPS = 10;
        let refinedOutput: {
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
        } = {
            sub_problems: [],
            next_step_summary: "",
        };
        const pathParts = uri.fsPath.split("/");
        this._primaryFolder = pathParts.slice(0, -1).join("/");
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
        refinedOutput = await this.runTask1(uri, startLine, endLine);
        // Loop to explore sub-problems
        while (!this._final_decision_sufficient && this._stepCounter < MAX_STEPS && !this.isStopped) {
            const startStep = new Date().getTime();
            this._newExploredCodeLines = []; // Reset the new explored code lines
            if (!refinedOutput || !refinedOutput.sub_problems) {
                console.error("Error: No sub-problems returned.");
                break;
            }

            if (this.isPaused) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait if paused
                continue;
            }

            // Task 2: Explore sub-problems
            const task2Results = await this.runTask2(refinedOutput.sub_problems);

            // Run task 5 and Task 3 concurrently
            const [task3Output, _] = await Promise.all([
                this.runTask3(),// Task 3: Propose next steps
                this.runTask5(task2Results)// task 5: Decide the importance of results
            ]);

            refinedOutput = task3Output;
            this._updateFindings = false;

            const endStep = new Date().getTime();
            console.log(`Step ${this._stepCounter} took ${endStep - startStep}ms`);

            if (this._final_decision_sufficient || refinedOutput.sub_problems.length === 0) {
                break;
            }

            this._stepCounter++;
        }

        this._sidebarViewProvider.agentIsDone();

        if (this._stepCounter >= MAX_STEPS) {
            console.log("Reached maximum exploration steps.");
            this.terminateAgent();
        }
    }

    async processVariableTree(
        uri: vscode.Uri,
        statementText: string,
        variableInfo: Result,
        sub_problems: any,
        startLine: number,
        endLine: number,
        parentID: string | null = null,
        lineVariablesMap: Map<string, Set<string>> = new Map()
    ) {
        const codeLine = await getLineText(uri, variableInfo.lineNumber);
        let codeSnippet = statementText;

        if (statementText.split("\n").length === 1 || statementText.split("\n").length > 6) {
            const { contextText } = await getSurroundingCode(uri, variableInfo.lineNumber, variableInfo.lineNumber);
            codeSnippet = contextText;
        }

        const nodeId = `${variableInfo.fileUri}:${variableInfo.lineNumber}:${variableInfo.variable}`;
        const newNode: Node = {
            id: nodeId,
            fileUri: variableInfo.fileUri,
            lineNumber: variableInfo.lineNumber,
            variable: variableInfo.variable,
            codeLine: codeLine,
            codeSnippet: codeSnippet,
            edges: new Set(),
        };

        if (startLine <= variableInfo.lineNumber && variableInfo.lineNumber <= endLine && !this._followUpBranchNodeId) {
            this._explorationGraph.addOrigin(newNode);
        } else if (parentID) {
            this._explorationGraph.upsertNode(parentID, variableInfo.fileUri, variableInfo.lineNumber, variableInfo.variable, variableInfo.tool);
        } else {
            console.warn("Parent ID is missing: ", variableInfo.variable, variableInfo.lineNumber);
        }

        // Track variables per line
        const lineKey = variableInfo.lineNumber.toString();
        if (!lineVariablesMap.has(lineKey)) {
            lineVariablesMap.set(lineKey, new Set());
        }
        lineVariablesMap.get(lineKey)?.add(variableInfo.variable);

        // Add sub-questions for analysis
        sub_problems.push(
            {
                sub_question: `Find references to "${variableInfo.variable}"`,
                tool: 1, // Find References
                code_context: {
                    file_uri: variableInfo.fileUri,
                    invoke_variable: variableInfo.variable,
                    code_line: codeLine,
                    line_number: variableInfo.lineNumber,
                    full_statement: statementText,
                },
                reason: `Determine where the variable "${variableInfo.variable}" is being used in the codebase.`,
            },
            {
                sub_question: `Go to the definition of "${variableInfo.variable}"`,
                tool: 0, // Go to Definition
                code_context: {
                    file_uri: variableInfo.fileUri,
                    invoke_variable: variableInfo.variable,
                    code_line: codeLine,
                    line_number: variableInfo.lineNumber,
                    full_statement: statementText,
                },
                reason: `Locate the definition of the variable "${variableInfo.variable}" to understand its origin.`,
            }
        );

        // Recursively process children
        for (const child of variableInfo.children) {
            await this.processVariableTree(uri, statementText, child, sub_problems, startLine, endLine, nodeId, lineVariablesMap);
        }
    }

    _extractVariables(variableInfos: Result[]): string[] {
        let variables: string[] = [];

        function traverse(variableInfo: Result) {
            variables.push(variableInfo.variable);
            variableInfo.children.forEach(traverse);
        }

        variableInfos.forEach(traverse);
        return variables;
    }

    async runTask1(uri: vscode.Uri, startLine: number, endLine: number) {
        this._sidebarViewProvider.updateSearchingContent("I am refining your question...");
        const fileUriString = uri.toString();
        const surroundingCode = await getLineTextFromRange(uri, startLine, endLine);

        // update fake origin node
        if (!this._followUpBranchNodeId) {
            this._explorationGraph.updateFakeOrigin(fileUriString, startLine, surroundingCode);
        }

        let totalVariables = 0;
        let sub_problems: {
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
        }[] = [];

        let sentenceStartLineNum = startLine;
        const newVariables = [];
        // Split the surrounding code into lines
        const codeSentences = surroundingCode.split("\n");
        for (const [index, sentence] of codeSentences.entries()) {
            const extractedVariables = await analyze(uri, sentenceStartLineNum + index);
            const { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, sentenceStartLineNum + index);
            const variables = this._extractVariables(extractedVariables);
            const lineVariablesMap = new Map<string, Set<string>>();
            for (const variableInfo of extractedVariables) {
                await this.processVariableTree(uri, statementText, variableInfo, sub_problems, startLine, endLine, null, lineVariablesMap);
            }

            for (const [lineKey, variablesSet] of lineVariablesMap.entries()) {
                newVariables.push({
                    file_uri: fileUriString,
                    line_number: parseInt(lineKey),
                    code_line: await getLineText(uri, parseInt(lineKey)),
                    variables: Array.from(variablesSet)
                });
            }

            this._addOrUpdateExploredCodeLines(fileUriString, startLineNum, endLineNum, statementText, variables);
            totalVariables += variables.length;
        };

        let task1Output: any = {
            refined_question: this._question,
            sub_problems: sub_problems
        };

        const inputJson = {
            task: 1,
            question: this._question,
            surrounding_code: surroundingCode,
            allowed_tools: allowedTools,
            variables_wait_for_exploring: newVariables,
        };

        console.log("Task 1 input: ", inputJson);

        const response = await this._callAgentAPI(inputJson, 1, task1Schema);
        task1Output = JSON.parse(response);
        this._refined_question = task1Output.refined_question;

        this._sidebarViewProvider.updateSearchingContent("I refined your question to: '" + task1Output.refined_question +"'");

        console.log("Task 1 output: ", task1Output);
        /* if (totalVariables <= this._numberOfVariablesThreshold) {
            task1Output.sub_problems = sub_problems;
        } */
        task1Output.sub_problems = sub_problems;

        return task1Output;
    }

    async runTask2(subProblems: any[]) {
        this._sidebarViewProvider.updateSearchingContent(`Looking for answers to ${subProblems.length} sub-questions...`);

        const task2Results: any[] = []; // Stores final results to display in the sidebar
        const newExploredLines: Array<{ file_uri: string, line_number: number, code_line: string, full_statement: string, variables: Set<string> }> = [];

        for (const subProblem of subProblems) {
            const variableName = subProblem.code_context.invoke_variable;
            let lineNumber = subProblem.code_context.line_number;
            const fileUri = vscode.Uri.parse(subProblem.code_context.file_uri);

            // Open the document at the specified fileUri
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Ensure the file is added to _exploredFiles if not already added
            this._addToExploredFiles(fileUri, document);

            // Get code of the line
            const codeLine = document.lineAt(lineNumber).text.trim();

            if (!codeLine.includes(variableName)) {
                const accurateLineNumber = getAccurateLineNumber(document.getText(), subProblem.code_context.full_statement, variableName, lineNumber);
                if (!accurateLineNumber) {
                    continue;
                } else {
                    subProblem.code_context.line_number = accurateLineNumber;
                    lineNumber = accurateLineNumber;
                }  
            }
            // Find the variable's offset in the document
            const offsetResult = searchVariableOffset(document, variableName, lineNumber);

            if (offsetResult == -1) {
                console.error(`Variable "${variableName}" not found near line ${lineNumber}.`);
                task2Results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    filtered_results: [],
                    reason: "Variable not found in code"
                });
                continue;
            }

            const offset = offsetResult;

            // Track explored sub-questions
            this._exploredSubQuestions.push(subProblem.sub_question);

            // Check if the variable has already been explored
            const existingVariable = this._exploredVariables.find(
                v => v.invoke_variable === variableName && v.line_number === lineNumber && v.file_uri === fileUri.toString() && v.tool === subProblem.tool
            );

            if (existingVariable && existingVariable.results.length > 0) {
                continue;
            }

            // Perform the selected tool action (Go to Definition or Find References)
            const results = await this._runTool(fileUri, lineNumber, offset, subProblem);

            if (results.length === 0) {
                continue;
            }

            // Add the variable and results to _exploredVariables
            this._exploredVariables.push({
                invoke_variable: variableName,
                line_number: lineNumber,
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
                    if (!existingLine.variables.has(result.variable)) {
                        existingLine.variables.add(result.variable);
                    }
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
        // this._sidebarViewProvider.addTask2Results({ questions_and_results: task2Results });

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
            results = await this._prepareResults(definitionLocations as vscode.Location[] | vscode.LocationLink[], subProblem);
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

    async processRelevantVariable(variableInfo: Result, parentID: string, resultNodeId: string, statementText: string, document: vscode.TextDocument, results: any[]) {
        const relevantResultNodeId = `${variableInfo.fileUri}:${variableInfo.lineNumber}:${variableInfo.variable}`;

        if (relevantResultNodeId !== resultNodeId) {

            const lineText = document.lineAt(variableInfo.lineNumber).text.trim();

            results.push({
                file_uri: variableInfo.fileUri,
                line_number: variableInfo.lineNumber,
                code_line: lineText,
                full_statement: (lineText.includes(variableInfo.variable) && lineText.includes(";")) ? lineText : statementText,
                variable: variableInfo.variable // Include the relevant variable
            });

            // Use upsertNode to link it to the correct parent node
            await this._explorationGraph.upsertNode(parentID, variableInfo.fileUri, variableInfo.lineNumber, variableInfo.variable, variableInfo.tool);
        }
        // Recursively process children, setting this node as their parent
        for (const child of variableInfo.children) {
            await this.processRelevantVariable(child, relevantResultNodeId, resultNodeId, statementText, document, results);
        }
    }

    async _prepareResults(locations: vscode.Location[] | vscode.LocationLink[], subProblem: any) {
        const results: Array<{ file_uri: string, line_number: number, code_line: string, full_statement: string, variable: string }> = [];
        if (!locations || locations.length === 0) {
            return results;
        }
        for (const location of locations) {
            const lineNumber = location instanceof vscode.Location
                ? location.range.start.line
                : (location as vscode.LocationLink).targetSelectionRange?.start.line ?? 0;

            const uri = location instanceof vscode.Location ? location.uri : location.targetUri;
            const fileUri = uri.toString();
            let pathParts = fileUri.replace("file://", "").split("/");
            let includedFolder = pathParts.slice(0, -1).join("/");
            if (this._fileExtensionsToExclude.some(ext => fileUri.includes(ext)) || this._primaryFolder !== includedFolder) {
                continue;
            }

            // Open document to retrieve code content and statements
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(fileUri));
            let { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, lineNumber);

            if ('targetSelectionRange' in location) {
                const targetSelectionRange = location.targetSelectionRange;
                startLineNum = targetSelectionRange?.start.line ?? 0;
                endLineNum = targetSelectionRange?.end.line ?? 0;
            }

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
            await this._explorationGraph.upsertNode(sourceId, fileUri, lineNumber, variable, subProblem.tool == 0 ? "definition" : "reference");

            // Analyze the code context for relevant variables
            const relevantVariables = await analyze(uri, lineNumber, variable); // after supporting class/function definitions, the full statement text could be different here.
            for (const variableInfo of relevantVariables) {
                await this.processRelevantVariable(variableInfo, resultNodeId, resultNodeId, statementText, document, results);
            }
            // Add both the base result variable and the relevant variables to the variable name list

            const variables = [variable, ...this._extractVariables(relevantVariables)];
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

    async filterInput(exploredCode: any[]) {
        let newVariables: { file_uri: string, line_number: number, code_line: string, variables: string[] }[] = [];
        let variableCount = 0;

        // Use a Set to track unique variable entries in newVariables
        let uniqueVariables = new Set<string>();
        // Use a Map to track unique exploration requests based on (file_uri, variable, line_number, tool)
        let uniqueExploreRequests = new Map<string, any>();

        for (const code of exploredCode) {
            for (const variable of code.variables) {
                if (code.code_snippet === "") {
                    console.error("Code snippet is empty for variable: ", code);
                }

                const accurateLineNumber = getLineNumber(code.code_snippet, variable, code.start_line);
                const lineNumber = accurateLineNumber ?? code.start_line;

                const existingVariables = this._exploredVariables.filter(
                    v => v.invoke_variable === variable &&
                        v.line_number === lineNumber &&
                        v.file_uri === code.file_uri
                );

                // Track tools already used for this variable
                let toolsUsed = new Set(existingVariables.map(v => v.tool));

                const createExploreRequest = (tool: number, reason: string) => {
                    const nodeId = `${code.file_uri}:${lineNumber}:${variable}`;
                    const exploreKey = `${nodeId}:${tool}`;
                    let node = this._explorationGraph.getNode(nodeId);
                    if (!uniqueExploreRequests.has(exploreKey) && node) {
                        uniqueExploreRequests.set(exploreKey, {
                            sub_question: "",
                            tool: tool,
                            code_context: {
                                file_uri: code.file_uri,
                                invoke_variable: variable,
                                code_line: code.code_snippet,
                                line_number: lineNumber,
                                full_statement: code.code_snippet
                            },
                            reason: reason
                        });
                    }
                };

                if (!toolsUsed.has(1)) {
                    createExploreRequest(1, "Explore the last reached variables in the code line using Find References");
                }
                if (!toolsUsed.has(0)) {
                    createExploreRequest(0, "Explore the last reached variables in the code line using Go to Definition");
                }
            }

            code.code_snippet.split("\n").forEach(async (line: string, index: number) => {
                const lineNumber = code.start_line + index;
                const lineText = line.trim();
                const nodeIds = this._explorationGraph.findNodeByLine(code.file_uri, lineNumber, true);
                const lineVariables = nodeIds.map((nodeId: string) => {
                    const parts = nodeId.split(":");
                    return parts[parts.length - 1];
                });
                const variableKey = `${code.file_uri}:${lineNumber}`;
                if (lineVariables.length > 0 && !uniqueVariables.has(variableKey)) {
                    uniqueVariables.add(variableKey);
                    variableCount++;
                    newVariables.push({
                        file_uri: code.file_uri,
                        line_number: lineNumber,
                        code_line: lineText,
                        variables: lineVariables
                    });
                }
            });
        }

        return {
            newVariables,
            variableCount,
            nextExploreVariables: Array.from(uniqueExploreRequests.values())
        };
    }

    async runTask3(task4Flag: boolean = false) {
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
        } = {
            sub_problems: [],
            next_step_summary: "",
        };

        let exploredCodeLines = this._newExploredCodeLines;
        if (task4Flag) {
            exploredCodeLines = this._exploredCodeLines;
        }
        const { newVariables, variableCount, nextExploreVariables } = await this.filterInput(exploredCodeLines);
        console.warn("Running Task 3, processing ", variableCount, " new code lines.");
        this._sidebarViewProvider.updateSearchingContent(`Picking variables to explore from ${variableCount} relevant lines of code...`);

        // If there are no new code lines to explore, directly run Task 4
        if (variableCount === 0) {
            console.warn("No new code lines to explore. Running Task 4.");
            const task4Output = await this.runTask3(true) as {
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
            };
            task3Output = task4Output;
        } else {
            if (variableCount <= this._numberOfVariablesThreshold) {
                console.warn("Number of variables is below threshold. Add all of them into the next step.");
                task3Output.sub_problems = nextExploreVariables;
            } else {
                const batchSize = this._batchSize;
                const batches = [];

                // Split newVariables into chunks of batchSize
                for (let i = 0; i < newVariables.length; i += batchSize) {
                    batches.push(newVariables.slice(i, i + batchSize));
                }

                // Function to process each batch
                const processBatch = async (batch: any[]) => {
                    const inputJson = {
                        task: 3,
                        refined_question: this._refined_question ?? "",
                        variables_wait_for_exploring: batch
                    };
                    const response = await this._callAgentAPI(inputJson, 3, task3Schema);
                    return JSON.parse(response);
                };

                // Dispatch API calls concurrently
                const responses = await Promise.all(batches.map(processBatch));

                // Merge results
                let combinedEvaluations: any[] = [];
                let nextStepSummaries: string[] = [];

                for (const res of responses) {
                    if (res.evaluations.length) combinedEvaluations.push(...res.evaluations);
                    if (res.next_step_summary) nextStepSummaries.push(res.next_step_summary);
                }

                // Keep only the first 3 summaries and collapse the rest
                let summarizedNextStep = nextStepSummaries.slice(0, 3).join("\n");
                if (nextStepSummaries.length > 3) {
                    summarizedNextStep += "...";
                }

                // Store final output
                const mergedOutput = {
                    evaluations: combinedEvaluations,
                    next_step_summary: summarizedNextStep
                };

                task3Output = await this.processTask3andTask4Output(mergedOutput);
            }

            // If Task 3 output is insufficient, run Task 4
            if (task3Output.sub_problems.length === 0) {
                console.warn("Task 3 output insufficient. Running Task 4.");
                const task4Output = await this.runTask3(true) as {
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

        console.log("Task 3 output: ", task3Output);
        return task3Output;
    }

    async runTask5(task2Results: Array<{ file_uri: string; line_number: number; code_line: string; full_statement: string; variables: Set<string> }>) {
        const filteredResults = task2Results.filter(
            result => {
                const isAlreadyInImportantSnippets = Array.from(this._importantCodeSnippets.values()).some(
                    r => r.file_uri === result.file_uri && r.line_number === result.line_number
                );
                const nodeId = this._explorationGraph.findNodeByLine(result.file_uri, result.line_number);
                const isNodeInGraph = nodeId.length > 0;
                return !isAlreadyInImportantSnippets && isNodeInGraph;
            }
        );

        console.warn("Running task 5, processing ", filteredResults.length, " results.");
        this._sidebarViewProvider.updateSearchingContent(`Reviewing ${filteredResults.length} discovered snippets...`);

        const batchSize = 10;
        const batches = [];

        // Split filteredResults into chunks of batchSize
        for (let i = 0; i < filteredResults.length; i += batchSize) {
            batches.push(filteredResults.slice(i, i + batchSize));
        }

        // Function to process each batch
        const processBatch = async (batch: any[]) => {
            const inputJson = {
                task: 5,
                refined_question: this._refined_question ?? "",
                results: batch.map(result => ({
                    file_uri: result.file_uri,
                    line_number: result.line_number,
                    code_line: result.code_line,
                    variables: Array.from(result.variables)
                }))
            };

            //console.log("Task 5 input: ", inputJson.results);

            try {
                const response = await this._callAgentAPI(inputJson, 5, task5Schema);
                return JSON.parse(response);
            } catch (e) {
                console.error("Failed to parse JSON response for task 5:", e);
                return { ranked_results: [] };
            }
        };

        // Dispatch API calls concurrently
        const responses = await Promise.all(batches.map(processBatch));

        // Merge results
        let combinedRankedResults: any[] = [];

        for (const res of responses) {
            // only append the result in res.ranked_results with relevance_score > 0
            combinedRankedResults.push(...res.ranked_results.filter((result: any) => result.relevance_score > 0));
        }

        // Store final output in task5Output
        const task5Output = {
            ranked_results: combinedRankedResults
        };

        task5Output.ranked_results.forEach((result: {
            file_uri: string;
            line_number: number;
            code_line: string;
            variable: string;
            explanation: string;
            relevance_score: number;
            finding: string;
        }) => {

            // Check if the snippet already exists
            const existingEntry = this._importantCodeSnippets.find(
                value => value.file_uri === result.file_uri && value.line_number === result.line_number
            );

            let snippetKey: number;

            if (!existingEntry) {
                snippetKey = this._importantCodeSnippets.length;
                this._importantCodeSnippets.push({
                    file_uri: result.file_uri,
                    code_line: result.code_line,
                    line_number: result.line_number,
                    explanation: result.explanation,
                    relevance_score: result.relevance_score,
                    snippetKey: snippetKey
                });
                this._findingsSummary.push({
                    snippetKey: [snippetKey],
                    statement: result.finding ?? result.explanation,
                    outOfDate: false
                });

                this._updateFindings = true;
            }
        });

        if (this._updateFindings) {
            await this.runTask7();
        }
    }

    private processFinalAnswer(task7Output: any): string {
        const { overview, code_insight } = task7Output.answer;
        const processOverview = (overview: string): string => {
            return `<p>${processMarkdown(overview)}</p>`;
        };

        // Process each insight in the "Lifecycle" section
        const processLifecycle = (code_insight: Array<{ insightName: string; details: string; reference: number }>): string => {
            let usedReferences = new Set<number>();
            let processedHighlights = "";
            let renewGraph = false;
            // Extract all references used in the insights
            code_insight.forEach((insight) => {
                if (usedReferences.has(insight.reference)) {
                    return;
                }
                insight.details = processMarkdown(insight.details);
                for (const record of this._importantCodeSnippets) {
                    if (record.snippetKey == insight.reference) {
                        usedReferences.add(insight.reference);
                        processedHighlights += `
                        <div class="insight" 
                            data-file-uri="${record.file_uri}"
                            data-line-number="${record.line_number}"
                            data-ref="${insight.reference}"
                        >
                            <h3>${insight.insightName}</h3>
                            <p>${insight.details}
                                <button class="jump-btn" title="Open in code editor" data-file-uri="${record.file_uri}" data-line-number="${record.line_number}">
                                    <i class="fa-solid fa-file-import"></i>
                                </button>
                                <button class="follow-btn" title="Follow along with AI agent">
                                    <i class="fa-solid fa-forward-step"></i>
                                    <span class="citation-ref" data-ref="${insight.reference}">walk me here</span>
                                </button>                            
                            </p>
                        </div>`;
                        const nodeId = this._explorationGraph.findNodeByLine(record.file_uri, record.line_number);
                        if (nodeId.length > 0) {
                            renewGraph = true;
                            const newNode = {
                                nodeID: nodeId[0],
                                statement: record.explanation
                            };
                            this._previousParsedNodes[record.snippetKey] = newNode;
                            return;
                        } else {
                            console.warn(`Node ID not found for line ${record.line_number} in ${record.file_uri}`);
                        }
                    }
                }
            });

            // generate the tree with the newPreviousParsedNodes
            if (renewGraph) {
                this._tree = this._explorationGraph.findSmallestTree(this._previousParsedNodes);
                //console.log("New tree: ", this._tree);
                if (task7Output.final_decision_sufficient || this._stepCounter == 0) {
                    this._sidebarViewProvider.updateGraphVisualization(this._tree);
                }
            }

            return processedHighlights;
        };

        const lifecycleAndInsightsContainer = `
            <div id="details-container" style="display: ${task7Output.final_decision_sufficient ? "block" : "none"};">
                <div class="lifecycle">
                    <h1>Descriptive tour of code</h1>
                    ${processLifecycle(code_insight)}
                </div>
            </div>
        `;

        // Add a button to toggle the visibility of the container
        const toggleButton = `
            <button id="toggle-details-btn" onclick="toggleDetails()">
                ${task7Output.final_decision_sufficient ? "Hide tour" : "Toggle descriptive tour of code"}
            </button>
        `;

        // Wrap the entire answer in a container div
        const processedAnswer = `
            <div class="final-answer">
                <h1 id="final-answer-header">${task7Output.final_decision_sufficient ? "Answer" : "Preliminary answer"}</h1>
                ${processOverview(overview)}
                ${toggleButton}
                ${lifecycleAndInsightsContainer}
            </div>
        `;

        return processedAnswer;
    }

    async runTask7() {
        console.warn("Running Task 7.");
        this._sidebarViewProvider.updateSearchingContent(`Reviewing ${this._importantCodeSnippets.length} snippets for an answer...`);
        const inputJson = {
            task: 7,
            user_question: this._question,
            refined_question: this._refined_question ?? this._question,
            relevant_code: this._importantCodeSnippets
        };
        console.log("Task 7 input: ", inputJson);

        const response = await this._callAgentAPI(inputJson, 7, task7Schema);
        const task7Output = JSON.parse(response);
        if (this._stepCounter < 3) {
            task7Output.final_decision_sufficient = false;
        }

        // update refined question if new_exploration_questions is not empty
        if (task7Output.new_exploration_questions.length > 0) {
            this._refined_question = "";
            for (const question of task7Output.new_exploration_questions) {
                this._refined_question += " " + question;
            }
        }
        this._final_decision_sufficient = task7Output.final_decision_sufficient;
        this._sidebarViewProvider.updateSearchingContent(`I decided my exploration so far has been ${this._final_decision_sufficient ? "sufficient" : "insufficient"}.`);
        console.log("Task 7 output: ", task7Output);
        const answerHtml = this.processFinalAnswer(task7Output);
        this._sidebarViewProvider.showAnswer(answerHtml);
    }

    async _callAgentAPI(inputJson: any, taskNumber: number, selectedSchema: any): Promise<string> {
        let taskInstructions = "";

        switch (taskNumber) {
            case 1:
                taskInstructions = `
                    Task 1: Refine the user's question.
                    The user has asked a potentially broad question.
                    You need to refine it into one that can guide the next step in searching the code.
                    Here is some guidance:

                    1. Make the question precise.
                    Restate the goal of the question by removing as much ambiguity as possible.
                    
                    2. State the question in terms of code search actions.
                    You will use the refined question to search the code with VSCode tooling.
                    So the question should be answerable using VSCode tooling.
                    For instance, the refined question may ask to find where a variable is assigned, trace function execution, or understand a data structure.
                `;
                break;
            case 3:
                taskInstructions = `
                    Task 3: Decide what code actions to take next.
                    You have been given:
                    * a question to ask in the code base
                    * a list of sites where you could take an exploration action to answer the question (in "variables_wait_for_exploring"). Each item in this list includes a code line and list of variables that you previously decided might be useful to explore from that line.

                    Select which variables to explore.
                    These variables should be variables that you think, when explored, might be able to help you answer the question.
                    Indirectness if okay---you can explore a variable thinking it might eventually lead to something useful, even if you don't know for sure.
                    (Variables must come from the input list).
                    For each variable, select which tool from VSCode to use to explore it.
                    Two tools are available:
                    - 0: Go to Definition
                    - 1: Find References
                    Write out a reason for why you chose each variable and tool.

                    You can choose more than one variable per line.
                    Each variable needs its own entry in the output.
                `;
                break;
            case 5:
                taskInstructions = `
                    Task 5: Steer upcoming search based on current findings.

                    You have been provided a set of findings ("results"), indicating what was found when VSCode was used to explore a variable you asked to explore.
                    Each of these findings may or may not work towards answering the input question.

                    For each finding, assign "relevance_score". It must be one of:
                    - 0: Irrelevant - The finding does not answer the question.
                    - 1: Relevant - The finding answers the question. (This can include useful steps towards the answer.)

                    For each finding, output the answer to the question ("explanation").
                    If there isn't a clear answer, provide a partial answer based on what was found.
                    (If the finding is irrelevant, no explanation is needed.)

                    Then summarize the finding in one sentence ("finding").
                    Use the structure: "Function/Field/Variable ... + Verb + Function/Field/Variable ...", e.g., ".innerHTML sets the content of HTML as 'ABC'".
                    The summary must be concise.
                    It must be a single clause.
                    It must be clear and crisp---it will be shown to the programmer.
                    Relay which variable was most used to answer the question in the "variable" field.
                    Only include one variable.
                    It must have come from the "variables" input.

                    In your ouptut, values of "file_uri", "code_line", "line_number", "full_statement", or "variables" must be copied verbatim from input.
                `;
                break;
            case 6:
                taskInstructions = taskInstructions = `
                Task 6: Consolidate findings from all past search activity.
                You have been given a collection of your past findings.
                Each finding contains:
                - the question that is meant to be answered by search
                - snippetKey: an array of keys that refer to distinct code snippets
                - codeSnippet: an array of lines of code with their snippet keys
                - statement: a statement of what has been "found"
                - outOfDate: a Boolean flag indicating if the finding is still relevant (false) or not (true)

                For each finding, update the "outOfDate" flag to "true" if the finding is now irrelevant or redundant.
                (Do not remove any out-of-date findings).

                Then, consolidate the findings.
                Whenever findings together describe one concept, combine them together.
                Do this by creating a new finding statement (clear, crisp, a single clause, easily-readable).
                It should adhere to the grammar of the original findings when possible.
                For example, findings "'fast' runs the fast algorithm." and "'slow' runs the slow algorithm." are combined into "'fast' and 'slow' run the fast and slow algorithms.".
                `;
                break;
            case 7:
                taskInstructions = `
                    Task 7: Convey progress.
                    I have given you findings from your search for your search question.
                    Decide if you have enough evidence that you can answer the question.
                    If you do, write the answer.
                    If you don't, adjust your search.

                    First, decide if the findings are sufficient to answer the question.
                    They are sufficient only if they:
                    1. Answer the question.
                    2. Trace the relevant execution fully (with no gaps in data or control flow).

                    If the findings are sufficient, generate an answer.
                    The answer contains:
                    1. Overview: A concise, basic answer to the question. Keep it extremely concise.
                    2. Context (code_insight): A small but comprehensive set of citations to code snippets. Together, they answer the question. Each citation includes:
                    - reference: the snippetKey of the relevant code snippet, verbatim.
                    - details: a concise description of what can be found at the code snippet. Don't be redundant with the overview answer. Omit snippet keys. Keep it extremely concise.
                    - insightName: a 2-3 word descriptive title that appearns next to the snippet.
                    "-1" is not valid a valid snippetKey to cite.
                    A snippet key cannot be used in more than one citation.

                    In the text you generate, use a bit of formatting.
                    Bold (with two asterisk signs) function names and answer and important variable names.
                    For short inline code snippets, use inline code formatting with backticks (\`...\`).

                    If the findings are insufficient, help steer the next step of the search.
                    Generate a refined question (as before, it should be precise and actionable with VSCode tools).
                    You will use this question to continue search.
                    `;
                break;
            default:
                throw new Error("Unknown task number provided.");
        }

        const systemMessage = `
            You are a programming assistant that helps users understand code bases.
            You do this by drawing on context you know about code, and applying VSCode tools iteratively to look up information. 
            You follow task-specific instructions carefully.
            
            In addition, you are:
            - Thorough: You give the programmer thorough and well-researched answers. You explore parts of the code that might give additional useful context, even when you think you have found an answer. 
            - Efficient: You don't repeat your work. If you searched part of the code before, don't do it again.
            - Clear: You convey findings with simple language and short sentences.
            - Concise: You keep your responses to 1 sentence, 2 sentence max.
            `;

        const prompt = (taskInstructions + "\n\n" +
            "Your output must match the provided schema." +
            JSON.stringify(inputJson));

        let result: any;
        let valid = false;

        while (!valid) {
            // Time the agent's response
            const start = new Date().getTime();
            let model;
            if (taskNumber === 7) {
                model = this._reasoningModel;
            } else {
                model = this._fasterModel;
            }

            const completion = await this._openai.beta.chat.completions.parse({
                model: model.model,
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: prompt },
                ],
                response_format: zodResponseFormat(selectedSchema, `task_${taskNumber}_schema`),
            });

            const end = new Date().getTime();
            console.log(`Task ${taskNumber} Response Time: ${end - start} ms`);

            const response = completion.choices[0].message.parsed;

            try {
                result = JSON.stringify(response);
                valid = true;
            } catch (error) {
                console.error(`Failed to parse response for Task ${taskNumber}:`, error);
                valid = false;
            }

            // If validation fails, provide feedback to the agent
            if (!valid) {
                console.warn(`Re-invoking agent for Task ${taskNumber} due to validation errors.`);
            }
        }

        // Log and return the validated result
        // console.log(`Validated Task ${taskNumber} Output:`, result);
        return result;
    }

    // Method to update the exploration graph and pass visualization data to SidebarView
    /* private updateGraphVisualization() {
        const graphData = this._explorationGraph.toVisualizationData();
        this._sidebarViewProvider.updateGraphVisualization(graphData); // Pass nodes and edges data directly
    }
 */
}