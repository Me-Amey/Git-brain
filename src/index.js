const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.git-brain.json');
const DEFAULT_PROVIDER = 'gemini';
const PROVIDERS = ['gemini', 'openrouter'];
const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-pro',
  openrouter: 'gpt-4o-mini',
};
const FALLBACK_MODELS = {
  gemini: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-lite-001',
    'gemini-3.1-flash-lite',
  ],
  openrouter: [
    'gpt-4o-mini',
    'gpt-4o',
    'mistral-7b-instruct',
    'mistral-7b',
  ],
};
const DEFAULT_STYLE = 'conventional';
const MAX_PROMPT_DIFF_CHARS = 120000;
const MAX_PROMPT_DIFF_HEAD_LINES = 180;
const MAX_PROMPT_DIFF_TAIL_LINES = 60;

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

function resolveProvider(options = {}) {
  const config = loadConfig();
  const provider = options.provider || process.env.GIT_BRAIN_PROVIDER || config.provider || DEFAULT_PROVIDER;
  return String(provider).toLowerCase();
}

function resolveApiKey(provider) {
  const config = loadConfig();
  if (provider === 'openrouter') {
    return process.env.OPENROUTER_API_KEY || config.openRouterApiKey || config.apiKey || null;
  }

  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || config.apiKey || null;
}

function resolveModel(provider, options = {}) {
  const config = loadConfig();
  if (options.model) return options.model;

  if (provider === 'openrouter') {
    return process.env.OPENROUTER_MODEL || config.model || DEFAULT_MODELS.openrouter;
  }

  return process.env.GENERATIVE_MODEL || process.env.GEMINI_MODEL || config.model || DEFAULT_MODELS.gemini;
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    if (result.error.code === 'ENOBUFS') {
      throw new Error('Git command failed due to a large output buffer. Try staging fewer changes or use a smaller diff.');
    }
    throw result.error;
  }

  if (result.status !== 0) {
    const message = result.stderr ? result.stderr.toString().trim() : `git ${args.join(' ')} failed`;
    throw new Error(message);
  }

  return result.stdout.trim();
}

function getBranchName() {
  try {
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch || 'unknown-branch';
  } catch (error) {
    return 'unknown-branch';
  }
}

function getStagedDiff() {
  try {
    const diff = runGit(['diff', '--staged', '--no-color']);
    if (!diff) {
      throw new Error('No staged changes found. Stage files before running git-brain commit.');
    }
    return diff;
  } catch (error) {
    throw new Error(error.message || 'Unable to read staged git diff.');
  }
}

function truncateDiff(diff) {
  if (!diff || diff.length <= MAX_PROMPT_DIFF_CHARS) {
    return diff;
  }

  const lines = diff.split(/\r?\n/);
  if (lines.length <= MAX_PROMPT_DIFF_HEAD_LINES + MAX_PROMPT_DIFF_TAIL_LINES) {
    return diff.slice(0, MAX_PROMPT_DIFF_CHARS);
  }

  const head = lines.slice(0, MAX_PROMPT_DIFF_HEAD_LINES);
  const tail = lines.slice(-MAX_PROMPT_DIFF_TAIL_LINES);
  return `${head.join('\n')}

...TRUNCATED DIFF: only the first ${MAX_PROMPT_DIFF_HEAD_LINES} lines and last ${MAX_PROMPT_DIFF_TAIL_LINES} lines are included...

${tail.join('\n')}`;
}

function buildPrompt(diff, branch, style) {
  const cleanedDiff = truncateDiff(diff);
  const base = `You are an expert git commit assistant. Generate 3 distinct professional commit messages based on the following staged diff. Use a ${style} commit style if possible and keep them concise.
Return the result as a strict JSON array of strings. Do not include markdown code blocks, just the raw JSON array.

Branch: ${branch}

Diff:
${cleanedDiff}`;
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

function getModelCandidates(provider, initialModel) {
  const providerFallbacks = FALLBACK_MODELS[provider] || [];
  const candidates = [initialModel, ...providerFallbacks.filter((model) => model !== initialModel)];
  return Array.from(new Set(candidates.filter(Boolean)));
}

function shouldFallbackToOpenRouter(error) {
  const message = String(error.message || '').toLowerCase();
  return /too many requests|rate limit|quota exceeded|not found|unsupported|invalid model|unknown model|did not include|no output|no response|request failed/.test(message);
}

async function queryGeminiModel(diff, branch, style, apiKey, model) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const client = new GoogleGenerativeAI(apiKey);
  const prompt = buildPrompt(diff, branch, style);

  const request = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 500, temperature: 0.4 },
  };

  const modelInstance = client.getGenerativeModel({ model }, { apiVersion: 'v1' });
  const response = await modelInstance.generateContent(request);
  return extractMessage(response);
}

