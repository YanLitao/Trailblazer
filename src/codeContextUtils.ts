import * as vscode from 'vscode';
import * as ts from "typescript";
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

export async function getLineText(fileUri: vscode.Uri, lineNumber: number): Promise<string> {
    const document = await vscode.workspace.openTextDocument(fileUri);
    return document.lineAt(lineNumber).text;
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

export async function getLineTextFromRange(uri: vscode.Uri, startLine: number, endLine: number): Promise<string> {
    const document = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    return document.getText(range);
}

export function stripLineIndentation(code: string): string {
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

    // Join the lines back into a multiple-line string
    return alignedLines.join('\n').trim();
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

    // Helper: Check if a line starts a class or function definition
    const isClassOrFunctionLine = (lineText: string): boolean => {
        return /^\s*(class|function|.*=>)/.test(lineText.trim());
    };

    // Helper: Check if a line is part of a destructuring assignment
    const isDestructuringLine = (lineText: string): boolean => {
        return lineText.includes('=') && lineText.includes('{') && !isClassOrFunctionLine(lineText);
    };

    // Helper: Count braces in a line
    const countBraces = (lineText: string) => {
        let open = 0, close = 0;
        for (const char of lineText) {
            if (char === '{') open++;
            if (char === '}') close++;
        }
        return { open, close };
    };

    let start = startLine;
    let openBracesCount = 0;
    let foundStart = false;

    // Backtrack to find the start of the relevant block
    while (start >= 0) {
        const lineText = document.lineAt(start).text;

        if (isClassOrFunctionLine(lineText)) {
            // If it's a class or function definition, return the line at startLine
            return document.lineAt(startLine).text.trim();
        }

        const { open, close } = countBraces(lineText);
        openBracesCount += open - close;

        if (openBracesCount > 0 && isDestructuringLine(lineText)) {
            foundStart = true;
            break;
        }

        start--;
    }

    if (!foundStart) {
        return document.lineAt(startLine).text.trim(); // Return the original line if no destructuring is found
    }

    let end = start;
    openBracesCount = 0;

    // Move forward to find the end of the destructuring block
    while (end < totalLines) {
        const lineText = document.lineAt(end).text;
        const { open, close } = countBraces(lineText);
        openBracesCount += open - close;

        if (openBracesCount === 0) {
            break;
        }

        end++;
    }

    // Ensure bounds are within the document
    start = Math.max(0, start);
    end = Math.min(totalLines - 1, end);

    // Extract the range of the destructuring block
    const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
    return document.getText(range).trim();
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

function processOtherSide(
    variables: { name: string; layer: number; side: 'left' | 'right'; line: number }[],
    functions: { name: string; side: 'left' | 'right'; line: number } | null,
    inputVariable: string,
    fileUri: string
): { fileUri: string; lineNumber: number; variable: string }[] {
    const results: { fileUri: string; lineNumber: number; variable: string }[] = [];
    let side: "left" | "right" | "none" = "none";

    // decide the side of inputVariable
    for (const variable of variables) {
        if (variable.name === inputVariable) {
            side = variable.side;
            break;
        }
    }

    // First, check if the inputVariable is inside a function call
    if (functions && side === functions.side) {
        results.push({
            fileUri,
            lineNumber: functions.line,
            variable: functions.name,
        });
        return results; // Return early since we've handled the function case
    }

    // Extract variables from the other side
    variables.forEach((variable) => {
        if (variable.side !== side) {
            results.push({
                fileUri,
                lineNumber: variable.line,
                variable: variable.name
            });
        }
    });

    return results;
}

function getRangeStart(sourceFile: ts.SourceFile, lineNumber: number): number {
    const lineStarts = sourceFile.getLineStarts();

    // Ensure lineNumber is within valid bounds
    if (lineNumber < 0 || lineNumber >= lineStarts.length) {
        throw new Error(`Invalid line number: ${lineNumber}. File has ${lineStarts.length} lines.`);
    }

    // Return the position of the start of the given line
    return lineStarts[lineNumber];
}

function getRangeEnd(sourceFile: ts.SourceFile, lineNumber: number): number {
    const lineStarts = sourceFile.getLineStarts();

    // Ensure lineNumber is within valid bounds
    if (lineNumber < 0 || lineNumber >= lineStarts.length) {
        throw new Error(`Invalid line number: ${lineNumber}. File has ${lineStarts.length} lines.`);
    }

    // Determine the end of the specified line
    if (lineNumber === lineStarts.length - 1) {
        // Last line: Use the end of the file
        return sourceFile.getEnd();
    } else {
        // Use the start of the next line as the end of the current line
        return lineStarts[lineNumber + 1] - 1; // The character before the next line
    }
}

function containsSingleCompleteSentence(node: ts.Node, sourceFile: ts.SourceFile): boolean {

    const text = node.getText(sourceFile);
    const textWithoutComments = removeComments(text);

    // Find the number of semicolons. If the code includes more than 1 semicolon, it's not a single complete sentence
    const semicolonCount = textWithoutComments.split(';').length - 1;
    if (semicolonCount > 1) {
        return false;
    }

    const semicolonIndex = textWithoutComments.lastIndexOf(';');
    if (semicolonIndex === -1) {
        return false;
    }

    return true;
}

function removeComments(text: string): string {
    return text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
}

function findFunctionDeclaration(node: ts.Node, isFunction: number): boolean {
    if (isFunction == 1 && ts.isFunctionDeclaration(node)) {
        return true;
    }
    if (isFunction == 2) {
        for (const child of node.getChildren()) {
            if (ts.isArrowFunction(child)) {
                return true;
            }
        }
    }
    return false;
}

// First part: Find assignment node text
async function findNode(
    fileUri: vscode.Uri,
    lineNumber: number,
    isFunction: number = 0
): Promise<ts.Node | null> {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const fileContent = document.getText();
    const sourceFile = ts.createSourceFile(
        fileUri.toString(),
        fileContent,
        ts.ScriptTarget.ESNext,
        true
    );
    const rangeStart = getRangeStart(sourceFile, lineNumber);
    const rangeEnd = getRangeEnd(sourceFile, lineNumber);

    function visit(node: ts.Node): ts.Node | null {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();

        // Check if the node overlaps with the specified range
        if (start <= rangeEnd && end >= rangeStart) {
            if (isFunction == 0 && containsSingleCompleteSentence(node, sourceFile)) {
                return node;
            } else if ((isFunction == 1 || isFunction == 2) && findFunctionDeclaration(node, isFunction)) {
                return node;
            } else if (isFunction == 3 && ts.isCallExpression(node)) {
                return node;
            }
        }

        // Recursively visit child nodes
        for (const child of node.getChildren(sourceFile)) {
            const result = visit(child);
            if (result) {
                return result;
            }
        }

        return null; // No valid node found
    }

    return visit(sourceFile);
}

export async function findCompleteStatementText(
    fileUri: vscode.Uri,
    lineNumber: number
): Promise<{ statementText: string; startLineNum: number; endLineNum: number }> {
    const completeLineNode = await findNode(fileUri, lineNumber);
    if (completeLineNode) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const statementText = completeLineNode.getText();
        const startPosition = completeLineNode.getStart();
        const endPosition = completeLineNode.getEnd();
        const startLineNum = document.positionAt(startPosition).line;
        const endLineNum = document.positionAt(endPosition).line;

        return { statementText, startLineNum, endLineNum };
    }

    // Return default empty values if no node is found
    return { statementText: '', startLineNum: -1, endLineNum: -1 };
}

// Combined function using both parts
async function extractVariables(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string,
    isFunction: number = 0
): Promise<{ fileUri: string; lineNumber: number; variable: string }[]> {
    const extractedNode = await findNode(fileUri, lineNumber, isFunction);
    if (extractedNode) {
        let results;
        if (isFunction == 1) {
            results = extractFunctionDefineAndParameters(extractedNode, inputVariable, fileUri.toString());
        } else if (isFunction == 0) {
            const { variables, functions } = extractVariablesAndFunctions(extractedNode);
            results = processOtherSide(variables, functions, inputVariable, fileUri.toString());
        } else if (isFunction == 2) {
            results = extractArrowFunctionAndParameters(extractedNode, inputVariable, fileUri.toString());
        } else {
            results = extractFunctionCallAndParameters(extractedNode, inputVariable, fileUri.toString());
        }
        return results;
    }
    return [];
}

function extractVariablesAndFunctions(node: ts.Node): {
    variables: { name: string; layer: number; side: 'left' | 'right'; line: number }[];
    functions: { name: string; side: 'left' | 'right'; line: number } | null;
} {
    const variables: { name: string; layer: number; side: 'left' | 'right'; line: number }[] = [];
    let functions: { name: string; side: 'left' | 'right'; line: number } | null = null;
    let minEqualSignLayer = Infinity;
    let currentLayer = 0;
    let isRightSide = false; // Flag to control the side

    // Helper function to traverse nodes
    function visit(node: ts.Node, layer: number) {
        if (layer >= 15) return; // Stop for deeply nested nodes

        // Skip irrelevant nodes
        if (ts.SyntaxKind.TypePredicate <= node.kind && node.kind <= ts.SyntaxKind.ImportType) {
            return;
        }

        console.log(node.kind, node.getText());

        if (node.kind === ts.SyntaxKind.EqualsToken) {
            if (layer < minEqualSignLayer) {
                minEqualSignLayer = layer;
                isRightSide = true; // Switch to the right side after encountering "="
                // Update all existing variable sides to "left"
                variables.forEach((v) => (v.side = 'left'));
            }
        }

        // Check for identifiers
        if (node.kind === ts.SyntaxKind.Identifier) {
            // get line number of the node
            const start = node.getStart();
            const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), start);
            const line = lineAndCharacter.line;

            variables.push({
                name: node.getText(),
                layer,
                side: isRightSide ? 'right' : 'left',
                line: line,
            });
        }

        // Check for call expressions (functions)
        if (node.kind === ts.SyntaxKind.CallExpression) {
            const firstChild = node.getChildren().find((child) => ts.isIdentifier(child));
            if (firstChild) {
                const start = firstChild.getStart();
                const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), start);
                const line = lineAndCharacter.line;
                functions = {
                    name: firstChild.getText(),
                    side: isRightSide ? 'right' : 'left',
                    line: line,
                };
            }
        }

        // Traverse child nodes
        node.getChildren().forEach((child) => visit(child, layer + 1));
    }

    visit(node, currentLayer);

    return { variables, functions };
}

