import * as vscode from 'vscode';
import * as path from 'path';
import * as url from 'url';

// Function to extract the file name from a file URI
export function getFileNameFromUri(fileUri: string | undefined): string {
    if (!fileUri) {
        console.warn("getFileNameFromUri received undefined fileUri");
        return "unknown_file"; // Placeholder if fileUri is undefined
    }

    try {
        // Convert file URI to a local path if it's in URI format
        const localPath = url.fileURLToPath(fileUri);
        return path.basename(localPath); // Extracts and returns the file name
    } catch (error) {
        console.error(`Error converting ${fileUri} to local path: `, error);
        return "unknown_file"; // Fallback if conversion fails
    }
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

export function getAccurateLineNumber(context: string, selectedCodeLine: string, fuzzyLineNum: number, contextStartLineNum: number): number | null {
    const contextLines = context.split('\n');
    let closestMatch = -1;
    let minDistance = contextLines.length + 1;

    // Normalize the selected code line by removing commas, semicolons, and extra whitespace
    const selectedComponents = selectedCodeLine.replace(/[,;]/g, '').split(/\s+/).filter(Boolean);

    // Loop through each line in the context and search for closest match
    for (let i = 0; i < contextLines.length; i++) {
        const lineText = contextLines[i].trim();

        if (lineText) {
            // Check if all components of the selected line exist in the current line
            const isMatch = selectedComponents.every(component => lineText.includes(component));

            if (isMatch) {
                // Calculate distance from the fuzzyLineNum to current line in context
                const lineNumInContext = contextStartLineNum + i;
                const distance = Math.abs(fuzzyLineNum - lineNumInContext);

                // Update closest match if this match is closer than previous matches
                if (closestMatch === -1 || distance < minDistance) {
                    closestMatch = lineNumInContext;
                    minDistance = distance;
                }
            }
        }
    }

    // Return the closest match if found, else return null
    if (closestMatch >= 0) {
        return closestMatch;
    } else {
        console.error(`Code line ${fuzzyLineNum}: "${selectedCodeLine}" not found in context.`);
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