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

export function getAccurateLineNumber(fullFile: string, fullStatement: string, variable: string, fuzzyLineNum: number): number | null {
    // we need to find the accurate line number of the variable from the full file based on given fullStatement
    const lines = fullFile.split('\n');
    const statementLines = fullStatement.split('\n');
    const variableLine = statementLines.findIndex((line) => line.includes(variable));
    if (variableLine === -1) {
        let lineNumberArr = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(variable)) {
                lineNumberArr.push(i);
            }
        }

        if (lineNumberArr.length === 0) {
            console.error(`Variable "${variable}" not found in the full file.`);
            return -1;
        } else if (lineNumberArr.length === 1) {
            return lineNumberArr[0];
        } else {
            let minDiff = Math.abs(lineNumberArr[0] - fuzzyLineNum);
            let minDiffIndex = 0;
            for (let i = 1; i < lineNumberArr.length; i++) {
                const diff = Math.abs(lineNumberArr[i] - fuzzyLineNum);
                if (diff < minDiff) {
                    minDiff = diff;
                    minDiffIndex = i;
                }
            }
            return lineNumberArr[minDiffIndex];
        }
    }

    let startLineNum = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(statementLines[0])) {
            startLineNum = i;
            break;
        }
    }
    return startLineNum + variableLine;
}