function extractFunctionDefineAndParameters(
    node: ts.Node,
    inputVariable: string,
    fileUri: string
): { fileUri: string; lineNumber: number; variable: string }[] {
    const currentLayer = 0;
    const results: { fileUri: string; lineNumber: number; variable: string }[] = [];

    // Helper function to traverse nodes
    function visit(node: ts.Node, layer: number) {
        if (layer >= 15) return; // Stop for deeply nested nodes

        // Skip irrelevant nodes
        if (ts.SyntaxKind.BreakKeyword <= node.kind && node.kind <= ts.SyntaxKind.OfKeyword ||
            ts.SyntaxKind.TypePredicate <= node.kind && node.kind <= ts.SyntaxKind.ImportType ||
            ts.SyntaxKind.Block == node.kind) {
            return;
        }

        // Check for identifiers
        if (node.kind === ts.SyntaxKind.Identifier) {
            // get line number of the node
            const start = node.getStart();
            const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), start);
            const line = lineAndCharacter.line;
            const extractedText = node.getText();

            if (extractedText === inputVariable) return;

            results.push({
                fileUri: fileUri,
                lineNumber: line,
                variable: extractedText
            });
        }

        // Traverse child nodes
        node.getChildren().forEach((child) => visit(child, layer + 1));
    }

    visit(node, currentLayer);

    return results;
}

