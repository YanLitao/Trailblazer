import * as vscode from 'vscode';
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { SidebarView } from './SideBarView';
import { test, getLineText, getSurroundingCode, getLineNumber, normalProcess, getLineTextFromRange, getAccurateLineNumber, searchVariableOffset, processMarkdown, analyze, findCompleteStatementText } from './codeContextUtils';
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
        sidebarViewProvider
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
            full_statement: z.string(),
            explanation: z.string(),
            relevance_score: z.number(),
            finding: z.string(),
            variable: z.string(),
        }).strict()
    ),
});

const task6Schema = z.object({
    filtered_findings: z.array(
        z.object({
            snippetKey: z.array(z.number()),
            statement: z.string(),
            outOfDate: z.boolean(),
        }).strict()
    ),
});

const task7Schema = z.object({
    answer: z.object({
        Overview: z.string(), // High-level summary of the question and findings.
        Lifecycle: z.array(
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
    private _importantCodeSnippets = new Map<number, { file_uri: string; code_line: string; line_number: number; full_statement: string; explanation: string; relevance_score: number }>();
    private _fileExtensionsToExclude = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js', '.test.jsx', '.spec.jsx', '.d.ts'];
    private _previousParsedNodes: { [key: number]: { nodeID: string; statement: string } } = {};
    private _tree: TreeNode = {
        id: "root",
        snippetKey: 0,
        fileUri: "",
        lineNumber: 0,
        variable: "",
        codeLine: "",
        codeSnippet: "",
        isIntermediate: false,
        statement: "",
        tool: "assignment",
        children: []
    };
    private _followUpBranchNodeId: string = "";
    private _findingsSummary: { snippetKey: number[], statement: string, outOfDate: boolean }[] = [];
    private _lastFindingSummary: { snippetKey: number[], statement: string, outOfDate: boolean }[] = [];
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
            isIntermediate: false,
            statement: "",
            tool: "assignment",
            children: []
        };

        // Step 4: Reset findings and exploration graph
        this._explorationGraph = new ExplorationGraph();
        this._findingsSummary = [];
        this._lastFindingSummary = [];
        this._updateFindings = false;
        this._final_decision_sufficient = false;

        // Step 5: Remove references to SidebarViewProvider
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider = null as any; // Clear reference
        }

        console.log("Agent disposed successfully.");
    }

    async terminateAgent() {
        let task7Output = await this.runTask7();
        this._sidebarViewProvider.addAnswer(task7Output);
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

    async runWorkflow(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        this.isPaused = false;
        this.isStopped = false;
        this._final_decision_sufficient = false;
        this._question = question;
        const MAX_STEPS = 10;
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
        refinedOutput = await this.runTask1(uri, startLine, endLine);
        // Loop to explore sub-problems
        while (!this._final_decision_sufficient && this._stepCounter < MAX_STEPS && !this.isStopped) {
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

            const endStep = new Date().getTime();
            console.log(`Step ${this._stepCounter} took ${endStep - startStep}ms`);

            if (this._final_decision_sufficient || refinedOutput.sub_problems.length === 0) {
                break;
            }
        }

        this._sidebarViewProvider.agentIsDone();

        if (this._stepCounter >= MAX_STEPS) {
            console.log("Reached maximum exploration steps.");
            this.terminateAgent();
        }
    }

    async runTask1(uri: vscode.Uri, startLine: number, endLine: number) {
        this._sidebarViewProvider.updateSearchingContent("Refining your question...");
        const fileUriString = uri.toString();
        const surroundingCode = await getLineTextFromRange(uri, startLine, endLine);

        // update fake origin node
        if (!this._followUpBranchNodeId) {
            this._explorationGraph.updateFakeOrigin(fileUriString, startLine, surroundingCode);
        }

        const codeContext: { file_uri: string, line_number: number, code_line: string, variables: Set<string> }[] = [];
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
        let fromID = "";

        let sentenceStartLineNum = startLine;
        // Split the surrounding code into lines
        const codeSentences = surroundingCode.split("\n");
        codeSentences.forEach(async (sentence, index) => {
            const extractedVariables = await analyze(uri, sentenceStartLineNum + index);
            const { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, sentenceStartLineNum + index);
            const codeLines = sentence;
            const variables = extractedVariables.map((variableInfo: any) => variableInfo.variable);

            extractedVariables.forEach(async (variableInfo: any) => {
                const codeLine = await getLineText(uri, variableInfo.lineNumber);

                sub_problems.push(
                    {
                        sub_question: `Find references to "${variableInfo.variable}"`,
                        tool: 1, // Find References
                        code_context: {
                            file_uri: fileUriString,
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
                            file_uri: fileUriString,
                            invoke_variable: variableInfo.variable,
                            code_line: codeLine,
                            line_number: variableInfo.lineNumber,
                            full_statement: statementText,
                        },
                        reason: `Locate the definition of the variable "${variableInfo.variable}" to understand its origin.`,
                    },
                );

                if (startLine <= variableInfo.lineNumber && variableInfo.lineNumber <= endLine && !this._followUpBranchNodeId) {
                    let codeSnippet = statementText;
                    if (statementText.split("\n").length == 1) {
                        const { contextText, startContextLine } = await getSurroundingCode(uri, variableInfo.lineNumber, variableInfo.lineNumber);
                        codeSnippet = contextText;
                    }
                    this._explorationGraph.addOrigin({
                        id: `${fileUriString}:${variableInfo.lineNumber}:${variableInfo.variable}`,
                        fileUri: fileUriString,
                        lineNumber: variableInfo.lineNumber,
                        variable: variableInfo.variable,
                        codeLine: codeLine,
                        codeSnippet: codeSnippet,
                        edges: new Set(),
                    });

                    if (!fromID) fromID = `${fileUriString}:${variableInfo.lineNumber}:${variableInfo.variable}`;
                }
            });


            const lineNum = sentenceStartLineNum + index;
            // get the variables with the same line number
            // const variables = extractedVariables.filter((variableInfo: any) => variableInfo.lineNumber === lineNum).map((variableInfo: any) => variableInfo.variable);
            codeContext.push({
                file_uri: fileUriString,
                line_number: lineNum,
                code_line: codeLines,
                variables: new Set(variables)
            });
            this._addOrUpdateExploredCodeLines(fileUriString, startLineNum, endLineNum, statementText, variables);
            //sentenceStartLineNum += codeLines.length;
            totalVariables += extractedVariables.length;
        });

        let task1Output: any = {
            refined_question: this._question,
            sub_problems: sub_problems
        };

        const inputJson = {
            task: 1,
            question: this._question,
            surrounding_code: surroundingCode,
            allowed_tools: allowedTools,
            code_context: codeContext,
        };

        console.log("Task 1 input: ", inputJson);

        const response = await this._callAgentAPI(inputJson, 1, task1Schema);
        task1Output = JSON.parse(response);
        this._refined_question = task1Output.refined_question;

        this._sidebarViewProvider.updateSearchingContent("Refined your question into: " + task1Output.refined_question);

        if (totalVariables <= this._numberOfVariablesThreshold) {
            task1Output.sub_problems = sub_problems;
        }

        for (const subProblem of task1Output.sub_problems) {
            const { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, subProblem.code_context.line_number);
            subProblem.code_context.file_uri = fileUriString; // when running the agent, sometimes the file_uri is not included in the input

            if (!this._followUpBranchNodeId) {
                // Create a node for each sub-problem and mark it as an invoking place
                const nodeId = `${fileUriString}:${subProblem.code_context.line_number}:${subProblem.code_context.invoke_variable}`;
                const codeLine = await getLineText(uri, subProblem.code_context.line_number);
                let codeSnippet = statementText;
                // const accurateLineNumber = getLineNumber(statementText, subProblem.code_context.invoke_variable, startLineNum);
                if (statementText.split("\n").length == 1) {
                    const { contextText, startContextLine } = await getSurroundingCode(uri, subProblem.code_context.line_number, subProblem.code_context.line_number);
                    codeSnippet = contextText;
                }
                const newNode: Node = {
                    id: nodeId,
                    fileUri: fileUriString,
                    lineNumber: subProblem.code_context.line_number,
                    variable: subProblem.code_context.invoke_variable,
                    codeLine: codeLine,
                    codeSnippet: codeSnippet,
                    edges: new Set(),
                };
                if (!fromID || startLine <= subProblem.code_context.line_number && subProblem.code_context.line_number <= endLine) {
                    this._explorationGraph.addOrigin(newNode);
                    if (!fromID) fromID = nodeId;
                } else {
                    this._explorationGraph.upsertNode(fromID, fileUriString, subProblem.code_context.line_number, subProblem.code_context.invoke_variable, "assignment");
                }
            }
        }

        // Update the sidebar view with Task 1 results after processing
        /* if (this._sidebarViewProvider) {
            this._sidebarViewProvider.addTask1Results(task1Output);  // Add the Task 1 results to the sidebar
        } */

        return task1Output;
    }

    async runTask2(subProblems: any[]) {
        this._sidebarViewProvider.updateSearchingContent(`Exploring ${subProblems.length} sub-problems...`);

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
                task2Results.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    filtered_results: existingVariable.results
                });
                continue;
            }
            // Perform the selected tool action (Go to Definition or Find References)
            console.log(`Exploring "${variableName}" in ${fileUri.toString()} line ${lineNumber} with tool ${subProblem.tool}...`);
            const results = await this._runTool(fileUri, lineNumber, offset, subProblem);

            if (results.length === 0) {
                console.warn(`No new results were found for "${subProblem.code_context.invoke_variable}" near line ${subProblem.code_context.line_number} with tool ${subProblem.tool}.`);
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

    async _prepareResults(locations: vscode.Location[] | vscode.LocationLink[], subProblem: any) {
        const results: Array<{ file_uri: string, line_number: number, code_line: string, full_statement: string, variable: string }> = [];
        if (!locations || locations.length === 0) {
            console.warn(`No locations found for ${subProblem.code_context.invoke_variable} around line ${subProblem.code_context.line_number}.`);
            return results;
        }

        for (const location of locations) {
            const lineNumber = location instanceof vscode.Location
                ? location.range.start.line
                : (location as vscode.LocationLink).targetSelectionRange?.start.line ?? 0;

            const uri = location instanceof vscode.Location ? location.uri : location.targetUri;
            const fileUri = uri.toString();
            if (this._fileExtensionsToExclude.some(ext => fileUri.includes(ext))) {
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
                if (lineVariables && !uniqueVariables.has(variableKey)) {
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
        console.warn("Running Task 3, processing ", this._newExploredCodeLines.length, " new code lines.");
        this._sidebarViewProvider.updateSearchingContent(`Deciding next exploration variables from ${this._newExploredCodeLines.length} new code lines...`);
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

        let exploredCodeLines = this._newExploredCodeLines;
        if (task4Flag) {
            exploredCodeLines = this._exploredCodeLines;
        }
        const { newVariables, variableCount, nextExploreVariables } = await this.filterInput(exploredCodeLines);

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
                answer: string;
            };
            task3Output = task4Output;
        } else {
            if (variableCount <= this._numberOfVariablesThreshold) {
                console.warn("Number of variables is below threshold. Add all of them into the next step.");
                task3Output.sub_problems = nextExploreVariables;
            } else {
                console.warn("Number of variables is above threshold. Splitting into batches and running Task 3.");
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
                    console.log("Task 3 input: ", inputJson.variables_wait_for_exploring);
                    const response = await this._callAgentAPI(inputJson, 3, task3Schema);
                    return JSON.parse(response);
                };

                // Dispatch API calls concurrently
                const responses = await Promise.all(batches.map(processBatch));

                // Merge results
                let combinedEvaluations: any[] = [];
                let nextStepSummaries: string[] = [];

                for (const res of responses) {
                    if (res.evaluations) combinedEvaluations.push(...res.evaluations);
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
        this._newExploredCodeLines = []; // Reset the new explored code lines
        // log the task3Output
        console.log("Task 3 output: ", task3Output);
        return task3Output;
    }

    async runTask5(task2Results: Array<{ file_uri: string; line_number: number; code_line: string; full_statement: string; variables: Set<string> }>) {
        console.warn("Running task 5, processing ", task2Results.length, " results.");
        this._sidebarViewProvider.updateSearchingContent(`Evaluating the importance of ${task2Results.length} results gained in this exploration...`);

        const filteredResults = task2Results.filter(
            result =>
                !Array.from(this._importantCodeSnippets.values()).some(
                    r => r.file_uri === result.file_uri && r.line_number === result.line_number
                )
        );

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
                    full_statement: result.full_statement,
                    variables: Array.from(result.variables)
                }))
            };

            console.log("Task 5 input: ", inputJson.results);

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
            if (res.ranked_results) combinedRankedResults.push(...res.ranked_results);
        }

        // Store final output in task5Output
        const task5Output = {
            ranked_results: combinedRankedResults
        };

        // nodeIds: {snippetKey: {nodeID: string, statement: string} ...} is an object that stores the node IDs and statement with the snippetKey as the key in this._importantCodeSnippets
        let nodeIds: {
            [key: number]: {
                nodeID: string;
                statement: string;
            }
        } = {};
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

                this._findingsSummary.push({
                    snippetKey: [snippetKey],
                    statement: result.finding ?? result.explanation,
                    outOfDate: false
                });

                this._updateFindings = true;
            } else {
                snippetKey = existingEntry[0];
            }

            const nodeId = this._explorationGraph.findNodeByLine(result.file_uri, result.line_number);
            if (nodeId.length === 0) {
                console.warn(`Node ID not found for line ${result.line_number} in ${result.file_uri}`);
                return {};
            } else {
                nodeIds[snippetKey] = {
                    nodeID: nodeId[0],
                    statement: result.finding ?? result.explanation
                };
            }
        });

        if (nodeIds !== this._previousParsedNodes && Object.keys(nodeIds).length > 0) {
            // Merge previous parsed nodes with the current ones
            nodeIds = { ...this._previousParsedNodes, ...nodeIds };
            console.log("Node IDs to form a tree: ", nodeIds);
            let newTree: TreeNode;
            // Decide between branch-specific or global updates
            if (this._followUpBranchNodeId) {
                newTree = this._explorationGraph.appendOrAddNodesToTree(nodeIds, this._followUpBranchNodeId);
            } else if (Object.keys(this._previousParsedNodes).length > 0) {
                newTree = this._explorationGraph.appendOrAddNodesToTree(nodeIds);
            } else {
                newTree = this._explorationGraph.findSmallestTree(nodeIds);
            }
            // Update the tree and visualization
            if (newTree.children.length > 0) {
                this._tree = newTree;
                this._sidebarViewProvider.updateGraphVisualization(this._tree);
                this._previousParsedNodes = nodeIds;
            } else {
                console.error("Failed to update the tree with the given node IDs: ", nodeIds);
            }
            console.log("Tree: ", newTree);
        }

        let evaluationOutput = "";
        if (this._updateFindings) {
            /* let [task7Output, task6Output] = await Promise.all([
                this.runTask7(),
                this.runTask6()
            ]); */
            evaluationOutput = await this.runTask7();
            /* if (this._final_decision_sufficient) {
                evaluationOutput = task7Output;
                this._sidebarViewProvider.addAnswer(evaluationOutput);
            } else {
                evaluationOutput = task7Output + task6Output;
            } */
        }

        return evaluationOutput;
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

    private findSnippetBySnippetKey(snippetKey: number): { fileUri: string; lineNumber: number } | null {
        // Recursive function to search the tree
        const traverseTree = (node: TreeNode): { fileUri: string; lineNumber: number } | null => {
            if (node.snippetKey === snippetKey) {
                return { fileUri: node.fileUri, lineNumber: node.lineNumber };
            }

            for (const child of node.children) {
                const result = traverseTree(child);
                if (result) {
                    return result; // Return as soon as a match is found
                }
            }

            return null; // Return null if no match is found
        };

        return traverseTree(this._tree);
    }



    private processFinalAnswer(task7Output: any): string {
        const { Overview, Lifecycle } = task7Output.answer;

        // Helper functions for markdown processing


        // Process the "Overview" section
        const processOverview = (overview: string): string => {
            return `<div class="overview"><h2>Overview</h2><p>${processMarkdown(overview)}</p></div>`;
        };

        // Process each insight in the "Lifecycle" section
        const processLifecycle = (lifecycle: Array<{ insightName: string; details: string; reference: number }>): string => {
            return lifecycle
                .map((insight) => {
                    insight.details = processMarkdown(insight.details);

                    // Extract snippetKey from reference
                    const snippetData = insight.reference !== null ? this.findSnippetBySnippetKey(insight.reference) : null;

                    // Add data attributes for fileUri and lineNumber
                    return `
                        <div class="insight" 
                            data-file-uri="${snippetData?.fileUri || ''}" 
                            data-line-number="${snippetData?.lineNumber || ''}" 
                            data-ref="${insight.reference}">
                            <h3>${insight.insightName}</h3>
                            <p>${insight.details}
                                [<span class="citation-ref" data-ref="${insight.reference}">See how we found this</span>]
                            </p>
                        </div>`;
                })
                .join("");
        };

        const lifecycleAndInsightsContainer = `
            <div id="details-container" style="display: ${task7Output.final_decision_sufficient ? "block" : "none"};">
                <div class="lifecycle">
                    <h2>Highlights</h2>
                    ${processLifecycle(Lifecycle)}
                </div>
            </div>
        `;

        // Add a button to toggle the visibility of the container
        const toggleButton = `
            <button id="toggle-details-btn" onclick="toggleDetails()">
                ${task7Output.final_decision_sufficient ? "Hide Details" : "Show Details"}
            </button>
        `;

        // Wrap the entire answer in a container div
        const processedAnswer = `
            <div class="final-answer">
                <h1 id="final-answer-header" style="font-weight: bold;">${task7Output.final_decision_sufficient ? "Final Answer" : "Preliminary Answer"}:</h1>
                ${processOverview(Overview)}
                ${toggleButton}
                ${lifecycleAndInsightsContainer}
            </div>
        `;

        return processedAnswer;
    }

    async runTask7() {
        console.warn("Running Task 7.");
        this._sidebarViewProvider.updateSearchingContent(`Deciding whether the exploration is sufficient based on a tree with ${this._explorationGraph.getNumberOfNodesInTree()}...`);
        const inputJson = {
            task: 7,
            user_question: this._question,
            refined_question: this._refined_question ?? this._question,
            data_flow_tree: this._tree
        };

        const response = await this._callAgentAPI(inputJson, 7, task7Schema);
        const task7Output = JSON.parse(response);

        // update refined question if new_exploration_questions is not empty
        if (task7Output.new_exploration_questions.length > 0) {
            this._refined_question = "";
            for (const question of task7Output.new_exploration_questions) {
                this._refined_question += " " + question;
            }
        }
        this._final_decision_sufficient = task7Output.final_decision_sufficient;
        this._sidebarViewProvider.updateSearchingContent(`Exploration is ${this._final_decision_sufficient ? "sufficient" : "insufficient"}.`);
        return this.processFinalAnswer(task7Output);
    }

    private async _updateStepResults(refinedOutput: any) {
        // Update sidebar and graph visualization with refinedOutput and important code snippets
        if (this._updateFindings) {
            this._sidebarViewProvider.showAnswer(refinedOutput.answer);
        } else {
            this._sidebarViewProvider.showAnswer(refinedOutput.answer);
        }
        this._updateFindings = false;
    }

    async _callAgentAPI(inputJson: any, taskNumber: number, selectedSchema: any): Promise<string> {
        let taskInstructions = "";

        switch (taskNumber) {
            case 1:
                taskInstructions = `
                    Task 1: Refine the user's question by incorporating relevant surrounding code while ensuring conciseness. Include only the necessary parts of the surrounding code that directly contribute to understanding and answering the question.

                    Next, identify valuable variables to explore using VSCode tools and select an appropriate tool from the following list by providing the corresponding integer value:
                    - 0: Go to Definition
                    - 1: Find References
                    
                    Each item in the sub_problems array corresponds to a code line with an array of variables available for exploration.
                    Evaluate each variable in the variables array and determine whether it is valuable to explore to answer the refined question. Justify the selection with a reason.
                    
                    The output format must strictly adhere to the JSON schema provided. Ensure that the tool is represented as an integer and do not alter the code_line.
                `;
                break;
            case 3:
                taskInstructions = `
                    Task 3: Evaluate the variables_wait_for_exploring based on the refined question and determine the next steps for further exploration.

                    Instructions:

                    1. Input Evaluation:
                    - You are given a refined question and a list of variables_wait_for_exploring.
                    - For each item in variables_wait_for_exploring contains a code_line and an array of unexplored variables. 
                    - Assess what variables are worth exploring next.

                    2. Output Requirements:
                    - Some code_lines may not be valuable for further exploration immediately but could be valuable later. So, try to mark all potentially valuable lines.
                    - If valuable, identify the valuable variable to explore next from variables array.
                        - Select the appropriate tool:
                            - 0: Go to Definition
                            - 1: Find References
                        - Provide a reason for choosing the variable and tool.
                    - If a line has more than one valuable variables, add multiple entries for that line.
                    - Do not include any other variables not from the variables array, even they are in the code_line.
                    - Only output if it is valuable for further exploration. 
                `;
                break;
            case 5:
                taskInstructions = `
                    task 5: Rank the exploration results based on relevance to the refined question and summarize findings.

                    Assign a "relevance_score" of 0 or 1 to each result, where:
                    - 0: Not relevant - The result is not useful or does not contribute to the understanding of the refined question. Exclude this result.
                    - 1: Worth showing - The result's code_line can directly or partially answer the question. Or it contains valuable findings that provide meaningful insights for the programmer to understand the important aspects of the exploration.

                    For each result in the "results" array:
                    - Provide an "explanation" of why it is helpful or how it contributes to understanding the question.
                    - Summarize the finding in one sentence under the "finding" field. Use the structure: 
                        "Function/Field/Variable ... + Verb + Function/Field/Variable ...", e.g., ".innerHTML sets the content of HTML as 'ABC'".
                        Ensure the sentence is concise, informative, and clear. Do not include a clause.
                    - Add the specific variable being tracked for this result under the "variable" field. Only select one variable. 
                        Important: The variable must be selected only from the "variables" array provided in the result. Do not use or infer any other variables.

                    Important:
                    - Do not modify the values of "file_uri", "code_line", "line_number", "full_statement", or "variables" for each exploration result in the input.
                `;
                break;
            case 6:
                taskInstructions = taskInstructions = `
                Task 6: Filter, consolidate, and refine findings based on the exploration results.

                Input:
                - A collection of findings where each finding contains:
                    - snippetKey: Array of reference keys
                    - statement: The finding statement
                    - outOfDate: Boolean flag for relevance
                    - codeSnippet: Array of corresponding code lines with their keys
                - The refined question to be answered
                
                Instructions:
                
                1. Filter Findings:
                - Review all input findings.
                - Mark any finding as outOfDate: true if it is irrelevant to the refined question, redundant, or does not contribute meaningful insight.
                - Retain all findings in the output, even those marked as outOfDate.
                
                2. Consolidate Findings:
                - Combine findings that describe similar or related concepts only if they follow the same structure.
                - Consolidate findings by combining their snippet keys and creating a concise statement adhering to the original structure.
                - Do not introduce new grammatical patterns or combine findings with differing structures.
                - Example:
                    - Input:
                    - 'sm' sets width to 24px.
                    - 'md' sets width to 48px.
                    - 'lg' sets width to 72px.
                    - Consolidated Output:
                    - 'sm', 'md', 'lg' set width to 24, 48, 72px.
                `;
                break;
            case 7:
                taskInstructions = `
                Task 7: Decide Sufficiency and Generate Answer

                Goals:
                1. Firstly, assess if the current findings and code exploration sufficiently answer the refined question.
                2. Then, generate a structured, evidence-based answer that includes key insights for developers.
                3. Finally, suggest New Questions if final_decision_sufficient is false.

                Input:
                1. user_question: The original user question.
                2. refined_question
                3. data_flow_tree: A structured tree containing findings and associated code snippets.

                Instructions:

                1. Generate Answer:
                Provide a structured, detailed answer object, whether or not findings are sufficient. The structure should include:
                - Overview: A concise summary of the code element's purpose and relevance to the question.
                - Key Insights: An array of objects representing crucial execution steps, dependencies, or structural behaviors:
                   - insightName: Name of the key insight (e.g., "Initialization," "Data Flow," "Parameter Influence").
                   - details: A short explanation of the insight.
                   - reference: A single snippetKey reference ([snippetKey: number]) that supports the explanation. 
                
                2. Guidelines for Generating Good "Key Insights":
                - Each claim in the Overview should have a corresponding key insight to support it.
                - Key insights should directly answer to the question. Make sure all question-relevant nodes from the tree are covered. 
                - Other important insights should capture important aspects of how the code works.
                - Other insights can focus on execution flow, control flow, data flow, structural relationships, or logical steps.
                - Name the insight concisely while making it clear what aspect of the code it describes.
                - Each insight should be specific, meaningful, and useful for understanding the question.

                Common Types of Key Insights Based on Code Elements:
                - Functions (What does this function do?)
                   - "Input Handling" - How the function processes incoming parameters.
                   - "Computation Logic" - How the function transforms data.
                   - "State Update" - If the function modifies state variables.
                   - "Output Generation" - What the function returns.
                   - "Error Handling" - How errors are caught or managed.
                   - "Side Effects" - Any changes outside the function (e.g., modifying global state).

                - Variables (How is this variable used?)
                   - "Initialization" - Where and how the variable is first assigned.
                   - "Modification" - What parts of the code change its value.
                   - "Usage" - Where and how it is referenced in computations or logic.
                   - "Scope and Lifetime" - How long the variable exists in the program.
                   - "Dependencies" - Other variables/functions that affect its value.

                - Parameters (Why is this parameter needed?)
                   - "Influence on Execution" - How the parameter affects function behavior.
                   - "Default Behavior" - What happens if the parameter is missing.
                   - "Conditional Logic" - Where the parameter influences branches (if/switch).
                   - "Dependency Injection" - If the parameter provides external dependencies.

                - Objects and Classes (What does this class or object do?)
                   - "Initialization" - How the object is created.
                   - "Properties and Methods" - Key attributes and their behaviors.
                   - "Interactions" - What other components this interacts with.
                   - "State Management" - How internal state is handled.

                - Configuration Settings (How does this setting affect behavior?)
                   - "Impact on Execution" - What this setting changes in the program.
                   - "Default and Custom Values" - What happens if it is set or left blank.
                   - "Dependency on Other Configurations" - If it interacts with other settings.
                   - "Performance Impact" - Whether this setting affects performance.
                   - "Security Considerations" - If the setting has security implications.

                Reference Guidelines:
                - Each insight should have a single number for referring to a code snippet reference (the number is from snippetKey: number in the tree). 
                - Not two insights should reference the same snippetKey.
                - Do not reference snippetKey: -1, as it represents the root node.
                - Use bold formatting (**importantMethod**) for function names and variables.
                - Use inline code formatting (\`someVariable\`) for small code snippets.

                3. Decide final_decision_sufficient:
                Evaluate if the current findings and data flow tree are fully sufficient to answer the refined question. Consider the following factors strictly:

                (A) Concrete Code Evidence: 
                - Are there direct code references (e.g., function calls, assignments, CSS changes, control flows) supporting each key part of the answer?
                - Does the data flow tree contain explicit operations that prove the behavior rather than inferred logic?

                (B) Execution Flow and Dependencies: 
                - Are all necessary execution steps traced? (e.g., function calls, variable mutations, interactions across files)
                - Does the explanation cover how the answer is implemented rather than just what it does?

                (C) Scope and Coverage:  
                - Are all relevant parts of the codebase (e.g., related functions, affecting variables, impacted components) included?
                - Are there missing dependencies, control flows, or unexplored conditions that could affect the answer?

                (D) Clarity and Completeness:  
                - Does the explanation clearly show how the findings lead to the final answer?  
                - Would a developer, unfamiliar with the code, be able to understand and verify the reasoning based on the provided snippets?  
                - If an important part is missing (e.g., where exactly a property is modified), the answer is insufficient.

                Decision Rules:
                - final_decision_sufficient = true: Only if the data flow tree contains concrete, traceable evidence covering all aspects above.
                - final_decision_sufficient = false: If any crucial evidence is missing, specify:
                - Missing areas (e.g., unexamined dependencies, unexplored control flows, or unclear logic).
                - Additional steps required (e.g., tracking function calls, variable changes, external dependencies).

                4. Suggest New Questions if final_decision_sufficient = false
                If the findings are not sufficient, generate new exploration questions based on the missing areas.

                Guidelines for New Questions:
                - Target the gaps in the current exploration tree.
                - Be specific about what needs to be investigated.
                - Encourage deeper exploration (e.g., function calls, missing conditions, related variables).
                `;
                break;
            default:
                throw new Error("Unknown task number provided.");
        }

        const systemMessage = `
            You are an assistant designed to help users explore and understand codebases by performing tasks using VSCode tools. 
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
            
            Ensure that your output matches the provided schema.
        `;


        const prompt = JSON.stringify(inputJson);

        let result: any;
        let valid = false;

        while (!valid) {
            // Time the agent's response
            const start = new Date().getTime();
            let model;
            if (taskNumber === 3 || taskNumber === 5) {
                model = this._fasterModel;
            } /* else if (taskNumber === 7) {
                model = this._reasoningModel; // need tier 5 users
            } */ else {
                model = this._model;
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
        console.log(`Validated Task ${taskNumber} Output:`, result);
        return result;
    }

    // Method to update the exploration graph and pass visualization data to SidebarView
    /* private updateGraphVisualization() {
        const graphData = this._explorationGraph.toVisualizationData();
        this._sidebarViewProvider.updateGraphVisualization(graphData); // Pass nodes and edges data directly
    }
 */
}