import * as vscode from 'vscode';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { SidebarView } from './SideBarView';

// API key for OpenAI
const API_KEY = process.env.OPENAI_TOKEN;

if (!API_KEY) {
    console.error("OpenAI API Key is missing. Please set the OPENAI_TOKEN environment variable.");
}

export function activate(context: vscode.ExtensionContext) {
    // Register the command to ask a question about code
    // Initialize the SidebarView with only the context
    const sidebarViewProvider = new SidebarView(context);

    // Register the webview provider for the sidebar
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebarViewProvider)
    );

    // Register the command to ask a question about code
    const disposable = vscode.commands.registerCommand('search-copilot.helloWorld', () => {
        askQuestionAboutCode(context, sidebarViewProvider); // Pass the SidebarView instance
    });
    context.subscriptions.push(disposable);
}

export async function getQuestion(code: string) {
    return vscode.window.showInputBox({
        placeHolder: "What do you want to ask about this code?",
        prompt: `The line of code is ${code}`
    });
}

async function askQuestionAboutCode(context: vscode.ExtensionContext, sidebarViewProvider: SidebarView) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const selection = editor.selection;

    // Get the selected lines, fallback to the current line if no selection is made
    let selectedText = editor.document.getText(selection);
    if (selection.isEmpty) {
        selectedText = editor.document.lineAt(selection.start.line).text;
    }

    const startLine = selection.start.line;
    const endLine = selection.end.line;

    // Call getQuestion to display input box to the user
    const query = await getQuestion(selectedText); // The input box appears here

    if (query === undefined) {
        return; // User canceled the input box
    }

    // Update the sidebar view content with the user question and selected code
    sidebarViewProvider.updateWebviewContent(query, selectedText);

    // Show the sidebar automatically once the question is received
    vscode.commands.executeCommand('workbench.view.extension.search-copilot-sidebar').then(() => {
        // Start the agent to handle exploration
        new Agent(sidebarViewProvider).runWorkflow(query, editor.document.uri, startLine, endLine);
    });
}

export async function getSurroundingCode(uri: vscode.Uri, startLine: number, endLine: number): Promise<{ contextText: string, startContextLine: number }> {
    const document = await vscode.workspace.openTextDocument(uri);
    const totalLines = document.lineCount;

    const startContextLine = Math.max(0, startLine - 3);
    const endContextLine = Math.min(totalLines - 1, endLine + 3);

    const range = new vscode.Range(startContextLine, 0, endContextLine, document.lineAt(endContextLine).text.length);
    const contextText = document.getText(range);

    return {
        contextText,
        startContextLine
    };
}

export function getAccurateLineNumber(context: string, selectedCodeLine: string, startLineOfContext: number): number | null {
    const contextLines = context.split('\n');
    //console.log("Context: " + context);
    //console.log(`Start line of context: ${startLineOfContext}`);

    for (let i = 0; i < contextLines.length; i++) {
        const lineText = contextLines[i].trim();
        if (lineText === selectedCodeLine.trim()) {
            const accurateLineNumber = startLineOfContext + i;
            //console.log(`Selected code line found in context at line ${accurateLineNumber}`);
            return accurateLineNumber;
        }
    }
    console.error(`Code line "${selectedCodeLine}" not found in the provided context: ${context}`);
    return null;
}

/**
 * Searches for the offset of the variable name in the document around the specified line number.
 * Handles the case where line numbers may be slightly off, or there are indentations.
 * @param document - The document to search in.
 * @param variableName - The name of the variable to search for.
 * @param startLine - The line number to start searching from.
 * @param range - How many lines before and after the start line to search.
 * @returns An object containing the line number and offset of the variable, or null if not found.
 */
