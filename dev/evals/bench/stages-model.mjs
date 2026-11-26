// Asks a model once per session for its stage boundaries over a compact digest of the
// messages, then scores them like stages.mjs: a hand-marked boundary is found when a model
// stage opens within ±N messages of it; the first stage of either side is not scored.
// Usage: node bench/stages-model.mjs [--n=2] [--model=claude-opus-5-5] [--effort=low]
//   [--session=<name>] [--dry] [--bench=out/bench]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask } from './claude.mjs';
import { rebuild } from './rebuild.mjs';

const flag = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const N = Number(flag('n', 2));
const MODEL = flag('model', 'claude-opus-5-5');
const EFFORT = flag('effort', 'low');
const ONLY = flag('session');
const DRY = process.argv.includes('--dry');
const MAX_CHARS = 60_000; // ~20k tokens of mixed Russian/English/code
const sessionsDir = join(flag('bench', join(dirname(fileURLToPath(import.meta.url)), '../out/bench')), 'sessions');

const oneLine = (s, max) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const shortInput = (input = {}) => {
  const value = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.prompt ?? input.skill ?? Object.values(input).find((v) => typeof v === 'string');
  return value ?? '';
};

/**
 * The signals the rebuild drops, as `{ afterIndex, text }`: the queued prompts (rebuild's
 * `attachments`, the records the hook's readQueuedPrompts reads) and the meta records of
 * `/goal` (set) and its Stop-hook feedback, each next to the message before it. A meta
 * record counts only when the nearest message above it is kept: a rewound branch's is not.
 */
function signals({ session_file, window_from_line, cut_line }, lines, attachments) {
  const out = attachments.map((a) =>
    a.mode === 'prompt' ? { afterIndex: a.afterIndex, text: `[queued] ${oneLine(a.prompt, 500)}` } : { afterIndex: a.afterIndex, text: `[${a.mode}] ${oneLine(a.prompt, 150)}` },
  );
  const kept = new Set(lines);
  const records = readFileSync(session_file, 'utf8')
    .split('\n')
    .map((raw, i) => {
      try {
        return { line: i + 1, record: JSON.parse(raw) };
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.line >= window_from_line && r.line <= cut_line);
  const byUuid = new Map(records.filter((r) => r.record.uuid).map((r) => [r.record.uuid, r]));
  const isMessage = (r) => (r.type === 'user' || r.type === 'assistant') && !r.isMeta;
  /** The nearest message up the parentUuid chain is a kept one: the record is on the context chain. */
  const onChain = (record) => {
    let parent = byUuid.get(record.parentUuid);
    while (parent && !isMessage(parent.record)) parent = byUuid.get(parent.record.parentUuid);
    return Boolean(parent && kept.has(parent.line));
  };
  for (const { line, record } of records) {
    if (record.type !== 'user' || !record.isMeta || !onChain(record)) continue;
    const content = record.message?.content;
    const text = typeof content === 'string' ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const goal = text.match(/^A session-scoped Stop hook is now active with condition: "([^"]*)"/);
    const feedback = text.match(/^Stop hook feedback:\s*\[[^\]]*\]:\s*([\s\S]*)/);
    const signal = goal ? `[goal set] ${oneLine(goal[1], 300)}` : feedback ? `[stop-hook feedback] ${oneLine(feedback[1], 120)}` : null;
    if (signal) out.push({ afterIndex: Math.max(0, lines.findLastIndex((l) => l < line)), text: signal });
  }
  return out;
}

/** One line per user text, assistant text head, tool call and signal; `inputChars` 0 drops tool calls. */
function digest(messages, extra, { userChars = 1500, assistantChars = 300, inputChars = 80 } = {}) {
  const out = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.text.trim()) out.push(`#${i} USER: ${m.text.length > userChars ? `${m.text.slice(0, userChars)}…[truncated]` : m.text}`);
    if (m.role === 'assistant' && m.text.trim()) out.push(`#${i} ASSISTANT: ${oneLine(m.text, assistantChars)}`);
    if (inputChars > 0) for (const t of m.toolUses) out.push(`#${i} ${t.tool} ${oneLine(shortInput(t.input), inputChars)}`);
    for (const s of extra) if (s.afterIndex === i) out.push(`#${i} ${s.text}`);
  });
  return out.join('\n');
}

/** Shrinks tool inputs, then assistant heads, then drops tool calls until the digest fits. */
function fittedDigest(messages, extra) {
  const steps = [{}, { inputChars: 40 }, { inputChars: 40, assistantChars: 150 }, { inputChars: 0, assistantChars: 150 }, { inputChars: 0, assistantChars: 100, userChars: 800 }];
  for (const step of steps) {
    const text = digest(messages, extra, step);
    if (text.length <= MAX_CHARS) return { text, step };
  }
  const step = steps.at(-1);
  return { text: digest(messages, extra, step), step };
}