function extractArrowFunctionAndParameters(node: ts.Node,
    inputVariable: string,
    fileUri: string
): { fileUri: string; lineNumber: number; variable: string }[] {
    const currentLayer = 0;
    const functionResult: { fileUri: string; lineNumber: number; variable: string }[] = [];
    const parameterResult: { fileUri: string; lineNumber: number; variable: string }[] = [];

    for (const child of node.getChildren()) {
        // the function is on the right side of the equal sign with ts.SyntaxKind.Identifier
        // the parameters are on the left side of the equal sign with ts.SyntaxKind.Identifier
        if (ts.isIdentifier(child)) {
            const start = child.getStart();
            const lineAndCharacter = ts.getLineAndCharacterOfPosition(child.getSourceFile(), start);
            const line = lineAndCharacter.line;
            const extractedText = child.getText();

            functionResult.push({
                fileUri: fileUri,
                lineNumber: line,
                variable: extractedText
            });
        } else {
            visit(child, currentLayer);
        }
    }

    // Helper function to traverse nodes
    function visit(node: ts.Node, layer: number) {
        if (layer >= 15) return; // Stop for deeply nested nodes

        // Skip irrelevant nodes
        if (ts.SyntaxKind.BreakKeyword <= node.kind && node.kind <= ts.SyntaxKind.OfKeyword ||
            ts.SyntaxKind.TypePredicate <= node.kind && node.kind <= ts.SyntaxKind.ImportType ||
            ts.SyntaxKind.Block == node.kind) {
            return;
        }

        // Check for identifiers
        if (node.kind === ts.SyntaxKind.Identifier) {
            // get line number of the node
            const start = node.getStart();
            const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), start);
            const line = lineAndCharacter.line;
            const extractedText = node.getText();

            if (extractedText === inputVariable) return;

            parameterResult.push({
                fileUri: fileUri,
                lineNumber: line,
                variable: extractedText
            });
        }

        // Traverse child nodes
        node.getChildren().forEach((child) => visit(child, layer + 1));
    }

    // check if the inputVariable is in the function
    for (const variable of functionResult) {
        if (variable.variable === inputVariable) {
            return parameterResult;
        }
    }

    return functionResult;
}