async function searchVariableOffset(
    document: vscode.TextDocument,
    variableName: string,
    startLine: number,
    range: number = 10
): Promise<{ line: number, offset: number } | null> {
    const totalLines = document.lineCount;

    // Search around the startLine (above and below within the given range)
    for (let i = -range; i <= range; i++) {
        const currentLine = startLine + i;

        // Ensure the line is within the document bounds
        if (currentLine >= 0 && currentLine < totalLines) {
            const lineText = document.lineAt(currentLine).text;

            // Search for the variable name in the current line
            const offset = lineText.indexOf(variableName);
            if (offset !== -1) {
                //console.log(`Found variable "${variableName}" at line ${currentLine}, offset ${offset}`);
                return { line: currentLine, offset: offset };
            }
        }
    }

    // If the variable wasn't found, return null
    console.error(`Variable "${variableName}" not found in the document.`);
    return null;
}

export function preProcessCodeLine(subProblem: any, surroundingCode: string): string | null {
    const codeLine = subProblem.code_context.code_line;
    const invokeVariable = subProblem.code_context.invoke_variable;

    const codeLineParts = codeLine.split("\n").map((line: string) => line.trim()).filter((line: string) => line.length > 0);

    for (const line of codeLineParts) {
        if (line.includes(invokeVariable)) {
            return line;
        }
    }

    console.warn(`invoke_variable "${invokeVariable}" not found in code_line. Falling back to surrounding code.`);

    const surroundingCodeParts = surroundingCode.split("\n").map((line: string) => line.trim()).filter((line: string) => line.length > 0);

    for (const line of surroundingCodeParts) {
        if (line.includes(invokeVariable)) {
            //console.log(`invoke_variable "${invokeVariable}" found in surrounding code.`);
            return line;
        }
    }

    console.error(`No line containing invoke_variable "${invokeVariable}" found in code_line or surrounding_code.`);
    return null;
}

export async function getDestructuringAssignment(document: vscode.TextDocument, startLine: number): Promise<string> {
    const totalLines = document.lineCount;
    let start = startLine;
    let end = startLine;

    // If the line contains ";", return the range of the line as is
    if (document.lineAt(startLine).text.includes(';')) {
        return document.lineAt(startLine).text;
    }

    let openBracesCount = 0;
    let foundStartBrace = false;

    const countBraces = (lineText: string) => {
        let open = 0, close = 0;
        for (const char of lineText) {
            if (char === '{') open++;
            if (char === '}') close++;
        }
        return { open, close };
    };

    while (start >= 0) {
        const lineText = document.lineAt(start).text;
        const { open, close } = countBraces(lineText);
        openBracesCount += open - close;

        if (openBracesCount > 0 && lineText.includes('{')) {
            foundStartBrace = true;
            break;
        }
        start--;
    }

    if (!foundStartBrace) {
        return document.lineAt(startLine).text;
    }

    openBracesCount = 0;

    while (end < totalLines) {
        const lineText = document.lineAt(end).text;
        const { open, close } = countBraces(lineText);
        openBracesCount += open - close;

        if (openBracesCount === 0 && lineText.includes('}')) {
            break;
        }
        end++;
    }

    const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
    return document.getText(range);
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
                    num_results: { type: "integer" }
                },
                required: ["sub_question", "tool", "code_context", "num_results"]
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
                                explanation: { type: "string" }
                            },
                            required: ["file_uri", "code_line", "line_number", "full_statement", "explanation"]
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
        final_answer: { type: "string" },
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
                    num_results: { type: "integer" },
                    reason: { type: "string" }
                },
                required: ["sub_question", "tool", "code_context", "num_results", "reason"]
            }
        }
    },
    required: ["final_decision_sufficient", "final_answer", "sub_problems"]
};

class Agent {
    private _model: ChatOpenAI;
    private _explorationHistory: any[] = [];
    private _stepCounter: number = 0;
    private _refined_question: string | null = null;
    private _sidebarViewProvider: SidebarView; // Add a reference to the SidebarView

