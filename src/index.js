const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.git-brain.json');
const DEFAULT_MODEL = 'gemini-1.5-pro';
const DEFAULT_STYLE = 'conventional';

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(data || '{}');
  } catch (error) {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function resolveApiKey() {
  const config = loadConfig();
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || config.apiKey || null;
}

function getBranchName() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return branch || 'unknown-branch';
  } catch (error) {
    return 'unknown-branch';
  }
}

function getStagedDiff() {
  try {
    const diff = execSync('git diff --staged --no-color', { encoding: 'utf8' }).trim();
    if (!diff) {
      throw new Error('No staged changes found. Stage files before running git-brain commit.');
    }
    return diff;
  } catch (error) {
    throw new Error(error.message || 'Unable to read staged git diff.');
  }
}

function buildPrompt(diff, branch, style) {
  const base = `You are an expert git commit assistant. Generate 3 distinct professional commit messages based on the following staged diff. Use a ${style} commit style if possible and keep them concise.
Return the result as a strict JSON array of strings. Do not include markdown code blocks, just the raw JSON array.

Branch: ${branch}

Diff:
${diff}`;
  return base;
}

function extractMessage(result) {
  try {
    const text = result.response.text().trim();
    let jsonStr = text.replace(/^```(json)?\r?\n?/, '').replace(/\r?\n?```$/, '');
    jsonStr = jsonStr.replace(/\\n/g, '\n');
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
    return [text];
  } catch (err) {
    // Fallback if not valid JSON
    return [result.response.text().trim()];
  }
}

async function queryGemini(diff, branch, style, apiKey) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const ora = require('ora');

  const spinner = ora('Generating commit messages with Gemini...').start();

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: DEFAULT_MODEL });
    const prompt = buildPrompt(diff, branch, style);
    
    const request = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.4 }
    };
    
    const response = await model.generateContent(request);
    spinner.succeed('Commit messages generated.');
    return extractMessage(response);
  } catch (error) {
    spinner.fail('Failed to generate commit messages.');
    throw error;
  }
}

async function runCommit(message) {
  try {
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  } catch (error) {
    throw new Error('Git commit failed. Make sure your repository is clean and the staged diff still exists.');
  }
}

async function handleCommit(options) {
  const inquirer = require('inquirer');
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error('Error: Gemini API key not found. Run `git-brain config --key <API_KEY>` or set GEMINI_API_KEY.');
    process.exit(1);
  }

  let diff;
  try {
    diff = getStagedDiff();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  const branch = getBranchName();
  const style = options.style || DEFAULT_STYLE;

  let generated;
  try {
    generated = await queryGemini(diff, branch, style, apiKey);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  let selectedMessage;
  if (Array.isArray(generated) && generated.length > 1) {
    const choices = generated.map(msg => ({ name: msg, value: msg }));
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'Select a commit message:',
      choices
    }]);
    selectedMessage = choice;
  } else {
    selectedMessage = Array.isArray(generated) ? generated[0] : generated;
  }

  console.log('\nSelected commit message:\n');
  console.log(selectedMessage);
  console.log('');

  const { decision } = await inquirer.prompt([{ type: 'list', name: 'decision', message: 'Accept this commit message?', choices: [
    { name: 'Yes, commit it', value: 'yes' },
    { name: 'Edit the message', value: 'edit' },
    { name: 'No, print only', value: 'no' },
  ] }]);

  if (decision === 'edit') {
    const { edited } = await inquirer.prompt([{ type: 'input', name: 'edited', message: 'Enter the commit message:', default: selectedMessage }]);
    if (!edited || !edited.trim()) {
      console.error('Commit message cannot be empty. Aborting.');
      process.exit(1);
    }
    if (!options.noCommit) {
      await runCommit(edited.trim());
    }
    return;
  }

  if (decision === 'yes') {
    if (options.noCommit) {
      console.log('Auto-commit skipped due to --no-commit.');
      return;
    }
    await runCommit(selectedMessage);
    return;
  }

  console.log('Commit skipped.');
}

async function handleConfig(options) {
  const inquirer = require('inquirer');
  const config = loadConfig();

  if (options.key) {
    config.apiKey = options.key;
    saveConfig(config);
    console.log(`Saved Gemini API key to ${CONFIG_PATH}`);
    return;
  }

  const { apiKey } = await inquirer.prompt([{ type: 'password', name: 'apiKey', message: 'Enter your Gemini API key:', mask: '*', validate: (value) => Boolean(value) || 'API key is required.' }]);
  config.apiKey = apiKey;
  saveConfig(config);
  console.log(`Saved Gemini API key to ${CONFIG_PATH}`);
}

async function main() {
  const { Command } = require('commander');
  const program = new Command();

  program
    .name('git-brain')
    .description('AI-powered commit message assistant for Git')
    .version('0.1.0');

  program.command('commit')
    .description('Generate a commit message for staged changes')
    .option('-s, --style <style>', 'commit style: conventional or emoji', DEFAULT_STYLE)
    .option('--no-commit', 'do not run git commit, only generate the message')
    .action(async (options) => {
      await handleCommit(options);
    });

  program.command('config')
    .description('Store Git-Brain settings locally')
    .option('--key <key>', 'Gemini API key to save')
    .action(async (options) => {
      await handleConfig(options);
    });

  if (process.argv.length <= 2) {
    program.help();
  }

  await program.parseAsync(process.argv);
}

async function run() {
  try {
    await main();
  } catch (error) {
    console.error(`Unexpected error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  buildPrompt,
  extractMessage,
  getBranchName,
  getStagedDiff,
  resolveApiKey,
  queryGemini,
  runCommit,
  handleCommit,
  handleConfig,
  main,
  run,
};
