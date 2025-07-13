# Trailblazer

Trailblazer is a VS Code extension that helps you understand and explore code bases using AI-powered analysis. It provides intelligent code exploration capabilities to answer questions about your codebase.

## Prerequisites

- Visual Studio Code 1.91.1 or later
- Node.js and npm installed
- OpenAI API key

## Installation

### Step 1: Clone and Build the Extension

1. Clone this repository:
   ```bash
   git clone https://github.com/YanLitao/Search_Copilot.git
   cd Search_Copilot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Compile the TypeScript code:
   ```bash
   npm run compile
   ```

### Step 2: Install the Extension in VS Code

1. Open VS Code
2. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS) to open the Command Palette
3. Type "Extensions: Install from VSIX..." and select it
4. Navigate to the project folder and select the generated `.vsix` file, or:

**Alternative method:**
1. Open VS Code
2. Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`)
3. Click the three dots menu (⋯) at the top of the Extensions view
4. Select "Install from VSIX..."
5. Browse to the project directory and select the `.vsix` file

**For Development:**
1. Open the project folder in VS Code
2. Press `F5` to launch a new Extension Development Host window with the extension loaded

## Setup

### Getting an OpenAI API Key

1. Visit [OpenAI's website](https://platform.openai.com/)
2. Sign up for an account or log in if you already have one
3. Navigate to the [API Keys section](https://platform.openai.com/api-keys)
4. Click "Create new secret key"
5. Copy the generated API key (keep it secure!)

### Setting the Environment Variable

#### On Windows:

**Method 1: System Environment Variables**
1. Press `Win + R`, type `sysdm.cpl`, and press Enter
2. Click "Environment Variables..."
3. Under "User variables" or "System variables", click "New..."
4. Set Variable name: `OPENAI_TOKEN`
5. Set Variable value: your OpenAI API key
6. Click OK and restart VS Code

**Method 2: Command Prompt**
```cmd
setx OPENAI_TOKEN "your-api-key-here"
```

#### On macOS/Linux:

**Method 1: Terminal (temporary)**
```bash
export OPENAI_TOKEN="your-api-key-here"
code
```

**Method 2: Shell Profile (permanent)**
1. Open your shell profile file:
   ```bash
   # For bash
   nano ~/.bashrc
   # For zsh (default on macOS)
   nano ~/.zshrc
   ```

2. Add this line at the end:
   ```bash
   export OPENAI_TOKEN="your-api-key-here"
   ```

3. Save the file and reload your shell:
   ```bash
   source ~/.bashrc  # or ~/.zshrc
   ```

4. Restart VS Code

## Usage

### Opening Trailblazer

1. After installation, you'll see the Trailblazer icon in the Activity Bar (left sidebar)
2. Click the Trailblazer icon to open the sidebar panel
3. Alternatively, use the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type "Ask Trailblazer a question"

### Using Trailblazer

1. **Select Code**: Highlight the code you want to explore in your editor
2. **Ask Questions**: In the Trailblazer sidebar, type your question about the selected code
3. **Explore**: Trailblazer will analyze your code and provide insights, showing:
   - Variable definitions and references
   - Function calls and dependencies
   - Code flow and relationships
   - Interactive exploration graph

### Example Questions

- "What does this function do?"
- "Where is this variable used?"
- "How does this component work?"
- "What are the dependencies of this function?"
- "Trace the execution flow of this code"

### Features

- **Intelligent Code Analysis**: AI-powered understanding of your codebase
- **Interactive Exploration**: Visual graph of code relationships
- **Multi-step Investigation**: Follows code paths and dependencies
- **Contextual Insights**: Provides relevant code snippets and explanations

## Troubleshooting

### Common Issues

**Extension not loading:**
- Ensure VS Code version 1.91.1 or later
- Check that the extension was installed correctly
- Try restarting VS Code

**API Key issues:**
- Verify your OpenAI API key is correct
- Ensure the `OPENAI_TOKEN` environment variable is set
- Restart VS Code after setting the environment variable
- Check your OpenAI account has sufficient credits

**No response from AI:**
- Check your internet connection
- Verify your OpenAI API key is valid and has credits
- Try asking a simpler question first

### Getting Help

If you encounter issues:
1. Check the VS Code Developer Console (`Help > Toggle Developer Tools`)
2. Look for error messages in the console
3. Ensure all prerequisites are met
4. Verify your OpenAI API key is working

## Development

To contribute or modify the extension:

1. Clone the repository
2. Install dependencies: `npm install`
3. Make your changes
4. Compile: `npm run compile`
5. Test in the Extension Development Host (`F5`)

## License

See the LICENSE file for details.