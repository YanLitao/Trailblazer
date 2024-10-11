import * as vscode from 'vscode';
import { window } from 'vscode';

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatMessageHistory } from "langchain/stores/message/in_memory";

// Get OpenAI API key from the environment.
// I had to export the OPENAI_API_KEY variable from the shell, and then launch
// vscode (with the "code" command after I did to get it to register.)
const API_KEY = process.env.OPENAI_TOKEN;

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "search-copilot" is now active!');
	const disposable = vscode.commands.registerCommand('search-copilot.helloWorld', () => {
		vscode.window.showInformationMessage('search-copilot was initialized');
		askQuestionAboutCode();
	});
	context.subscriptions.push(disposable);
}

function askQuestionAboutCode() {
	// Get current selection
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}
	const selection = editor.selection;
	const line = editor.document.lineAt(selection.start.line);
	const code = line.text;

	// Get user's question...
	getQuestion(code).then(query => {
		if (query === undefined) {
			return;
		}
		// And then launch an agent to look for an answer.
		new Agent().go(query, new vscode.Location(editor.document.uri, selection));
	});
}

async function getQuestion(code: string) {
	return window.showInputBox({
		placeHolder: "What do you want to ask about this code?",
		prompt: `The line of code is ${code}`
	});
}

type Reference = {
	location: vscode.Location;
	context: string;
}

class Agent {
	private _model: ChatOpenAI;
	private _goals: string[] = []; // stack
	private _state: string = "idle";
	private _chatHistory: ChatMessageHistory = new ChatMessageHistory();

	private _currentDocUri: vscode.Uri | null = null;
	private _currentLine: number = -1;
	private _currentQuestion: string | null = null;

	constructor() {
		this._model = new ChatOpenAI({
			model: "gpt-4o-mini",
			apiKey: API_KEY,
		});
	}

	// Helper for us to just log what the agent is doing at any given time.
	async _updateState(state: string, ...extras: string[]) {
		console.log("\n");
		console.log("Agent is: " + state.toUpperCase() + ".");
		this._state = state;
		for (const extra of extras) {
			console.log("↳ Extra info: " + extra);
		}
	}

	async go(question: string, location: vscode.Location) {
		// Do console logging throughout.
		// Start history for chat.
		// TODO: factor this out into an implementation that doesn't upload the complete history
		// every time a query is made. For instance, use the OpenAI assistants API
		// for LangChain: https://python.langchain.com/v0.1/docs/modules/agents/agent_types/openai_assistants/
		this._chatHistory = new ChatMessageHistory();

		// Step 1: Prime the agent. Tell it what it is.
		this._currentQuestion = question;
		this._currentLine = location.range.start.line;
		this._currentDocUri = location.uri;

		this._updateState("priming model");
		await this._primeModel();
		await this._doSearchLoop();
	}

