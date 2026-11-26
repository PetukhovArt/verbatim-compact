#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const BENCH = resolve(flag('bench', join(dirname(fileURLToPath(import.meta.url)), '../out/bench')));
const out = resolve(flag('out', join(BENCH, 'runs2')));
const TIE = 0.02;
const CELL_NAME = { full: 'full', native: 'native', 'defaults@haiku': 'plugin' };
const CELLS = ['full', 'native', 'plugin'];
const MODES = [
  ['tools', 'quality', 'quality.json'],
  ['notools', 'qualityNoTools', 'quality-notools.json'],
];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '-');
const range = (xs, d = 3) => (xs.length > 1 ? `${fmt(mean(xs), d)} (${fmt(Math.min(...xs), d)}-${fmt(Math.max(...xs), d)})` : fmt(xs[0], d));
const table = (head, rows) => [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');

const rows = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const spend = { valid: sum(rows.filter((r) => !r.failed).map((r) => r.totalCostUsd ?? 0)), failed: sum(rows.filter((r) => r.failed).map((r) => r.totalCostUsd ?? 0)) };
const probesOf = new Map();
const probesFor = (session) => {
  if (!probesOf.has(session)) probesOf.set(session, readJson(join(BENCH, 'sessions', session, 'probes.json')));
  return probesOf.get(session);
};

const scoreOf = (grades) => mean(grades.map((g) => g.score));
const runDirs = (session) => {
  const root = join(out, session);
  return existsSync(root) ? readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, 'quality.json'))) : [];
};
const claimed = new Set();
function dirOf(row) {
  if (row.dir && existsSync(join(row.dir, 'quality.json'))) return row.dir;
  const prefix = row.cell.replace(/[@:]/g, '_');
  const found = runDirs(row.session).find((d) => {
    if (claimed.has(d)) return false;
    const name = d.split(/[\\/]/).pop();
    if (!name.startsWith(`${prefix}-`) || !/-\d+(-retry)?$/.test(name)) return false;
    if (name.slice(prefix.length + 1).replace(/^\d{4}-.*?Z-/, '').replace('-retry', '') !== String(row.index)) return false;
    return Math.abs(scoreOf(readJson(join(d, 'quality.json'))) - row.quality.score) < 1e-9;
  });
  if (found) claimed.add(found);
  return found;
}

const runs = [];
const seen = new Map();
for (const row of rows.filter((r) => !r.failed && CELL_NAME[r.cell])) {
  const dir = dirOf(row);
  if (!dir) {
    console.error(`no run dir for ${row.session} ${row.cell} ${row.index}`);
    continue;
  }
  const cell = CELL_NAME[row.cell];
  const key = `${row.session}/${cell}`;
  const repeat = seen.get(key) ?? 0;
  seen.set(key, repeat + 1);
  const questions = probesFor(row.session).questions;
  const categories = new Map(questions.map((q) => [q.id, q.category]));
  const usedAfterCut = new Map(questions.map((q) => [q.id, q.used_after_cut]));
  const graded = {};
  for (const [mode, , file] of MODES) {
    const path = join(dir, file);
    if (existsSync(path)) {
      graded[mode] = readJson(path).map((g) => ({ ...g, category: categories.get(g.id), usedAfterCut: usedAfterCut.get(g.id) }));
    }
  }
  runs.push({ row, session: row.session, cell, repeat, graded });
}

const sessions = [...new Set(runs.map((r) => r.session))].sort();
const repeatsOf = (cell) => Math.max(0, ...runs.filter((r) => r.cell === cell).map((r) => r.repeat + 1));
const handbackSessions = new Set(sessions.filter((s) => probesFor(s).handback_available === true));
const keepProbe = (run, g) => g.category !== 'hand-back' || handbackSessions.has(run.session);

function atRepeat(cell, i) {
  const n = repeatsOf(cell);
  return runs.filter((r) => r.cell === cell && r.repeat === (n === 1 ? 0 : i));
}

function poolScore(selected, mode, pick = () => true) {
  const grades = selected.flatMap((r) => (r.graded[mode] ?? []).filter((g) => keepProbe(r, g) && pick(g)));
  return { grades, score: mean(grades.map((g) => g.score)), wrong: grades.filter((g) => g.confident_wrong).length / (grades.length || NaN) };
}

