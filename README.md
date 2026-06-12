# Git-Brain

Git-Brain is a local Node.js CLI assistant that generates professional commit messages from your staged Git diff using the Gemini API.

## Features

- `git-brain commit` reads `git diff --staged`
- Generates a conventional commit message via Gemini
- Shows a loader while the AI responds
- Prompts to accept, edit, or reject the commit message
- Automatically commits when accepted
- Stores your Gemini API key locally with `git-brain config`

## Installation

1. Install dependencies:

```bash
npm install
```

2. Link the CLI locally for development:

```bash
npm link
```

3. Save your Gemini API key:

```bash
git-brain config --key YOUR_API_KEY
```

> If you want to use OpenRouter as a fallback or primary provider, save a second key as well:
>
> ```bash
git-brain config --openrouter-key YOUR_OPENROUTER_API_KEY
> ```
>
> You can also save both keys together:
>
> ```bash
git-brain config --gemini-key YOUR_GEMINI_API_KEY --openrouter-key YOUR_OPENROUTER_API_KEY
> ```
>
> For Gemini free tier keys, use a free-tier model if needed:
>
> ```powershell
> $env:GEMINI_MODEL = "gemini-2.5-flash"
> git-brain commit
> ```
>
> Other free-tier-friendly options:
>
> ```powershell
> $env:GEMINI_MODEL = "gemini-2.5-flash-lite"
> git-brain commit
>
> $env:GEMINI_MODEL = "gemini-2.0-flash"
> git-brain commit
>
> $env:GEMINI_MODEL = "gemini-2.0-flash-lite"
> git-brain commit
> ```
>
> To use OpenRouter directly:
>
> ```powershell
> git-brain commit --provider openrouter --model "gpt-4o-mini"
> ```
>
> Or use a custom OpenRouter model name such as:
>
> ```powershell
> git-brain commit --provider openrouter --model "NVIDIA Llama Nemotron Rerank VL 1B V2"
> ```
>
> If you prefer environment variables:
>
> ```powershell
> $env:OPENROUTER_API_KEY = "YOUR_OPENROUTER_API_KEY"
> $env:OPENROUTER_MODEL = "NVIDIA Llama Nemotron Rerank VL 1B V2"
> git-brain commit --provider openrouter
> ```
>
> `git-brain` will use `apiKey` for Gemini and `openRouterApiKey` for OpenRouter if both are configured.
>
## Usage

Stage your changes, then run:

```bash
git-brain commit
```

## Tech Stack

- Node.js
- commander
- inquirer
- ora
- @google/generative-ai

