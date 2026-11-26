import {
  CONTENT_CONTEXT,
  collectToolCalls,
  estimateTokens,
  explicitGoal,
  fitState,
  goalFromMessages,
  renderTranscript,
  truncate,
} from './state.js';
import { closedStageFoldsBefore, INDEX_PREFIX, pickedNarration, stageDigests, turnIndexFoldsBefore, withFoldsApplied } from './fold.js';
import { EDIT_TOOLS, repeatedTexts, sourceCuts, type Repeat, type SourceCut } from './source.js';
import type {
  Brief,
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAnswer,
  JevAsker,
  JevQuestions,
  Message,
  PartAction,
  ResolvedCompactOptions,
  ResultFormat,
  TextAsker,
  ToolCall,
  ToolResult,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  instructions: '',
  strategy: 'tiers',
  supersede: true,
  format: 'per-tool',
  brief: 'none',
  scoring: 'none',
  reshorten: true,
  keepThreshold: 0.65,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 500,
  oldFormat: 'note-only',
  recentFraction: 0.15,
  headFraction: 0.1,
  shortMarkers: true,
  keepEdits: 40,
  inputFieldChars: 100,
  keepDocs: 'head',
  docHeadChars: 0,
  keepExternalChars: 2000,
  minCutChars: 200,
  keepImages: 3,
  foldStages: true,
  stageDigest: 'pick',
  pickPrompt: 'prose',
  foldStyle: 'index',
  queuedPrompts: [],
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const format = options.format ?? DEFAULT_OPTIONS.format;
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    instructions: options.instructions ?? DEFAULT_OPTIONS.instructions,
    strategy: options.strategy ?? DEFAULT_OPTIONS.strategy,
    supersede: options.supersede ?? DEFAULT_OPTIONS.supersede,
    format,
    brief: options.brief ?? DEFAULT_OPTIONS.brief,
    scoring: options.scoring ?? DEFAULT_OPTIONS.scoring,
    reshorten: options.reshorten ?? DEFAULT_OPTIONS.reshorten,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    oldFormat: options.oldFormat ?? DEFAULT_OPTIONS.oldFormat,
    recentFraction: Math.min(1, Math.max(0, finite(options.recentFraction, DEFAULT_OPTIONS.recentFraction))),
    headFraction: Math.min(1, Math.max(0, finite(options.headFraction, DEFAULT_OPTIONS.headFraction))),
    shortMarkers: options.shortMarkers ?? DEFAULT_OPTIONS.shortMarkers,
    keepEdits: Math.max(0, Math.floor(finite(options.keepEdits, DEFAULT_OPTIONS.keepEdits))),
    inputFieldChars: Math.max(0, Math.floor(finite(options.inputFieldChars, DEFAULT_OPTIONS.inputFieldChars))),
    keepDocs: options.keepDocs ?? DEFAULT_OPTIONS.keepDocs,
    docHeadChars: Math.max(0, Math.floor(finite(options.docHeadChars, DEFAULT_OPTIONS.docHeadChars))),
    keepExternalChars: Math.max(0, finite(options.keepExternalChars, DEFAULT_OPTIONS.keepExternalChars)),
    minCutChars: Math.max(0, finite(options.minCutChars, DEFAULT_OPTIONS.minCutChars)),
    keepImages: Math.max(-1, Math.floor(finite(options.keepImages, DEFAULT_OPTIONS.keepImages))),
    foldStages: options.foldStages ?? DEFAULT_OPTIONS.foldStages,
    stageDigest: options.stageDigest ?? DEFAULT_OPTIONS.stageDigest,
    pickPrompt: options.pickPrompt ?? DEFAULT_OPTIONS.pickPrompt,
    foldStyle: options.foldStyle ?? DEFAULT_OPTIONS.foldStyle,
    queuedPrompts: options.queuedPrompts ?? DEFAULT_OPTIONS.queuedPrompts,
  };
}

/** Longest input field a shortened input keeps whole; a longer one keeps this many characters. */
const INPUT_FIELD_CHARS = 300;

function fieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function inputJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** Whether shortening the input would cut anything, so it is worth asking about. */
export function hasLongInput(input: Record<string, unknown>): boolean {
  return Object.values(input).some((value) => fieldText(value).length > INPUT_FIELD_CHARS);
}

/**
 * The questions asked about a call: keep its full result verbatim, and keep
 * its full input verbatim when the input has a field long enough to cut.
 */