function overall(mode) {
  const body = [];
  for (const cell of CELLS) {
    const n = Math.max(repeatsOf(cell), 1);
    const per = Array.from({ length: n }, (_, i) => poolScore(atRepeat(cell, i), mode));
    const used = Array.from({ length: n }, (_, i) => poolScore(atRepeat(cell, i), mode, (g) => g.usedAfterCut).score);
    const ident = Array.from({ length: n }, (_, i) => poolScore(atRepeat(cell, i), mode, (g) => g.category === 'identifier').score);
    const cellRows = runs.filter((r) => r.cell === cell).map((r) => r.row);
    const tokensBefore = sum(cellRows.map((r) => r.tokensBefore));
    const tokensAfter = sum(cellRows.map((r) => r.tokensAfter));
    body.push([
      cell,
      String(cellRows.length),
      range(per.map((p) => p.score)),
      range(used.filter(Number.isFinite)),
      range(ident.filter(Number.isFinite)),
      pct(mean(per.map((p) => p.wrong))),
      fmt(mean(cellRows.map((r) => r.tokensAfter)), 0),
      pct(1 - tokensAfter / tokensBefore),
      cell === 'full' ? '-' : fmt(mean(cellRows.map((r) => r.wallMs)) / 1000, 1),
      cell === 'full' ? '-' : fmt(mean(cellRows.map((r) => r.costUsd)), 4),
    ]);
  }
  return table(['cell', 'runs', 'probe score mean (min-max over repeats)', 'used-after-cut', 'identifier', 'confident-wrong', 'tokens after (mean)', 'reduction', 'compaction wall s', 'compaction $'], body);
}

function byCategory(mode) {
  const cats = ['identifier', 'decision', 'state', 'instruction', 'pointer', 'hand-back'];
  const body = cats.map((cat) => [
    cat,
    ...CELLS.map((cell) => {
      const n = Math.max(repeatsOf(cell), 1);
      const per = Array.from({ length: n }, (_, i) => poolScore(atRepeat(cell, i), mode, (g) => g.category === cat));
      const probes = Math.round(mean(per.map((p) => p.grades.length)));
      return `${range(per.map((p) => p.score))} [${probes}]`;
    }),
  ]);
  return table(['category [probes per repeat]', ...CELLS], body);
}

function toolUse() {
  const body = [];
  for (const cell of CELLS) {
    const list = runs.filter((r) => r.cell === cell && r.graded.tools && r.graded.notools);
    const q = list.map((r) => r.row.quality);
    const deltas = list.flatMap((r) => {
      const plain = new Map(r.graded.notools.map((g) => [g.id, g.score]));
      return r.graded.tools.filter((g) => keepProbe(r, g) && plain.has(g.id)).map((g) => g.score - plain.get(g.id));
    });
    body.push([
      cell,
      String(list.length),
      pct(q.filter((x) => x.toolCalls > 0).length / q.length),
      fmt(mean(q.map((x) => x.toolCalls)), 1),
      fmt(mean(q.map((x) => x.rereadChars)), 0),
      fmt(mean(deltas), 3),
      pct(deltas.filter((d) => d > 0).length / deltas.length),
      pct(deltas.filter((d) => d < 0).length / deltas.length),
      fmt(mean(q.map((x) => x.costUsd)) - mean(list.map((r) => r.row.qualityNoTools.costUsd)), 3),
    ]);
  }
  return table(['cell', 'answers', 'answers that opened a file', 'tool calls', 'chars read', 'per-probe gain from tools', 'probes better', 'probes worse', 'extra answer+grade $'], body);
}

function perSession(mode) {
  const body = [];
  const tally = { win: 0, loss: 0, tie: 0 };
  for (const s of sessions) {
    const get = (cell) => mean(runs.filter((r) => r.session === s && r.cell === cell).map((r) => poolScore([r], mode).score));
    const plugin = get('plugin');
    const native = get('native');
    const full = get('full');
    const delta = plugin - native;
    const verdict = Math.abs(delta) < TIE ? 'tie' : delta > 0 ? 'win' : 'loss';
    tally[verdict]++;
    const tokens = (cell) => mean(runs.filter((r) => r.session === s && r.cell === cell).map((r) => r.row.tokensAfter));
    body.push([s, fmt(full), fmt(native), fmt(plugin), fmt(delta, 3), verdict, `${fmt(tokens('native'), 0)} / ${fmt(tokens('plugin'), 0)}`]);
  }
  return `${table(['session', 'full', 'native', 'plugin', 'plugin - native', `verdict (tie < ${TIE})`, 'tokens after native / plugin'], body)}\n\nplugin vs native: ${tally.win} wins, ${tally.loss} losses, ${tally.tie} ties`;
}

console.log(`runs: ${runs.length} valid in ${sessions.length} sessions (${sessions.join(', ')}); hand-back counted in ${[...handbackSessions].join(', ')}`);
console.log(`spend: valid rows $${spend.valid.toFixed(2)}, failed attempts $${spend.failed.toFixed(2)}, total $${(spend.valid + spend.failed).toFixed(2)}\n`);
for (const [mode, label] of [['tools', 'with Read,Grep'], ['notools', 'no tools']]) {
  console.log(`## ${label}: overall\n\n${overall(mode)}\n\n### by category\n\n${byCategory(mode)}\n\n### per session\n\n${perSession(mode)}\n`);
}
console.log(`## tool use (paired)\n\n${toolUse()}`);
