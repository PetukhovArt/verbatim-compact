import type { Message } from './types.js';

/** A stretch of the session with one goal (see Stage in GLOSSARY.md); indexes into the messages. */
export interface Stage {
  from: number;
  /** Last message, inclusive. */
  to: number;
  /** The prompt or message that opened the stage; `from` is earlier when slash commands precede the prompt. */
  openedBy: number;
  /** The last assistant text of the stage, its report; null while the stage is open. */
  closedBy: number | null;
  /** True once the next stage has started. */
  closed: boolean;
}

/**
 * An assistant text at least this long, without tool calls, is a report.
 * Mid-turn narration on the bench stays under 200 characters, the one
 * mid-length answer (a side question) at 723; reports run 1900 and up.
 */
const REPORT_CHARS = 1500;

const COMMAND = /^\s*<command-(?:name|message)>/;
/** Commands that set or drop the session's goal: a stage boundary on their own. */
const GOAL_COMMAND = /<command-name>\/(?:goal|clear)<\/command-name>/;
/** User text the harness wrote, not the person: task notices, command output. */
const HARNESS_TEXT = /^\s*<(?:task-notification|local-command-(?:stdout|stderr|caveat))>/;

const isCommand = (message: Message): boolean => message.role === 'user' && COMMAND.test(message.text);

/** Text the person typed: not a tool result alone, a command record or a harness notice. */
function isPrompt(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.text.trim() !== '' &&
    !COMMAND.test(message.text) &&
    !HARNESS_TEXT.test(message.text)
  );
}

const isReport = (message: Message): boolean =>
  message.role === 'assistant' && message.toolUses.length === 0 && message.text.length >= REPORT_CHARS;

/** Ends with a question mark, past trailing markdown emphasis, quotes and brackets. */
const endsWithQuestion = (text: string): boolean => /\?[\s*_`»")\]]*$/.test(text);

/**
 * Where the stage opened at `index` starts: a prompt takes along the command
 * records and notices between it and the last assistant message.
 */
function stageStart(messages: readonly Message[], index: number): number {
  let from = index;
  while (from > 0 && messages[from - 1].role === 'user' && !messages[from - 1].toolResults) from -= 1;
  return from;
}

/**
 * Whether message `index` opens a new stage:
 * - a `/goal` or `/clear` command record;
 * - a prompt answering the assistant's last text when that text is a report or
 *   ends with a question, or a prompt that follows a slash command (the person
 *   stepped out of the stage to run it); other prompts are side questions or
 *   corrections inside the stage;
 * - an assistant message right after a report: a turn that no visible prompt
 *   started (a Stop hook, a `/goal` set, a hand-back; those records never reach
 *   the hook). After a short text the same restart is the Stop hook nagging
 *   within the stage.
 * Task notices alone open nothing: a hand-back lands inside the stage waiting for it.
 */
function opensStage(messages: readonly Message[], index: number): boolean {
  const message = messages[index];
  if (message.role === 'user' && GOAL_COMMAND.test(message.text)) return true;
  if (message.role === 'assistant') return index > 0 && isReport(messages[index - 1]);
  if (!isPrompt(message)) return false;
  const from = stageStart(messages, index);
  if (messages.slice(from, index).some(isCommand)) return true;
  const answered = messages.slice(0, from).findLast((m) => m.role === 'assistant' && m.text.trim() !== '');
  return answered !== undefined && (isReport(answered) || endsWithQuestion(answered.text.trimEnd()));
}

/**
 * Splits the messages into stages at the boundaries the messages themselves
 * show, with no model call. Every stage but the last is closed.
 */
export function detectStages(messages: readonly Message[]): Stage[] {
  if (messages.length === 0) return [];
  const openings = [0];
  for (let index = 1; index < messages.length; index += 1) {
    // A prompt right after a `/goal` record opens the same stage as the record.
    if (opensStage(messages, index) && stageStart(messages, index) > openings.at(-1)!) openings.push(index);
  }
  const starts = openings.map((index, k) => (k === 0 ? 0 : stageStart(messages, index)));
  return openings.map((openedBy, k) => {
    const closed = k < openings.length - 1;
    const to = closed ? starts[k + 1] - 1 : messages.length - 1;
    const report = messages.slice(starts[k], to + 1).findLastIndex((m) => m.role === 'assistant' && m.text.trim() !== '');
    return {
      from: starts[k],
      to,
      openedBy,
      closedBy: closed && report >= 0 ? starts[k] + report : null,
      closed,
    };
  });
}