export function questionsFor(call: ToolCall): JevQuestions {
  const questions: JevQuestions = {};
  if (hasLongInput(call.input)) {
    questions[`input_${call.id}`] = {
      type: 'noul',
      instructions: `The full input of tool call ${call.id} (${call.tool}, ${inputJson(call.input).length} chars) should stay in the history verbatim: at this stage of the session the assistant needs its long arguments in context, not just its short fields, the head of each long one, and a saved copy it can Read`,
    };
  }
  questions[`result_${call.id}`] = {
    type: 'noul',
    instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant needs most of it in context, not just its head, its identifier and error lines, and a saved copy it can Read`,
  };
  return questions;
}

/** Characters of a call's input and of its output a content-scoring question shows. */
const EXCERPT_CHARS = 1000;

/** `questionsFor`, each question also showing the input, the result one the head of the output. */
export function contentQuestionsFor(call: ToolCall, output: string): JevQuestions {
  const questions = questionsFor(call);
  const input = JSON.stringify(inputJson(call.input).slice(0, EXCERPT_CHARS));
  for (const [name, question] of Object.entries(questions)) {
    question.instructions += `. Input: ${input}`;
    if (name.startsWith('result_')) {
      question.instructions += `. Output${output.length > EXCERPT_CHARS ? ' head' : ''}: ${JSON.stringify(output.slice(0, EXCERPT_CHARS))}`;
    }
  }
  return questions;
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
  questionsOf: (call: ToolCall) => JevQuestions = questionsFor,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsOf(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const part = (keep: number): PartAction =>
    call.pinned || keep >= options.keepThreshold ? 'keep' : 'drop';
  return {
    id: call.id,
    tool: call.tool,
    pinned: call.pinned,
    ...answer,
    input: part(answer.keepInput),
    result: part(answer.keepResult),
  };
}

function noulAnswer(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name];
  if (!answer || !('noul' in answer) || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid answer for ${name}`);
  }
  return answer.noul;
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState | object,
  batch: readonly ToolCall[],
  questionsOf: (call: ToolCall) => JevQuestions,
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsOf));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepInput: `input_${call.id}` in questions ? noulAnswer(answers, `input_${call.id}`) : 1,
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

const SALVAGE_PATTERNS = [
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/, // git SHA
  /(?:[\w.-]+[\/\\])+[\w.-]+\.[A-Za-z]\w{0,5}\b/, // path with an extension, `:line` or not
  /\b[\w-]+\.(?:[cm]?[jt]sx?|vue|json|md|ya?ml|s?css|html|py|go|rs|java|kt|sh|txt|lock)\b/, // bare file name
  /\b(?:feature|fix|bugfix|hotfix|release|origin)\/[\w./-]+|\bWC-\d+\b/, // branch-like refs
  /error|failed|fatal:|not found|no such file|exit code/i,
];

/** Lines of `text` naming an identifier or an error, deduplicated, within both caps. */
export function salvageLines(text: string, maxLines = 40, maxChars = 3000): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim().slice(0, 300);
    if (!line || seen.has(line) || !SALVAGE_PATTERNS.some((p) => p.test(line))) continue;
    if (kept.length >= maxLines || chars + line.length > maxChars) break;
    seen.add(line);
    kept.push(line);
    chars += line.length + 1;
  }
  return kept;
}

/** Marks a result already shortened by an earlier compaction; such a result is final. */
const TRUNCATED_MARK = '[claude-compact: full output';

/** The saved-copy marker; without a `path` (short markers) the notes message names the dir. */
function savedMark(chars: number, path: string): string {
  return `${TRUNCATED_MARK} (${chars} chars) saved${path ? ` to ${path}; Read it if needed` : ''}]`;
}

/**
 * The marker of a part cut under `source`: its level and pointer, readable
 * back by `LEVEL_MARK`, then where the full copy went.
 */
function levelMark(level: number, pointer: string, chars: number, path: string, part: 'input' | 'output'): string {
  return `[claude-compact: L${level} ${pointer} | full ${part} (${chars} chars) saved${path ? ` to ${path}; Read it if needed` : ''}]`;
}

