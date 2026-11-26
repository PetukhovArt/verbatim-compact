import { isPinned } from './state.js';
import type { Message, ToolCall } from './types.js';

/**
 * What the `source` strategy cuts of one candidate call (see Live source,
 * Pointer and Supersession in GLOSSARY.md).
 */
export interface SourceCut {
  /** How to get the content back, and the call that superseded it, if any. */
  pointer: string;
  input: boolean;
  result: boolean;
  /** The result keeps its first lines ahead of the marker; a superseded one keeps the marker only. */
  head: boolean;
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A Bash segment printing a file, whose output a Read of it restores. */
const FILE_READER = /^(?:cat|head|tail|less|type|Get-Content|sed\s+-n)\b/;
/** A Bash segment whose output rerunning it restores. */
const RERUNNABLE =
  /^(?:grep|rg|ls|find|wc|git(?:\s+-C\s+\S+|\s+--no-pager)*\s+(?:show|log|diff|status|branch)|(?:glab|gh)\s+\S+\s+(?:view|list|diff))\b/;
/** Segments allowed alongside a reader: they change nothing (a shell variable set to a plain word included). */
const FILTER = /^(?:(?:cd|echo|sort|uniq|cut|tr|jq|nl)\b|[A-Za-z_]\w*=[^\s$`]*$)/;
/** Redirects that write nothing. */
const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*\/dev\/null/g;
/** A write inside otherwise read-only programs; `-i` counts for sed only (for grep and rg it ignores case). */
const WRITES = />|\bsed\s[^|;&]*\s-i\b|\s-(?:delete|exec)\b|\bgit\s+branch\s+-[dDmM]\b/;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const unquote = (text: string): string => text.replace(/^['"]|['"]$/g, '');
const normalPath = (path: string): string => unquote(path).replace(/\\/g, '/').toLowerCase();

/** The segments of a read-only Bash command, or undefined when any segment may write. */
function readOnlySegments(command: string): string[] | undefined {
  const segments = command.split(/\s*(?:&&|\|\||[;|\n])\s*/).filter(Boolean);
  const readOnly =
    !WRITES.test(command.replace(HARMLESS_REDIRECT, '')) &&
    segments.every((s) => FILE_READER.test(s) || RERUNNABLE.test(s) || FILTER.test(s)) &&
    segments.some((s) => !FILTER.test(s));
  return readOnly ? segments : undefined;
}

/** The file a call reads whole or in part: Read, or a lone Bash cat/head/tail/sed -n of it. */
function readPath(call: Pick<ToolCall, 'tool' | 'input'>): string | undefined {
  if (call.tool === 'Read') return typeof call.input.file_path === 'string' ? call.input.file_path : undefined;
  const command = call.tool === 'Bash' && typeof call.input.command === 'string' ? call.input.command : '';
  const segments = readOnlySegments(command);
  if (segments?.length !== 1 || !FILE_READER.test(segments[0]!)) return undefined;
  const last = segments[0]!.split(/\s+/).at(-1)!;
  return last.startsWith('-') || FILE_READER.test(last) ? undefined : unquote(last);
}

function editPath(call: Pick<ToolCall, 'tool' | 'input'>): string | undefined {
  const path = call.input.file_path ?? call.input.notebook_path;
  return EDIT_TOOLS.has(call.tool) && typeof path === 'string' ? path : undefined;
}

/**
 * The pointer to a call's live source, undefined when it has none: a Read of
 * the file, a rerun of a search or of a read-only command, a git diff of an
 * edited file. Anything off this list stays whole.
 */
export function liveSource(call: Pick<ToolCall, 'tool' | 'input'>): string | undefined {
  const { input } = call;
  const edited = editPath(call);
  if (edited) return `git diff -- ${edited}`;
  const read = readPath(call);
  if (read && call.tool === 'Read') {
    const range = ['offset', 'limit'].filter((key) => typeof input[key] === 'number').map((key) => `${key}=${input[key]}`);
    return oneLine(`Read ${read} ${range.join(' ')}`);
  }
  if (read) return `Read ${read}`;
  if (call.tool === 'Grep' || call.tool === 'Glob') {
    return oneLine(`rerun: ${call.tool} ${String(input.pattern ?? '')} ${typeof input.path === 'string' ? input.path : ''}`);
  }
  const command = call.tool === 'Bash' && typeof input.command === 'string' ? input.command : '';
  return readOnlySegments(command) ? `rerun: ${oneLine(command)}` : undefined;
}

/** An edit result saying a hook refused it. */
const DENIED = /hook|denied|deny|blocked/i;

/**
 * The tool_use_id superseding each call, by call id: a later successful read
 * or edit of a file an earlier call read, a later edit of a file a hook
 * refused an edit of.
 */
function supersessions(calls: readonly ToolCall[], resultOf: (call: ToolCall) => string): Map<string, string> {
  const touched = new Map<string, string>();
  const edited = new Map<string, string>();
  const by = new Map<string, string>();
  for (const call of [...calls].reverse()) {
    const read = readPath(call);
    const edit = editPath(call);
    const later = read === undefined ? undefined : touched.get(normalPath(read));
    if (later) by.set(call.id, later);
    const retry = edit === undefined ? undefined : edited.get(normalPath(edit));
    if (retry && call.isError && DENIED.test(resultOf(call))) by.set(call.id, retry);
    const file = read ?? edit;
    if (file !== undefined && !call.isError) touched.set(normalPath(file), call.tool_use_id);
    if (edit !== undefined) edited.set(normalPath(edit), call.tool_use_id);
  }
  return by;
}

/**
 * The cut of every candidate call with a live source or superseded: a read
 * or search loses its result to its first lines and a pointer (an error stays
 * whole), an edit its input; a superseded call keeps the marker only. Without
 * `live`, only the superseded calls, their pointer naming the superseding call alone.
 */
export function sourceCuts(
  calls: readonly ToolCall[],
  resultOf: (call: ToolCall) => string,
  live = true,
): Map<string, SourceCut> {
  const superseded = supersessions(calls, resultOf);
  const cuts = new Map<string, SourceCut>();
  for (const call of calls) {
    if (call.pinned) continue;
    const source = live ? liveSource(call) : undefined;
    const by = superseded.get(call.id);
    const edit = EDIT_TOOLS.has(call.tool);
    if (by) {
      const pointer = [source, `superseded by ${by}`].filter(Boolean).join(', ');
      cuts.set(call.id, { pointer, input: edit, result: true, head: false });
    } else if (source) {
      cuts.set(call.id, { pointer: source, input: edit, result: !edit && !call.isError, head: true });
    }
  }
  return cuts;
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\d]+/gu) ?? []);

/** Share of the words two texts have in common (Jaccard). */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / (x.size + y.size - shared || 1);
}

/** Two texts this close in words say the same thing (a Stop-hook loop rewording its wait). */
const REPEAT_OVERLAP = 0.5;

/** A repeated text: its message, its place in the run and the run's length, the kept last one included. */
export interface Repeat {
  index: number;
  nth: number;
  of: number;
}

/**
 * Unpinned assistant texts without tool calls that the next such text in an
 * unbroken run repeats near word for word: the run keeps its last one. A tool
 * call or a user text breaks the run; a marker text is skipped.
 */
export function repeatedTexts(messages: readonly Message[], preserveRecentMessages: number): Repeat[] {
  const runs: number[][] = [];
  let run: number[] = [];
  let previous: number | undefined;
  const close = (): void => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  messages.forEach((message, index) => {
    const text = message.text.trim();
    if (message.toolUses.length > 0 || (message.role === 'user' && text)) {
      previous = undefined;
      close();
    }
    if (message.role !== 'assistant' || message.toolUses.length > 0 || !text || text.startsWith('[claude-compact:')) return;
    if (previous !== undefined && overlap(messages[previous]!.text, text) >= REPEAT_OVERLAP) run.push(previous);
    else close();
    previous = isPinned(index, messages.length, preserveRecentMessages) ? undefined : index;
  });
  close();
  return runs.flatMap((indexes) => indexes.map((index, k) => ({ index, nth: k + 1, of: indexes.length + 1 })));
}