    constructor(sidebarViewProvider: SidebarView) { // Pass in the sidebar view provider
        this._model = new ChatOpenAI({
            model: "gpt-4o-mini",
            apiKey: API_KEY,
        });
        this._sidebarViewProvider = sidebarViewProvider;
    }

    // Main workflow method to run all tasks
    async runWorkflow(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        const MAX_STEPS = 30;
        let sufficient = false;
        let refinedOutput;

        this._sidebarViewProvider.agentIsRunning();

        //console.log(`Starting workflow with question: "${question}" at ${uri.toString()} on line ${startLine}` + (startLine !== endLine ? ` to ${endLine}` : ""));

        // Start Task 1 and update the sidebar with the results
        //console.log(`Step ${this._stepCounter}: Running Task 1`);
        refinedOutput = await this.runTask1(question, uri, startLine, endLine);

        // Update sidebar after Task 1 completes
        if (!refinedOutput) {
            console.error("Error: Task 1 did not return sub-problems.");
        }

        // Continue with Task 2 and Task 3 if necessary
        while (!sufficient && this._stepCounter < MAX_STEPS) {
            if (!refinedOutput || !refinedOutput.sub_problems) {
                console.error("Error: Task 3 did not return sub-problems.");
            }

            this._stepCounter++;

            // Start Task 2
            //console.log(`Step ${this._stepCounter}: Running Task 2`);
            await this.runTask2(refinedOutput.sub_problems);

            // Start Task 3
            //console.log(`Step ${this._stepCounter}: Running Task 3`);
            const task3Output = await this.runTask3(uri);

            sufficient = task3Output.final_decision_sufficient === true;
            refinedOutput = task3Output;

            //console.log(`Task 3 Output: ${JSON.stringify(task3Output, null, 2)}`);

            if (sufficient) {
                //console.log(`Final Answer:\n${task3Output.final_answer}`);
                break;
            }
        }

        this._sidebarViewProvider.agentIsDone();

        if (this._stepCounter >= MAX_STEPS) {
            //console.log("Reached the maximum steps of exploration.");
        }
    }

    async runTask1(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
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

        const document = await vscode.workspace.openTextDocument(uri);

        for (const subProblem of task1Output.sub_problems) {
            if (uri) {
                subProblem.code_context.file_uri = uri.toString();
            }

            const invokeVariable = subProblem.code_context.invoke_variable;
            const codeLine = preProcessCodeLine(subProblem, surroundingCode);

            if (codeLine) {
                const accurateLineNumber = getAccurateLineNumber(surroundingCode, codeLine, startContextLine);

                if (accurateLineNumber !== null) {
                    subProblem.code_context.line_number = accurateLineNumber;
                    //console.log(`Accurate line number for invoke_variable "${invokeVariable}" is: ${accurateLineNumber}`);

                    const fullStatement = await getDestructuringAssignment(document, accurateLineNumber);
                    subProblem.code_context.full_statement = fullStatement;
                } else {
                    console.error(`Failed to find accurate line number for invoke_variable "${invokeVariable}" in code_line: ${codeLine}`);
                }
            } else {
                console.error(`preProcessCodeLine failed for sub_problem "${subProblem.sub_question}".`);
            }
        }

        console.log(`Task 1 Results: ${JSON.stringify(task1Output, null, 2)}`);

        // Update the sidebar view with Task 1 results after processing
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider.addTask1Results(task1Output);  // Add the Task 1 results to the sidebar
        }