export function getLineNumber(codeSnippet: string, variableName: string, startLineNum: number): number {
    const lines = codeSnippet.split('\n');
    const lineNum = lines.findIndex((line) => line.includes(variableName));
    if (lineNum === -1) {
        return startLineNum;
    }

    return startLineNum + lineNum;
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
export function searchVariableOffset(
    document: vscode.TextDocument,
    variableName: string,
    lineNumber: number
): number {
    // Ensure document is valid
    if (!document) {
        console.error("Document is undefined or not initialized.");
        return -1;
    }

    // Validate line number
    if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= document.lineCount) {
        console.error(`Invalid line number: ${lineNumber}. Document has ${document.lineCount} lines.`);
        return -1;
    }

    const lineText = document.lineAt(lineNumber).text;

    // Search for the variable name in the current line
    const offset = lineText.indexOf(variableName);
    if (offset !== -1) {
        //console.log(`Found variable "${variableName}" at line ${currentLine}, offset ${offset}`);
        return offset;
    }

    // If the variable wasn't found, return null
    console.error(`Variable "${variableName}" not found in around the line ${lineNumber}.`);
    return -1;
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

export type Result = {
    fileUri: string;
    lineNumber: number;
    variable: string;
    tool: string;
    children: Result[];
};

function processOtherSide(
    variables: { name: string; layer: number; side: 'left' | 'right'; line: number }[],
    functions: { name: string; side: 'left' | 'right'; line: number } | null,
    inputVariable: string,
    fileUri: string
): Result[] {
    const results: Result[] = [];
    let side: "left" | "right" | "none" = "none";

    // decide the side of inputVariable
    for (const variable of variables) {
        if (variable.name === inputVariable) {
            side = variable.side;
            results.push({
                fileUri,
                lineNumber: variable.line,
                variable: variable.name,
                tool: "assignment",
                children: [],
            });
            break;
        }
    }

    if (results.length === 0) {
        return results;
    }

    // First, check if the inputVariable is inside a function call
    if (functions && side === functions.side) {
        results[0].children.push({
            fileUri,
            lineNumber: functions.line,
            variable: functions.name,
            tool: "call",
            children: [],
        });
        return results; // Return early since we've handled the function case
    }

    // Extract variables from the other side
    variables.forEach((variable) => {
        if (variable.side !== side) {
            results[0].children.push({
                fileUri,
                lineNumber: variable.line,
                variable: variable.name,
                tool: "parameter",
                children: [],
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

export function processMarkdown(text: string): string {
    // Handle headers
    text = text.replace(/^###\s*(.*)$/gm, (_, content) => `<h3>${content.trim()}</h3>`);
    text = text.replace(/^##\s*(.*)$/gm, (_, content) => `<h2>${content.trim()}</h2>`);
    text = text.replace(/^#\s*(.*)$/gm, (_, content) => `<h1>${content.trim()}</h1>`);

    // Handle bold (**content**)
    text = text.replace(/\*\*(.*?)\*\*/g, (_, content) => `<b>${content}</b>`);

    // Handle inline code (`content`)
    text = text.replace(/`([^`]*)`/g, (_, content) => `<span class="inline-code">${content}</span>`);

    // Handle inline code ('content')
    text = text.replace(/(?<!\w)'([^']*?)'(?!\w)/g, (_, content) => `<span class="inline-code">${content}</span>`);

    // Handle line breaks (\n -> <br>)
    text = text.replace(/\n/g, "<br>");

    return text;
};

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
            } else if (isFunction == 4 && ts.isClassDeclaration(node)) {
                return node;
            } else if (isFunction == 9 && ts.isIfStatement(node)) {
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
    const lineText = await getLineText(fileUri, lineNumber);
    const trimmedLine = lineText.trim();

    if (!trimmedLine) {
        return { statementText: lineText, startLineNum: lineNumber, endLineNum: lineNumber };
    }

    let isFunction = 0;
    if (trimmedLine.startsWith("if ") || trimmedLine.startsWith("else if ") || trimmedLine.startsWith("else {")) {
        const ifBlockText = await extractSpecificIfElseBlock(fileUri, lineNumber);
        return ifBlockText;
    } else if (/^\s*(export\s+)?class\s+\w+/.test(trimmedLine)) {
        isFunction = 4; // Class declaration
    } else if (/^\s*(export\s+)?(async\s+)?function\s+\w+\s*\(/.test(trimmedLine)) {
        isFunction = 1; // Function declaration
    } else if (trimmedLine.endsWith(",")) {
        isFunction = 0; // destructuring assignment
    } else {
        return { statementText: lineText, startLineNum: lineNumber, endLineNum: lineNumber };
    }

    const completeLineNode = await findNode(fileUri, lineNumber, isFunction);
    if (completeLineNode) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const statementText = completeLineNode.getText();
        const startPosition = completeLineNode.getStart();
        const endPosition = completeLineNode.getEnd();
        const startLineNum = document.positionAt(startPosition).line;
        const endLineNum = document.positionAt(endPosition).line;
        return { statementText, startLineNum, endLineNum };
    }

    return { statementText: lineText, startLineNum: lineNumber, endLineNum: lineNumber };
}

// Combined function using both parts
async function extractVariables(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string,
    isFunction: number = 0,
    tool: string = "assignment"
): Promise<Result[]> {
    const extractedNode = await findNode(fileUri, lineNumber, isFunction);
    if (extractedNode) {
        let results: Result[] = [];
        if (isFunction == 1) {
            results = await extractFunctionDefineAndParameters(fileUri, lineNumber, inputVariable);
        } else if (isFunction == 0) {
            const { variables, functions } = extractVariablesAndFunctions(extractedNode);
            if (inputVariable === "") {
                // combine variables and functions into results
                results = variables.map((variable) => {
                    return {
                        fileUri: fileUri.toString(),
                        lineNumber: variable.line,
                        variable: variable.name,
                        tool: tool,
                        children: [],
                    };
                });
                if (functions) {
                    results.push({
                        fileUri: fileUri.toString(),
                        lineNumber: functions.line,
                        variable: functions.name,
                        tool: "function",
                        children: [],
                    });
                }
            } else {
                results = processOtherSide(variables, functions, inputVariable, fileUri.toString());
            }
        } else if (isFunction == 2) {
            results = await extractFunctionDefineAndParameters(fileUri, lineNumber, inputVariable); //extractArrowFunctionAndParameters(extractedNode, inputVariable, fileUri.toString());
        } else if (isFunction == 4) {
            results = extractClass(extractedNode, inputVariable, fileUri.toString());
        } else {
            results = extractFunctionCallAndParameters(extractedNode, inputVariable, fileUri.toString());
        }
        // traverse the results. if the variable is XX.XX, we need to separate them into two variables
        const newResults = [];
        for (const result of results) {
            if (result.variable.includes('.')) {
                const variables = result.variable.split('.');
                for (const variable of variables) {
                    newResults.push({
                        fileUri: result.fileUri,
                        lineNumber: result.lineNumber,
                        variable: variable,
                        tool: result.tool,
                        children: result.children,
                    });
                }
            } else {
                newResults.push(result);
            }
        }
        return newResults;
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
        if (ts.SyntaxKind.FunctionType <= node.kind && node.kind <= ts.SyntaxKind.ImportType || ts.SyntaxKind.JSDoc == node.kind) {
            return;
        }

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

async function extractFunctionDefineAndParameters(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string = ""
): Promise<any[]> {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const fileContent = document.getText();
    const sourceFile = ts.createSourceFile(
        fileUri.toString(),
        fileContent,
        ts.ScriptTarget.ESNext,
        true
    );

    function visit(node: ts.Node): ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | null {
        if (
            ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node)
        ) {
            const startPos = node.getStart(sourceFile);
            const startLine = document.positionAt(startPos).line;

            if (startLine === lineNumber) {
                return node;
            }
        }

        for (const child of node.getChildren(sourceFile)) {
            const result = visit(child);
            if (result) {
                return result;
            }
        }

        return null;
    }

    const functionNode = visit(sourceFile);
    if (!functionNode) return [];

    let allResults: Promise<any[]>[] = [];
    let results: Result[] = [];
    let functionName = "anonymous";

    if (ts.isFunctionDeclaration(functionNode) || ts.isMethodDeclaration(functionNode)) {
        functionName = functionNode.name?.getText() || "anonymous";
    } else if (ts.isFunctionExpression(functionNode) || ts.isArrowFunction(functionNode)) {
        let parent = functionNode.parent;

        // Case 1: Arrow function assigned to a variable
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            functionName = parent.name.getText();
        }
        // Case 2: Arrow function assigned to an object property
        else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
            functionName = parent.name.getText();
        }
        // Case 3: Arrow function inside an array (anonymous function in array)
        else if (ts.isArrayLiteralExpression(parent)) {
            functionName = "array_function";
        }
        // Case 4: Arrow function passed as a callback
        else if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
            functionName = `callback_of_${parent.expression.getText()}`;
        }
    }

    if (functionName === "anonymous") {
        return [];
    }

    // Get function start line
    const funcStartPos = functionNode.getStart(sourceFile);
    const funcLine = document.positionAt(funcStartPos).line;

    // **Ensure function name is first in the results**
    results.push({
        fileUri: fileUri.toString(),
        lineNumber: funcLine,
        variable: functionName,
        tool: "function",
        children: [],
    });

    // Extract function parameters
    functionNode.parameters.forEach((param) => {
        const paramName = param.name.getText();
        const paramStartPos = param.getStart(sourceFile);
        const paramLine = document.positionAt(paramStartPos).line;
        results[0].children.push({
            fileUri: fileUri.toString(),
            lineNumber: paramLine,
            variable: paramName,
            tool: "parameter",
            children: [],
        });
    });

    async function collectDirectStatements(block: ts.Block) {
        for (const statement of block.statements) {
            const startPos = statement.getStart(sourceFile);
            const statementLine = document.positionAt(startPos).line;
            const statementLength = statement.getText(sourceFile).length;
            if (statementLength > 1) {
                if (ts.isReturnStatement(statement)) {
                    const endPos = statement.getEnd();
                    const startLine = document.positionAt(startPos).line;
                    const endLine = document.positionAt(endPos).line;
                    for (let line = startLine; line <= endLine; line++) {
                        results[0].children.push(...await analyze(fileUri, line, inputVariable, "function"));
                    }
                } else {
                    results[0].children.push(...await analyze(fileUri, statementLine, inputVariable, "function"));
                }
            } else {
                results[0].children.push(...await analyze(fileUri, statementLine, inputVariable, "function"));
            }
        }
    }

    if (functionNode.body && ts.isBlock(functionNode.body)) {
        collectDirectStatements(functionNode.body);
    }

    // Collect all async results
    const bodyResults = await Promise.all(allResults).then(results => results.flat());

    // **Ensure function name is always the first element**
    return [...results, ...bodyResults];
}

function extractFunctionCallAndParameters(
    node: ts.Node,
    inputVariable: string,
    fileUri: string
): Result[] {
    const currentLayer = 0;
    const results: Result[] = [];
    const functions: Result[] = [];

    let functionSide = true; // we assume the nodes before SyntaxList are all function names

    // Helper function to traverse nodes
    function visit(node: ts.Node, layer: number, functionSide: boolean) {
        if (layer >= 15) return; // Stop for deeply nested nodes

        // Skip irrelevant nodes
        if (ts.SyntaxKind.BreakKeyword <= node.kind && node.kind <= ts.SyntaxKind.OfKeyword ||
            ts.SyntaxKind.TypePredicate <= node.kind && node.kind <= ts.SyntaxKind.ImportType ||
            ts.SyntaxKind.Block == node.kind || ts.SyntaxKind.JSDoc == node.kind) {
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
                    variable: extractedText,
                    tool: "function",
                    children: [],
                });
            } else {
                results.push({
                    fileUri: fileUri,
                    lineNumber: line,
                    variable: extractedText,
                    tool: "variable",
                    children: [],
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

    if (inputVariable === "") {
        // combine functions and results into results
        results.push(...functions);
        return results;
    }

    return functions;
}

function extractClass(node: ts.Node, inputVariable: string, fileUri: string): Result[] {
    const currentLayer = 0;
    let className: string | null = null;
    const properties: Result[] = [];
    const methods: Result[] = [];
    const results: Result[] = [];

    // Helper function to traverse nodes
    function visit(node: ts.Node, layer: number) {
        if (layer >= 15) return; // Stop for deeply nested nodes

        // Skip irrelevant nodes
        if (
            ts.SyntaxKind.BreakKeyword <= node.kind && node.kind <= ts.SyntaxKind.OfKeyword ||
            ts.SyntaxKind.TypePredicate <= node.kind && node.kind <= ts.SyntaxKind.ImportType ||
            ts.SyntaxKind.Block == node.kind || ts.SyntaxKind.JSDoc == node.kind
        ) {
            return;
        }

        // Check for class name
        if (ts.isClassDeclaration(node) && node.name) {
            className = node.name.getText();
        }

        // Check for properties
        if (ts.isPropertyDeclaration(node)) {
            const start = node.getStart();
            const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), start);
            const line = lineAndCharacter.line;
            const propertyName = node.name.getText();

            if (propertyName === inputVariable) {
                return;
            }
            properties.push({
                fileUri: fileUri,
                lineNumber: line,
                variable: propertyName,
                tool: "property",
                children: [],
            });
        }

        // Check for methods
        if (ts.isMethodDeclaration(node) && node.name) {
            const start = node.getStart();
            const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), start);
            const line = lineAndCharacter.line;
            methods.push({
                fileUri: fileUri,
                lineNumber: line,
                variable: node.name.getText(),
                tool: "method",
                children: [],
            });
        }

        // Traverse child nodes
        node.getChildren().forEach((child) => visit(child, layer + 1));
    }

    visit(node, currentLayer);

    if (className) {
        const classResult: Result = {
            fileUri: fileUri,
            lineNumber: node.getStart(),
            variable: className,
            tool: "class",
            children: [...properties, ...methods],
        };
        results.push(classResult);
    }

    return results;
}


// Main function to parse the file and extract assignments
export async function analyze(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string = "",
    tool: string = "assignment"
) {
    const lineText = await getLineText(fileUri, lineNumber);
    const trimmedLine = lineText.trim();

    if (!trimmedLine) {
        return [];
    }

    let isFunction = 0;

    // Handle if-else conditions
    if (trimmedLine.startsWith("if ") || trimmedLine.startsWith("else if ") || trimmedLine.startsWith("else {")) {
        // If depth > 0, only return statements without further analysis
        tool = "if";
        return await findIfElseDirectStatementsWithLines(fileUri, lineNumber, inputVariable, 0);
    }

    if (/^\s*(export\s+)?class\s+\w+/.test(trimmedLine)) {
        isFunction = 4; // Class declaration
        tool = "class";
    } else if (/^\s*(export\s+)?(async\s+)?function\s+\w+\s*\(/.test(trimmedLine)) {
        isFunction = 1; // Function declaration
        tool = "function";
    } else if (trimmedLine.includes("=>")) {
        isFunction = 2; // Arrow function
        tool = "function";
    } else if (trimmedLine.endsWith(",")) {
        isFunction = 0; // destructuring assignment
        if (inputVariable === "") {
            const lineVariables = normalProcess(trimmedLine, inputVariable, fileUri.toString(), lineNumber);
            if (lineVariables.length === 1) {
                inputVariable = lineVariables[0].variable;
            }
        }
    } else {
        return normalProcess(trimmedLine, inputVariable, fileUri.toString(), lineNumber, tool);
    }

    const results = await extractVariables(fileUri, lineNumber, inputVariable, isFunction, tool);

    if (results.length > 0) {
        return results
    }
    return normalProcess(trimmedLine, inputVariable, fileUri.toString(), lineNumber, tool);
}

export function normalProcess(
    line: string,
    inputVariable: string,
    fileUri: string,
    lineNumber: number,
    tool: string = "assignment"
): Result[] {

    const keywords = new Set([
        "abstract", "as", "any", "async", "await", "boolean", "break", "case", "catch", "class", "const", "continue",
        "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false", "final",
        "finally", "for", "from", "function", "get", "goto", "if", "implements", "import", "in", "infer", "instanceof",
        "interface", "is", "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "of",
        "package", "private", "protected", "public", "readonly", "require", "return", "set", "static", "string",
        "super", "switch", "symbol", "this", "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown",
        "var", "void", "while", "with", "yield", "React", "useRef", "useEffect", "document", "window", "console", "log", "error", "warn",
        "HTMLDivElement", "EventTarget", "KeyboardEvent", "ManagedModalProps"
    ]);

    // Extract potential identifiers
    const matches = line.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g);

    // Filter and map to the required format
    return matches
        ? matches
            .filter(identifier => !keywords.has(identifier) && identifier !== inputVariable)
            .map(variable => ({ fileUri, lineNumber, variable, tool, children: [] }))
        : [];
}

async function findIfElseDirectStatementsWithLines(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string = "",
    depth: number = 0 // Pass depth to control recursion
): Promise<Result[]> {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const fileContent = document.getText();
    const sourceFile = ts.createSourceFile(
        fileUri.toString(),
        fileContent,
        ts.ScriptTarget.ESNext,
        true
    );

    function visit(node: ts.Node): ts.IfStatement | null {
        if (ts.isIfStatement(node)) {
            const startPos = node.getStart(sourceFile);
            const startLine = document.positionAt(startPos).line;

            if (startLine === lineNumber) {
                return node;
            }
        }

        for (const child of node.getChildren(sourceFile)) {
            const result = visit(child);
            if (result) {
                return result;
            }
        }

        return null;
    }

    const ifNode = visit(sourceFile);
    if (!ifNode) return [];

    let allResults: Result[] = [];

    const condition = ifNode.expression.getText(sourceFile);
    const conditionResults = normalProcess(condition, inputVariable, fileUri.toString(), lineNumber);
    allResults.push(...conditionResults);

    async function collectDirectStatements(block: ts.Block) {
        for (const statement of block.statements) {
            const startPos = statement.getStart(sourceFile);
            const statementLine = document.positionAt(startPos).line;
            const analyzedResults = await analyze(fileUri, statementLine, inputVariable);
            // Recursively analyze each statement, preventing deeper if-analysis, adding them into each result's children in allResults
            allResults.forEach(result => {
                result.children.push(...analyzedResults);
            });
        }
    }

    if (ifNode.thenStatement && ts.isBlock(ifNode.thenStatement)) {
        collectDirectStatements(ifNode.thenStatement);
    }
    if (ifNode.elseStatement && ts.isBlock(ifNode.elseStatement)) {
        collectDirectStatements(ifNode.elseStatement);
    }

    return allResults;
}

async function extractSpecificIfElseBlock(
    fileUri: vscode.Uri,
    lineNumber: number
): Promise<{ fileUri: vscode.Uri; lineNumber: number; statementText: string; startLineNum: number; endLineNum: number }> {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const fileContent = document.getText();
    const sourceFile = ts.createSourceFile(
        fileUri.toString(),
        fileContent,
        ts.ScriptTarget.ESNext,
        true
    );

    function visit(node: ts.Node): ts.IfStatement | null {
        if (ts.isIfStatement(node)) {
            const startPos = node.getStart(sourceFile);
            const startLine = document.positionAt(startPos).line;

            if (startLine === lineNumber) {
                return node;
            }
        }

        for (const child of node.getChildren(sourceFile)) {
            const result = visit(child);
            if (result) {
                return result;
            }
        }

        return null;
    }

    const ifNode = visit(sourceFile);

    function getBlockInfo(statement: ts.Statement | undefined): { statementText: string; startLineNum: number; endLineNum: number } {
        if (!statement) {
            return {
                statementText: "",
                startLineNum: lineNumber,
                endLineNum: lineNumber
            };
        }

        const startPos = statement.getStart(sourceFile);
        const endPos = statement.getEnd();
        const startLine = document.positionAt(startPos).line;
        const endLine = document.positionAt(endPos).line;

        return {
            statementText: fileContent.substring(startPos, endPos).trim(),
            startLineNum: startLine,
            endLineNum: endLine
        };
    }

    if (ifNode) {
        // Check if the `if` statement itself starts at the given line number
        if (document.positionAt(ifNode.getStart(sourceFile)).line === lineNumber) {
            return { fileUri, lineNumber, ...getBlockInfo(ifNode.thenStatement) };
        }

        // Traverse `else if` and `else` branches
        let elseBranch = ifNode.elseStatement;
        while (elseBranch) {
            const elseStartLine = document.positionAt(elseBranch.getStart(sourceFile)).line;

            if (elseStartLine === lineNumber) {
                return { fileUri, lineNumber, ...getBlockInfo(ts.isIfStatement(elseBranch) ? elseBranch.thenStatement : elseBranch) };
            }

            if (ts.isIfStatement(elseBranch)) {
                elseBranch = elseBranch.elseStatement; // Move to the next else-if or else block
            } else {
                break;
            }
        }
    }

    // Fallback: If no matching block is found, return the raw line
    return {
        fileUri,
        lineNumber,
        statementText: document.lineAt(lineNumber).text.trim(),
        startLineNum: lineNumber,
        endLineNum: lineNumber
    };
}

export async function test() {
    const fileUri = vscode.Uri.file("/Users/litaoyan/Documents/Research/dataflow/material-ui-master/packages/mui-base/src/FocusTrap/FocusTrap.tsx");
    const lineNumber = 135;
    const inputVariable = "";

    const results = await analyze(fileUri, lineNumber, inputVariable);
    console.log("results: ", results);
}