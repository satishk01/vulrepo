#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { run, VERSION } from '../src/index.js';
import { DEFAULTS } from '../src/config.js';

const program = new Command();

program
  .name('secaudit')
  .description('Security code review combining AI models (AWS Bedrock, Anthropic, Google Gemini/Vertex, OpenRouter, Azure OpenAI, Ollama) with open-source non-LLM scanners (Semgrep, Bandit, gosec, Gitleaks, Trivy, OSV-Scanner, Checkov).\nRun AI only, scanners only, or both. BYOK + BYOT.')
  .version(VERSION, '-v, --version')
  .argument('[directory]', 'path to the code base folder to scan')
  .option('--mode <mode>', 'which engines to run: llm | scanners | both', 'llm')
  .option('-m, --models <list>', 'comma-separated model aliases or provider:modelId (e.g. bedrock-sonnet-4.5, opus-4.8, gemini-3.5-or, azure-gpt5.5, ollama-qwen). Run --list-models to see all.',
    (val) => val.split(',').map((s) => s.trim()).filter(Boolean), DEFAULTS.models)
  .option('-s, --scanners <list>', 'comma-separated non-LLM scanners to run (default: all). Run --list-scanners to see all.',
    (val) => val.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--list-models', 'print all built-in model aliases and their providers, then exit')
  .option('--list-scanners', 'print all supported non-LLM scanners and install hints, then exit')
  .option('-r, --region <region>', 'AWS region (Bedrock only)', DEFAULTS.region)
  .option('-p, --profile <name>', 'AWS named profile (otherwise uses default credential chain)')
  .option('-o, --out <dir>', 'output directory for the report', DEFAULTS.outputDir)
  .option('-c, --concurrency <n>', 'parallel model requests', (v) => parseInt(v, 10), DEFAULTS.concurrency)
  .option('--include <globs>', 'comma-separated include globs (default: all source files)',
    (val) => val.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--exclude <globs>', 'comma-separated extra ignore globs',
    (val) => val.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--max-files <n>', 'cap number of files analyzed (useful for trials)', (v) => parseInt(v, 10))
  .option('--dry-run', 'list files that would be analyzed, then exit (no API calls)')
  .option('-V, --verbose', 'log every file/model request as it starts and finishes')
  .option('-q, --quiet', 'suppress progress output')
  .addHelpText('after', `
Examples:
  ${pc.dim('# List every built-in model alias and its provider')}
  secaudit --list-models

  ${pc.dim('# Bedrock (retained default behaviour)')}
  secaudit ./my-app -m bedrock-sonnet-4.5

  ${pc.dim('# Anthropic API direct — Opus 4.8')}
  secaudit ./my-app -m opus-4.8

  ${pc.dim('# Google Gemini 3.5 (direct API key)')}
  secaudit ./my-app -m gemini-3.5

  ${pc.dim('# OpenRouter: GLM 5.2 + Claude 4.5 + Gemini 3.5 in one run')}
  secaudit ./my-app -m glm-5.2-or,anthropic-4.5-or,gemini-3.5-or

  ${pc.dim('# Azure OpenAI GPT-4 and GPT-5.5 (deployment names in config)')}
  secaudit ./my-app -m azure-gpt4,azure-gpt5.5

  ${pc.dim('# Local Ollama — no API key, no cloud')}
  secaudit ./my-app -m ollama-qwen

  ${pc.dim('# Mix providers in a single scan (cross-provider consensus)')}
  secaudit ./my-app -m bedrock-opus-4.8,gemini-3.5,glm-5.2-or

  ${pc.dim('# Any model by raw id: provider:modelId')}
  secaudit ./my-app -m "openrouter:z-ai/glm-5.2"

  ${pc.dim('# Non-LLM scanners only (no API key needed) — production deployment check')}
  secaudit ./my-app --mode scanners

  ${pc.dim('# Only specific scanners')}
  secaudit ./my-app --mode scanners -s semgrep,gitleaks,trivy

  ${pc.dim('# BOTH: AI review + scanners, merged into one report (most comprehensive)')}
  secaudit ./my-app --mode both -m opus-4.8

  ${pc.dim('# See all supported scanners and how to install them')}
  secaudit --list-scanners

Credentials are BYOK (bring your own key) via environment variables.
See README.md "Credentials (BYOK)" for the exact env var per provider.`);

program.parse();

const opts = program.opts();
const [directory] = program.args;

// --list-models: print the registry and exit (no directory needed).
if (opts.listModels) {
  const { MODEL_REGISTRY } = await import('../src/providers/registry.js');
  const byProvider = {};
  for (const [alias, { provider, modelId }] of Object.entries(MODEL_REGISTRY)) {
    (byProvider[provider] ||= []).push({ alias, modelId });
  }
  console.log(pc.bold('\n  Built-in model aliases (BYOK):\n'));
  for (const provider of Object.keys(byProvider)) {
    console.log('  ' + pc.cyan(provider));
    for (const { alias, modelId } of byProvider[provider]) {
      console.log(`    ${pc.white(alias.padEnd(22))} ${pc.dim(modelId)}`);
    }
    console.log('');
  }
  console.log(pc.dim('  Also accepted: "provider:modelId" (e.g. openrouter:z-ai/glm-5.2)'));
  console.log(pc.dim('  Override or add aliases in secaudit.config.json (see example).\n'));
  process.exit(0);
}

// --list-scanners: print supported non-LLM scanners and exit.
if (opts.listScanners) {
  const { listScanners, SCANNER_KINDS } = await import('../src/scanners/registry.js');
  console.log(pc.bold('\n  Supported non-LLM scanners (install the ones you want — BYOT):\n'));
  const byKind = {};
  for (const s of listScanners()) (byKind[s.kind] ||= []).push(s);
  for (const kind of Object.keys(SCANNER_KINDS)) {
    if (!byKind[kind]) continue;
    console.log('  ' + pc.cyan(SCANNER_KINDS[kind]));
    for (const s of byKind[kind]) {
      console.log(`    ${pc.white(s.id.padEnd(13))} ${pc.dim(s.languages)}`);
      console.log(`    ${' '.repeat(13)} ${pc.dim('install: ' + s.install)}`);
    }
    console.log('');
  }
  console.log(pc.dim('  Run scanners with:  secaudit <dir> --mode scanners'));
  console.log(pc.dim('  Or AI + scanners:   secaudit <dir> --mode both -m opus-4.8\n'));
  process.exit(0);
}

if (!directory) {
  console.error(pc.red('\n  Error: missing <directory> argument.'));
  console.error(pc.dim('  Run "secaudit --help" for usage, "--list-models" for AI models, or "--list-scanners" for scanners.\n'));
  process.exit(2);
}

run(directory, opts).then((res) => {
  if (res && res.ok === false) process.exit(2);
  process.exit(0);
}).catch((err) => {
  console.error(pc.red(`\nFatal: ${err.message}`));
  if (process.env.SECAUDIT_DEBUG) console.error(err.stack);
  process.exit(1);
});
