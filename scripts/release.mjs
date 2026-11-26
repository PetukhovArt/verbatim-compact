#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('usage: node scripts/release.mjs patch|minor|major');
  process.exit(1);
}

const manifestPath = 'plugin/.claude-plugin/plugin.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const [major, minor, patch] = manifest.version.split('.').map(Number);
const version =
  bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

const changelog = readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n');
const unreleased = changelog.match(/^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
if (!unreleased || !unreleased[1].trim()) {
  console.error('CHANGELOG.md: `## Unreleased` is empty, nothing to release');
  process.exit(1);
}
const date = new Date().toISOString().slice(0, 10);
writeFileSync('CHANGELOG.md', changelog.replace('## Unreleased\n', `## Unreleased\n\n## ${version} (${date})\n`));

manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

execFileSync('git', ['add', manifestPath, 'CHANGELOG.md'], { stdio: 'inherit' });
execFileSync('git', ['commit', '-m', `chore(release): ${version}`], { stdio: 'inherit' });
console.log(`release commit for ${version} is ready: push main, the Release workflow tags it and moves live`);
