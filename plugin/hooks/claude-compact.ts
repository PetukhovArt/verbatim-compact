import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
} from 'claude-code';

import { compact, DEFAULT_OPTIONS, reductionRatio, resolveOptions, type Offload } from '../src/compact.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  JevResponse,
  Message,
  QueuedPrompt,
  TextAsker,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  minReductionRatio: 0.25,
  model: 'sonnet',
  briefModel: 'haiku',
};

/** String options passed to the library as they are; the manifest limits their values. */
const VARIANT_KEYS = ['strategy', 'scoring'] as const;
const NUMBER_KEYS = ['preserveRecentMessages', 'keepImages'] as const;

/**
 * `$.model.complete`'s result in 2.1.280. The bundled 2.1.274 types still say
 * `Promise<string>`, so the shape is declared here.
 */
export type ModelCompleteResult =
  | { isAnswered: true; text: string }
  | { isAnswered: false; reason: string; status?: number; error?: string };

export type ModelComplete = (request: {
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  effort?: string;
}) => Promise<ModelCompleteResult>;

export type HookConfig = CompactOptions & {
  minReductionRatio: number;
  scoringModel: string;
  briefModel: string;
  /** `$.model.complete`'s effort per stage; unset leaves the model's default. */
  scoringEffort?: string;
  briefEffort?: string;
  /** Read the window's queued prompts from the transcript, for the library's `queuedPrompts`. */
  restoreQueued?: boolean;
};


function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const values: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of NUMBER_KEYS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) values[key] = value;
  }
  const scoringModel = HOOK_DEFAULTS.model;
  const config: HookConfig = {
    restoreQueued: true,
    ...values,
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    scoringModel,
    briefModel: HOOK_DEFAULTS.briefModel,
  };
  for (const key of VARIANT_KEYS) {
    const value = optionString(options, key);
    if (value) Object.assign(config, { [key]: value });
  }
  return config;
}

export function claudePrompt(state: unknown, questions: Record<string, { instructions: string }>): string {
  const lines = Object.entries(questions).map(([name, q]) => `${name}: ${q.instructions}`);
  return `${JSON.stringify(state)}

For each question below, give the probability (0 to 1) that its statement is true.
Every call stays in the history. An output not kept verbatim keeps its head, its lines naming commit hashes, paths, branches or errors, and a note pointing to a file with the full text, so nothing is lost. File contents and search results (cat, sed, grep, Read) are cheap to recover from that file or the source: answer above 0.5 only when the assistant will need most of the output in context for its very next steps. An input not kept verbatim keeps its short fields (paths, commands) and the head of each long one (written file contents, edit strings), with a note pointing to a file with the full input. Earlier writes and edits are already on disk: answer above 0.5 only when the exact text still matters at the current stage of the session.
${lines.join('\n')}

Reply with only a JSON object mapping every question name to its probability, like {"${
    Object.keys(questions)[0] ?? 'name'
  }": 0.7}, and nothing else.`;
}

/**
 * Reads `{ name: probability }` out of the reply. A missing or invalid answer
 * counts as keep (1); more than half missing throws, so the hook falls back.
 */
