import * as vscode from 'vscode';

export async function getQuestion(code: string) {
    return vscode.window.showInputBox({
        placeHolder: "What do you want to ask about this code?", //How, concretely, does the "size" parameter affect the rendering of the circle progress component?
        prompt: `The line of code is ${code}`
    });
}

// Helper function to get the code context (3 lines before and after the selection)
export async function getCodeContext(uri: vscode.Uri, startLine: number, endLine: number): Promise<{ contextText: string, startContextLine: number }> {
    const document = await vscode.workspace.openTextDocument(uri);
    const totalLines = document.lineCount;

    // Determine the range of lines to extract (3 lines before the selection, 3 lines after)
    const startContextLine = Math.max(0, startLine - 3);  // Ensure we don't go before line 0
    const endContextLine = Math.min(totalLines - 1, endLine + 3);  // Ensure we don't go beyond the last line

    // Extract the text within the specified range
    const range = new vscode.Range(startContextLine, 0, endContextLine, document.lineAt(endContextLine).text.length);
    const contextText = document.getText(range);

    // Return both the extracted context and the start line of the context
    return {
        contextText,
        startContextLine
    };
}

/**
 * Function to get the accurate line number for the selected code line
 * @param context - The code context containing several lines of code
 * @param cursorLine - The line number where the cursor is located
 * @param selectedCodeLine - The full line of code selected by the agent
 * @returns The line number of the selected code line relative to the original file.
 */
export function getAccurateLineNumber(context: string, selectedCodeLine: string, startLineOfContext: number): number | null {
    // Split the context into lines
    const contextLines = context.split('\n');
    console.log("Context: " + context);

    // Calculate the starting line number of the context
    console.log(`Start line of context: ${startLineOfContext}`);

    // Iterate over each line in the context to find the selected code line
    for (let i = 0; i < contextLines.length; i++) {
        const lineText = contextLines[i].trim();

        // Check if the line matches the selected code line exactly (ignoring leading/trailing spaces)
        if (lineText === selectedCodeLine.trim()) {
            // Calculate the accurate line number based on the context's start line
            const accurateLineNumber = startLineOfContext + i;  // Adjust by the line offset
            console.log(`Selected code line found in context at line ${accurateLineNumber}`);
            return accurateLineNumber;  // Return the accurate line number
        }
    }

    // Return null if the selected code line is not found in the context
    console.error(`Code line "${selectedCodeLine}" not found in the provided context.`);
    return null;
}

// Pre-process the agent's output to handle multi-line code_line and find the line with the invoke_variable
export function preProcessCodeLine(subProblem: any): string | null {
    const codeLine = subProblem.code_context.code_line;
    const invokeVariable = subProblem.code_context.invoke_variable;

    // Split the codeLine into multiple lines if necessary
    const codeLineParts = codeLine.split("\n").map((line: string) => line.trim()).filter((line: string) => line.length > 0);

    // Look for the line that contains the invoke_variable
    for (const line of codeLineParts) {
        if (line.includes(invokeVariable)) {
            return line;  // Return the relevant line that contains the invoke_variable
        }
    }

    // If no line contains the invoke_variable, log an error and return null
    console.error(`No line containing invoke_variable "${invokeVariable}" found in code_line: ${codeLine}`);
    return null;
}