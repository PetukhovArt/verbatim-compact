#!/usr/bin/env node
// Offline scan, no model calls: token reduction and an evidence-survival proxy per
// session x rule-only config. A probe question's key strings (the whole answer when it
// is a short exact one, else its identifier-like tokens) that the uncompacted context
// holds count as survived when the compacted context still holds them.
//   node bench/scan.mjs [--bench DIR] [--sessions a,b] [--configs x,y]
//   node bench/scan.mjs --check RUNDIR   proxy vs graded score of a run's cells
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGS } from './configs.mjs';
import { compactLib, stateLib } from './lib.mjs';
import { queuedPromptsOption, rebuild, renderContext } from './rebuild.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const BENCH = flag('bench', join(dirname(fileURLToPath(import.meta.url)), '../out/bench'));
const { estimateTokens, renderTranscript } = stateLib;

/** JSON-escaped inputs and plain text alike: `\\` -> `\`, `\"` -> `"`, `\n` -> newline. */
const unescape = (text) => text.replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\n/g, '\n');

/** Whether `text` holds `key` as a whole token: no letter or digit right before or after it. */
const holds = (text, key) => new RegExp(`(?<![A-Za-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(text);
export function keyStrings(question) {
  const answer = question.answer.trim();
  if (question.exact && answer.length <= 40) return [answer];
  const keys = new Set();
  for (const [, code, quoted] of answer.matchAll(/`([^`]{3,80})`|«([^»]{3,80})»/g)) keys.add(code ?? quoted);
  for (const raw of answer.split(/[\s,;()«»`]+/)) {
    const token = raw.replace(/^['"]+|[.:'"]+$/g, '');
    if (token.length >= 4 && /\d|[\/\\_]|\w\.\w|[a-z][A-Z]|^[A-Z][A-Z_]{3,}$|^!\d/.test(token)) keys.add(token);
  }
  return [...keys];
}

/** `{ survived, measured }` fractions over the questions whose keys the full context holds. */
export function survival(questions, fullText, compactedText) {
  const full = unescape(fullText);
  const compacted = unescape(compactedText);
  const perQuestion = [];
  for (const q of questions) {
    const keys = keyStrings(q).filter((k) => holds(full, k));
    if (keys.length === 0) continue;
    perQuestion.push({ id: q.id, value: keys.filter((k) => holds(compacted, k)).length / keys.length });
  }
  const mean = perQuestion.reduce((s, q) => s + q.value, 0) / (perQuestion.length || 1);
  return { mean, measured: perQuestion.length, perQuestion };
}

const sessionsDir = join(BENCH, 'sessions');
const loadProbes = (s) => JSON.parse(readFileSync(join(sessionsDir, s, 'probes.json'), 'utf8'));

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

const pct = (x) => (x * 100).toFixed(1);

if (flag('check')) {
  // Every cell dir of a run: survival from its compacted.txt, score from its quality.json.
  const run = flag('check');
  const cells = [];
  const pairs = [];
  for (const session of readdirSync(run).filter((d) => existsSync(join(sessionsDir, d, 'probes.json')))) {
    const probes = loadProbes(session);
    const before = rebuild(probes);
    const fullText = renderContext(before.messages, before.messages, before.attachments, renderTranscript).text;
    for (const dir of readdirSync(join(run, session))) {
      const quality = join(run, session, dir, 'quality.json');
      if (!existsSync(quality)) continue;
      const graded = JSON.parse(readFileSync(quality, 'utf8'));
      const s = survival(probes.questions, fullText, readFileSync(join(run, session, dir, 'compacted.txt'), 'utf8'));
      const score = graded.reduce((a, g) => a + g.score, 0) / graded.length;
      cells.push({ session, cell: dir.replace(/-2026-.*/, ''), survival: s.mean, score });
      for (const q of s.perQuestion) pairs.push([q.value, graded.find((g) => g.id === q.id)?.score ?? 0]);
    }
  }
  for (const c of cells) console.log(`${c.session.padEnd(14)} ${c.cell.padEnd(52)} survival ${pct(c.survival)} score ${c.score.toFixed(2)}`);
  const report = (label, list) => {
    const mean = (c, key) => { const own = list.filter((d) => d.session === c.session); return own.reduce((a, d) => a + d[key], 0) / own.length; };
    const centred = (key) => list.map((c) => c[key] - mean(c, key));
    console.log(`${label}, ${list.length} cells: pearson(survival, score) pooled ${pearson(list.map((c) => c.survival), list.map((c) => c.score)).toFixed(2)}, within-session ${pearson(centred('survival'), centred('score')).toFixed(2)}`);
  };
  report('all cells', cells);
  report('plugin cells', cells.filter((c) => c.cell !== 'full' && c.cell !== 'native'));
  console.log(`question x cell pairs ${pairs.length}: pearson ${pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])).toFixed(2)}`);
  process.exit(0);
}

const sessions = (flag('sessions') ?? readdirSync(sessionsDir).filter((d) => existsSync(join(sessionsDir, d, 'probes.json'))).join(',')).split(',');
const configs = (flag('configs') ?? Object.keys(CONFIGS).filter((c) => CONFIGS[c].baseline === 'full' || (CONFIGS[c].options?.scoring === 'none' && !CONFIGS[c].options?.brief)).join(',')).split(',');
const offload = { dir: 'C:/Users/u/.claude/compact-offload/00000000-0000-0000-0000-000000000000', write: async () => {} };
const noModel = { ask: async () => { throw new Error('scan runs rule-only configs'); }, complete: async () => { throw new Error('scan runs rule-only configs'); } };

const rows = new Map(configs.map((c) => [c, {}]));
const images = new Map();
for (const session of sessions) {
  const probes = loadProbes(session);
  const before = rebuild(probes);
  const fullText = renderContext(before.messages, before.messages, before.attachments, renderTranscript).text;
  const tokensBefore = estimateTokens(fullText);
  for (const name of configs) {
    const config = CONFIGS[name];
    const output = config.baseline === 'full'
      ? before.messages
      : (await compactLib.compact(before.messages, noModel, { ...config.options, queuedPrompts: config.options.restoreQueued ? queuedPromptsOption(before.attachments) : undefined }, offload, noModel)).messages;
    const text = renderContext(before.messages, output, before.attachments, renderTranscript).text;
    // The engine rebuilds a message it gets back as a new object without its images.
    const index = new Map(before.messages.map((m, i) => [m, i]));
    const imagesAfter = output.reduce((sum, m) => sum + (before.imageTokens[index.get(m)] ?? 0), 0);
    rows.get(name)[session] = { reduction: 1 - estimateTokens(text) / tokensBefore, survival: survival(probes.questions, fullText, text), imagesAfter };
  }
  images.set(session, { count: before.messages.flatMap((m) => m.toolResults ?? []).filter((r) => r.image).length, tokens: before.imageTokens.reduce((a, b) => a + b, 0) });
}
console.log(`| config | ${sessions.map((s) => `${s} red/surv`).join(' | ')} | mean red | mean surv |`);
for (const [name, bySession] of rows) {
  const cells = sessions.map((s) => bySession[s]);
  const mean = (f) => cells.reduce((a, c) => a + f(c), 0) / cells.length;
  console.log(`| ${name} | ${cells.map((c) => `${pct(c.reduction)} / ${pct(c.survival.mean)}`).join(' | ')} | ${pct(mean((c) => c.reduction))} | ${pct(mean((c) => c.survival.mean))} |`);
}
// Image tokens are not in the text reduction: images, their tokens before, and per config after.
console.log(`\n| session | images | image tokens before | ${configs.map((c) => `${c} after`).join(' | ')} |`);
for (const s of sessions) console.log(`| ${s} | ${images.get(s).count} | ${images.get(s).tokens} | ${configs.map((c) => rows.get(c)[s].imagesAfter).join(' | ')} |`);
if (args.includes('--lost')) {
  // Questions whose keys a config loses, with what is missing.
  for (const [name, bySession] of rows) for (const s of sessions) for (const q of bySession[s].survival.perQuestion) if (q.value < 1) console.log(`${name} ${s} ${q.id} ${pct(q.value)}`);
}