/** Level, pointer and full size of a `levelMark`; the pointer may hold `|`, so it is matched up to the last one. */
const LEVEL_MARK = /\[claude-compact: L(\d) (.*) \| full (?:input|output) \((\d+) chars\) saved/;

/** Marks an image result an earlier compaction dropped; such a result is final. */
const IMAGE_MARK = '[claude-compact: image dropped';

/** Whether an earlier compaction already cut this result. */
const isMarked = (text: string): boolean =>
  text.includes(TRUNCATED_MARK) || text.includes(IMAGE_MARK) || LEVEL_MARK.test(text);

/** What a dropped image result reads instead: its file and size; the file itself is the saved copy. */
function imageMark(call: ToolCall, image: NonNullable<ToolResult['image']>): string {
  const path = typeof call.input.file_path === 'string' ? `, ${call.input.file_path}` : '';
  const size = image.width > 0 ? `, ${image.width}x${image.height}` : '';
  return `${IMAGE_MARK} to save context${path}${size}. The Read returned it and you viewed it before the drop, so what you said about it stands; Read the file to see it again]`;
}

/**
 * Under `keepImages` ≥ 0: the unpinned image calls to drop, and the indexes of
 * the messages holding a kept one. Such a message stays whole, since the engine
 * rebuilds an edited message without its images; so an older image sharing it stays too.
 */
function imageWindow(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  keep: number,
): { dropped: ToolCall[]; guarded: Set<number> } {
  if (keep < 0) return { dropped: [], guarded: new Set() };
  const images = calls.filter((call) => !call.pinned && toolResult(messages, call)?.image);
  const guarded = new Set(images.slice(Math.max(0, images.length - keep)).map((call) => call.resultIndex));
  return { dropped: images.filter((call) => !guarded.has(call.resultIndex)), guarded };
}

/** Lines of a cut result kept ahead of its level marker, and the length each keeps. */
const POINTER_HEAD_LINES = 2;
const POINTER_LINE_CHARS = 150;

/** A result cut under `source`: its first lines (unless superseded) and the level-1 marker. */
function pointerText(text: string, cut: SourceCut, path: string): string {
  const head = cut.head
    ? text.split('\n').filter((line) => line.trim()).slice(0, POINTER_HEAD_LINES).map((line) => truncate(line, POINTER_LINE_CHARS))
    : [];
  return [...head, levelMark(1, cut.pointer, text.length, path, 'output')].join('\n');
}

/** An edit input cut under `source`: its file path and the level-1 marker. */
function pointerInput(input: Record<string, unknown>, pointer: string, path: string): Record<string, unknown> {
  const short: Record<string, unknown> = {};
  for (const key of ['file_path', 'notebook_path']) if (key in input) short[key] = input[key];
  short.claude_compact = levelMark(1, pointer, inputJson(input).length, path, 'input');
  return short;
}

export function truncatedResultText(
  text: string,
  headChars: number,
  path: string,
  maxLines?: number,
  maxChars?: number,
): string {
  const lines = salvageLines(text.slice(headChars), maxLines, maxChars);
  return [
    text.slice(0, headChars),
    lines.length > 0
      ? `[claude-compact: lines with identifiers or errors from the rest]\n${lines.join('\n')}`
      : '',
    savedMark(text.length, path),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Tools whose output is a file or search listing, recoverable from the source on disk. */
const SOURCE_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const PER_TOOL_MIN_HEAD = 250;
const PER_TOOL_MAX_HEAD = 500;
/** Input fields a note-only line names, first found wins. */
const TARGET_FIELDS = ['file_path', 'path', 'pattern', 'command', 'url', 'description'];

/**
 * One line: the full-output pointer, the tool and its target (left out with
 * short markers, as the call sits right before), and a few short identifier lines.
 */
export function noteLine(tool: string, input: Record<string, unknown>, text: string, path: string): string {
  const target = TARGET_FIELDS.map((key) => input[key]).find((value) => typeof value === 'string');
  const ids = salvageLines(text, 3, 200).join(' | ');
  return [
    savedMark(text.length, path),
    path ? `${tool}${typeof target === 'string' ? ` ${truncate(target.replace(/\s+/g, ' '), 120)}` : ''}` : '',
    ids,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A dropped result shortened per `format`. */
export function shortenResult(
  call: Pick<ToolCall, 'tool' | 'input'>,
  text: string,
  format: ResultFormat,
  headChars: number,
  path: string,
): string {
  if (format === 'note-only') return noteLine(call.tool, call.input, text, path);
  if (format === 'current') return truncatedResultText(text, headChars, path);
  if (SOURCE_TOOLS.has(call.tool)) return truncatedResultText(text, PER_TOOL_MIN_HEAD, path, 0, 0);
  const head = Math.min(PER_TOOL_MAX_HEAD, Math.max(PER_TOOL_MIN_HEAD, headChars));
  return truncatedResultText(text, head, path, 10, 800);
}

/**
 * The input with every field over `INPUT_FIELD_CHARS` cut to that many
 * characters, plus a `claude_compact` field pointing to the saved copy.
 */
export function truncatedInput(
  input: Record<string, unknown>,
  path: string,
  fieldChars = INPUT_FIELD_CHARS,
): Record<string, unknown> {
  const short: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const text = fieldText(value);
    short[key] =
      text.length <= fieldChars
        ? value
        : `${text.slice(0, fieldChars)}… [${text.length - fieldChars} chars omitted]`;
  }
  short.claude_compact = `full input (${inputJson(input).length} chars) saved${path ? ` to ${path}; Read it if needed` : ''}`;
  return short;
}

/** A call's shortened parts, by tool_use_id; a part left out stays as it is. */
export interface CallEdit {
  input?: Record<string, unknown>;
  text?: string;
}

/**
 * Rebuilds the conversation with every call kept: a call in `edits` (by
 * tool_use_id) takes the edited input and result text. Untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  edits: ReadonlyMap<string, CallEdit>,
): Message[] {
  return messages.map((message) => {
    const touched =
      message.toolUses.some((tool) => edits.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => edits.get(result.tool_use_id)?.text !== undefined);
    if (!touched) return message;
    const rebuilt: Message = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => {
        const edit = edits.get(tool.tool_use_id);
        if (!edit) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: edit.input ?? tool.input,
        };
        const text = edit.text ?? tool.text;
        if (text !== undefined) copy.text = text;
        if (tool.isError) copy.isError = true;
        return copy;
      }),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map((result) => {
        const text = edits.get(result.tool_use_id)?.text;
        return text === undefined
          ? result
          : { tool_use_id: result.tool_use_id, text, isError: result.isError };
      });
    }
    return rebuilt;
  });
}

/** Where a dropped part's full text is saved before it is shortened. */
export interface Offload {
  /** Absolute directory; the files are `<dir>/<tool_use_id>.txt` and `.input.json`. */
  dir: string;
  /**
   * Saves `text` unless `path` exists: an existing file is the earlier full
   * copy of the same call (ids are unique), never to be overwritten.
   */
  write(path: string, text: string): Promise<void>;
}

async function save(offload: Offload | undefined, path: string, text: string): Promise<boolean> {
  if (!offload) return false;
  try {
    await offload.write(path, text);
    return true;
  } catch {
    return false;
  }
}

function toolResult(messages: readonly Message[], call: ToolCall): ToolResult | undefined {
  return messages[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id);
}

function resultText(messages: readonly Message[], call: ToolCall): string {
  return toolResult(messages, call)?.text ?? '';
}

const SAVED_MARK = /\[claude-compact: full output \((\d+) chars\) saved(?: to (.+?); Read it if needed)?\]/;

/**
 * A result an earlier compaction shortened, shortened again per `format` from
 * what is left of it, pointing at the copy that compaction saved; undefined
 * without a readable marker. Nothing is saved: the saved copy is the full one.
 */
function reshortened(
  call: ToolCall,
  text: string,
  format: ResultFormat,
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars' | 'shortMarkers'>,
): string | undefined {
  const mark = SAVED_MARK.exec(text);
  if (!mark) return undefined;
  const [, fullChars, path = ''] = mark;
  const rest = text
    .split('\n')
    .filter((line) => !line.startsWith('[claude-compact:'))
    .join('\n');
  // The marker names the size of the full output, not of what is left.
  const markPath = options.shortMarkers ? '' : path;
  return shortenResult(call, rest, format, options.truncateHeadChars, markPath).replace(
    `${TRUNCATED_MARK} (${rest.length} chars)`,
    `${TRUNCATED_MARK} (${fullChars} chars)`,
  );
}

/**
 * A superseded result an earlier compaction cut to a head and `SAVED_MARK`, as
 * the level marker alone; undefined for any other cut, a level marker included.
 */
function supersededMark(
  text: string,
  cut: SourceCut,
  options: Pick<ResolvedCompactOptions, 'shortMarkers'>,
): string | undefined {
  const mark = cut.head ? null : SAVED_MARK.exec(text);
  return mark ? levelMark(1, cut.pointer, Number(mark[1]), options.shortMarkers ? '' : (mark[2] ?? ''), 'output') : undefined;
}

/**
 * Saves each dropped input and result that shortening would cut and returns
 * the shortened parts by tool_use_id. A drop that would cut nothing turns into
 * a keep, as does one of a part an earlier compaction already shortened unless
 * `reshorten` shortens it further; one whose write fails, or with no `offload`
 * at all, stays whole as `offload_failed`. A call in `cuts` is shortened to its
 * pointer instead, and a part already cut stays as it is.
 */
async function offloadParts(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  decisions: CallDecision[],
  formats: ReadonlyMap<string, CallFormat>,
  options: ResolvedCompactOptions,
  offload: Offload | undefined,
  cuts: ReadonlyMap<string, SourceCut> = new Map(),
): Promise<Map<string, CallEdit>> {
  const markPath = (path: string): string => (options.shortMarkers ? '' : path);
  const edits = new Map<string, CallEdit>();
  await Promise.all(
    decisions.map(async (decision, index) => {
      const call = calls[index]!;
      const edit: CallEdit = {};
      const cut = cuts.get(call.id);
      if (decision.input === 'drop' && 'claude_compact' in call.input) decision.input = 'keep';
      if (decision.input === 'drop') {
        const path = `${offload?.dir}/${call.tool_use_id}.input.json`;
        const short = cut?.input
          ? pointerInput(call.input, cut.pointer, markPath(path))
          : truncatedInput(call.input, markPath(path), options.inputFieldChars);
        if (inputJson(short).length >= inputJson(call.input).length) decision.input = 'keep';
        else if (await save(offload, path, JSON.stringify(call.input, null, 2))) edit.input = short;
        else decision.input = 'offload_failed';
      }
      const text = resultText(messages, call);
      const format = formats.get(call.id) ?? options.format;
      if (decision.result === 'drop' && isMarked(text)) {
        // A kept document read an earlier compaction cut stays as that compaction left it.
        const short = cut
          ? supersededMark(text, cut, options)
          : options.reshorten && format !== 'doc'
            ? reshortened(call, text, format, options)
            : undefined;
        if (short !== undefined && short.length < text.length) edit.text = short;
        else decision.result = 'keep';
      } else if (decision.result === 'drop') {
        const path = `${offload?.dir}/${call.tool_use_id}.txt`;
        const short = cut
          ? pointerText(text, cut, markPath(path))
          : format === 'doc'
            ? truncatedResultText(text, options.docHeadChars, markPath(path), 0, 0)
            : shortenResult(call, text, format, options.truncateHeadChars, markPath(path));
        if (short.length >= text.length) decision.result = 'keep';
        else if (await save(offload, path, text)) edit.text = short;
        else decision.result = 'offload_failed';
      }
      if (edit.input || edit.text !== undefined) edits.set(call.tool_use_id, edit);
    }),
  );
  return edits;
}

const DOC_PATH = /[\w.@-]+\.(?:md|mdx|txt|adoc|rst)\b/i;
const READ_COMMAND = /\b(?:cat|head|tail|sed|less|type|Get-Content)\b/;
const EXTERNAL_COMMAND = /\b(?:glab|gh|jira|curl|git\s+(?:log|show))\b/;

/** `doc`: a kept document read, cut to `docHeadChars` (whole when 0). */
type CallFormat = ResultFormat | 'doc';

/** The document a call reads (`Read`, or a Bash cat/head/sed of one), lowercased; undefined otherwise. */
function docRead(call: ToolCall): string | undefined {
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  const target =
    call.tool === 'Read' ? call.input.file_path : call.tool === 'Bash' && READ_COMMAND.test(command) ? command : undefined;
  if (typeof target !== 'string') return undefined;
  const name = DOC_PATH.exec(target)?.[0];
  return name && (call.tool === 'Read' ? target.replace(/\\/g, '/') : name).toLowerCase();
}

/**
 * The result format of every candidate call, by id: `format` for the newest
 * `recentFraction` and the oldest `headFraction` of the candidates, `oldFormat`
 * for the rest; `doc` for a document read `keepDocs` keeps, note-only for an
 * earlier read of a document `latest` keeps.
 */
export function resultFormats(
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'format' | 'oldFormat' | 'recentFraction' | 'headFraction' | 'keepDocs'>,
): Map<string, CallFormat> {
  const candidates = calls.filter((call) => !call.pinned);
  const headUntil = Math.round(candidates.length * options.headFraction);
  const oldBefore = candidates.length - Math.round(candidates.length * options.recentFraction);
  const lastRead = new Map<string, number>();
  calls.forEach((call, index) => {
    const doc = docRead(call);
    if (doc) lastRead.set(doc, index);
  });
  return new Map(
    candidates.map((call, index): [string, CallFormat] => {
      const doc = options.keepDocs === 'none' ? undefined : docRead(call);
      const tiered = index >= headUntil && index < oldBefore ? options.oldFormat : options.format;
      if (!doc || (options.keepDocs === 'head' && index >= headUntil)) return [call.id, tiered];
      if (options.keepDocs === 'latest' && lastRead.get(doc) !== calls.indexOf(call)) return [call.id, 'note-only'];
      return [call.id, 'doc'];
    }),
  );
}

/** Whether a call's result stays whole: a short Bash read of external state (tracker, MR, git history). */
function keptExternal(call: ToolCall, maxChars: number): boolean {
  const command = call.input.command;
  return call.tool === 'Bash' && call.resultChars <= maxChars && typeof command === 'string' && EXTERNAL_COMMAND.test(command);
}

/** Ids of the newest `count` unpinned edit calls, whose inputs stay whole. */
function keptEdits(calls: readonly ToolCall[], count: number): Set<string> {
  const edits = calls.filter((call) => !call.pinned && EDIT_TOOLS.has(call.tool));
  return new Set(count > 0 ? edits.slice(-count).map((call) => call.id) : []);
}

export const NOTES_PREFIX = '[claude-compact notes]';
/**
 * What an assistant text a later one repeats is replaced with under `source`
 * or `supersede`: its place in the run, so the run's length survives.
 */
const repeatedMark = (repeat: Repeat): string =>
  `[claude-compact: L1 repeat ${repeat.nth}/${repeat.of}, the last one kept]`;

/**
 * The notes message: the offload dir (short markers) and the queued prompts
 * that hung off a rebuilt message; '' when neither applies.
 */
function notesText(
  messages: readonly Message[],
  edits: ReadonlyMap<string, CallEdit>,
  kept: readonly Message[],
  options: ResolvedCompactOptions,
  offload: Offload | undefined,
  historyHint = '',
): string {
  const parts: string[] = historyHint ? [historyHint] : [];
  if (options.shortMarkers && offload && edits.size > 0) {
    parts.push(
      `Cut tool outputs are saved as ${offload.dir}/<tool_use_id>.txt, cut inputs as <tool_use_id>.input.json; Read one when you need it.`,
    );
  }
  const messageOf = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const tool of m.toolUses) messageOf.set(tool.tool_use_id, i);
    for (const result of m.toolResults ?? []) messageOf.set(result.tool_use_id, i);
  });
  const lost = options.queuedPrompts.filter((prompt) => {
    const i = messageOf.get(prompt.toolUseId ?? '');
    return i !== undefined && kept[i] !== messages[i];
  });
  if (lost.length > 0) {
    const list = lost.map((p) => `- ${p.text}`).join('\n');
    parts.push(`Prompts queued mid-turn next to the cut calls (not shown with them any more), oldest first:\n${list}`);
  }
  return parts.length > 0 ? `${NOTES_PREFIX}\n${parts.join('\n\n')}` : '';
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], test: (d: CallDecision) => boolean): number {
  return decisions.filter(test).length;
}

