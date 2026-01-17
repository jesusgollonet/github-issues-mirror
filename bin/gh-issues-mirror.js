#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function usage(exitCode = 0) {
  const msg = `
Usage:
  gh-issues-mirror sync [repoPath] [--repo owner/name] [--since <iso>] [--verbose]

Notes:
  - Defaults to repoPath = current directory.
  - If --repo is not provided, it is inferred from git remote "origin".
  - Writes to <repoPath>/.github-mirror/
`;
  process.stdout.write(msg.trimStart() + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    command: null,
    repoPath: null,
    repoSlug: null,
    since: null,
    verbose: false,
  };

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    if (a === '--verbose' || a === '-v') {
      args.verbose = true;
      continue;
    }
    if (a === '--repo') {
      args.repoSlug = argv[++i];
      continue;
    }
    if (a.startsWith('--repo=')) {
      args.repoSlug = a.slice('--repo='.length);
      continue;
    }
    if (a === '--since') {
      args.since = argv[++i];
      continue;
    }
    if (a.startsWith('--since=')) {
      args.since = a.slice('--since='.length);
      continue;
    }
    rest.push(a);
  }

  args.command = rest[0] || null;
  args.repoPath = rest[1] || null;

  return args;
}

function padIssueNumber(num) {
  const s = String(num);
  return s.length >= 6 ? s : '0'.repeat(6 - s.length) + s;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonStringify(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fileExistsSync(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, { cwd, verbose } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} exited with code ${code}: ${stderr || stdout}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      if (verbose) {
        process.stderr.write(`\n[gh-issues-mirror] command failed: ${cmd} ${args.join(' ')}\n`);
      }
      reject(err);
    });
  });
}

async function inferRepoSlugFromGit(repoPath) {
  const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
  const url = stdout.trim();
  if (!url) throw new Error('Could not infer repo: git remote origin is empty');

  // ssh: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

  // https: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

  throw new Error(`Unsupported origin URL format: ${url}`);
}

async function ghApiJson(repoPath, apiPath, { paginate = true, verbose = false } = {}) {
  const args = ['api'];
  if (paginate) args.push('--paginate');
  args.push('-H', 'Accept: application/vnd.github+json');
  args.push(apiPath);

  if (verbose) process.stdout.write(`[gh-issues-mirror] gh ${args.join(' ')}\n`);
  const { stdout } = await run('gh', args, { cwd: repoPath, verbose });
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(statePath, state) {
  fs.writeFileSync(statePath, safeJsonStringify(state), 'utf8');
}

async function sync(repoPath, { repoSlug, since, verbose } = {}) {
  const absRepoPath = path.resolve(repoPath);

  if (!repoSlug) repoSlug = await inferRepoSlugFromGit(absRepoPath);
  if (!repoSlug || !repoSlug.includes('/')) throw new Error(`Invalid repo: ${repoSlug}`);

  const mirrorDir = path.join(absRepoPath, '.github-mirror');
  const issuesDir = path.join(mirrorDir, 'issues');
  ensureDirSync(issuesDir);

  const statePath = path.join(mirrorDir, 'state.json');
  const prevState = readState(statePath);

  const effectiveSince = since || prevState?.lastSuccessfulSyncAt || null;
  const sinceQs = effectiveSince ? `&since=${encodeURIComponent(effectiveSince)}` : '';

  const [owner, repo] = repoSlug.split('/');

  // REST issues endpoint includes PRs unless filtered (we keep them for v0)
  const issues = await ghApiJson(
    absRepoPath,
    `/repos/${owner}/${repo}/issues?state=all&per_page=100${sinceQs}`,
    { paginate: true, verbose }
  );

  if (!Array.isArray(issues)) throw new Error('Unexpected response: issues list is not an array');

  let updatedCount = 0;
  let commentsFetched = 0;

  for (const issue of issues) {
    if (!issue || typeof issue.number !== 'number') continue;

    const number = issue.number;
    const fileName = `${padIssueNumber(number)}.json`;
    const outPath = path.join(issuesDir, fileName);

    let comments = [];
    if (issue.comments && issue.comments > 0) {
      comments = await ghApiJson(
        absRepoPath,
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
        { paginate: true, verbose }
      );
      if (!Array.isArray(comments)) comments = [];
      commentsFetched += comments.length;
    }

    const payload = {
      schemaVersion: 1,
      fetchedAt: nowIso(),
      repo: repoSlug,
      issue,
      comments,
    };

    fs.writeFileSync(outPath, safeJsonStringify(payload), 'utf8');
    updatedCount++;
  }

  const nextState = {
    schemaVersion: 1,
    repo: repoSlug,
    lastRunAt: nowIso(),
    lastSuccessfulSyncAt: nowIso(),
    effectiveSince,
    stats: {
      fetchedIssues: issues.length,
      wroteIssueFiles: updatedCount,
      fetchedComments: commentsFetched,
    },
  };

  writeState(statePath, nextState);

  process.stdout.write(
    `[gh-issues-mirror] synced ${issues.length} issues/PRs (wrote ${updatedCount} files, comments ${commentsFetched})\n`
  );
  process.stdout.write(`[gh-issues-mirror] repo ${repoSlug} → ${path.relative(absRepoPath, mirrorDir)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) usage(1);

  if (args.command === 'sync') {
    const repoPath = args.repoPath || process.cwd();
    await sync(repoPath, {
      repoSlug: args.repoSlug,
      since: args.since,
      verbose: args.verbose,
    });
    return;
  }

  usage(1);
}

main().catch((err) => {
  process.stderr.write(`[gh-issues-mirror] error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
