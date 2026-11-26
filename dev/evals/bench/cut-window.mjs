#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const [file, name] = args;
const bench = flag('bench', `${REPO}/out/bench`);
const nth = Number(flag('nth', 1));

const lines = readFileSync(file, 'utf8').split('\n');
const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
const boundaries = records.flatMap((r, i) => (r?.subtype === 'compact_boundary' ? [i + 1] : []));
const boundary = boundaries[nth - 1];
if (!boundary) throw new Error(`no boundary #${nth}; ${boundaries.length} found`);
const from = nth === 1 ? 1 : boundaries[nth - 2] + 1;
const lineOf = new Map(records.map((r, i) => [r?.uuid, i + 1]));
const parent = records[boundary - 1].logicalParentUuid;
const cut = lineOf.get(parent);
if (!cut || cut < from) throw new Error(`boundary ${boundary}: logical parent not in the window`);
const next = boundaries[nth] ?? lines.length;

const dir = join(bench, 'sessions', name);
mkdirSync(dir, { recursive: true });
const meta = { session_file: resolve(file).replace(/\\/g, '/'), window_from_line: from, cut_line: cut, boundary_line: boundary, after_to_line: next };
writeFileSync(join(dir, 'window.json'), `${JSON.stringify(meta, null, 2)}\n`);
const readable = `${REPO}/bench/jsonl-readable.mjs`;
console.log(execFileSync('node', [readable, file, String(from), String(cut), join(dir, 'window.txt')], { encoding: 'utf8' }).trim());
console.log(execFileSync('node', [readable, file, String(cut + 1), String(next), join(dir, 'after.txt')], { encoding: 'utf8' }).trim());
console.log(JSON.stringify(meta));