const BRIEF_SYSTEM = `You write the brief a coding assistant resumes from after its conversation is compacted: its tool outputs will be cut to a head and a pointer to a saved copy, so the brief carries what it must not lose. Reply with only a JSON object:
{"goal": string, "stage": string, "next_steps": string[], "key_facts": [{"fact": string, "pointer": string}]}
goal: the task being worked on; an explicit_goal, when given, is the goal and comes first, word for word. stage: where the work stands now. next_steps: what the assistant does next, in order. key_facts: at most 40 facts it will need (identifiers, paths, branches, commit hashes, decisions and their reasons, the user's constraints), each copied exactly, pointer = the id of the tool call holding it, or "" when the fact comes from conversation text.`;
const BRIEF_MAX_TOKENS = 4000;
export const BRIEF_PREFIX = '[claude-compact brief]';

/** Reads the brief's JSON out of a reply; throws when there is none. */
export function parseBrief(text: string): Brief {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('brief: no JSON object in the reply');
  const raw = JSON.parse(text.slice(start, end + 1)) as Partial<Brief>;
  if (typeof raw.goal !== 'string') throw new Error('brief: no goal');
  return {
    goal: raw.goal,
    stage: String(raw.stage ?? ''),
    next_steps: Array.isArray(raw.next_steps) ? raw.next_steps.map(String) : [],
    key_facts: Array.isArray(raw.key_facts)
      ? raw.key_facts.map((f) => ({ fact: String(f?.fact ?? ''), pointer: String(f?.pointer ?? '') }))
      : [],
  };
}

