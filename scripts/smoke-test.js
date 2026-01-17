#!/usr/bin/env node

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function run(args) {
  const bin = path.join(__dirname, '..', 'bin', 'gh-issues-mirror.js');
  const res = spawnSync('node', [bin, ...args], { encoding: 'utf8' });
  return res;
}

const res = run(['--help']);
if (res.status !== 0) {
  process.stderr.write(res.stderr || 'Expected --help to exit 0\n');
  process.exit(1);
}

process.stdout.write('ok\n');