function extractFunctionCallAndParameters(
    node: ts.Node,
    inputVariable: string,
    fileUri: string
): { fileUri: string; lineNumber: number; variable: string }[] {
    const currentLayer = 0;
    const results: { fileUri: string; lineNumber: number; variable: string }[] = [];
    const functions: { fileUri: string; lineNumber: number; variable: string }[] = [];

    let functionSide = true; // we assume the nodes before SyntaxList are all function names

    // Helper function to traverse nodes
    function visit(node: ts.Node, layer: number, functionSide: boolean) {
        if (layer >= 15) return; // Stop for deeply nested nodes

        // Skip irrelevant nodes
        if (ts.SyntaxKind.BreakKeyword <= node.kind && node.kind <= ts.SyntaxKind.OfKeyword ||
            ts.SyntaxKind.TypePredicate <= node.kind && node.kind <= ts.SyntaxKind.ImportType ||
            ts.SyntaxKind.Block == node.kind) {
            return;
        } else if (ts.SyntaxKind.SyntaxList == node.kind) {
            functionSide = false;
        }

        // Check for identifiers
        if (node.kind === ts.SyntaxKind.Identifier) {
            // get line number of the node
            const start = node.getStart();
            const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), start);
            const line = lineAndCharacter.line;
            const extractedText = node.getText();

            if (extractedText === inputVariable) return;

            if (functionSide) {
                functions.push({
                    fileUri: fileUri,
                    lineNumber: line,
                    variable: extractedText
                });
            } else {
                results.push({
                    fileUri: fileUri,
                    lineNumber: line,
                    variable: extractedText
                });
            }
        }

        // Traverse child nodes
        node.getChildren().forEach((child) => visit(child, layer + 1, functionSide));
    }

    visit(node, currentLayer, functionSide);

    // check if the inputVariable is in the function or not
    for (const f of functions) {
        if (f.variable === inputVariable) {
            return results;
        }
    }

    return functions;
}



// Main function to parse the file and extract assignments
export async function analyze(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string
) {
    const lineText = await getLineText(fileUri, lineNumber);
    const trimmedLine = lineText.trim();

    if (!trimmedLine) {
        console.error(`Line ${lineNumber} not found in file ${fileUri}`);
        return [];
    }
    let isFunction = 0;
    if (trimmedLine.includes("function ")) {
        isFunction = 1;
    } else if (trimmedLine.includes("=>")) {
        isFunction = 2;
    } else if (trimmedLine.includes("=")) {
        isFunction = 0;
    } else {
        isFunction = 3; // function call
    }
    const results = await extractVariables(fileUri, lineNumber, inputVariable, isFunction);
    return results;
}