function openRouterRequest(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestBody = JSON.stringify(body);

    const options = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody, 'utf8'),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        const result = {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          text: async () => responseData,
          json: async () => {
            try {
              return JSON.parse(responseData);
            } catch (err) {
              throw new Error(`Invalid JSON response from OpenRouter: ${err.message}`);
            }
          },
        };

        if (result.ok) {
          resolve(result);
        } else {
          reject(new Error(`OpenRouter request failed: HTTP ${res.statusCode} ${res.statusMessage} - ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

async function queryOpenRouterModel(diff, branch, style, apiKey, model) {
  const prompt = buildPrompt(diff, branch, style);
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 500,
  };

  const response = await openRouterRequest(url, requestBody, apiKey);
  const data = await response.json();

  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (!content) {
    throw new Error('OpenRouter response did not include a model output.');
  }

  return extractMessage({ response: { text: () => String(content) } });
}

async function generateCommitMessages(provider, diff, branch, style, apiKey, model) {
  const oraPkg = require('ora');
  const ora = oraPkg.default || oraPkg;
  const spinner = ora(`Generating commit messages with ${provider}...`).start();
  const candidates = getModelCandidates(provider, model);
  let lastError = null;

  for (const candidateModel of candidates) {
    try {
      spinner.text = `Generating commit messages with ${provider} model ${candidateModel}...`;
      const generated = provider === 'openrouter'
        ? await queryOpenRouterModel(diff, branch, style, apiKey, candidateModel)
        : await queryGeminiModel(diff, branch, style, apiKey, candidateModel);

      spinner.succeed(`Commit messages generated with ${provider} model ${candidateModel}.`);
      return generated;
    } catch (error) {
      lastError = error;
      const message = String(error.message || '');
      const isRateLimit = /Too Many Requests|rate limit|quota exceeded/i.test(message);
      const isNotFound = /not found|unsupported|invalid model|unknown model/i.test(message);
      const isLastCandidate = candidateModel === candidates[candidates.length - 1];

      if (isLastCandidate || (!isRateLimit && !isNotFound)) {
        if (provider === 'gemini') {
          const openRouterKey = resolveApiKey('openrouter');
          if (openRouterKey && shouldFallbackToOpenRouter(error)) {
            spinner.succeed('All Gemini model attempts failed. Switching to OpenRouter fallback...');
            const openRouterModel = resolveModel('openrouter');
            return await generateCommitMessages('openrouter', diff, branch, style, openRouterKey, openRouterModel);
          }
        }

        spinner.fail('Failed to generate commit messages.');
        if (isRateLimit) {
          throw new Error('Quota exceeded. Wait a few seconds and try again, or set a lower-cost model.');
        }
        throw error;
      }

      spinner.text = `Model ${candidateModel} failed; trying fallback model...`;
    }
  }

  spinner.fail('Failed to generate commit messages.');
  throw lastError || new Error('Unable to generate commit messages.');
}

async function runCommit(message) {
  try {
    const result = spawnSync('git', ['commit', '-m', message], { stdio: 'inherit', shell: false });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error('Git commit failed. Make sure your repository is clean and the staged diff still exists.');
    }
  } catch (error) {
    throw new Error('Git commit failed. Make sure your repository is clean and the staged diff still exists.');
  }
}

async function handleCommit(options) {
  const inquirer = require('inquirer');
  const provider = resolveProvider(options);

  if (!PROVIDERS.includes(provider)) {
    console.error(`Error: Unsupported provider '${provider}'. Use 'gemini' or 'openrouter'.`);
    process.exitCode = 1;
    return;
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    console.error(`Error: ${provider === 'openrouter' ? 'OpenRouter' : 'Gemini'} API key not found. ` +
      `Run \`git-brain config --provider ${provider} --key <API_KEY>\` or set ${provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY'}.`);
    process.exitCode = 1;
    return;
  }

  let diff;
  try {
    diff = getStagedDiff();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const branch = getBranchName();
  const style = options.style || DEFAULT_STYLE;
  const model = resolveModel(provider, options);

  let generated;
  try {
    generated = await generateCommitMessages(provider, diff, branch, style, apiKey, model);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
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

  const provider = (options.provider || config.provider || DEFAULT_PROVIDER).toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    console.error(`Error: Unsupported provider '${options.provider}'. Use 'gemini' or 'openrouter'.`);
    process.exitCode = 1;
    return;
  }

  const isProviderKeyMode = Boolean(options.key) || Boolean(options.geminiKey) || Boolean(options.openrouterKey);

  if (isProviderKeyMode) {
    if (options.key) {
      if (provider === 'openrouter') {
        config.openRouterApiKey = options.key;
      } else {
        config.apiKey = options.key;
      }
    }

    if (options.geminiKey) {
      config.apiKey = options.geminiKey;
    }

    if (options.openrouterKey) {
      config.openRouterApiKey = options.openrouterKey;
    }

    if (options.provider) {
      config.provider = provider;
    }

    if (options.model) {
      config.model = options.model;
    }

    saveConfig(config);

    const savedKeys = [];
    if (options.key) savedKeys.push(`${provider} key`);
    if (options.geminiKey) savedKeys.push('Gemini key');
    if (options.openrouterKey) savedKeys.push('OpenRouter key');
    console.log(`Saved ${savedKeys.join(' and ')} to ${CONFIG_PATH}`);
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Which provider do you want to use?',
      choices: PROVIDERS,
      default: provider,
    },
    {
      type: 'password',
      name: 'apiKey',
      message: (answers) => `Enter your ${answers.provider === 'openrouter' ? 'OpenRouter' : 'Gemini'} API key:`,
      mask: '*',
      validate: (value) => Boolean(value) || 'API key is required.',
    },
    {
      type: 'input',
      name: 'model',
      message: 'Optional model name (press enter to use default):',
      default: (answers) => answers.provider === 'openrouter' ? DEFAULT_MODELS.openrouter : DEFAULT_MODELS.gemini,
    },
    {
      type: 'confirm',
      name: 'addOtherKey',
      message: 'Would you like to configure the other provider API key as well?',
      default: false,
    },
    {
      type: 'password',
      name: 'otherApiKey',
      message: (answers) => answers.provider === 'openrouter'
        ? 'Enter your Gemini API key:'
        : 'Enter your OpenRouter API key:',
      when: (answers) => answers.addOtherKey,
      mask: '*',
      validate: (value) => Boolean(value) || 'API key is required.',
    },
  ]);

  config.provider = answers.provider;
  config.model = answers.model || DEFAULT_MODELS[answers.provider];

  if (answers.provider === 'openrouter') {
    config.openRouterApiKey = answers.apiKey;
    if (answers.addOtherKey) {
      config.apiKey = answers.otherApiKey;
    }
  } else {
    config.apiKey = answers.apiKey;
    if (answers.addOtherKey) {
      config.openRouterApiKey = answers.otherApiKey;
    }
  }

  saveConfig(config);
  console.log(`Saved ${answers.provider} API key to ${CONFIG_PATH}`);
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
    .option('-p, --provider <provider>', 'AI provider: gemini or openrouter', DEFAULT_PROVIDER)
    .option('--model <model>', 'Override the model name to use')
    .option('--no-commit', 'do not run git commit, only generate the message')
    .action(async (options) => {
      await handleCommit(options);
    });

  program.command('config')
    .description('Store Git-Brain settings locally')
    .option('--provider <provider>', 'Provider to configure: gemini or openrouter')
    .option('--model <model>', 'Optional default model name for the configured provider')
    .option('--key <key>', 'API key to save for the selected provider')
    .option('--gemini-key <key>', 'Gemini API key to save')
    .option('--openrouter-key <key>', 'OpenRouter API key to save')
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
  runCommit,
  handleCommit,
  handleConfig,
  main,
  run,
};
