import * as vscode from 'vscode';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getQuestion, getCodeContext, preProcessCodeLine, getAccurateLineNumber } from './codeContextUtils';

// API key for OpenAI
const API_KEY = process.env.OPENAI_TOKEN;

// Maximum exploration steps to avoid infinite loop
const MAX_STEPS = 30;

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "search-copilot" is now active!');
    const disposable = vscode.commands.registerCommand('search-copilot.helloWorld', () => {
        askQuestionAboutCode();
    });
    context.subscriptions.push(disposable);
}

function askQuestionAboutCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const selection = editor.selection;

    // Get all selected lines, not just the start line
    const selectedText = editor.document.getText(selection);
    const startLine = selection.start.line;  // Use the start line for reference
    const endLine = selection.end.line;  // Use the end line for reference

    getQuestion(selectedText).then(query => {
        if (query === undefined) {
            return;
        }
        // Start the workflow by running task 1
        new Agent().runWorkflow(query, editor.document.uri, startLine, endLine);  // Pass the start line
    });
}

// Define the allowed VSCode tools for Task 1 and Task 4
const allowedTools = {
    "Find References": 0,
    "Go to Definition": 1,
    //"Go to Type Definition": 2,
    //"Go to Implementation": 3,
    //"Go to Symbol": 4,
    //"Open Symbol by Name": 5,
    //"Peek": 6,
    //"Find All References": 7,
    //"Call Hierarchy": 8,
    //"Search": 9
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
                            code_line: { type: "string" }  // Ensure code_line is a single line
                        },
                        required: ["file_uri", "invoke_variable", "code_line"]
                    },
                    num_results: { type: "integer" }
                },
                required: ["sub_question", "tool", "code_context", "num_results"]
            }
        }
    },
    required: ["refined_question", "sub_problems"]
};

// JSON Schema for Task 2 (Output)
const task2JsonSchema = {
    type: "object",
    properties: {
        processed_results: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    sub_question: { type: "string" },
                    filtered_results: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                file_uri: { type: "string" },
                                line_number: { type: "integer" },
                                code_line: { type: "string" },
                                explanation: { type: "string" }
                            },
                            required: ["file_uri", "line_number", "code", "explanation"]
                        }
                    },
                    status: { type: "string" },
                    message: { type: "string" },
                    suggestions: {
                        type: "array",
                        items: { type: "string" }
                    }
                },
                required: ["sub_question", "filtered_results", "status", "message", "suggestions"]
            }
        }
    },
    required: ["processed_results"]
};

const task3JsonSchema = {
    type: "object",
    properties: {
        final_decision_sufficient: { type: "boolean" }, // Changing to boolean
        final_answer: { type: "string" }, // If insufficient, provide the reason
        additional_requirements: { // If sufficient, this should be an empty array
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
                            code_line: { type: "string" },  // Ensure code_line is a single line
                            line_number: { type: "integer" }  // Accurate line number from Task 1
                        },
                        required: ["file_uri", "invoke_variable", "code_line", "line_number"]
                    },
                    num_results: { type: "integer" },
                    reason: { type: "string" }
                },
                required: ["sub_question", "tool", "code_context", "num_results"]
            }
        }
    },
    required: ["final_decision_sufficient", "final_answer", "additional_requirements"]
};

// The Agent class which interacts with the OpenAI API and handles the workflow
// The Agent class which interacts with the OpenAI API and handles the workflow
class Agent {
    private _model: ChatOpenAI;
    private _explorationHistory: any[] = []; // Stack to store exploration steps
    private _stepCounter: number = 0;
    private _refined_question: string | null = null;  // Store the refined question once it's generated

    constructor() {
        this._model = new ChatOpenAI({
            model: "gpt-4o-mini",
            apiKey: API_KEY,
        });
    }

