import * as vscode from 'vscode';
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { SidebarView } from './SideBarView';
import { test, getLineText, getSurroundingCode, getLineNumber, getFileNameFromUri, getLineTextFromRange, getAccurateLineNumber, searchVariableOffset, preProcessCodeLine, analyze, findCompleteStatementText } from './codeContextUtils';
import { ExplorationGraph, Node, Edge, TreeNode } from './explorationGraph';

// API key for OpenAI
const API_KEY = process.env.OPENAI_TOKEN;

if (!API_KEY) {
    console.error("OpenAI API Key is missing. Please set the OPENAI_TOKEN environment variable.");
}

export function activate(context: vscode.ExtensionContext) {
    test();
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
        }),
        vscode.commands.registerCommand('extension.followUpQuestion', (userInput, fileUri, lineNumber, variable) => {
            agent.followUpQuestion(userInput, fileUri, lineNumber, variable);
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

const task4Schema = z.object({
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
    final_decision_sufficient: z.boolean(),
    answer: z.object({
        Overview: z.string(), // High-level summary of the question and findings.
        Lifecycle: z.array(
            z.object({
                insightName: z.string(), // Name of the lifecycle stage or behavior.
                details: z.string(), // Explanation of the stage's role or function.
                reference: z.string(),
            })
        ),
        Practical_Insights: z.string(), // Summary of best practices, tips, or pitfalls.
    })
}).strict();

class Agent {
    private _model: ChatOpenAI;
    private _fasterModel: ChatOpenAI;
    private _reasoningModel: ChatOpenAI;
    private _openai: OpenAI;
    private _stepCounter: number = 0;
    private _question: string = "";
    private _refined_question: string | null = null;
    private _numberOfVariablesThreshold: number = 15; // If the collection of variables is less than this threshold, explore them directly without using LLMs to choose the next steps
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

        this._reasoningModel = new ChatOpenAI({
            model: "o1-mini",
            apiKey: API_KEY,
            maxTokens: 128000,
            temperature: 1.0,
            topP: 1,
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
    }

    stop() {
        this.isPaused = false;
        this.isStopped = true;
    }

    followUpQuestion(userInput: string, fileUri: string, lineNumber: number, variable: string) {
        this.isPaused = false;
        this._final_decision_sufficient = false;
        this._question += " " + userInput;
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider.updatetitleQuestion(this._question);
        }
        this._followUpBranchNodeId = `${fileUri}:${lineNumber}:${variable}`;
        this.runWorkflow(this._question, vscode.Uri.parse(fileUri), lineNumber, lineNumber);
    }

    async runWorkflow(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        this._question = question;

        const MAX_STEPS = 30;
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
        }
    }

    async runTask1(uri: vscode.Uri, startLine: number, endLine: number) {
        console.warn("Running Task 1");
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
        const codeSentences = surroundingCode.split(";");
        codeSentences.forEach(async (sentence, index) => {
            const extractedVariables = await analyze(uri, sentenceStartLineNum);
            const { statementText, startLineNum, endLineNum } = await findCompleteStatementText(uri, sentenceStartLineNum);
            const codeLines = sentence.split("\n");
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

            codeLines.forEach(async (codeLine, index) => {
                const lineNum = sentenceStartLineNum + index;
                // get the variables with the same line number
                const variables = extractedVariables.filter((variableInfo: any) => variableInfo.lineNumber === lineNum).map((variableInfo: any) => variableInfo.variable);
                codeContext.push({
                    file_uri: fileUriString,
                    line_number: lineNum,
                    code_line: codeLine,
                    variables: new Set(variables)
                });
            });
            this._addOrUpdateExploredCodeLines(fileUriString, startLineNum, endLineNum, statementText, variables);
            sentenceStartLineNum += codeLines.length;
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
        this._refined_question += task1Output.refined_question;

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
        console.warn("Running Task 2, processing ", subProblems.length, " sub-problems: ", subProblems);

        /* const task2Input: any = {
            task: 2,
            refined_question: this._refined_question,
            questions_and_results: [] // Only includes sub-problems that need further filtering by the agent
        }; */

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
            const results = await this._runTool(fileUri, lineNumber, offset, subProblem);

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
        let newVariables = [];
        let variableCount = 0;
        let nextExploreVariables = [];
        for (const code of exploredCode) {
            for (const variable of code.variables) {
                if (code.code_snippet == "") {
                    console.error("Code snippet is empty for variable: ", code);
                }
                const accurateLineNumber = getLineNumber(code.code_snippet, variable, code.start_line);
                const existingVariables = this._exploredVariables.filter(
                    v => v.invoke_variable === variable && v.line_number === accurateLineNumber && v.file_uri === code.file_uri
                );
                const lineText = await getLineText(vscode.Uri.parse(code.file_uri), accurateLineNumber ?? code.start_line);
                let toolsUsed: number[] = [];
                if (existingVariables) {
                    // Determine which tools have been used
                    const toolsUsed = new Set(existingVariables.map(v => v.tool));

                    // If both tools have been used, skip this variable
                    if (toolsUsed.has(0) && toolsUsed.has(1)) {
                        continue;
                    }
                }

                // If only one tool has been used, return the other tool
                if (!toolsUsed.includes(1)) {
                    nextExploreVariables.push({
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
                    });
                }
                if (!toolsUsed.includes(0)) {
                    nextExploreVariables.push({
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
                    });
                }

                variableCount++;
                newVariables.push({
                    file_uri: code.file_uri,
                    line_number: accurateLineNumber ?? code.start_line,
                    code_line: lineText,
                    variable: variable
                });
            }
        }

        return { newVariables, variableCount, nextExploreVariables };
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

        const { newVariables, variableCount, nextExploreVariables } = await this.filterInput(this._newExploredCodeLines);

        // If there are no new code lines to explore, directly run Task 4
        if (variableCount === 0) {
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
            if (variableCount <= this._numberOfVariablesThreshold) {
                task3Output.sub_problems = nextExploreVariables;

            } else {
                const inputJson = {
                    task: 3,
                    refined_question: this._refined_question ?? "",
                    variables_wait_for_exploring: newVariables
                };

                const response = await this._callAgentAPI(inputJson, 3, task3Schema);
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
        console.log("Task 3 output: ", task3Output);
        return task3Output;
    }

    async runTask4() {
        // check each variable in this._exploredCodeLines whether it has been explored in this._exploredVariables
        let task4Output: {
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
        const filterResult = await this.filterInput(this._exploredCodeLines);
        let { newVariables, variableCount, nextExploreVariables } = filterResult;


        if (variableCount > 0 && variableCount <= this._numberOfVariablesThreshold) {
            task4Output.sub_problems = nextExploreVariables;
        } else {
            console.warn("Running task 4, evaluating ", variableCount, " variables.");

            const inputJson = {
                task: 4,
                refined_question: this._refined_question ?? "",
                variables_wait_for_exploring: newVariables,
            };

            const response = await this._callAgentAPI(inputJson, 4, task4Schema);

            // Validate JSON format
            let agentOutput;
            try {
                agentOutput = JSON.parse(response);
            } catch (e) {
                console.error("Failed to parse JSON response for task 4:", e, response);
                return [];
            }

            task4Output = await this.processTask3andTask4Output(agentOutput);
        }
        console.log("Task 4 output: ", task4Output);
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

        const response = await this._callAgentAPI(inputJson, 5, task5Schema);
        const task5Output = JSON.parse(response);
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

            const nodeId = this._explorationGraph.findNodeByLine(result.file_uri, result.line_number);
            if (nodeId === null) {
                console.error(`Node ID not found for line ${result.line_number} in ${result.file_uri}`);
                return {};
            } else {
                nodeIds[snippetKey] = {
                    nodeID: nodeId,
                    statement: result.finding ?? result.explanation
                };
            }

            // Find the path for this variable only if not already stored
            if (!this._importantCodePaths.has(pathId)) {

                const paths = this._explorationGraph.findShortestPathFromNode(nodeId);
                console.log("Paths for ", pathId, ": ", paths, " with node ID: ", nodeId);
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
            let [task7Output, task6Output] = await Promise.all([
                this.runTask7(),
                this.runTask6()
            ]);
            evaluationOutput = task7Output + task6Output;
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

        const response = await this._callAgentAPI(inputJson, 6, task6Schema);
        const task6Output = JSON.parse(response);

        if (!task6Output || !task6Output.filtered_findings) {
            console.error("Invalid output from task 6.");
            return "";
        }

        // Update the findings summary
        const updatedFindings = this.updateFindingsSummary(task6Output.filtered_findings);

        // Generate the HTML for the findings
        let concatenatedHtml = "Finding: <ul>";

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

        return concatenatedHtml + "</ul>";
    }

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
        const { Overview, Lifecycle, Practical_Insights } = task7Output.answer;

        // Helper functions for markdown processing
        const processMarkdown = (text: string): string => {
            // Handle headers
            text = text.replace(/^###\s*(.*)$/gm, (_, content) => `<h3>${content.trim()}</h3>`);
            text = text.replace(/^##\s*(.*)$/gm, (_, content) => `<h2>${content.trim()}</h2>`);
            text = text.replace(/^#\s*(.*)$/gm, (_, content) => `<h1>${content.trim()}</h1>`);

            // Handle bold (**content**)
            text = text.replace(/\*\*(.*?)\*\*/g, (_, content) => `<b>${content}</b>`);

            // Handle inline code (`content`)
            text = text.replace(/`([^`]*)`/g, (_, content) => `<span class="inline-code">${content}</span>`);

            // Handle line breaks (\n -> <br>)
            text = text.replace(/\n/g, "<br>");

            return text;
        };

        // Process the "Overview" section
        const processOverview = (overview: string): string => {
            return `<div class="overview"><h2>Overview</h2><p>${processMarkdown(overview)}</p></div>`;
        };

        // Process each insight in the "Lifecycle" section
        const processLifecycle = (lifecycle: Array<{ insightName: string; details: string; reference: string }>): string => {
            return lifecycle
                .map((insight) => {
                    insight.details = processMarkdown(insight.details);
                    // Extract snippetKey from reference
                    const snippetKeyMatch = insight.reference.match(/snippetKey:\s*(-?\d+)/);
                    const snippetKey = snippetKeyMatch ? parseInt(snippetKeyMatch[1], 10) : null;

                    // Find snippet data using the recursive traversal function
                    const snippetData = snippetKey !== null ? this.findSnippetBySnippetKey(snippetKey) : null;

                    // Add data attributes for fileUri and lineNumber
                    return `
                        <div class="insight" 
                            data-file-uri="${snippetData?.fileUri || ''}" 
                            data-line-number="${snippetData?.lineNumber || ''}" 
                            data-ref="${snippetKey}"
                            onmouseenter="hoverInsight(event)">
                            <h3>${insight.insightName}</h3>
                            <p>${insight.details}
                                [<span class="citation-ref" data-ref="${snippetKey}">${snippetKey}</span>]
                            </p>
                        </div>`;
                })
                .join("");
        };

        // Process the "Practical_Insights" section
        const processPracticalInsights = (insights: string): string => {
            return `<div class="practical-insights"><h2>Practical Insights</h2><p>${processMarkdown(insights)}</p></div>`;
        };

        // Add the lifecycle and practical insights container with toggle functionality
        const lifecycleAndInsightsContainer = `
            <div id="details-container" style="display: ${task7Output.final_decision_sufficient ? "block" : "none"};">
                <div class="lifecycle">
                    <h2>Lifecycle</h2>
                    ${processLifecycle(Lifecycle)}
                </div>
                ${processPracticalInsights(Practical_Insights)}
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
                <h1 style="font-weight: bold;">${task7Output.final_decision_sufficient ? "Final Answer" : "Preliminary Answer"}:</h1>
                ${processOverview(Overview)}
                ${toggleButton}
                ${lifecycleAndInsightsContainer}
            </div>
        `;

        return processedAnswer;
    }

    async runTask7() {
        console.warn("Running Task 7.");

        const inputJson = {
            task: 7,
            refined_question: this._refined_question ?? this._question,
            data_flow_tree: this._tree
        };

        const response = await this._callAgentAPI(inputJson, 7, task7Schema);
        const task7Output = JSON.parse(response);

        this._final_decision_sufficient = task7Output.final_decision_sufficient;

        return this.processFinalAnswer(task7Output);
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
                    Task 1: Refine the user's question and select valuable variables to explore to answer the question using VSCode tools.
                    And you can choose the tool from the following list by providing the corresponding integer value:
                    - 0: Go to Definition
                    - 1: Find References
                    
                    From the code_context, each item in the sub_problems array contains a code line with an array of variables in this line to explore.
                    Evaluate each variable in the variables array to determine whether it is valuable to explore to answer the question, and provide a reason for choosing the variable and tool.
                    The output format should strictly follow the JSON schema provided, where the tool should be represented as an integer.
                    Do not change the code_line.
                    
                    Output format for each variable if valuable 
                    sub_problems: [{
                        sub_question: "string" , // what is the sub-question can be answered by exploring the invoke_variable in the code line to answer the refined question
                        tool: "integer",
                        code_context: {
                            file_uri: "string", // directly reuse the content file_uri from code_context, do not change
                            invoke_variable: "string" , // must be one of the variables in the variables array
                            code_line: "string", // directly reuse the content from code_context, do not change
                            line_number: "integer", // directly reuse the content from code_context, do not change
                            full_statement: "string" // directly reuse the content from code_context, do not change
                        },
                        reason: "string" // For each sub-question, provide a clear and specific “reason” explaining the goal of exploring this sub-question. Describe exactly what we aim to uncover, such as particular methods, patterns, or code structures relevant to the exploration. Be as precise as possible in defining what we are looking for and why it is essential to the investigation.
                    }, ...]
                    
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
                    Task 3: Evaluate the variables_wait_for_exploring based on the refined question and determine the next steps for further exploration.

                    Instructions:

                    1. Input Evaluation:
                    - You are given a refined question and a list of variables_wait_for_exploring.
                    - Assess what variables in variables_wait_for_exploring are worth exploring next.

                    2. Output Requirements:
                    - Provide evaluations for each explored line:
                        - For each line, specify if it is valuable for further exploration. 
                        - Some lines may not be valuable for further exploration immediately but could be valuable later. So, try to mark all potentially valuable lines.
                        - If valuable, specify at least one variables from the variables array in the input variables_wait_for_exploring, the exploration tool, and a reason.
                        - Ensure at least one line is marked as valuable to explore next.
                        - Summarize the proposed next steps in "next_step_summary".

                    3. Line-by-Line Evaluation:
                    - For each variable in variables_wait_for_exploring:
                        - Specify whether the line is valuable for further exploration.
                        - If valuable:
                        - Identify the variable to explore next.
                        - Select the appropriate tool:
                            - 0: Go to Definition
                            - 1: Find References
                        - Provide a reason for choosing the variable and tool.

                    4. Output Format:

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
                    task 4: Evaluate the variables_wait_for_exploring based on the refined question and determine the next steps for further exploration.
    
                    Instructions:
    
                    1. Input Evaluation:
                    - You are given a refined question and a list of variables wait for exploring.
                    - Assess what variables are worth exploring next.
    
                    2. Output Requirements:
                    - Provide evaluations for each explored line:
                        - For each line, specify if it is valuable for further exploration.
                        - If valuable, specify at least one variables, the exploration tool, and a reason.
                        - Ensure at least one line is marked as valuable to explore next.
                        - Summarize the proposed next steps in "next_step_summary".
    
                    3. Line-by-Line Evaluation:
                    - For each variable in variables_wait_for_exploring:
                        - Specify whether the line is valuable for further exploration.
                        - If valuable:
                        - Identify the variable to explore next.
                        - Select the appropriate tool:
                            - 0: Go to Definition
                            - 1: Find References
                        - Provide a reason for choosing the variable and tool.
    
                    4. Output Format:
    
                    {
                        "evaluations": [ // Evaluations of variables wait for exploring
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
                    - Add the specific variable being tracked for this result under the "variable" field. Only select one variable. 
                        Important: The variable must be selected only from the "variables" array provided in the result. Do not use or infer any other variables.

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
                
                Output Format:
                {
                    "filtered_findings": [
                        {
                            "snippetKey": ["array of snippet keys"],
                            "statement": "Implementation-specific finding",
                            "outOfDate": boolean
                        }
                    ]
                }
                `;
                break;
            case 7:
                taskInstructions = `
                Task 7: Decide Sufficiency and Generate Answer

                Objective:
                1. Assess if the current findings and code exploration sufficiently answer the refined question.
                2. Generate a structured, evidence-based answer that includes lifecycle insights, practical tips, and clarity for developers.

                Input:
                1. refined_question: The question to answer (e.g., "What does this function do?", "Why is this parameter needed?", "How does this variable handle X?").
                2. data_flow_tree: A structured tree containing findings and associated code snippets.

                TreeNode = {
                    id: string;
                    snippetKey: number;
                    fileUri: string;
                    lineNumber: number;
                    variable: string;
                    codeLine: string;
                    codeSnippet: string; // 3 lines before and after the codeLine
                    isIntermediate: boolean;
                    statement: string; // findings extracted from this line of code
                    children: TreeNode[]; // Recursive definition
                };

                Instructions:

                1. Decide final_decision_sufficient:
                Evaluate if the current findings and data flow tree are enough to fully answer the refined question:
                - **Depth**: Are the explored code snippets detailed enough to address the question's scope (e.g., logic, behavior, dependencies)?
                - **Coverage**: Does the exploration include all relevant parts of the codebase (e.g., key functions, variables, structures) needed to answer the question?
                - **Clarity**: Is the data flow traceable, and are the findings coherent enough to form a beginner-friendly answer?

                Set:
                - **final_decision_sufficient**: true if all aspects are covered.
                - **final_decision_sufficient**: false if further exploration is needed, specifying:
                    - Missing areas (e.g., unexamined dependencies, unexplored control flows, or unclear logic).

                2. Generate Answer:
                Provide a structured, detailed answer object, whether or not findings are sufficient. The structure should include:
                - **Overview:** A concise summary of the code element's purpose and relevance to the question.
                - **Lifecycle:** An array of objects, each representing a lifecycle stage, behavior, or key relationship:
                   - **insightName:** Name of the lifecycle stage or behavior (e.g., "Initialization," "Mounting").
                   - **details:** A short explanation of the stage or behavior.
                   - **reference:** A single snippetKey reference ([snippetKey: number]) that supports the explanation.
                - **Practical_Insights:** A string summarizing best practices, tips, or common pitfalls relevant to the question.

                **Formatting and Reference Guidelines:**
                - **References to Code Snippets:** Each item in the Lifecycle section must include one and only one reference using [snippetKey: number].
                - **Bold Emphasis:** Highlight critical methods, variables, or concepts with **bold** text.
                - **Inline Code:** Use backticks (\`) for inline code elements.

                Output Format:
                {
                    "final_decision_sufficient": boolean,
                    "answer": {
                        "Overview": string, // High-level summary of the question and findings.
                        "Lifecycle": Array<{
                            insightName: string, // Name of the lifecycle stage or behavior.
                            details: string, // Explanation of the stage's role or function.
                            reference: string // Single code snippet reference in the form [snippetKey: number].
                        }>,
                        "Practical_Insights": string // Summary of best practices, tips, or pitfalls.
                    }
                }

                Checklist for Sufficiency:
                1. Are all relevant aspects of the refined question addressed (e.g., logic, dependencies, behavior)?
                2. Is the explanation clear, detailed, and well-supported by code snippets?
                3. Are key relationships, lifecycle stages, and logic paths traceable and easy to follow?
                4. Is the final answer concise, actionable, and suitable for both novice and experienced developers?
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
            if (taskNumber === 3 || taskNumber === 4 || taskNumber === 6 || taskNumber === 7) {
                model = this._model;
            } /* else if (taskNumber === 7) {
                model = this._reasoningModel; // need tier 5 users
            } */ else {
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

export function deactivate() { }