import * as vscode from 'vscode';
import * as path from 'path';

// Function to extract the file name from a file URI
export function getFileNameFromUri(fileUri: string): string {
    return path.basename(fileUri); // Returns the file name, e.g., 'useModal.ts'
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

export function stripSingleLineIndentation(code: string): string {
    // decide if the code is single line
    if (code.includes('\n')) {
        return code;
    }
    return code.replace(/\s+/g, ' ').trim();
}

export function getAccurateLineNumber(context: string, selectedCodeLine: string, startLineOfContext: number): number | null {
    const contextLines = context.split('\n');
    let closestMatch = -1;
    let distance = contextLines.length + 1;

    // Break down the selected code line into components
    const selectedComponents = selectedCodeLine.replace(/[,;]/g, '').split(/\s+/).filter(Boolean); // Remove commas/semicolons and split by whitespace

    // Loop through all the lines in the context and find matches based on components
    for (let i = 0; i < contextLines.length; i++) {
        const lineText = contextLines[i].trim();

        if (lineText) {
            // Check if all components of the selected line exist in the current line
            const isMatch = selectedComponents.every(component => lineText.includes(component));
            if (isMatch) {
                // Calculate the distance of this match from the start line of the context
                const d = Math.abs(startLineOfContext - i);

                // Check if this match is closer than any previous matches
                if (closestMatch === -1 || distance > d) {
                    closestMatch = i + 1;
                    distance = d;
                }
            }
        }
    }

    // Return the closest match if any, otherwise return null
    if (closestMatch >= 0) {
        return closestMatch;
    } else {
        console.error(`Code line ${startLineOfContext}: "${selectedCodeLine}" not found in ${context}.`);
        return null;
    }
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
export async function searchVariableOffset(
    document: vscode.TextDocument,
    variableName: string,
    startLine: number,
    range: number = 10
): Promise<{ line: number, offset: number } | null> {
    const totalLines = document.lineCount;
    const start = Math.max(0, startLine - range);
    const end = Math.min(totalLines - 1, startLine + range);

    // Search around the startLine (above and below within the given range)
    for (let i = 0; i < end - start + 1; i++) {
        const currentLine = start + i;

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
    console.error(`Variable "${variableName}" not found in around the line ${startLine} in the document between line ${start} and ${end}.`);
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

    // Ensure the start and end lines are within the document bounds
    start = Math.max(0, start);
    end = Math.min(totalLines - 1, end);

    const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
    return document.getText(range);
}

export function alignCodeLeft(code: string): string {
    // Split the code into lines
    const lines = code.split('\n');

    // Find the minimum indent by looking for the non-empty line with the least leading whitespace
    let minIndent = Infinity;
    for (let line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.length > 0) {
            const match = line.match(/^\s*/);
            const leadingWhitespace = match ? match[0].length : 0;
            minIndent = Math.min(minIndent, leadingWhitespace);
        }
    }

    // If there is no indent, we return the code as it is
    if (minIndent === Infinity) {
        return code;
    }

    // Remove the indent from each line
    const alignedLines = lines.map(line => line.startsWith(' '.repeat(minIndent)) || line.startsWith('\t'.repeat(minIndent))
        ? line.slice(minIndent)
        : line
    );

    // Join the lines back into a single string
    return alignedLines.join('\n');
}