/**
 * One request over the history: outputs omitted (`blind`, the fitted state's
 * history) or included (`full`, the whole transcript). A pointer naming a
 * call's short id becomes its tool_use_id, the id the compacted history shows.
 */
async function writeBrief(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  resolved: ResolvedCompactOptions,
  asker: TextAsker,
): Promise<Brief> {
  const explicit = explicitGoal(messages, resolved.instructions);
  const header = explicit ? `explicit_goal:\n${explicit}\n\n` : '';
  const history = (): string =>
    JSON.stringify(fitState(messages, calls, { ...resolved, goal: explicit || resolved.goal }).state.history);
  const prompt =
    resolved.brief === 'full'
      ? `${header}Conversation:\n${renderTranscript(messages)}`
      : `${header}History (tool outputs omitted):\n${history()}`;
  const brief = parseBrief(
    await asker.complete({ system: BRIEF_SYSTEM, prompt, maxTokens: BRIEF_MAX_TOKENS }),
  );
  const toolUseIds = new Map(calls.map((call) => [call.id, call.tool_use_id]));
  for (const fact of brief.key_facts) fact.pointer = toolUseIds.get(fact.pointer) ?? fact.pointer;
  return brief;
}

function firstRecentCallIndex(calls: readonly ToolCall[], options: Pick<ResolvedCompactOptions, 'recentFraction'>): number {
  const candidates = calls.filter((call) => !call.pinned);
  const oldBefore = candidates.length - Math.round(candidates.length * options.recentFraction);
  return candidates[oldBefore]?.callIndex ?? Infinity;
}

