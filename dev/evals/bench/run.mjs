#!/usr/bin/env node
// Offline compaction bench: one run = session x cell, over the session's real transcript.
//   node bench/run.mjs --session my-session --configs current,per-tool@claude-haiku-4-5-20251001 [--out DIR]
//     a cell is <config>[@<model>[:<effort>]]: model and effort for both brief and scoring
//     [--model M]            model for every plugin cell that names none
//     [--probes FILE]        probe file instead of <sessions>/<session>/probes.json
//     [--from N --cut N]     override the probe file's window (a tiny window for a dry run)
//     [--no-quality]         skip the answer and grade calls
//     [--answer-tools T]     tools the answering model may call (e.g. Read,Grep) to follow
//                            markers to the offload copy or the live file; calls go to answer-tools.json
//     [--add-dir a,b]        directories those tools reach besides the cwd
//     [--answer-effort E]    the answering model's effort (default low)
//     [--parallel N]         cells at once (default 1); a failed cell is retried once
//     [--budget USD]         start no cell once <out>/results.jsonl totals this much
//     [--bench DIR]          bench root holding sessions/ and runs/ (default out/bench)
// Writes <out>/<session>/<cell>-<stamp>/{compacted.txt,quality.json,offload/} and appends
// one line per cell to <out>/results.jsonl.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, isolatedEnv } from './claude.mjs';
import { CONFIGS, DEFAULT_MODELS } from './configs.mjs';
import { compactLib, hookLib, stateLib } from './lib.mjs';
import { queuedPromptsOption, rebuild, renderContext as renderWith } from './rebuild.mjs';

const ANSWER = { model: 'claude-sonnet-5-5', effort: 'low' };
const GRADER = { model: 'claude-opus-5-5', effort: 'high' };

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
// Probes and runs hold session content (hosts, credentials): kept in the gitignored out.
const BENCH = flag('bench', join(dirname(fileURLToPath(import.meta.url)), '../out/bench'));
const session = flag('session');
const cells = flag('configs', 'current').split(',');
const out = flag('out', join(BENCH, 'runs'));
const modelOverride = flag('model');
const parallel = Number(flag('parallel', 1));
const budget = Number(flag('budget', Infinity));
const answerTools = flag('answer-tools', '');
const addDirs = flag('add-dir', '').split(',').filter(Boolean);
if (flag('answer-effort')) ANSWER.effort = flag('answer-effort');
const probes = JSON.parse(readFileSync(flag('probes', join(BENCH, 'sessions', session ?? '', 'probes.json')), 'utf8'));
if (flag('from')) probes.window_from_line = Number(flag('from'));
if (flag('cut')) probes.cut_line = Number(flag('cut'));

const { messageChars, reductionRatio } = compactLib;
const { estimateTokens, renderTranscript } = stateLib;
const sumChars = (messages) => messages.reduce((sum, m) => sum + messageChars(m), 0);
const resultsFile = join(out, 'results.jsonl');

/** `<config>[@<model>[:<effort>]]` -> the config with the cell's model and effort. */
function cellConfig(cell) {
  const [name, spec] = cell.split('@');
  const config = CONFIGS[name];
  if (!config) throw new Error(`unknown config ${name}; known: ${Object.keys(CONFIGS).join(', ')}`);
  const [model, effort] = (spec ?? modelOverride ?? '').split(':');
  if (!model) return config;
  return config.baseline
    ? { ...config, model }
    : { ...config, scoringModel: model, briefModel: model, ...(effort && { scoringEffort: effort, briefEffort: effort }) };
}

/** Requests of one run, each `{ stage, durationApiMs, costUsd, usage }`. */
function recorder() {
  const requests = [];
  const complete = (stage) => async (request) => {
    const reply = await ask({ model: request.model, prompt: request.prompt, system: request.system, effort: request.effort });
    requests.push({ stage, durationApiMs: reply.durationApiMs, costUsd: reply.costUsd, usage: reply.usage });
    return reply.isError
      ? { isAnswered: false, reason: 'api-error', error: reply.text }
      : { isAnswered: true, text: reply.text };
  };
  // Stages run one after another; the requests of a stage run in parallel.
  const criticalApiMs = () => {
    const byStage = new Map();
    for (const r of requests) byStage.set(r.stage, Math.max(byStage.get(r.stage) ?? 0, r.durationApiMs));
    return [...byStage.values()].reduce((a, b) => a + b, 0);
  };
  const cost = () => requests.reduce((sum, r) => sum + r.costUsd, 0);
  return { requests, complete, criticalApiMs, cost };
}