	async _doSearchLoop() {
		// Step 2: Provide the context of the current goal.
		if (this._currentDocUri === null || this._currentLine === -1) return;
		this._updateState("reading code");
		const codeContext = await this._getCodeContext(this._currentDocUri, this._currentLine);
		await this._giveModelCodeContext(codeContext);

		// Step 3: Ask if there is an answer to the question.
		if (this._currentQuestion === null) return;
		this._updateState("checking if my question is answered", "Question: " + this._currentQuestion);
		const response = await this._isQuestionAnswered(this._currentQuestion);
		if (response.toLowerCase().indexOf("yes") !== -1) {
			this._updateState("found answer",
				"Location " + this._currentDocUri + ":" + this._currentLine,
				"Answer: " + response);
			return;
		}

		// TODO(andrewhead): get this to be stateful.
		// One way is to maybe use agents: https://python.langchain.com/v0.1/docs/modules/agents/agent_types/openai_assistants/
		// Can also use RunnableHistory, good enough for prototype, but probably expensive.
		// Step 4: Ask for a smaller, tightly-focused question.
		this._updateState("question not yet answered");
		this._updateState("refining question");
		const refinedQuestion = await this._refineQuestion();
		this._currentQuestion = refinedQuestion;

		// Step 5: Map it to a VSCode action.
		this._updateState("deciding on how to look up more information", "refined question: " + refinedQuestion);
		const action = await this._pickVscodeAction(refinedQuestion, codeContext);

		// Step 6: Execute with VSCode APIs.
		if (this._currentDocUri === null) return;
		if (action.indexOf("Find references") === -1 && action.indexOf("Go to definition") === -1) {
			console.log("Not sure how to handle VSCode action: " + action + ", quitting now.");
			return;
		}

		let references: Reference[] = [];
		this._updateState("looking up references", "action: " + action);
		if (action.indexOf("Find references") !== -1) {
			const variableName = action.match(/Find references to (.*)\./)?.[1];
			if (variableName) {
				const offset = codeContext.indexOf(variableName);
				if (offset === -1) {
					console.log("Variable name not found in the code context: " + variableName + "\nin: " + this._currentDocUri + ", line: " + this._currentLine + "\nCode: " + codeContext);
					return; // Exit or handle the case where the variable is not found.
				}
				console.log(variableName + " found at offset: " + offset + " in code context: " + codeContext);
				const pos = new vscode.Position(this._currentLine - 3, 0).translate(0, offset);
				const loc = new vscode.Location(this._currentDocUri, pos);
				if (loc) {
					// I learned about this way to get references from:
					// https://stackoverflow.com/a/61163986/2096369
					// This link also suggests a couple of additional useful APIs that are
					// do more sophisticated code analysis for TypeScript, including the
					// Typescript language service API and the Compiler API.
					// We should familiarize ourselves with them and maybe use them later.
					const referenceLocation = await vscode.commands.executeCommand(
						'vscode.executeReferenceProvider', loc.uri, loc.range.start);
					if (referenceLocation !== undefined) {
						for (const r of referenceLocation as vscode.Location[]) {
							const line = r.range.start.line;
							if (line >= 0) {
								references.push({
									location: r,
									context: await this._getCodeContext(r.uri, line),
								});
							} else {
								console.log("Invalid line number found: " + line);
							}
						}
					}
				}
			}
		} else if (action.indexOf("Go to definition") !== -1) {
			const symbolName = action.match(/Go to definition of (.*)\./)?.[1];
			if (symbolName) {
				const offset = codeContext.indexOf(symbolName);
				if (offset === -1) {
					console.log("Symbol name not found in the code context: " + symbolName + "\nin: " + this._currentDocUri + ", line: " + this._currentLine + "\nCode: " + codeContext);
					return; // Exit or handle the case where the symbol is not found.
				}
				console.log(symbolName + " found at offset: " + offset + " in code context: " + codeContext);
				const pos = new vscode.Position(this._currentLine - 3, 0).translate(0, offset);
				const loc = new vscode.Location(this._currentDocUri, pos);
				if (loc) {
					const definitionLocation = await vscode.commands.executeCommand(
						'vscode.executeDefinitionProvider', loc.uri, loc.range.start);

					if (definitionLocation !== undefined) {
						for (const d of definitionLocation as vscode.LocationLink[]) {

							const targetUri = d.targetUri;
							const targetRange = d.targetRange.start;  // Extract the start line of the targetRange

							references.push({
								location: new vscode.Location(targetUri, new vscode.Range(
									new vscode.Position(targetRange.line, targetRange.character),
									new vscode.Position(targetRange.line, targetRange.character)
								)),
								context: await this._getCodeContext(targetUri, targetRange.line),
							});
						}
					}
				}
			}
		}
		console.log("Reference: " + JSON.stringify(references, null, 4));
		// Step 7: If there are references, select one result to open.
		if (references.length > 0) {
			let reference = references[0];
			if (references.length > 1) {
				this._updateState("deciding which reference to follow", "found " + references.length + " references");
				reference = await this._pickReference(references);
			}

			// Step 8: Get context for the result.
			this._currentDocUri = reference.location.uri;
			this._currentLine = reference.location.range.start.line;

			// Continue with the search loop
			this._doSearchLoop();
		} else {
			console.log("No references found, cannot proceed further.");
			this._updateState("no references found");
		}

		// Step 9: Loop back to step 2.
		this._doSearchLoop();
	}

	async _prompt(...messages: (SystemMessage | HumanMessage)[]): Promise<string> {
		this._chatHistory.addMessages(messages);
		const result = await this._model.invoke(await this._chatHistory.getMessages());
		const parser = new StringOutputParser();
		const response = await parser.invoke(result);
		this._chatHistory.addMessage(new AIMessage(response));
		return response;
	}

	async _primeModel() {
		return this._prompt(new SystemMessage(
			"You are an agent that searches through a code base on the user's behalf. " +
			"I am about to ask you a few questions to guide the search through the code." +
			"I will not be providing any other context before asking these questions and " +
			"do not yet want a response."));
	}