    // The main workflow that runs tasks sequentially
    async runWorkflow(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        let sufficient = false;
        let refinedOutput;

        console.log(`Starting workflow with question: "${question}" at ${uri.toString()} on line ${startLine}` + (startLine !== endLine ? ` to ${endLine}` : ""));

        console.log(`Step ${this._stepCounter}: Running Task 1`);

        // Task 1: Refine the question and break it into sub-problems
        refinedOutput = await this.runTask1(question, uri, startLine, endLine);
        if (!refinedOutput || !refinedOutput.sub_problems) {
            console.error("Error: Task 1 did not return sub-problems.");
        }

        // Loop through until either sufficient result is found or max steps reached
        while (!sufficient && this._stepCounter < MAX_STEPS) {
            if (!refinedOutput || !refinedOutput.sub_problems) {
                console.error("Error: Task 3 did not return sub-problems.");
            }

            this._stepCounter++;

            // Task 2: Process each sub-problem and explore with VSCode API
            console.log(`Step ${this._stepCounter}: Running Task 2`);
            const task2Output = await this.runTask2(refinedOutput.sub_problems);
            if (!task2Output) {
                console.error("Error: Task 2 did not return filtered results.");
                break;
            }

            // Task 3: Decide if the answer is sufficient or requires more exploration
            console.log(`Step ${this._stepCounter}: Running Task 3`);
            const task3Output = await this.runTask3();
            sufficient = task3Output.final_decision_sufficient === true;
            refinedOutput = task3Output.additional_requirements;

            // Log task 3 output
            console.log(`Task 3 Output: ${JSON.stringify(task3Output, null, 2)}`);

            if (sufficient) {
                console.log(`Final Answer:\n${task3Output.final_answer}`);
                break;
            }
        }

        if (this._stepCounter >= MAX_STEPS) {
            console.log("Reached the maximum steps of exploration.");
        }
    }

    // Task 1: Refine question and break it into sub-problems
    async runTask1(question: string, uri: vscode.Uri, startLine: number, endLine: number) {
        const { contextText: codeContext, startContextLine } = await getCodeContext(uri, startLine, endLine);
        // Include the URI and line number in the input JSON
        const inputJson = {
            "task": 1,
            "question": question,
            "code_context": codeContext,
            "file_uri": uri.toString(),  // Include the correct file path (URI)
            "line_number": startLine,
            "allowed_tools": allowedTools
        };

        console.log(`Task 1 Input: ${JSON.stringify(inputJson)}`);

        const response = await this._callAgentAPI(inputJson, 1, task1JsonSchema);
        const task1Output = JSON.parse(response);

        // Log Task 1 output
        console.log(`Task 1 Output: ${JSON.stringify(task1Output)}`);

        // Store the refined question in the private field
        this._refined_question = task1Output.refined_question;

        // Iterate over sub-problems to compute accurate line numbers for the selected symbols
        for (const subProblem of task1Output.sub_problems) {
            if (uri) {
                subProblem.code_context.file_uri = uri.toString();
            }
            const invokeVariable = subProblem.code_context.invoke_variable;
            const codeLine = preProcessCodeLine(subProblem);

            // If we found a valid line with the invoke_variable, proceed with finding the accurate line number
            if (codeLine) {
                const accurateLineNumber = getAccurateLineNumber(codeContext, codeLine, startContextLine);

                if (accurateLineNumber !== null) {
                    subProblem.code_context.line_number = accurateLineNumber;
                    console.log(`Accurate line number for invoke_variable "${invokeVariable}" is: ${accurateLineNumber}`);
                } else {
                    console.error(`Failed to find accurate line number for invoke_variable "${invokeVariable}" in code_line: ${codeLine}`);
                }
            }
        }

        return task1Output;
    }