const prompt = (text) => `Below is a digest of a Claude Code session. Each line starts with #<message index>. USER lines are the user's prompts in full (long pastes truncated); ASSISTANT lines are the first characters of the assistant's replies; bracketed lines are events that are not messages: [queued] a prompt the user typed while the assistant worked, [task-notification] a background task's notice, [goal set] a /goal condition the user set, [stop-hook feedback] the /goal checker refusing to let the turn end; other lines are tool calls (tool name, short input).

Split the session into stages. A stage is a stretch of the session with one goal, from the user prompt that opened it to the assistant's report or the signal that ended it. A stage is closed when a later stage began.

A boundary is a NEW GOAL or a new deliverable from the user. It is NOT a boundary when the user:
- clarifies or corrects the current task, including a correction of method ("don't use agents, check it yourself"),
- answers a question the assistant asked, or its numbered questions/options ("4 ok, 5 a, 6 b"),
- asks an aside question ("by the way, why ...?") and then the same work goes on,
- asks for a side fix or side check that serves the current goal,
- follows up on the same work (asks to fix, re-check, summarize, explain or extend what was just done).
A new goal can also arrive as a [queued] prompt or a [goal set] line; [stop-hook feedback] and [task-notification] lines alone do not open a stage. Slash commands like /effort, /model, /clear alone do not open a stage. A wrong boundary costs more than a missed one: when unsure, do not split.

The first stage always has startIndex 0, even when it is only setup. startIndex is the # of the line that opened the stage.

Reply with JSON only, no prose, no code fence:
[{"startIndex": <number>, "goal": "<one line>", "closed": <true|false>, "endedBy": "report|commit|abandoned|current|other"}]

Digest:
${text}`;

const parseStages = (text) => {
  try {
    return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  } catch {
    return null;
  }
};

const pct = (a, b) => (b === 0 ? 'n/a' : `${Math.round((100 * a) / b)}% (${a}/${b})`);
const total = { truth: 0, found: 0, detected: 0, matched: 0, cost: 0 };
for (const session of readdirSync(sessionsDir)) {
  if (ONLY && session !== ONLY) continue;
  const file = join(sessionsDir, session, 'probes.json');
  const probes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!Array.isArray(probes.stages)) continue;
  const { messages, lines, attachments } = rebuild(probes);
  const { text, step } = fittedDigest(messages, signals(probes, lines, attachments));
  console.log(`${session}: ${messages.length} messages, digest ${text.length} chars, shrink ${JSON.stringify(step)}`);
  if (DRY) {
    for (const l of text.split('\n').filter((l) => /^#\d+ \[/.test(l))) console.log(`  ${l.slice(0, 110)}`);
    continue;
  }

  const reply = await ask({ model: MODEL, prompt: prompt(text), effort: EFFORT });
  const u = reply.usage;
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  total.cost += reply.costUsd;
  console.log(`  ${MODEL}:${EFFORT} $${reply.costUsd.toFixed(3)} in ${input} tok, out ${u.output_tokens ?? 0} tok, ${Math.round(reply.durationMs / 1000)} s`);
  const stages = reply.isError ? null : parseStages(reply.text);
  if (!stages) {
    console.log(`  FAILED: ${reply.text.slice(0, 300)}`);
    continue;
  }
  stages.sort((a, b) => a.startIndex - b.startIndex);
  for (const s of stages) console.log(`  model #${s.startIndex} L${lines[s.startIndex]} ${s.endedBy}${s.closed ? '' : ' (open)'}: ${s.goal}`);

  // The first stage opens at the window start; a model that skips setup may put it later, so drop index 0 only.
  const openings = stages.map((s) => s.startIndex).filter((i) => i > 0);
  const used = new Set();
  let found = 0;
  for (const stage of probes.stages.slice(1)) {
    const index = lines.findIndex((l) => l >= stage.opened_by);
    const hit = openings.filter((o) => Math.abs(o - index) <= N).sort((a, b) => Math.abs(a - index) - Math.abs(b - index))[0];
    if (hit !== undefined) {
      found += 1;
      used.add(hit);
    }
    const at = hit === undefined ? `MISSED ${JSON.stringify(oneLine(messages[index]?.text, 120))}` : `hit #${hit} (${hit - index >= 0 ? '+' : ''}${hit - index})`;
    console.log(`  ${stage.id} L${stage.opened_by} -> #${index}  ${at}`);
  }
  for (const o of openings.filter((o) => !used.has(o))) {
    console.log(`  extra #${o} L${lines[o]} ${messages[o]?.role}: ${JSON.stringify(oneLine(messages[o]?.text, 120))}`);
  }
  console.log(`  precision ${pct(used.size, openings.length)}  recall ${pct(found, probes.stages.length - 1)}`);
  total.truth += probes.stages.length - 1;
  total.found += found;
  total.detected += openings.length;
  total.matched += used.size;
}
if (!DRY) console.log(`TOTAL precision ${pct(total.matched, total.detected)}  recall ${pct(total.found, total.truth)}  N=±${N}  cost $${total.cost.toFixed(3)}`);