        return task1Output;
    }

    async runTask2(subProblems: any[]) {
        console.warn("Running Task 2");
        interface SubProblem {
            sub_question: string;
            tool: number;
            code_context: {
                file_uri: string;
                invoke_variable: string;
                code_line: string;
                line_number: number;
            };
            num_results: number;
            results: any[];
        }

        const task2Input = {
            "task": 2,
            "refined_question": this._refined_question,
            "questions_and_results": [] as SubProblem[]
        };

        const task2Results: any[] = []; // A unified structure to store all results

        for (const subProblem of subProblems) {
            const variableName = subProblem.code_context.invoke_variable;
            const initialLineNumber = subProblem.code_context.line_number;
            const fileUri = vscode.Uri.parse(subProblem.code_context.file_uri);

            //console.log(`Processing sub-problem: ${subProblem.sub_question} using variable "${variableName}"`);
            //console.log(`Initial line number for "${variableName}": ${initialLineNumber}`);

            // Open the document at the specified fileUri
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Use the helper function to find the variable's offset in the document
            const offsetResult = await searchVariableOffset(document, variableName, initialLineNumber);

            if (offsetResult) {
                const { line, offset } = offsetResult;
                //console.log(`Found variable "${variableName}" at line ${line}, offset ${offset}`);

                // Create the position and location for further exploration
                const pos = new vscode.Position(line, offset);
                const loc = new vscode.Location(fileUri, pos);

                // Execute VSCode API commands based on the selected tool
                let results = [];
                if (subProblem.tool === 1) {
                    //console.log(`Finding references for "${variableName}"`);
                    const referenceLocations = await vscode.commands.executeCommand(
                        'vscode.executeReferenceProvider', loc.uri, loc.range.start
                    );
                    //console.log(`Reference locations found: ${JSON.stringify(referenceLocations)}`);
                    results = await this._prepareResults(referenceLocations as vscode.Location[] | vscode.LocationLink[], subProblem);
                } else if (subProblem.tool === 0) {
                    //console.log(`Going to definition for "${variableName}"`);
                    const definitionLocations = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
                        'vscode.executeDefinitionProvider', loc.uri, loc.range.start
                    );
                    //console.log(`Definition locations found: ${JSON.stringify(definitionLocations)}`);
                    results = await this._prepareResults(definitionLocations, subProblem);
                }

                if (results.length === 0) {
                    console.warn(`No results were found for sub-problem "${subProblem.sub_question}" and variable "${variableName}".`);
                }

                // Define the structure of eachSubProblem
                const eachSubProblem: any = {
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    num_results: subProblem.num_results,
                };

                // Store results in the final unified structure for the sidebar
                if (results.length > subProblem.num_results && subProblem.num_results > 0) {
                    // Add "results" key if more results need to be processed by the agent
                    eachSubProblem["results"] = results;
                    task2Input.questions_and_results.push(eachSubProblem);  // Add to task2Input for agent processing
                } else {
                    // Add "filtered_results" key otherwise and push directly to task2Results
                    eachSubProblem["filtered_results"] = results;
                    task2Results.push(eachSubProblem);
                }
            } else {
                console.error(`Variable "${variableName}" not found near line ${initialLineNumber}.`);
            }
        }

        // Process sub-problems with the agent if necessary
        if (task2Input.questions_and_results.length > 0) {
            //console.log(`Task 2 Input for agent processing: ${JSON.stringify(task2Input, null, 2)}`);

            const response = await this._callAgentAPI(task2Input, 2, task2JsonSchema);
            const task2Output = JSON.parse(response);

            //console.log(`Task 2 Output from agent: ${JSON.stringify(task2Output, null, 2)}`);

            // Add agent-processed results to the final structure
            if (Array.isArray(task2Output.questions_and_results)) {
                task2Results.push(...task2Output.questions_and_results);
            } else if (typeof task2Output.questions_and_results === 'object') {
                task2Results.push(task2Output.questions_and_results);
            } else {
                console.error("questions_and_results is neither an array nor an object:", task2Output.questions_and_results);
            }
        }

        // Once all results are gathered, add them to the exploration history and update the sidebar
        this._explorationHistory.push(...task2Results);

        console.log(`Task 2 Results: ${JSON.stringify(task2Results, null, 2)}`);

        // Update the sidebar with the full Task 2 results
        if (this._sidebarViewProvider) {
            this._sidebarViewProvider.addTask2Results({ questions_and_results: task2Results });  // Update sidebar with Task 2 results
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

            results.push({
                file_uri: fileUri,
                line_number: lineNumber,
                code_line: document.lineAt(lineNumber).text.trim(),
                full_statement: fullStatement
            });
        }

        return results;
    }

    async runTask3(uri: vscode.Uri) {
        console.warn("Running Task 3");
        // Create a clean exploration history without explanations for Task 3 input
        const cleanExplorationHistory = this._explorationHistory.map((entry: any) => {
            // For each sub-problem, map the filtered results and remove the explanation
            return {
                sub_question: entry.sub_question,
                filtered_results: entry.filtered_results.map((result: any) => ({
                    file_uri: result.file_uri,
                    code_line: result.code_line,
                    line_number: result.line_number,
                    full_statement: result.full_statement
                }))
            };
        });

        // Prepare the input JSON for Task 3, using the cleaned exploration history
        const inputJson = {
            "task": 3,
            "refined_question": this._refined_question ?? "",
            "exploration_history": cleanExplorationHistory  // Include the cleaned exploration history
        };

        //console.log("Task 3 Input:\n", JSON.stringify(inputJson));

        const response = await this._callAgentAPI(inputJson, 3, task3JsonSchema);
        const task3Output = JSON.parse(response);

        console.log(`Task 3 Results: ${JSON.stringify(task3Output, null, 2)}`);

        // Handle sub-problems that have no valid starting points
        for (const subProblem of task3Output.sub_problems) {
            if (Object.keys(subProblem.code_context).length === 0) {
                console.log(`No starting point found for sub-question: ${subProblem.sub_question}`);
            }
        }

        if (this._sidebarViewProvider) {
            this._sidebarViewProvider.addTask3Results(task3Output);
        }

        return task3Output;
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
                `;
                break;
            case 2:
                taskInstructions = `
                    Task 2: Filter and rank the exploration results for each sub-question.
                    Pick the most relevant results (up to num_results) for each sub-question based on their usefulness in answering the refined question.
                    Ensure that the output follows the provided JSON schema for questions_and_results, which should include file uri, line number, code, and explanation.
                `;
                break;
            case 3:
                taskInstructions = `
                    Task 3: Assess whether the refined question has been sufficiently answered based on the questions_and_results.
                    If the question is sufficiently answered, set "final_decision_sufficient" to true.
                    Provide an insightful and beginner-friendly explanation in the "final_answer" to help the user understand how the question was addressed.

                    If the question is not sufficiently answered, set "final_decision_sufficient" to false and propose additional sub-questions that can further explore the question.

                    When proposing sub-questions:
                    - **Do not generate hypothetical code contexts.** You must use existing code contexts from the exploration history or real code from the provided file.
                    - First, check the exploration history (provided in the input) to see if there are any starting points (code contexts) already identified in the history that can be used to explore the sub-question.
                    - If no valid starting point is found from the exploration history, use the full file content (provided in the input) to search for relevant code areas that may help explore the sub-question.
                    - Include the file, invoke_variable, code_line, and full_statement in the output for each sub-question with a valid starting point.
                    - If no relevant code is found in the file, leave the code_context empty for that sub-question. 

                    The output format must strictly follow the provided JSON schema:
                    - "final_decision_sufficient" should be a boolean indicating whether the question was fully answered.
                    - "final_answer" should be a clear explanation if the question was sufficiently answered.
                    - "sub_problems" should contain any sub-questions and code contexts for further exploration if the question was not sufficiently answered.
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
            - Ensure Thorough Exploration: Strive to explore the codebase deeply enough to fully answer the refined question. Consider related functions, classes, or files that may be necessary to examine. 
            - Generate Additional Sub-Questions When Necessary: If initial explorations are insufficient, create further sub-questions to delve deeper into the code.
            - Avoid Redundancy: Always consider the exploration_history to prevent redundant efforts.
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

        return response;
    }
}

export function deactivate() { }