    async runTask2(subProblems: any[]) {
        interface SubProblem {
            sub_question: string;
            tool: number;
            code_context: {
                file_uri: string;
                invoke_variable: string;
                code_line: string; // Include the full code line from Task 1 response
                line_number: number; // Accurate line number calculated previously
            };
            num_results: number;
            results: any[];
        }

        const task2Input = {
            "task": 2,
            "refined_question": this._refined_question,  // Use the stored refined question
            "sub_problems": [] as SubProblem[],
            "exploration_history": this._explorationHistory
        };

        for (const subProblem of subProblems) {
            const variableName = subProblem.code_context.invoke_variable;
            const accurateLineNumber = subProblem.code_context.line_number; // Get the accurate line number
            const fileUri = vscode.Uri.parse(subProblem.code_context.file_uri); // Ensure we're using the correct file
            const codeLine = subProblem.code_context.code_line;  // Use the code line from the context

            console.log(`Processing sub-problem: ${subProblem.sub_question} using variable "${variableName}"`);
            console.log(`Code line: ${codeLine}`);
            console.log(`Accurate line number for "${variableName}": ${accurateLineNumber}`);

            // Calculate the offset of the variable within the code line
            const offset = codeLine.indexOf(variableName);
            console.log(`Offset for "${variableName}" in the code line: ${offset}`);

            if (offset !== -1) {
                const pos = new vscode.Position(accurateLineNumber, offset);
                const loc = new vscode.Location(fileUri, pos);

                // Create start and end positions, adjusting for the correct line and offset
                const startPos = new vscode.Position(accurateLineNumber, offset); // Start position at the offset
                const endPos = new vscode.Position(accurateLineNumber, offset + variableName.length); // End position covers the full variable

                // Create a range covering the entire variable
                const variableRange = new vscode.Range(startPos, endPos);
                const document = await vscode.workspace.openTextDocument(fileUri);  // Open the document
                const rangeText = document.getText(variableRange);  // Get the text from the range

                // Log the calculated range and the corresponding text
                console.log(`Double check whether ${rangeText} is the variable "${variableName}"`);

                // Execute VSCode API commands based on the tool selected
                let results = [];
                if (subProblem.tool === allowedTools["Find References"]) {
                    console.log(`Finding references for "${variableName}"`);
                    const referenceLocations = await vscode.commands.executeCommand(
                        'vscode.executeReferenceProvider', loc.uri, loc.range.start
                    );
                    console.log(`Reference locations found: ${JSON.stringify(referenceLocations)}`);
                    results = this._prepareResults(referenceLocations as vscode.Location[] | vscode.LocationLink[], subProblem);
                } else if (subProblem.tool === allowedTools["Go to Definition"]) {
                    console.log(`Going to definition for "${variableName}"`);
                    const definitionLocations = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
                        'vscode.executeDefinitionProvider', loc.uri, loc.range.start
                    );
                    console.log(`Definition locations found: ${JSON.stringify(definitionLocations)}`);
                    results = this._prepareResults(definitionLocations, subProblem);
                }

                if (results.length === 0) {
                    console.warn(`No results were found for sub-problem "${subProblem.sub_question}" and variable "${variableName}".`);
                }

                // Add the exploration results to the task input
                task2Input.sub_problems.push({
                    sub_question: subProblem.sub_question,
                    tool: subProblem.tool,
                    code_context: subProblem.code_context,
                    num_results: subProblem.num_results, // Number of results to be selected by the agent
                    results: results
                });
            } else {
                console.error(`Variable "${variableName}" not found in the code line: ${codeLine}`);
            }
        }

        console.log(`Task 2 Input: ${JSON.stringify(task2Input, null, 2)}`);

        // Call the agent to filter and rank the results
        const response = await this._callAgentAPI(task2Input, 2, task2JsonSchema);
        const task2Output = JSON.parse(response);

        // Log task 2 output
        console.log(`Task 2 Output: ${JSON.stringify(task2Output, null, 2)}`);

        // Update exploration history immediately after Task 2
        this._explorationHistory.push(...task2Output.processed_results);