async function runPlugin(config, messages, attachments, dir, rec) {
  const models = { ...DEFAULT_MODELS, ...config };
  const offloadDir = join(dir, 'offload').replace(/\\/g, '/');
  mkdirSync(offloadDir, { recursive: true });
  const offload = {
    dir: offloadDir,
    write: async (path, text) => {
      if (!existsSync(path)) writeFileSync(path, text, { flag: 'wx' });
    },
  };
  const result = await compactLib.compact(
    messages,
    hookLib.claudeAsker(rec.complete('scoring'), models.scoringModel, config.scoringEffort),
    { ...config.options, queuedPrompts: config.options.restoreQueued ? queuedPromptsOption(attachments) : undefined },
    offload,
    hookLib.claudeTextAsker(rec.complete('brief'), models.briefModel, config.briefEffort),
  );
  const hasBrief = config.options.brief && config.options.brief !== 'none';
  return {
    messages: result.messages,
    metrics: {
      models: {
        scoring: config.options.scoring === 'none' ? null : `${models.scoringModel}${config.scoringEffort ? `:${config.scoringEffort}` : ''}`,
        brief: hasBrief ? `${models.briefModel}${config.briefEffort ? `:${config.briefEffort}` : ''}` : null,
      },
      summary: hookLib.summarize(result),
      requests: rec.requests.length,
      criticalApiMs: rec.criticalApiMs(),
      briefChars: result.stats.briefChars,
    },
  };
}

/** Lines from a compaction's preserved tail back to its head, following parentUuid. */
function preservedLines(records, segment) {
  if (!segment) return [];
  const lineOf = new Map(records.map((r, i) => [r?.uuid, i + 1]));
  const lines = [];
  for (let uuid = segment.tailUuid; uuid && lineOf.has(uuid); uuid = records[lineOf.get(uuid) - 1].parentUuid) {
    lines.unshift(lineOf.get(uuid));
    if (uuid === segment.headUuid) break;
  }
  return lines;
}

/** The engine's own /compact on a copy of the session cut at `cut_line`, no plugins. */
async function runNative(config, dir, rec) {
  const copy = join(dir, 'native-input.jsonl');
  const lines = readFileSync(probes.session_file, 'utf8').split('\n').slice(0, probes.cut_line);
  writeFileSync(copy, `${lines.join('\n')}\n`);
  const argv = ['-p', '/compact', '--resume', copy, '--fork-session', ...(config.model ? ['--model', config.model] : []),
    '--output-format', 'json', '--tools', '', '--safe-mode', '--setting-sources', '', '--strict-mcp-config'];
  const reply = await new Promise((resolve) => {
    const child = spawn('claude', argv, { cwd: dir, env: isolatedEnv(), shell: false });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', () => resolve(text));
    child.stdin.end();
  });
  const json = JSON.parse(reply);
  rec.requests.push({ stage: 'native', durationApiMs: json.duration_api_ms ?? 0, costUsd: json.total_cost_usd ?? 0 });
  const projects = join(homedir(), '.claude', 'projects');
  const file = readdirSync(projects).map((p) => join(projects, p, `${json.session_id}.jsonl`)).find(existsSync);
  if (!file) throw new Error(`native: no session file for ${json.session_id}: ${reply.slice(0, 300)}`);
  copyFileSync(file, join(dir, 'native-output.jsonl'));
  const records = readFileSync(file, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const boundary = records.findLastIndex((r) => r?.subtype === 'compact_boundary');
  if (boundary < 0) throw new Error(`native: no compact boundary: ${reply.slice(0, 300)}`);
  const rebuilt = rebuild({
    session_file: file,
    window_from_line: boundary + 2,
    cut_line: records.length,
    preserved_lines: preservedLines(records, records[boundary].compactMetadata?.preservedSegment),
  });
  return { ...rebuilt, metrics: { requests: 1, criticalApiMs: json.duration_api_ms } };
}

const renderContext = (input, output, attachments) => renderWith(input, output, attachments, renderTranscript);

function jsonOf(text) {
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
}

async function quality(rendered, dir) {
  const { questions } = probes;
  const answer = await ask({
    ...ANSWER,
    system: answerTools
      ? `You answer questions about a coding-assistant conversation, as the assistant would when it resumes: from the conversation and the files it names, which you open with ${answerTools}. Parts of the conversation were cut and saved: a "[claude-compact" marker or notes message names the saved copy (a path, or a directory plus the call's tool_use_id). When the conversation does not hold an answer, open the saved copies and files that the topic points to before answering. Answer "unknown" only when they do not hold it either. Never guess.`
      : 'You answer questions about a coding-assistant conversation from that conversation alone. When it does not contain the answer, answer "unknown". Never guess.',
    tools: answerTools,
    addDirs: [...addDirs, dir],
    prompt: `<conversation>\n${rendered}\n</conversation>\n\nAnswer every question below. Reply with only a JSON object mapping each question id to its answer.\n${questions.map((q) => `${q.id}: ${q.q}`).join('\n')}`,
  });
  if (answerTools) writeFileSync(join(dir, 'answer-tools.json'), JSON.stringify(answer.toolCalls, null, 2));
  if (answer.isError) throw new Error(`answer: ${answer.text.slice(0, 300)}`);
  const answers = jsonOf(answer.text);
  const items = questions.map((q) => ({ id: q.id, question: q.q, reference: q.answer, exact: q.exact, answer: String(answers[q.id] ?? 'unknown') }));
  const grade = await ask({
    ...GRADER,
    system: 'You grade answers against reference answers.',
    prompt: `Grade each answer against its reference: 1 correct and complete, 0.5 partly correct, 0 wrong, missing or "unknown". When exact is true, the identifiers in the reference must appear verbatim in the answer, else 0. confident_wrong is true when the answer asserts something wrong instead of saying unknown.\nReply with only a JSON object mapping each id to {"score": number, "confident_wrong": boolean}.\n${JSON.stringify(items, null, 1)}`,
  });
  if (grade.isError) throw new Error(`grade: ${grade.text.slice(0, 300)}`);
  const grades = jsonOf(grade.text);
  const graded = items.map((item) => ({ ...item, score: Number(grades[item.id]?.score ?? 0), confident_wrong: Boolean(grades[item.id]?.confident_wrong) }));
  const mean = (list) => (list.length ? list.reduce((s, g) => s + g.score, 0) / list.length : null);
  const byId = new Map(questions.map((q) => [q.id, q]));
  return {
    graded,
    metrics: {
      score: mean(graded),
      usedAfterCut: mean(graded.filter((g) => byId.get(g.id).used_after_cut)),
      identifier: mean(graded.filter((g) => byId.get(g.id).category === 'identifier')),
      confidentWrong: graded.filter((g) => g.confident_wrong).length,
      costUsd: answer.costUsd + grade.costUsd,
      ...(answerTools && { toolCalls: answer.toolCalls.length, rereadChars: answer.toolCalls.reduce((sum, call) => sum + call.returnedChars, 0), answerUsage: answer.usage }),
      answerApiMs: answer.durationApiMs,
    },
  };
}

const before = rebuild(probes);
const beforeText = renderContext(before.messages, before.messages, before.attachments).text;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(out, { recursive: true });
let spent = existsSync(resultsFile)
  ? readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).reduce((sum, l) => sum + (JSON.parse(l).totalCostUsd ?? 0), 0)
  : 0;