async function savedFolds<T extends { path: string; fullText: string }>(folds: readonly T[], offload: Offload | undefined): Promise<T[]> {
  const saved = await Promise.all(folds.map((fold) => save(offload, fold.path, fold.fullText)));
  return folds.filter((_, i) => saved[i]);
}

/**
 * Where the brief goes: right before the pinned tail, moved back past tool
 * results so it never sits between a tool_use and its tool_result.
 */
function briefIndex(messages: readonly Message[], preserveRecentMessages: number): number {
  let index = Math.max(1, messages.length - preserveRecentMessages);
  while (index > 1 && (messages[index]?.toolResults?.length ?? 0) > 0) index -= 1;
  return index;
}

/**
 * The keep probabilities of every candidate, by call id: from `scoring`
 * `blind` (the fitted history, outputs omitted, as state), `content` (the
 * goal as state, each question showing the call's input and output head) or
 * `none` (0: every candidate is cut). `goal` is the brief when there is one.
 */
async function score(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  resolved: ResolvedCompactOptions,
  goal: string,
  asker: JevAsker,
): Promise<{ answers: Map<string, CallAnswer>; tokens: number; stage: string; requests: number }> {
  const candidates = calls.filter((call) => !call.pinned);
  const answers = new Map<string, CallAnswer>();
  if (candidates.length === 0) return { answers, tokens: 0, stage: '', requests: 0 };
  if (resolved.scoring === 'none') {
    for (const call of candidates) answers.set(call.id, { keepInput: 0, keepResult: 0 });
    return { answers, tokens: 0, stage: 'none', requests: 0 };
  }
  const isContent = resolved.scoring === 'content';
  const questionsOf = isContent
    ? (call: ToolCall) => contentQuestionsFor(call, resultText(messages, call))
    : questionsFor;
  const contentState = { context: CONTENT_CONTEXT, goal };
  const fitted = isContent
    ? { state: contentState, tokens: estimateTokens(JSON.stringify(contentState)), stage: 'content' }
    : fitState(messages, calls, { ...resolved, goal });
  const batches = batchCalls(candidates, fitted.tokens, resolved, questionsOf);
  const answered = await Promise.all(
    batches.map((batch) => askBatch(asker, fitted.state, batch, questionsOf)),
  );
  for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  return { answers, tokens: fitted.tokens, stage: fitted.stage, requests: batches.length };
}