        return task2Output;  // Return the filtered and ranked results
    }

    _prepareResults(locations: vscode.Location[] | vscode.LocationLink[], subProblem: any) {
        const results: any[] = [];
        if (!locations || locations.length === 0) {
            console.warn(`No locations found for sub-problem: ${subProblem.sub_question}`);
            return results; // Return empty if no locations are found
        }
        locations.forEach((location: vscode.Location | vscode.LocationLink) => {
            const lineNumber = location instanceof vscode.Location ? location.range.start.line : (location as vscode.LocationLink).targetRange.start.line;
            const fileUri = location instanceof vscode.Location ? location.uri.toString() : (location as vscode.LocationLink).targetUri.toString(); // Handle multiple files here

            // Log result details
            console.log(`Result found at file: ${fileUri}, line: ${lineNumber}`);

            // Prepare the results using the correct file path (Uri) and line number
            results.push({
                file_uri: fileUri,  // Correct Uri for the result's file
                line_number: lineNumber,  // Line number in the target file
                code_line: fileUri
            });
        });

        return results;
    }

    // Task 3: Decide if the question is sufficiently answered and propose new sub-questions if necessary
    async runTask3() {
        const inputJson = {
            "task": 3,
            "refined_question": this._refined_question ?? "",
            "exploration_history": this._explorationHistory  // Include the exploration history for exploration purposes
        };

        console.log("Task 3 Input:\n", JSON.stringify(inputJson));

        const response = await this._callAgentAPI(inputJson, 3, task3JsonSchema);
        const task3Output = JSON.parse(response);

        // Log task 3 output
        console.log("Task 3 Output:\n", JSON.stringify(task3Output, null, 2));

        return task3Output;
    }

    async _callAgentAPI(inputJson: any, taskNumber: number, selectedSchema: any): Promise<string> {
        let taskInstructions = "";

        // Add task-specific instructions based on the task number
        switch (taskNumber) {
            case 1:
                taskInstructions = `
                    Task 1: Refine the user's question and break it into actionable sub-questions using VSCode tools.
                    Ensure that each sub-question can be answered using a single VSCode tool from the following list by providing the corresponding integer value:
                    - 0: Find References
                    - 1: Go to Definition
                    
                    When specifying the 'code_line', only include the specific line of code that contains the 'invoke_variable'. 
                    The 'code_line' should not span multiple lines, and must include the exact line that contains the 'invoke_variable' being explored.

                    The output format should strictly follow the JSON schema provided, where the tool should be represented as an integer.
                `;
                break;
            case 2:
                taskInstructions = `
                    Task 2: Filter and rank the exploration results for each sub-question.
                    Pick the most relevant results (up to num_results) for each sub-question based on their usefulness in answering the refined question.
                    Ensure that the output follows the provided JSON schema for processed results, which should include file uri, line number, code, and explanation.
                `;
                break;
            case 3:
                taskInstructions = `
                    Task 3: Assess whether the refined question has been sufficiently answered based on the processed results.
                    If the question is sufficiently answered, set "final_decision_sufficient" to true.
                    Provide an insightful and beginner-friendly explanation in the "final_answer" to help the user understand how the question was addressed.
            
                    If the question is not sufficiently answered, set "final_decision_sufficient" to false and propose additional sub-questions that can further explore the question.
            
                    When proposing sub-questions:
                    - For each sub-question, check the exploration history (provided in the input) to see if there are any starting points (code contexts) already identified in the history that can be used to explore the sub-question.
                    - If a valid starting point is found, reuse it and include the file, invoke_variable, and code_line in the output.
                    - If no valid starting point exists in the exploration history, leave the code_context empty for that sub-question.
            
                    The output format must strictly follow the provided JSON schema:
                    - "final_decision_sufficient" should be a boolean indicating whether the question was fully answered.
                    - "final_answer" should be a clear explanation if the question was sufficiently answered.
                    - "additional_requirements" should contain any sub-questions and code contexts for further exploration if the question was not sufficiently answered.
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

        // Incorporating the prompt with task-specific instructions
        const systemMessage = new SystemMessage(`
            You are Agent 0, an assistant designed to help users explore and understand codebases by performing tasks using VSCode tools. 
            Your role depends on the task in the input, and you must carefully follow task-specific instructions and formats.
    
            ${taskInstructions}
            
            Ensure that your output matches the provided JSON schema.
        `);

        const prompt = JSON.stringify(inputJson); // Create a JSON-based prompt
        const messages = [
            systemMessage, // Include the system message for the agent's role
            new HumanMessage(prompt)  // Pass the task-specific JSON as a HumanMessage
        ];

        // Call the OpenAI model with response_format included, and wrap the schema inside the `schema` field
        const result = await this._model.invoke(messages, {
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: `task_${taskNumber}_schema`, // Name the schema based on the task number
                    schema: selectedSchema  // Wrap the schema inside the `schema` field
                }
            }
        });

        const parser = new StringOutputParser();
        const response = await parser.invoke(result);

        return response;  // Return the raw response as string
    }
}

// Deactivate the extension
export function deactivate() { }