/** One attempt of a cell; its spend is added to `rec` even when it throws. */
async function attempt(cell, dir, rec) {
  const config = cellConfig(cell);
  if (config.baseline === 'native' && !args.includes('--allow-native')) {
    throw new Error('native reported $32 and $138 for one /compact on two sessions (2026-11-20), likely the resumed session\'s cost counter, unverified: pass --allow-native to run it');
  }
  const started = Date.now();
  const run =
    config.baseline === 'full' ? { ...before, metrics: { requests: 0, criticalApiMs: 0 } }
    : config.baseline === 'native' ? await runNative(config, dir, rec)
    : { ...(await runPlugin(config, before.messages, before.attachments, dir, rec)), attachments: before.attachments };
  const wallMs = Date.now() - started;
  // native came from its own transcript: all of it is as the engine left it
  const context = config.baseline === 'native'
    ? renderContext(run.messages, run.messages, run.attachments)
    : renderContext(before.messages, run.messages, run.attachments);
  writeFileSync(join(dir, 'compacted.txt'), `${context.text}\n`);
  const charsBefore = sumChars(before.messages);
  const charsAfter = sumChars(run.messages);
  const row = {
    session, cell, options: config.options ?? null, window: [probes.window_from_line, probes.cut_line],
    messagesBefore: before.messages.length, messagesAfter: run.messages.length,
    queuedPrompts: `${context.promptsKept}/${before.attachments.length}`,
    charsBefore, charsAfter, ratio: reductionRatio({ stats: { charsBefore, charsAfter } }),
    tokensBefore: estimateTokens(beforeText), tokensAfter: estimateTokens(context.text),
    wallMs, costUsd: rec.cost(), ...run.metrics,
  };
  if (!args.includes('--no-quality') && probes.questions?.length) {
    const q = await quality(context.text, dir);
    writeFileSync(join(dir, 'quality.json'), JSON.stringify(q.graded, null, 2));
    row.quality = q.metrics;
  }
  return row;
}

async function runCell(cell) {
  let failures = [];
  let cost = 0;
  for (let tryNo = 1; tryNo <= 2; tryNo++) {
    const dir = join(out, session ?? 'probe', `${cell.replace(/[@:]/g, '_')}-${stamp}${tryNo > 1 ? '-retry' : ''}`);
    mkdirSync(dir, { recursive: true });
    const rec = recorder();
    try {
      const row = await attempt(cell, dir, rec);
      row.totalCostUsd = cost + row.costUsd + (row.quality?.costUsd ?? 0);
      row.failedAttempts = failures;
      return row;
    } catch (error) {
      cost += rec.cost();
      failures.push(String(error?.message ?? error).slice(0, 400));
      console.error(`${cell} attempt ${tryNo} failed: ${failures.at(-1)}`);
    }
  }
  return { session, cell, failed: true, failedAttempts: failures, totalCostUsd: cost };
}

const queue = [...cells];
await Promise.all(
  Array.from({ length: Math.max(1, parallel) }, async () => {
    while (queue.length > 0) {
      if (spent >= budget) {
        console.error(`budget $${budget} reached ($${spent.toFixed(2)}); skipped: ${queue.splice(0).join(', ')}`);
        return;
      }
      const cell = queue.shift();
      const row = await runCell(cell);
      spent += row.totalCostUsd ?? 0;
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
    }
  }),
);
console.error(`spent so far in ${resultsFile}: $${spent.toFixed(2)}`);
