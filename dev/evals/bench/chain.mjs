#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, isolatedEnv } from './claude.mjs';
import { CONFIGS, DEFAULT_MODELS } from './configs.mjs';
import { compactLib, hookLib, stateLib } from './lib.mjs';
import { queuedPromptsOption, rebuild } from './rebuild.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ANSWER = { model: 'claude-sonnet-5-5', effort: 'low' };
const GRADER = { model: 'claude-opus-5-5', effort: 'high' };
const NATIVE_MODEL = 'claude-sonnet-5-5';
const STEPS = 3;

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const ROOT = resolve(flag('root', join(HERE, '../out/chain')));
const name = flag('name');
const dir = join(ROOT, name ?? '');
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};
const readLines = (file) => readFileSync(file, 'utf8').split('\n');
const readMeta = () => JSON.parse(readFileSync(join(dir, 'chain.json'), 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const { estimateTokens, renderTranscript } = stateLib;
const sumChars = (messages) => messages.reduce((sum, m) => sum + compactLib.messageChars(m), 0);

function prep() {
  const file = resolve(flag('file'));
  const lines = readLines(file);
  const records = lines.map(parse);
  const boundaries = records.flatMap((r, i) => (r?.subtype === 'compact_boundary' ? [i + 1] : []));
  if (boundaries.length < STEPS) throw new Error(`${boundaries.length} boundaries, need ${STEPS}`);
  for (const b of boundaries.slice(0, STEPS)) {
    if (records[b - 1].compactMetadata?.preservedSegment || records[b]?.isCompactSummary) {
      throw new Error(`boundary at line ${b} is a built-in compaction: its product cannot be told from new records by timestamp`);
    }
  }
  const lineOf = new Map(records.map((r, i) => [r?.uuid, i + 1]));
  const isMessage = (r) => r?.type === 'user' || r?.type === 'assistant';
  const isCompactCommand = (r) => /<command-name>\/compact/.test(JSON.stringify(r.message?.content ?? '').slice(0, 400));
  const cutOf = (b) => {
    const logical = lineOf.get(records[b - 1].logicalParentUuid);
    if (logical && logical < b) return logical;
    for (let i = b - 1; i > 0; i--) if (isMessage(records[i - 1]) && !records[i - 1].isMeta && !isCompactCommand(records[i - 1])) return i;
    throw new Error(`no cut before line ${b}`);
  };
  const startOf = (b) => {
    const at = Date.parse(records[b - 1].timestamp);
    for (let i = b + 1; i <= records.length; i++) if (isMessage(records[i - 1]) && Date.parse(records[i - 1].timestamp) > at) return i;
    return undefined;
  };
  const cuts = boundaries.map(cutOf);
  const starts = boundaries.map(startOf);
  const ranges = [[1, cuts[0]]];
  for (let i = 1; i <= boundaries.length && starts[i - 1]; i++) ranges.push([starts[i - 1], i < boundaries.length ? cuts[i] : lines.length]);
  mkdirSync(dir, { recursive: true });
  const texts = Number(flag('texts', 5));
  const readable = join(HERE, 'jsonl-readable.mjs');
  const stretches = [];
  ranges.slice(0, texts).forEach(([from, to], i) => {
    let source = file;
    let range = [from, to];
    if (i > 0) {
      const kept = lines.slice(from - 1, to).filter((l) => {
        const r = parse(l);
        return r?.uuid && !r.isSidechain && r.type !== 'file-history-snapshot';
      });
      source = join(dir, `stretch${i + 1}.jsonl`);
      writeFileSync(source, `${kept.join('\n')}\n`);
      range = [1, kept.length];
    }
    const info = execFileSync('node', [readable, source, String(range[0]), String(range[1]), join(dir, `s${i + 1}.txt`)], { encoding: 'utf8' }).trim();
    stretches.push({ index: i + 1, source: source.replace(/\\/g, '/'), range, info });
  });
  const meta = { session_file: file.replace(/\\/g, '/'), boundaries, cuts, starts, ranges, stretches };
  writeJson(join(dir, 'chain.json'), meta);
  console.log(JSON.stringify(meta, null, 1));
}

const stretchInput = (meta, i) => {
  const s = meta.stretches[i];
  return { session_file: s.source, window_from_line: s.range[0], cut_line: s.range[1] };
};

function recorder() {
  const requests = [];
  const complete = (stage) => async (request) => {
    const reply = await ask({ model: request.model, prompt: request.prompt, system: request.system, effort: request.effort });
    requests.push({ stage, durationApiMs: reply.durationApiMs, costUsd: reply.costUsd });
    return reply.isError ? { isAnswered: false, reason: 'api-error', error: reply.text } : { isAnswered: true, text: reply.text };
  };
  const criticalApiMs = () => {
    const byStage = new Map();
    for (const r of requests) byStage.set(r.stage, Math.max(byStage.get(r.stage) ?? 0, r.durationApiMs));
    return [...byStage.values()].reduce((a, b) => a + b, 0);
  };
  return { requests, complete, criticalApiMs, cost: () => requests.reduce((sum, r) => sum + r.costUsd, 0) };
}

function renderHeld(messages, held) {
  const withPrompts = messages.flatMap((message) => [
    message,
    ...(held.get(message) ?? []).map((text) => ({ role: 'user', text: `[queued_command attachment]\n${text}`, toolUses: [] })),
  ]);
  return renderTranscript(withPrompts);
}

async function runStep(messages, attachments, offload, model) {
  let failure;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rec = recorder();
    try {
      const started = Date.now();
      const result = await compactLib.compact(
        messages,
        hookLib.claudeAsker(rec.complete('scoring'), model),
        { ...CONFIGS.defaults.options, queuedPrompts: queuedPromptsOption(attachments) },
        offload,
        hookLib.claudeTextAsker(rec.complete('brief'), model),
      );
      return { result, rec, wallMs: Date.now() - started };
    } catch (error) {
      failure = error;
      console.error(`step attempt ${attempt} failed: ${error?.message ?? error}`);
    }
  }
  throw failure;
}

async function plugin() {
  const meta = readMeta();
  const model = flag('model', 'haiku');
  const pluginSteps = Number(flag('steps', STEPS));
  const out = join(dir, flag('out', 'plugin'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const offloadDir = join(out, 'offload').replace(/\\/g, '/');
  mkdirSync(offloadDir, { recursive: true });
  const offload = {
    dir: offloadDir,
    write: async (path, text) => {
      if (!existsSync(path)) writeFileSync(path, text, { flag: 'wx' });
    },
  };
  const held = new Map();
  let messages = [];
  const steps = [];
  for (let step = 1; step <= pluginSteps; step++) {
    const segment = rebuild(step === 1 ? { session_file: meta.session_file, window_from_line: 1, cut_line: meta.ranges[0][1] } : stretchInput(meta, step - 1));
    for (const a of segment.attachments) {
      const message = segment.messages[a.afterIndex];
      held.set(message, [...(held.get(message) ?? []), a.text]);
    }
    const input = [...messages, ...segment.messages];
    const tokensBefore = estimateTokens(renderHeld(input, held));
    const { result, rec, wallMs } = await runStep(input, segment.attachments, offload, model);
    messages = result.messages;
    const text = renderHeld(messages, held);
    const row = {
      step,
      messagesBefore: input.length,
      messagesAfter: messages.length,
      newMessages: segment.messages.length,
      tokensBefore,
      tokensAfter: estimateTokens(text),
      charsAfter: sumChars(messages),
      wallMs,
      criticalApiMs: rec.criticalApiMs(),
      requests: rec.requests.length,
      costUsd: rec.cost(),
      stagesFolded: result.stats.stagesFolded,
      summary: hookLib.summarize(result),
    };
    steps.push(row);
    mkdirSync(join(out, `step${step}`), { recursive: true });
    writeFileSync(join(out, `step${step}`, 'compacted.txt'), `${text}\n`);
    console.log(JSON.stringify(row));
  }
  writeFileSync(join(out, 'final.txt'), readFileSync(join(out, `step${pluginSteps}`, 'compacted.txt')));
  writeJson(join(out, 'steps.json'), steps);
}

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

function chainInput(previous, stretchFile, target) {
  const records = readLines(previous).map(parse).filter((r) => r && r.type !== 'cost-state');
  const known = new Set(records.map((r) => r.uuid).filter(Boolean));
  const toolUses = new Set();
  for (const r of records) {
    if (Array.isArray(r.message?.content)) for (const b of r.message.content) if (b.type === 'tool_use') toolUses.add(b.id);
  }
  let last = records.findLast((r) => r.uuid).uuid;
  const added = [];
  for (const r of readLines(stretchFile).map(parse)) {
    if (!r?.uuid) continue;
    if (Array.isArray(r.message?.content)) {
      for (const b of r.message.content) if (b.type === 'tool_use') toolUses.add(b.id);
      if (r.type === 'user') {
        const blocks = r.message.content.filter((b) => b.type !== 'tool_result' || toolUses.has(b.tool_use_id));
        if (blocks.length === 0) continue;
        r.message.content = blocks;
      }
    }
    if (!r.parentUuid || !known.has(r.parentUuid)) r.parentUuid = last;
    known.add(r.uuid);
    last = r.uuid;
    added.push(r);
  }
  writeFileSync(target, `${[...records, ...added].map((r) => JSON.stringify(r)).join('\n')}\n`);
  return added.length;
}

function sessionFile(id) {
  const projects = join(homedir(), '.claude', 'projects');
  return readdirSync(projects).map((p) => join(projects, p, `${id}.jsonl`)).find(existsSync);
}

async function nativeCompact(input, cwd) {
  const argv = ['-p', '/compact', '--resume', input, '--fork-session', '--model', NATIVE_MODEL,
    '--output-format', 'json', '--tools', '', '--safe-mode', '--setting-sources', '', '--strict-mcp-config'];
  const started = Date.now();
  const reply = await new Promise((done) => {
    const child = spawn('claude', argv, { cwd, env: isolatedEnv(), shell: false });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', () => done(text));
    child.stdin.end();
  });
  const json = JSON.parse(reply);
  const file = sessionFile(json.session_id);
  if (!file) throw new Error(`native: no session file for ${json.session_id}: ${reply.slice(0, 300)}`);
  return { json, file, wallMs: Date.now() - started };
}

async function native() {
  const meta = readMeta();
  const out = join(dir, 'native');
  mkdirSync(out, { recursive: true });
  const steps = [];
  let previous;
  let finalFile;
  for (let step = 1; step <= STEPS; step++) {
    const input = join(out, `input${step}.jsonl`);
    const output = join(out, `output${step}.jsonl`);
    let added = 0;
    if (step === 1) {
      const kept = readLines(meta.session_file).slice(0, meta.ranges[0][1]).filter((l) => parse(l)?.type !== 'cost-state');
      writeFileSync(input, `${kept.join('\n')}\n`);
    } else {
      added = chainInput(previous, meta.stretches[step - 1].source, input);
    }
    let run;
    for (let attempt = 1; attempt <= 2 && !run; attempt++) {
      try {
        run = await nativeCompact(input, out);
      } catch (error) {
        console.error(`native step ${step} attempt ${attempt} failed: ${error?.message ?? error}`);
      }
    }
    if (!run) throw new Error(`native step ${step} failed twice`);
    copyFileSync(run.file, output);
    if (step < STEPS) rmSync(run.file);
    else finalFile = run.file;
    rmSync(input);
    const records = readLines(output).map(parse);
    const boundary = records.findLastIndex((r) => r?.subtype === 'compact_boundary');
    const built = rebuild({
      session_file: output,
      window_from_line: boundary + 2,
      cut_line: records.length,
      preserved_lines: preservedLines(records, records[boundary].compactMetadata?.preservedSegment),
    });
    const held = new Map();
    for (const a of built.attachments) {
      const message = built.messages[a.afterIndex];
      held.set(message, [...(held.get(message) ?? []), a.text]);
    }
    const text = renderHeld(built.messages, held);
    const metadata = records[boundary].compactMetadata ?? {};
    const restoredChars = records.slice(boundary).filter((r) => r?.type === 'attachment' && /^(file|compact_file_reference)$/.test(r.attachment?.type)).reduce((sum, r) => sum + JSON.stringify(r.attachment).length, 0);
    const row = {
      step,
      appendedRecords: added,
      messagesAfter: built.messages.length,
      tokensAfter: estimateTokens(text),
      charsAfter: sumChars(built.messages),
      realPreTokens: metadata.preTokens,
      realPostTokens: metadata.postTokens,
      restoredAttachmentChars: restoredChars,
      wallMs: run.wallMs,
      criticalApiMs: run.json.duration_api_ms,
      costUsd: run.json.total_cost_usd,
      usage: run.json.usage,
      modelUsage: run.json.modelUsage,
    };
    steps.push(row);
    mkdirSync(join(out, `step${step}`), { recursive: true });
    writeFileSync(join(out, `step${step}`, 'compacted.txt'), `${text}\n`);
    console.log(JSON.stringify({ ...row, usage: undefined, modelUsage: undefined }));
    previous = output;
  }
  writeFileSync(join(out, 'final.txt'), readFileSync(join(out, `step${STEPS}`, 'compacted.txt')));
  writeJson(join(out, 'steps.json'), steps);
  writeJson(join(out, 'final-session.json'), { file: finalFile.replace(/\\/g, '/'), dir: dirname(finalFile).replace(/\\/g, '/') });
}

function full() {
  const meta = readMeta();
  const held = new Map();
  const messages = [];
  for (let i = 0; i < STEPS; i++) {
    const segment = rebuild(i === 0 ? { session_file: meta.session_file, window_from_line: 1, cut_line: meta.ranges[0][1] } : stretchInput(meta, i));
    for (const a of segment.attachments) {
      const message = segment.messages[a.afterIndex];
      held.set(message, [...(held.get(message) ?? []), a.text]);
    }
    messages.push(...segment.messages);
  }
  const text = renderHeld(messages, held);
  mkdirSync(join(dir, 'full'), { recursive: true });
  writeFileSync(join(dir, 'full', 'final.txt'), `${text}\n`);
  console.log(JSON.stringify({ messages: messages.length, tokens: estimateTokens(text) }));
}

function jsonOf(text) {
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
}

const SYSTEM_TOOLS = (tools) =>
  `You answer questions about a coding-assistant conversation, as the assistant would when it resumes: from the conversation and the files it names, which you open with ${tools}. Parts of the conversation were cut and saved: a "[claude-compact" marker or notes message names the saved copy (a path, or a directory plus the call's tool_use_id), and a summary may name the full transcript file. When the conversation does not hold an answer, open the saved copies and files that the topic points to before answering. Answer "unknown" only when they do not hold it either. Never guess.`;
const SYSTEM_PLAIN = 'You answer questions about a coding-assistant conversation from that conversation alone. When it does not contain the answer, answer "unknown". Never guess.';

async function answer() {
  const cell = flag('cell');
  const mode = flag('mode', 'none');
  const tools = mode === 'tools' ? 'Read,Grep' : '';
  const { questions } = JSON.parse(readFileSync(join(dir, 'probes.json'), 'utf8'));
  const text = readFileSync(join(dir, cell, 'final.txt'), 'utf8');
  const answerDirs = !tools ? [] : cell === 'plugin' ? [join(dir, 'plugin', 'offload')] : cell === 'native' ? [JSON.parse(readFileSync(join(dir, 'native', 'final-session.json'), 'utf8')).dir] : [];
  const cwd = join(dir, cell, `answer-cwd-${mode}`);
  mkdirSync(cwd, { recursive: true });
  const reply = await ask({
    ...ANSWER,
    effort: flag('answer-effort', ANSWER.effort),
    system: tools ? SYSTEM_TOOLS(tools) : SYSTEM_PLAIN,
    tools,
    addDirs: answerDirs,
    cwd,
    prompt: `<conversation>\n${text}\n</conversation>\n\nAnswer every question below. Reply with only a JSON object mapping each question id to its answer.\n${questions.map((q) => `${q.id}: ${q.q}`).join('\n')}`,
  });
  if (tools) writeJson(join(dir, cell, `answer-tools-${mode}.json`), reply.toolCalls);
  if (reply.isError) throw new Error(`answer: ${reply.text.slice(0, 300)}`);
  const answers = jsonOf(reply.text);
  const items = questions.map((q) => ({ id: q.id, question: q.q, reference: q.answer, exact: q.exact, answer: String(answers[q.id] ?? 'unknown') }));
  const grade = await ask({
    ...GRADER,
    system: 'You grade answers against reference answers.',
    prompt: `Grade each answer against its reference: 1 correct and complete, 0.5 partly correct, 0 wrong, missing or "unknown". When exact is true, the identifiers in the reference must appear verbatim in the answer, else 0. confident_wrong is true when the answer asserts something wrong instead of saying unknown.\nReply with only a JSON object mapping each id to {"score": number, "confident_wrong": boolean}.\n${JSON.stringify(items, null, 1)}`,
  });
  if (grade.isError) throw new Error(`grade: ${grade.text.slice(0, 300)}`);
  const grades = jsonOf(grade.text);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const graded = items.map((item) => ({
    ...item,
    category: byId.get(item.id).category,
    window: byId.get(item.id).window,
    score: Number(grades[item.id]?.score ?? 0),
    confident_wrong: Boolean(grades[item.id]?.confident_wrong),
  }));
  writeJson(join(dir, cell, `quality-${mode}.json`), graded);
  const mean = (list) => (list.length ? list.reduce((s, g) => s + g.score, 0) / list.length : null);
  const group = (key) => Object.fromEntries([...new Set(graded.map((g) => g[key]))].map((v) => [v, { n: graded.filter((g) => g[key] === v).length, score: mean(graded.filter((g) => g[key] === v)) }]));
  const row = {
    session: name,
    cell,
    mode,
    score: mean(graded),
    n: graded.length,
    byCategory: group('category'),
    byWindow: group('window'),
    confidentWrong: graded.filter((g) => g.confident_wrong).length,
    costUsd: reply.costUsd + grade.costUsd,
    toolCalls: reply.toolCalls.length,
    rereadChars: reply.toolCalls.reduce((sum, call) => sum + call.returnedChars, 0),
  };
  appendFileSync(join(ROOT, 'results.jsonl'), `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}

function transcript() {
  const meta = readMeta();
  const info = JSON.parse(readFileSync(join(dir, 'native', 'final-session.json'), 'utf8'));
  const raw = readLines(meta.session_file).slice(0, meta.ranges[0][1]).filter((l) => parse(l)?.type !== 'cost-state');
  const output = readLines(join(dir, 'native', `output${STEPS}.jsonl`));
  const boundary = output.findLastIndex((l) => parse(l)?.subtype === 'compact_boundary');
  const lines = [...raw];
  for (let i = 1; i < STEPS; i++) lines.push(...readLines(meta.stretches[i].source));
  lines.push(...output.slice(boundary));
  writeFileSync(info.file, `${lines.filter(Boolean).join('\n')}\n`);
  console.log(`${lines.length} lines written to the final native session file`);
}

function clean() {
  const file = join(dir, 'native', 'final-session.json');
  if (!existsSync(file)) return;
  rmSync(JSON.parse(readFileSync(file, 'utf8')).file, { force: true });
}

const commands = { prep, plugin, native, transcript, full, answer, clean };
if (!commands[command]) throw new Error(`usage: chain.mjs ${Object.keys(commands).join('|')} --name N [--file F] [--cell plugin|native|full --mode none|tools] [--root DIR]`);
await commands[command]();
