import * as vscode from "vscode";
import * as ts from "typescript";

function splitNodeByEqualSign(nodeText: string): { left: string; right: string } {
    let splitIndex = -1;
    let openBraces = 0;

    // Traverse the text to find the correct `=` sign
    for (let i = 0; i < nodeText.length; i++) {
        const char = nodeText[i];

        if (char === "{") openBraces++;
        if (char === "}") openBraces--;

        // Check for `=` outside nested structures
        if (char === "=" && openBraces === 0) {
            splitIndex = i;
            break;
        }
    }

    // If no `=` sign is found, throw an error
    if (splitIndex === -1) {
        throw new Error("No valid `=` sign found in the node text.");
    }

    // Split the text into left and right parts
    const left = nodeText.slice(0, splitIndex).trim();
    const right = nodeText.slice(splitIndex + 1).trim();

    return { left, right };
}

const RESERVED_KEYWORDS = new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "switch", "case", "break", "continue", "throw", "catch", "try", "typeof",
    "instanceof", "new", "this", "class", "extends", "import", "export", "default",
    "async", "await", "static", "public", "private", "protected", "interface",
    "implements", "enum", "type", "namespace", "module", "declare", "global",
    "window", "document", "console", "process", "require", "module",
    "true", "false", "null", "undefined", "NaN", "Infinity", "void", "delete"
]);

function processOtherSide(
    left: string,
    right: string,
    inputVariable: string,
    fileUri: string,
    inputLineNumber: number
): { fileUri: string; lineNumber: number; variable: string }[] {
    const results: { fileUri: string; lineNumber: number; variable: string }[] = [];
    let side: "left" | "right" | "none" = "none";

    // Regex to match function calls like `useModal(...)`
    const functionRegex = /([\w$]+)\s*\(/;

    // First, check if the inputVariable is inside a function call
    if (left.includes(inputVariable) && functionRegex.test(left)) {
        const functionMatch = left.match(functionRegex);
        if (functionMatch) {
            const functionName = functionMatch[1];
            if (!RESERVED_KEYWORDS.has(functionName)) {
                results.push({
                    fileUri,
                    lineNumber: inputLineNumber,
                    variable: functionName,
                });
            }
            return results; // Return early since we've handled the function case
        }
    }

    if (right.includes(inputVariable) && functionRegex.test(right)) {
        const functionMatch = right.match(functionRegex);
        if (functionMatch) {
            const functionName = functionMatch[1];
            if (!RESERVED_KEYWORDS.has(functionName)) {
                results.push({
                    fileUri,
                    lineNumber: inputLineNumber,
                    variable: functionName,
                });
            }
            return results; // Return early since we've handled the function case
        }
    }

    // Determine the side of the input variable
    if (left.includes(inputVariable)) {
        side = "left";
    } else if (right.includes(inputVariable)) {
        side = "right";
    }

    // Extract variables from the relevant side
    const targetText = side === "left" ? right : side === "right" ? left : "";
    if (targetText) {
        // Handle destructuring assignments
        const destructureRegex = /([\w$]+)(\s*=\s*[\w$.]+)?|(\.\.\.[\w$]+)/g; // Matches `var`, `...var`, or `var = value`
        const matches = [...targetText.matchAll(destructureRegex)];

        matches.forEach((match) => {
            const variable = match[1] || match[3]; // Capture variable or spread variable
            if (variable && !RESERVED_KEYWORDS.has(variable)) {
                results.push({
                    fileUri,
                    lineNumber: inputLineNumber,
                    variable,
                });
            }
        });
    }

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

// First part: Find assignment node text
export async function findCompleteLineText(
    fileUri: vscode.Uri,
    lineNumber: number,
    assignmentFlag: boolean = false
): Promise<string> {
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

    function visit(node: ts.Node): string {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();

        // Check if the node overlaps with the specified range
        if (start <= rangeEnd && end >= rangeStart) {
            // Ensure the node contains a valid assignment (complete sentence with "=")
            if (containsSingleCompleteSentence(node, sourceFile) && (!assignmentFlag || node.getText().includes('='))) {
                return node.getText(sourceFile); // Return the text of the matching node
            }
        }

        // Recursively visit child nodes
        for (const child of node.getChildren(sourceFile)) {
            const result = visit(child);
            if (result) {
                return result; // Return immediately if a valid result is found
            }
        }

        return ""; // No valid text found
    }

    return visit(sourceFile);
}

// Second part: Process the assignment text
function processAssignmentText(
    nodeText: string,
    inputVariable: string,
    fileUri: string,
    lineNumber: number
): { fileUri: string; lineNumber: number; variable: string }[] {
    const { left, right } = splitNodeByEqualSign(nodeText);
    const results = processOtherSide(left, right, inputVariable, fileUri, lineNumber);
    return results;
}

// Combined function using both parts
async function extractAssignments(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string
): Promise<{ fileUri: string; lineNumber: number; variable: string }[]> {
    const assignmentText = await findCompleteLineText(fileUri, lineNumber, true);
    if (assignmentText) {
        return processAssignmentText(assignmentText, inputVariable, fileUri.toString(), lineNumber);
    }
    return [];
}

// Main function to parse the file and extract assignments
export async function analyze(
    fileUri: vscode.Uri,
    lineNumber: number,
    inputVariable: string
) {

    const assignments = await extractAssignments(fileUri, lineNumber, inputVariable);
    return assignments;
}