/**
 * Compacts a transcript by asking Claude, for every tool call outside the pinned
 * first and newest messages, whether its full result and its full (long) input
 * must stay verbatim; a part that need not is saved through `offload` and
 * shortened per `format`. With `brief`, one request first writes a brief of
 * the task, inserted as a user message before the pinned tail and used as the
 * goal of scoring. Throws when Claude fails or the history cannot be fitted;
 * the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
  offload?: Offload,
  briefAsker?: TextAsker,
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let brief: Brief | undefined;
  if (resolved.brief !== 'none') {
    if (!briefAsker) throw new Error(`brief "${resolved.brief}" needs a brief asker`);
    brief = await writeBrief(messages, calls, resolved, briefAsker);
  }
  const goal = brief
    ? JSON.stringify(brief)
    : resolved.goal || goalFromMessages(messages, resolved.instructions);
  const bySource = resolved.strategy === 'source';
  const cuts =
    bySource || resolved.supersede ? sourceCuts(calls, (call) => resultText(messages, call), bySource) : undefined;
  const scored = bySource
    ? { answers: new Map<string, CallAnswer>(), tokens: 0, stage: '', requests: 0 }
    : await score(messages, calls, resolved, goal, asker);

  const wholeInputs = keptEdits(calls, resolved.keepEdits);
  const formats = resultFormats(calls, resolved);
  const images = imageWindow(messages, calls, resolved.keepImages);
  const decisions = calls.map((call) => {
    const cut = cuts?.get(call.id);
    const guarded = images.guarded.has(call.resultIndex);
    if (bySource) {
      const keepResult = cut?.result && call.resultChars >= resolved.minCutChars && !guarded ? 0 : 1;
      return decideCall(call, { keepInput: cut?.input ? 0 : 1, keepResult }, resolved);
    }
    const answer = scored.answers.get(call.id) ?? { keepInput: 1, keepResult: 1 };
    const wholeResult =
      (formats.get(call.id) === 'doc' && resolved.docHeadChars === 0) ||
      keptExternal(call, resolved.keepExternalChars) ||
      call.resultChars < resolved.minCutChars;
    return decideCall(
      call,
      {
        keepInput: cut?.input ? 0 : wholeInputs.has(call.id) ? 1 : answer.keepInput,
        keepResult: guarded ? 1 : cut ? 0 : wholeResult ? 1 : answer.keepResult,
      },
      resolved,
    );
  });
  const edits = await offloadParts(messages, calls, decisions, formats, resolved, offload, cuts);
  for (const call of images.dropped) {
    decisions[calls.indexOf(call)]!.result = 'drop';
    edits.set(call.tool_use_id, { ...edits.get(call.tool_use_id), text: imageMark(call, toolResult(messages, call)!.image!) });
  }
  const repeats = (cuts ? repeatedTexts(messages, resolved.preserveRecentMessages) : []).filter(
    (repeat) => messages[repeat.index]!.text.length > repeatedMark(repeat).length,
  );
  const firstRebuiltIndex = Math.min(
    ...calls.filter((call) => edits.has(call.tool_use_id)).map((call) => call.callIndex),
    ...repeats.map((repeat) => repeat.index),
    brief ? briefIndex(messages, resolved.preserveRecentMessages) : Infinity,
  );
  for (const call of calls) {
    const image = toolResult(messages, call)?.image;
    if (!image || call.resultIndex < firstRebuiltIndex || edits.get(call.tool_use_id)?.text !== undefined) continue;
    decisions[calls.indexOf(call)]!.result = 'drop';
    edits.set(call.tool_use_id, { ...edits.get(call.tool_use_id), text: imageMark(call, image) });
  }
  const kept = applyDecisions(messages, edits);
  // A fresh message: one carrying the engine's handle would stand as the engine has it.
  for (const repeat of repeats) kept[repeat.index] = { role: 'assistant', text: repeatedMark(repeat), toolUses: [] };
  const briefText = brief ? `${BRIEF_PREFIX}\n${JSON.stringify(brief, null, 2)}` : '';
  const insertAt = briefIndex(messages, resolved.preserveRecentMessages);
  const foldBefore = Math.min(insertAt, firstRecentCallIndex(calls, resolved));
  const foldsWith = (digests?: ReadonlyMap<string, string>) =>
    resolved.foldStyle === 'index'
      ? turnIndexFoldsBefore(foldBefore, messages, offload?.dir, resolved.queuedPrompts, digests)
      : closedStageFoldsBefore(foldBefore, messages, offload?.dir, resolved.queuedPrompts, digests, resolved.foldStyle);
  const ruleFolds = resolved.foldStages ? foldsWith() : [];
  const modelNotes = {
    rules: undefined,
    model: stageDigests,
    pick: (folds: Parameters<typeof pickedNarration>[0], asker: TextAsker) => pickedNarration(folds, asker, resolved.pickPrompt),
  }[resolved.stageDigest];
  const noteRequests = { sent: 0, failed: 0 };
  const countedAsker: TextAsker | undefined = briefAsker && {
    async complete(request) {
      noteRequests.sent += 1;
      try {
        return await briefAsker.complete(request);
      } catch (error) {
        noteRequests.failed += 1;
        throw error;
      }
    },
  };
  const digests = modelNotes && countedAsker && ruleFolds.length > 0 ? await modelNotes(ruleFolds, countedAsker) : undefined;
  const folds = await savedFolds(digests ? foldsWith(digests) : ruleFolds, offload);
  const foldedPrompts = new Set(folds.flatMap((fold) => fold.anchoredPrompts));
  const unfoldedPrompts = resolved.queuedPrompts.filter((prompt) => !foldedPrompts.has(prompt));
  const historyHint =
    resolved.foldStyle === 'index' && folds.length > 0 && offload
      ? `Earlier turns are folded into "${INDEX_PREFIX}" entries: what changed, what was run and fetched, the user's words, hand-backs, decisions and replies. Every folded call with its full output is saved under ${offload.dir}. Before answering from memory about anything older than the recent calls, look it up there: Grep that dir with -n and head_limit for one distinctive term at a time (a path, symbol, id or English keyword; reports are often in English), and Grep again with another term when the first finds nothing; then Read the file with offset and limit around the hit, or at the @L<n> an entry gives, about 150 lines, never a whole turn file. Reread live files and rerun fetches for their current state.`
      : '';
  const notes = notesText(messages, edits, kept, { ...resolved, queuedPrompts: unfoldedPrompts }, offload, historyHint);
  const inserted = [briefText, notes]
    .filter(Boolean)
    .map((text): Message => ({ role: 'user', text, toolUses: [] }));
  kept.splice(insertAt, 0, ...inserted);
  const output = withFoldsApplied(kept, folds);
  return {
    messages: output,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: output.length,
      charsBefore,
      charsAfter: output.reduce((sum, message) => sum + messageChars(message), 0),
      stagesFolded: folds.length,
      noteRequestsFailed: noteRequests.failed,
      calls: calls.length,
      kept: count(decisions, (d) => !d.pinned && d.input === 'keep' && d.result === 'keep'),
      inputsDropped: count(decisions, (d) => d.input === 'drop'),
      resultsDropped: count(decisions, (d) => d.result === 'drop'),
      offloadFailed:
        count(decisions, (d) => d.input === 'offload_failed') +
        count(decisions, (d) => d.result === 'offload_failed'),
      pinned: count(decisions, (d) => d.pinned),
      stateTokens: scored.tokens,
      stateStage: scored.stage,
      requests: scored.requests + (brief ? 1 : 0) + noteRequests.sent,
      briefChars: briefText.length,
      notesChars: notes.length,
      ms: Date.now() - started,
    },
  };
}