	async _getCodeContext(uri: vscode.Uri, line: number): Promise<string> {
		return vscode.workspace.openTextDocument(uri).then(doc => {
			const range = new vscode.Range(line - 3, 0, line + 4, 0);
			return doc.getText(range);
		});
	}

	async _giveModelCodeContext(code: string) {
		return this._prompt(new HumanMessage(
			"I have this code snippet:\n\n" + code + "\n\n. I do not yet want a response."
		));
	}

	async _isQuestionAnswered(question: string): Promise<string> {
		return await this._prompt(
			new HumanMessage(
				"I have this question about the code, which I will refer to below as the 'search question':\n" +
				question + "\n\n"),
			new HumanMessage(
				"Does this code snippet answer my search question? " +
				"If no, then just answer 'no'. If yes, " +
				"answer 'yes' and then elaborate on the answer."
			)
		);
	}

	async _refineQuestion(): Promise<string> {
		await this._prompt(new HumanMessage(
			"Please elaborate in one or two sentences as to why this does not yet answer my question."));
		// TODO (update this to just be much more aligned with the kinds of searches that can be done).
		return this._prompt(new HumanMessage(
			"What is a smaller, tightly-focused question I should first answer by searching through " +
			"the code to answer my larger search question? Output only the question and nothing else."));
	}

	async _pickVscodeAction(question: string, codeContext: string): Promise<string> {
		return this._prompt(new HumanMessage(
			"I have the following code context:\n\n" + codeContext +
			"\n\nHow should I use the editor to find information to answer the following question: '" + question + "'?" +
			"\n\nHere are your option templates. Choose one of those templates, and " +
			"respond with it exactly, substituting in the part in '[]' (square brackets) " +
			"with a symbol from the provided code context that is most relevant to the question.\n\n" +
			"Option 1. Find references to [symbol in snippet].\n" +
			"Option 2. Go to definition of [symbol in snippet].\n" +
			"Option 3. Something else: [provide suggestion]."
		));
	}

	async _pickReference(references: Reference[]): Promise<Reference> {
		// Format the references for the agent
		let referenceDescriptions = references.map((ref, index) => {
			return `Reference ${index}:\nLocation: ${ref.location.uri.fsPath}, line ${ref.location.range.start.line}\nContext: ${ref.context}\n\n`;
		}).join("\n");

		// Include the current question in the prompt
		const promptMessage =
			"I have the following references from the code that might help answer the question: '" + this._currentQuestion + "'.\n" +
			"Each reference has a location and some surrounding code context. Please choose the best reference for further exploration by returning the number corresponding to the best option.\n\n" +
			referenceDescriptions +
			"Return the index of the reference you think is the best to explore next, between 0 and " + (references.length - 1) + ".";

		// Prompt the agent to pick the best reference
		const response = await this._prompt(
			new HumanMessage(promptMessage)
		);

		// Parse the response as an integer and return the corresponding reference
		const selectedIndex = parseInt(response, 10);
		if (!isNaN(selectedIndex) && selectedIndex >= 0 && selectedIndex < references.length) {
			return references[selectedIndex];
		} else {
			console.log("Invalid index received from agent, defaulting to the first reference.");
			return references[0]; // Fallback to the first reference in case of error
		}
	}
}


// This method is called when your extension is deactivated
export function deactivate() { }

/*
 * Note for the future... we want the agent to be able to...
 * * Look up type of a variable.
 * * Look up callers of this function.
 * * Decide between callers.
 * * Look up the definition of a variable.
 * * Look up references to this variable.
 * * (and a lot more... we'll add more later)
 *
 * These goals roughly correspond to actions it can take.
 *
 * Given its goal, it needs to make decisions, namely:
 * * which of multiple options does it look at next...
 * * what action should it take next?
 *
 * The example I will work with is: find an example of an initialization of a visibleRangeProvider.
 */

// Maybe use this later: this is a function that I think can be used to
// find references to a particular function.
// function lookUpCallers(docUri: vscode.Uri, variableLoc: vscode.Location) {
// 	vscode.commands.executeCommand('editor.action.findReferences', docUri, variableLoc.range.start).then(references => {
// 		const referenceList: vscode.Location[] = references as vscode.Location[];
// 		referenceList.forEach(reference => {
// 			// Iterate over each reference and perform desired actions
// 			// For example, you can get the line of code where the reference is and display it
// 			vscode.workspace.openTextDocument(reference.uri).then(doc => {
// 				const line = doc.lineAt(reference.range.start.line);
// 				console.log("Found reference: " + line.text);
// 			});
// 		});
// 	});
// }