export function parseAnswers(text: string, names: readonly string[]): JevResponse {
  const unfenced = text.replace(/```(?:json)?/g, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.indexOf('}', start);
  let parsed: Record<string, unknown> = {};
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(unfenced.slice(start, end + 1));
    } catch {}
  }
  let missing = 0;
  const answers: JevResponse['answers'] = {};
  for (const name of names) {
    const value = parsed[name];
    const valid = typeof value === 'number' && value >= 0 && value <= 1;
    if (!valid) missing += 1;
    answers[name] = { noul: valid ? value : 1 };
  }
  if (missing * 2 > names.length) {
    throw new Error(`${missing}/${names.length} answers missing`);
  }
  return { answers };
}

/** A `TextAsker` over the engine's `$.model.complete`, for the brief. */
export function claudeTextAsker(complete: ModelComplete, model: string, effort?: string): TextAsker {
  return {
    async complete(request) {
      const reply = await complete({ model, ...request, ...(effort && { effort }) });
      if (!reply.isAnswered) throw new Error(`model not answered: ${reply.reason}`);
      return reply.text;
    },
  };
}

/** A `JevAsker` over the engine's `$.model.complete`. */
export function claudeAsker(complete: ModelComplete, model: string, effort?: string): JevAsker {
  return {
    async ask(state, questions) {
      const names = Object.keys(questions);
      const reply = await complete({
        model,
        prompt: claudePrompt(state, questions),
        maxTokens: 4096 + names.length * 24,
        ...(effort && { effort }),
      });
      if (!reply.isAnswered) throw new Error(`model not answered: ${reply.reason}`);
      return parseAnswers(reply.text, names);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

type ImageRecord = { type?: unknown; file?: { dimensions?: { originalWidth?: number; originalHeight?: number } } };

/** The size of the image a Read returned (its stored record, text ''), 0 when unknown; undefined for any other result. */
function imageOf(result: ToolResultSummary): ToolResult['image'] {
  const record = result.result as ImageRecord | undefined;
  if (result.text !== '' || record?.type !== 'image') return undefined;
  const size = record.file?.dimensions;
  return { width: size?.originalWidth ?? 0, height: size?.originalHeight ?? 0 };
}

/** The library's view of the session: a message with an image result is copied, the image's base64 replaced by its size. */
export function toMessages(input: readonly SessionMessage[]): Message[] {
  return input.map((message) => {
    if (!message.toolResults?.some(imageOf)) return message;
    const toolResults = message.toolResults.map((result): ToolResult => {
      const image = imageOf(result);
      return image ? { tool_use_id: result.tool_use_id, text: result.text, isError: result.isError, image } : result;
    });
    return { role: message.role, text: message.text, toolUses: message.toolUses, toolResults };
  });
}

/**
 * Maps the library's output back onto session messages; `libInput` is what the
 * library was given, index for index with `input`. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
  libInput: readonly Message[] = input,
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  input.forEach((message, i) => {
    const own = libInput[i]!;
    messages.set(own, message);
    own.toolUses.forEach((tool, j) => uses.set(tool, message.toolUses[j]!));
    own.toolResults?.forEach((result, j) => results.set(result, message.toolResults![j]!));
  });
  let edited = false;
  return output.map((message) => {
    const own = messages.get(message);
    if (own && !edited) return own;
    edited = true;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when Claude fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  complete: ModelComplete,
  offload?: Offload,
): Promise<SessionCompaction> {
  const libInput = toMessages(messages);
  const result = await compact(
    libInput,
    claudeAsker(complete, config.scoringModel, config.scoringEffort),
    config,
    offload,
    claudeTextAsker(complete, config.briefModel, config.briefEffort),
  );
  return { result, messages: toSessionMessages(messages, result.messages, libInput) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.inputsDropped > 0 ? `${stats.inputsDropped} inputs truncated` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.offloadFailed > 0 ? `${stats.offloadFailed} parts kept whole (offload failed)` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.stagesFolded > 0 ? `${stats.stagesFolded} turns folded` : '',
    stats.noteRequestsFailed > 0 ? `${stats.noteRequestsFailed} pick request(s) failed, rules used` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${
    stats.briefChars > 0 ? `; brief ${stats.briefChars} chars` : ''
  }`;
}

/** FNV-1a of `text`, 8 hex digits. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const PER_RUN_KEYS = new Set(['goal', 'instructions', 'queuedPrompts']);

/**
 * The library defaults' hash, then every option that differs from them: a
 * stale module shows as another hash, a stale or custom config as overrides.
 */
export function configLine(config: CompactOptions): string {
  const defaults = new Map(Object.entries(DEFAULT_OPTIONS));
  const overrides = Object.entries(resolveOptions(config))
    .filter(([key, value]) => !PER_RUN_KEYS.has(key) && JSON.stringify(value) !== JSON.stringify(defaults.get(key)))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `config: defaults ${hash(JSON.stringify(DEFAULT_OPTIONS))}${
    overrides.length > 0 ? `, overrides ${overrides.join(' ')}` : ', no overrides'
  }`;
}

const UI_LOG_MAX_CHARS = 4096;

type HomeHost = { env: { get: (name: string) => Promise<string | undefined> } };

async function homeDir($: HomeHost): Promise<string | undefined> {
  return ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')))?.replace(/\\/g, '/');
}

/**
 * `~/.claude/compact-offload/<session id>`; a timestamp and random suffix
 * stand in for the id when the engine does not give one. Undefined without a
 * home directory, so nothing is truncated.
 */
async function offloadDir($: HomeHost & { session: { id: () => Promise<string> } }): Promise<string | undefined> {
  const home = await homeDir($);
  if (!home) return undefined;
  let id: string;
  try {
    id = await $.session.id();
  } catch {
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return `${home}/.claude/compact-offload/${id}`;
}

/** `~/.claude/projects/<cwd, each character but a letter or digit a dash>/<session id>.jsonl`. */
export function transcriptPath(home: string, cwd: string, id: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`;
}

type TranscriptRecord = {
  uuid?: string;
  parentUuid?: string | null;
  subtype?: string;
  attachment?: { type?: string; commandMode?: string; prompt?: unknown };
  message?: { content?: unknown };
};

function parseRecords(jsonl: string): TranscriptRecord[] {
  return jsonl.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as TranscriptRecord];
    } catch {
      return [];
    }
  });
}

/** A tool block id of the message record at or above `uuid`, the attachments between skipped. */
function anchorOf(uuid: string | null | undefined, byUuid: ReadonlyMap<string, TranscriptRecord>): string | undefined {
  let record = uuid ? byUuid.get(uuid) : undefined;
  while (record && !record.message) record = record.parentUuid ? byUuid.get(record.parentUuid) : undefined;
  const blocks = Array.isArray(record?.message?.content) ? (record.message.content as Record<string, unknown>[]) : [];
  const block = blocks.find((b) => b.type === 'tool_use' || b.type === 'tool_result');
  const id = block?.type === 'tool_use' ? block.id : block?.tool_use_id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The prompts queued since the last compact boundary (task notices left out),
 * each anchored to the message it hangs off; `records` in file order, `parents`
 * holding at least the records they hang off.
 */
export function queuedPromptsOf(
  records: readonly TranscriptRecord[],
  parents: ReadonlyMap<string, TranscriptRecord>,
): QueuedPrompt[] {
  return records
    .slice(records.findLastIndex((r) => r.subtype === 'compact_boundary') + 1)
    .filter((r) => r.attachment?.type === 'queued_command' && r.attachment.commandMode === 'prompt')
    .map((r) => ({ text: String(r.attachment?.prompt ?? ''), toolUseId: anchorOf(r.parentUuid, parents) }));
}

type TranscriptHost = HomeHost & {
  session: { id: () => Promise<string>; cwd: () => Promise<string> };
  fs: { read: (path: string) => Promise<string> };
  process: { run: (argv: readonly string[], init?: { cwd?: string }) => Promise<{ stdout: string }> };
};

/**
 * The session transcript's queued prompts. `$.fs.read` refuses a file over
 * 4 MiB, so a long transcript is filtered through grep: the queued and boundary
 * records first, then the records they hang off, a few hops up.
 */
export async function readQueuedPrompts($: TranscriptHost): Promise<QueuedPrompt[]> {
  const home = await homeDir($);
  if (!home) return [];
  const path = transcriptPath(home, await $.session.cwd(), await $.session.id());
  const byUuid = (records: TranscriptRecord[]): Map<string, TranscriptRecord> =>
    new Map(records.flatMap((r) => (r.uuid ? [[r.uuid, r] as const] : [])));
  try {
    const records = parseRecords(await $.fs.read(path));
    return queuedPromptsOf(records, byUuid(records));
  } catch {
    const slash = path.lastIndexOf('/');
    const grep = async (patterns: string[]): Promise<TranscriptRecord[]> =>
      parseRecords(
        (
          await $.process.run(
            ['git', 'grep', '--no-index', '-h', '-F', ...patterns.flatMap((p) => ['-e', p]), '--', path.slice(slash + 1)],
            { cwd: path.slice(0, slash) },
          )
        ).stdout,
      );
    const records = await grep(['"queued_command"', '"compact_boundary"']);
    const parents = new Map<string, TranscriptRecord>();
    let wanted = records.flatMap((r) => (r.attachment?.type === 'queued_command' && r.parentUuid ? [r.parentUuid] : []));
    for (let hop = 0; hop < 4 && wanted.length > 0; hop++) {
      const found = byUuid(await grep(wanted.map((uuid) => `"uuid":"${uuid}"`)));
      for (const [uuid, record] of found) parents.set(uuid, record);
      wanted = wanted.flatMap((uuid) => {
        const record = found.get(uuid);
        return record && !record.message && record.parentUuid ? [record.parentUuid] : [];
      });
    }
    return queuedPromptsOf(records, parents);
  }
}

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => !d.pinned)
    .map(
      (d) =>
        `${d.id}:${d.tool}:input=${d.input}@${d.keepInput.toFixed(2)}/result=${d.result}@${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  // The engine prefixes a plugin's log lines with its name already.
  $.ui.log(text);
  $.ui.toast(`claude-compact: ${text}`, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  // Runs whenever the engine compacts: /compact, or its autocompact threshold
  // (CLAUDE_CODE_AUTO_COMPACT_WINDOW sets the window it is measured against).
  const configured = resolveHookConfig(options);

  // Only a person's /compact falls back to the built-in summary; any other
  // trigger installs the plugin's result even below the minimum, or skips.
  on('session.compact', async ($, event, next) => {
    const { trigger } = event;
    const isManual = trigger === 'manual';
    // `/compact native [instructions]` asks for the built-in summary outright.
    const native = isManual ? /^native\b\s*/.exec(event.instructions ?? '') : null;
    if (native) {
      notify($, `${trigger}: built-in summary requested`);
      return next({ ...event, instructions: event.instructions!.slice(native[0].length) || undefined });
    }
    try {
      const config: HookConfig = { ...configured, instructions: event.instructions };
      const debug = (text: string): void => $.ui.log(text, { to: 'debug' });
      debug(configLine(config));
      if (config.restoreQueued) {
        try {
          config.queuedPrompts = await readQueuedPrompts($);
          debug(`restoreQueued: ${config.queuedPrompts.length} queued prompt(s) in the transcript`);
        } catch (error) {
          debug(`restoreQueued: transcript not read (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const dir = await offloadDir($);
      const write = async (path: string, text: string): Promise<void> => {
        if (!(await $.fs.exists(path))) await $.fs.write(path, text);
      };
      const { result, messages } = await compactSession(
        event.messages,
        config,
        (request) => $.model.complete(request) as unknown as Promise<ModelCompleteResult>,
        dir === undefined ? undefined : { dir, write },
      );
      for (const line of decisionLogLines(result)) debug(line);
      const isBelowMinimum = reductionRatio(result) < config.minReductionRatio;
      const minimum = `below ${percent(config.minReductionRatio)} minimum`;
      if (isBelowMinimum && isManual) {
        notify($, `${trigger}: fallback to built-in summary (${minimum}: ${summarize(result)})`);
        return next(event);
      }
      notify(
        $,
        `${trigger}: kept ${messages.length}/${event.messages.length} messages, no summary${
          isBelowMinimum ? `, ${minimum}` : ''
        } (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isManual) {
        notify($, `${trigger}: fallback to built-in summary (${reason})`);
        return next(event);
      }
      notify($, `${trigger}: compaction skipped (${reason})`);
      return { skip: `claude-compact: ${reason}` };
    }
  });
};

export { resolveOptions };
