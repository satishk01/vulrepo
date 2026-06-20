#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { run, VERSION } from '../src/index.js';
import { DEFAULTS } from '../src/config.js';

const program = new Command();

program
  .name('secaudit')
  .description('Deep AI-powered security code review using Claude on AWS Bedrock.\nFinds logic & architectural vulnerabilities that SAST/DAST scanners miss.')
  .version(VERSION, '-v, --version')
  .argument('<directory>', 'path to the code base folder to scan')
  .option('-m, --models <list>', 'comma-separated models/aliases (sonnet-4.5, opus-4.6, fable-5, or a raw Bedrock ID)',
    (val) => val.split(',').map((s) => s.trim()).filter(Boolean), DEFAULTS.models)
  .option('-r, --region <region>', 'AWS region for Bedrock', DEFAULTS.region)
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
  ${pc.dim('# Quick scan with the default model (Sonnet 4.5)')}
  secaudit ./my-app

  ${pc.dim('# Deep multi-model scan, custom output folder')}
  secaudit "C:\\\\code\\\\customer-app" -m sonnet-4.5,opus-4.6,fable-5 -o ./audit-out

  ${pc.dim('# See what would be scanned without spending tokens')}
  secaudit ./my-app --dry-run

  ${pc.dim('# Use a named AWS profile and a specific region')}
  secaudit ./my-app -p security-audit -r us-west-2

Before first use, configure AWS credentials and enable Bedrock model access.
See README.md for full setup instructions.`);

program.parse();

const opts = program.opts();
const [directory] = program.args;

run(directory, opts).then((res) => {
  if (res && res.ok === false) process.exit(2);
  process.exit(0);
}).catch((err) => {
  console.error(pc.red(`\nFatal: ${err.message}`));
  if (process.env.SECAUDIT_DEBUG) console.error(err.stack);
  process.exit(1);
});
