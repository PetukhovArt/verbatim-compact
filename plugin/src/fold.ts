import { salvageLines } from './compact.js';
import { EDIT_TOOLS } from './source.js';
import { detectStages, type Stage } from './stages.js';
import { renderTranscript, truncate } from './state.js';
import type { FoldStyle, Message, PickPrompt, QueuedPrompt, ToolUse } from './types.js';

export const FOLD_PREFIX = '[claude-compact: L3 stage fold';

const HAND_BACK = /<task-notification>|\[Subagent hand-back\]|<agent-message/;
const PLUGIN_INSERT = /^\[claude-compact (?:notes|brief)\]/;
const FETCH_COMMAND = /\b(?:glab|gh|jira|curl|git\s+(?:log|show|status|diff))\b|atlassian|jira-tools/;
const OUTPUT_FILE = /<output-file>([^<]+)<\/output-file>|^output_file: (.+)$/m;
const TASK_NOTIFICATION = /<task-notification>[\s\S]*?(?:<\/task-notification>|$)/g;
const AGENT_LAUNCHED = /^Async agent launched successfully/;
const SENT_MESSAGE = /^\{"success":true,"message":"(.*?)(?: → |")/;
const STATUS_ONLY = /is waiting on its own background work/;
const HAND_BACK_BOILERPLATE =
  /^(?:agentId:|output_file:|The agent is working in the background|Do not duplicate this agent|Do NOT Read or tail|running; you'll get|This agent has not reported yet)/;
const INTERNAL_METADATA_NOTE = /\s*\(This tool result is internal metadata[^)]*\)/g;
const HAND_BACK_SUMMARY = /<summary>([^<]+)<\/summary>/;
const HAND_BACK_RESULT = /<result>([\s\S]*?)(?:<\/result>|$)/;

const PROMPT_CHARS = 1500;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'SendMessage']);
const NOTE_MIN_CHARS = 200;
const NOTE_CHARS = 800;
const USER_ANSWER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const FETCH_COMMAND_CHARS = 300;
const LISTED_COMMANDS = 20;
const LISTED_READS = 12;
const LISTED_OTHER_CALLS = 8;
const COMMAND_CHARS = 120;
const HAND_BACK_HEAD_CHARS = 3000;
const HAND_BACK_FACT_LINES = 8;
const LARGEST_FOLD_SHARE = 0.7;

export interface Replacement {
  firstFoldedIndex: number;
  lastFoldedIndex: number;
  text: string;
  roleKeepingAlternation?: Message['role'];
}

export interface StageFold extends Replacement {
  fullText: string;
  path: string;
  anchoredPrompts: QueuedPrompt[];
  narration?: string[];
}

const charsOf = (messages: readonly Message[]): number =>
  messages.reduce(
    (sum, m) =>
      sum +
      m.text.length +
      m.toolUses.reduce((s, t) => s + JSON.stringify(t.input ?? {}).length + (t.text?.length ?? 0), 0) +
      (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0),
    0,
  );

const oneLine = (text: string, limit: number): string => truncate(text.replace(/\s+/g, ' ').trim(), limit);

const targetOf = (tool: ToolUse): string => {
  const { input } = tool;
  const value = input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.description ?? input.url;
  return typeof value === 'string' ? oneLine(value, COMMAND_CHARS) : '';
};

interface HandBack {
  facts: string;
  key: string;
  statusOnly: boolean;
}

function handBackOf(text: string, headChars = HAND_BACK_HEAD_CHARS, label = ''): HandBack {
  const fileMatch = OUTPUT_FILE.exec(text);
  const outputFile = (fileMatch?.[1] ?? fileMatch?.[2])?.trim();
  const fullReport = outputFile ? `full report: ${outputFile}` : '';
  const key = outputFile ?? text;
  const trimmed = text.trim();
  if (AGENT_LAUNCHED.test(trimmed)) {
    return { facts: `${label ? `Agent "${label}"` : 'Agent'} launched`, key, statusOnly: true };
  }
  const sent = SENT_MESSAGE.exec(trimmed)?.[1];
  if (sent !== undefined) return { facts: `sent: ${sent}`, key, statusOnly: false };
  const summary = HAND_BACK_SUMMARY.exec(text)?.[1];
  const result = HAND_BACK_RESULT.exec(text)?.[1];
  const report = (result ?? (summary ? text.replace(TASK_NOTIFICATION, '') : text))
    .replace(INTERNAL_METADATA_NOTE, '')
    .split('\n')
    .filter((line) => !HAND_BACK_BOILERPLATE.test(line.trim()))
    .join('\n')
    .trim();
  const head = truncate(report, headChars);
  const laterFacts = salvageLines(report.slice(headChars), HAND_BACK_FACT_LINES, 600).map((line) => oneLine(line, 160));
  const facts = [...new Set([summary ?? '', head, ...laterFacts].map((line) => line.trim()))].filter(Boolean);
  return {
    facts: [...facts, fullReport].filter(Boolean).join('\n    '),
    key,
    statusOnly: STATUS_ONLY.test(`${summary ?? ''}\n${report}`),
  };
}

const handBackFacts = (text: string, headChars = HAND_BACK_HEAD_CHARS): string => handBackOf(text, headChars).facts;

const LOG_CALL_CHARS = 140;
const LOG_NOTE_CHARS = 800;

function callLine(tool: ToolUse): string {
  const command = typeof tool.input.command === 'string' ? tool.input.command : undefined;
  const limit = command && FETCH_COMMAND.test(command) ? FETCH_COMMAND_CHARS : LOG_CALL_CHARS;
  return `${tool.tool} ${oneLine(command ?? targetOf(tool), limit)}`.trim();
}

function logFoldText(
  body: readonly Message[],
  reportIndexes: ReadonlySet<number>,
  path: string,
  prompts: readonly QueuedPrompt[],
): string {
  const lines = [
    `${FOLD_PREFIX} | tool outputs and long narration are cut, one line per call; full stage (${charsOf(body)} chars) saved to ${path}; Read it if needed]`,
    ...prompts.map((p) => `User (queued): ${truncate(p.text, PROMPT_CHARS)}`),
  ];
  const subagentCalls = new Set<string>();
  const userAnswerCalls = new Set<string>();
  body.forEach((message, index) => {
    if (message.role === 'assistant') {
      const text = message.text.trim();
      if (text) lines.push(reportIndexes.has(index) ? `Report:\n${text}` : `Assistant: ${truncate(text, LOG_NOTE_CHARS)}`);
      for (const tool of message.toolUses) {
        lines.push(`  → ${callLine(tool)}`);
        if (SUBAGENT_TOOLS.has(tool.tool)) subagentCalls.add(tool.tool_use_id);
        if (USER_ANSWER_TOOLS.has(tool.tool)) userAnswerCalls.add(tool.tool_use_id);
        if (tool.text && SUBAGENT_TOOLS.has(tool.tool)) lines.push(`Hand-back: ${handBackFacts(tool.text)}`);
        if (tool.text && USER_ANSWER_TOOLS.has(tool.tool)) lines.push(`User answered: ${truncate(tool.text, PROMPT_CHARS)}`);
      }
      return;
    }
    for (const result of message.toolResults ?? []) {
      if (subagentCalls.has(result.tool_use_id)) lines.push(`Hand-back: ${handBackFacts(result.text)}`);
      if (userAnswerCalls.has(result.tool_use_id)) lines.push(`User answered: ${truncate(result.text, PROMPT_CHARS)}`);
    }
    const text = message.text.trim();
    if (!text || PLUGIN_INSERT.test(text)) return;
    lines.push(HAND_BACK.test(text) ? `Hand-back: ${handBackFacts(text)}` : `User: ${truncate(text, PROMPT_CHARS)}`);
  });
  return lines.join('\n');
}

function foldText(
  body: readonly Message[],
  reportIndexes: ReadonlySet<number>,
  path: string,
  prompts: readonly QueuedPrompt[],
  digest: string | undefined,
): string {
  const changed = new Set<string>();
  const reads = new Set<string>();
  const fetches: string[] = [];
  const commands: string[] = [];
  const otherCalls: string[] = [];
  const userMessages: string[] = prompts.map((p) => truncate(p.text, PROMPT_CHARS));
  const handBacks: string[] = [];
  const notes: string[] = [];
  const subagentCalls = new Set<string>();
  const userAnswerCalls = new Set<string>();
  body.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const tool of message.toolUses) {
        if (SUBAGENT_TOOLS.has(tool.tool)) {
          subagentCalls.add(tool.tool_use_id);
          if (tool.text) handBacks.push(handBackFacts(tool.text));
        }
        if (USER_ANSWER_TOOLS.has(tool.tool)) {
          userAnswerCalls.add(tool.tool_use_id);
          if (tool.text) userMessages.push(truncate(tool.text, PROMPT_CHARS));
        }
        if (EDIT_TOOLS.has(tool.tool)) changed.add(targetOf(tool));
        else if (tool.tool === 'Read') reads.add(targetOf(tool));
        else if (tool.tool === 'Bash' && typeof tool.input.command === 'string') {
          const isFetch = FETCH_COMMAND.test(tool.input.command);
          const command = oneLine(tool.input.command, isFetch ? FETCH_COMMAND_CHARS : COMMAND_CHARS);
          (isFetch ? fetches : commands).push(command);
        } else otherCalls.push(`${tool.tool} ${targetOf(tool)}`.trim());
      }
      if (!reportIndexes.has(index) && message.text.length >= NOTE_MIN_CHARS) notes.push(truncate(message.text.trim(), NOTE_CHARS));
      return;
    }
    for (const result of message.toolResults ?? []) {
      if (subagentCalls.has(result.tool_use_id)) handBacks.push(handBackFacts(result.text));
      if (userAnswerCalls.has(result.tool_use_id)) userMessages.push(truncate(result.text, PROMPT_CHARS));
    }
    const text = message.text.trim();
    if (!text || PLUGIN_INSERT.test(text)) return;
    if (HAND_BACK.test(text)) handBacks.push(handBackFacts(text));
    else userMessages.push(truncate(text, PROMPT_CHARS));
  });
  const unique = (list: readonly string[], limit: number): string[] => [...new Set(list)].slice(0, limit);
  const section = (title: string, lines: readonly string[]): string =>
    lines.length === 0 ? '' : `${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`;
  return [
    `${FOLD_PREFIX} | the stage's calls and narration are cut; full stage (${charsOf(body)} chars) saved to ${path}; Read it if needed]`,
    section('Changed files (Read them for the current content)', [...changed].filter(Boolean)),
    section('Fetched (rerun for the current state)', unique(fetches, LISTED_COMMANDS)),
    section('Other commands', unique(commands, LISTED_COMMANDS)),
    section('Read', unique([...reads].filter(Boolean), LISTED_READS)),
    section('Other calls', unique(otherCalls, LISTED_OTHER_CALLS)),
    section('User messages during the stage', userMessages),
    section('Hand-backs', handBacks),
    digest ? `Decisions and facts of the stage, written at compaction:\n${digest}` : section('Notes', notes),
    ...[...reportIndexes].sort((a, b) => a - b).map((index) => `Report:\n${body[index]!.text}`),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function promptsAnchoredIn(
  messages: readonly Message[],
  queuedPrompts: readonly QueuedPrompt[],
): (first: number, last: number) => QueuedPrompt[] {
  const anchorOf = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const tool of m.toolUses) anchorOf.set(tool.tool_use_id, i);
    for (const result of m.toolResults ?? []) anchorOf.set(result.tool_use_id, i);
  });
  return (first, last) =>
    queuedPrompts.filter((p) => {
      const anchor = anchorOf.get(p.toolUseId ?? '');
      return anchor !== undefined && anchor >= first && anchor <= last;
    });
}

export function closedStageFoldsBefore(
  foldBefore: number,
  messages: readonly Message[],
  offloadDir: string | undefined,
  queuedPrompts: readonly QueuedPrompt[],
  digestsByPath: ReadonlyMap<string, string> = new Map(),
  style: FoldStyle = 'grouped',
): StageFold[] {
  if (!offloadDir) return [];
  const anchoredIn = promptsAnchoredIn(messages, queuedPrompts);
  const folds: StageFold[] = [];
  const foldable = detectStages(messages).filter(
    (stage) => stage.closed && stage.from > 0 && stage.to < foldBefore,
  );
  const endsBeforeUserMessage = (stage: Stage): boolean => messages[stage.to + 1]?.role !== 'assistant';
  for (let k = 0; k < foldable.length; k += 1) {
    const opening = foldable[k]!;
    const firstFoldedIndex = opening.openedBy + 1;
    const opensWithPromptThenAnswer =
      messages[opening.openedBy]!.role === 'user' && messages[firstFoldedIndex]?.role === 'assistant';
    if (!opensWithPromptThenAnswer) continue;
    let last = k;
    while (
      !endsBeforeUserMessage(foldable[last]!) &&
      foldable[last + 1]?.from === foldable[last]!.to + 1 &&
      messages[foldable[last + 1]!.from]!.role === 'assistant'
    ) last += 1;
    if (!endsBeforeUserMessage(foldable[last]!)) continue;
    const chain = foldable.slice(k, last + 1);
    k = last;
    const lastFoldedIndex = chain.at(-1)!.to;
    const body = messages.slice(firstFoldedIndex, lastFoldedIndex + 1);
    const firstCall = body.flatMap((m) => m.toolUses)[0];
    if (!firstCall) continue;
    const anchoredPrompts = anchoredIn(firstFoldedIndex, lastFoldedIndex);
    const reportIndexes = new Set(
      chain.flatMap((stage) => (stage.closedBy !== null && stage.closedBy >= firstFoldedIndex ? [stage.closedBy - firstFoldedIndex] : [])),
    );
    const path = `${offloadDir}/stage-${firstCall.tool_use_id}.txt`;
    const text = style === 'log'
      ? logFoldText(body, reportIndexes, path, anchoredPrompts)
      : foldText(body, reportIndexes, path, anchoredPrompts, digestsByPath.get(path));
    if (text.length > charsOf(body) * LARGEST_FOLD_SHARE) continue;
    folds.push({ firstFoldedIndex, lastFoldedIndex, text, fullText: renderTranscript(body), path, anchoredPrompts });
  }
  return folds;
}

export const INDEX_PREFIX = '[claude-compact: L3 index';

const STATE_CHANGING_COMMAND =
  /\bgit\s+(?:commit|push|checkout|switch|merge|rebase|reset|revert|cherry-pick|stash|branch|tag|worktree)\b|\b(?:glab|gh)\s+(?:mr|pr|issue)\s+(?:create|update|edit|merge|note|comment|approve|close)\b|\b(?:rm|mv|mkdir)\s|\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove)\b/;
const DECISION_WORDING =
  /\b(?:because|since|so that|instead|rather than|decided?|chose|choose|prefer|root cause|caused by|turns out|means|must|never|won't|can't|cannot|breaks?|broken|fail(?:s|ed)?|bug|fix(?:es|ed)?|works?|worked|risk|wrong|correct)\b|потому|поэтому|вместо|решил|выбрал|выбор|причин|оказал|значит|нельзя|надо|нужно|слома|не работает|работает|ошибк|баг|исправ|риск|неверн|правильн/i;
const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/;
const SENTENCE_MIN_CHARS = 8;
const DECISION_MIN_CHARS = 20;
const RECORDED_VALUE = /^[\w.\-/`]{2,60}\s*[=:]\s*\S/;
const SENTENCE_CHARS = 300;
const DECISIONS_CHARS = 1500;
const REPLY_CHARS = 4000;
const INDEX_HAND_BACK_CHARS = 2500;
const LISTED_INDEX_READS = 15;
const STATE_COMMAND_CHARS = 200;
const INDEX_MIN_FOLDED_CHARS = 2000;

const fileNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const isFoldEntry = (message: Message): boolean =>
  message.toolUses.length === 0 && (message.text.startsWith(INDEX_PREFIX) || message.text.startsWith(FOLD_PREFIX));

function foldableIntoIndex(message: Message): boolean {
  if (isFoldEntry(message)) return false;
  if (message.role === 'assistant') return true;
  if (message.toolResults?.length) return true;
  return HAND_BACK.test(message.text) && !PLUGIN_INSERT.test(message.text);
}

const LIST_MARKER = /^(?:(?:[-*•]|\d+[.)])\s+)+/;

const sentencesOf = (text: string): string[] =>
  text
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim().replace(LIST_MARKER, ''))
    .filter((sentence) => sentence.length >= SENTENCE_MIN_CHARS && !sentence.endsWith(':'))
    .map((sentence) => oneLine(sentence, SENTENCE_CHARS));

const decisionSentences = (text: string): string[] =>
  sentencesOf(text).filter(
    (sentence) => RECORDED_VALUE.test(sentence) || (sentence.length >= DECISION_MIN_CHARS && DECISION_WORDING.test(sentence)),
  );

function replyTest(body: readonly Message[]): (message: Message, index: number) => boolean {
  const lastReplyIndex = body.findLastIndex((m) => m.role === 'assistant' && m.toolUses.length === 0 && m.text.trim() !== '');
  return (message, index) => index === lastReplyIndex || (message.toolUses.length === 0 && message.text.trim().length >= REPLY_CHARS / 2);
}

function narrationSentences(body: readonly Message[]): string[] {
  const isReply = replyTest(body);
  return body.flatMap((message, index) =>
    message.role === 'assistant' && message.text.trim() && !isReply(message, index) ? sentencesOf(message.text) : [],
  );
}

function withinChars(lines: readonly string[], limit: number): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const line of new Set(lines)) {
    if (chars + line.length > limit) break;
    kept.push(line);
    chars += line.length;
  }
  return kept;
}

function headerLines(fullText: string): Map<string, number> {
  const lineOfHeader = new Map<string, number>();
  fullText.split('\n').forEach((line, i) => {
    if (line.startsWith('=== #')) lineOfHeader.set(line, i + 1);
  });
  return lineOfHeader;
}

function indexEntryText(
  body: readonly Message[],
  path: string,
  prompts: readonly QueuedPrompt[],
  digest: string | undefined,
  fullText: string,
): string {
  const lineOfHeader = headerLines(fullText);
  const at = (header: string): string => {
    const line = lineOfHeader.get(header);
    return line === undefined ? '' : ` @L${line}`;
  };
  const resultAt = (index: number, id: string, isError?: boolean): string =>
    at(`=== #${index} user · tool_result (${id})${isError ? ' · error' : ''} ===`);
  const textAt = (index: number, role: Message['role']): string => at(`=== #${index} ${role} · text ===`);
  const changed = new Map<string, string>();
  const reads = new Set<string>();
  const stateCommands: string[] = [];
  const fetches: string[] = [];
  const userLines: string[] = prompts.map((p) => `User (queued): ${truncate(p.text, PROMPT_CHARS)}`);
  const handBacks = new Map<string, HandBack>();
  const addHandBack = (handBack: HandBack, key: string, line: string): void => {
    const earlier = handBacks.get(key);
    if (earlier && handBack.statusOnly && !earlier.statusOnly) return;
    handBacks.delete(key);
    handBacks.set(key, { ...handBack, facts: line ? `${handBack.facts}\n    full text saved: Read the turn file at${line}` : handBack.facts });
  };
  const reportedCalls = new Set<string>();
  const callLabels = new Map<string, string>();
  const decisions: string[] = [];
  const replies: string[] = [];
  const subagentCalls = new Set<string>();
  const userAnswerCalls = new Set<string>();
  const isReply = replyTest(body);
  let calls = 0;
  body.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const tool of message.toolUses) {
        calls += 1;
        if (SUBAGENT_TOOLS.has(tool.tool)) {
          subagentCalls.add(tool.tool_use_id);
          callLabels.set(tool.tool_use_id, targetOf(tool));
          if (tool.text) {
            const handBack = handBackOf(tool.text, INDEX_HAND_BACK_CHARS, targetOf(tool));
            reportedCalls.add(tool.tool_use_id);
            addHandBack(handBack, handBack.key === tool.text ? tool.tool_use_id : handBack.key, at(`=== #${index} assistant · tool_use ${tool.tool} (${tool.tool_use_id}) ===`));
          }
        }
        if (USER_ANSWER_TOOLS.has(tool.tool)) {
          userAnswerCalls.add(tool.tool_use_id);
          if (tool.text) userLines.push(`User answered: ${truncate(tool.text, PROMPT_CHARS)}`);
        }
        const command = typeof tool.input.command === 'string' ? tool.input.command : undefined;
        if (EDIT_TOOLS.has(tool.tool)) changed.set(targetOf(tool), at(`=== #${index} assistant · tool_use ${tool.tool} (${tool.tool_use_id}) ===`));
        else if (tool.tool === 'Read' || tool.tool === 'WebFetch') reads.add(targetOf(tool));
        else if (command && FETCH_COMMAND.test(command)) fetches.push(`${oneLine(command, FETCH_COMMAND_CHARS)}${resultAt(index + 1, tool.tool_use_id)}`);
        else if (command && STATE_CHANGING_COMMAND.test(command)) stateCommands.push(oneLine(command, STATE_COMMAND_CHARS));
      }
      const text = message.text.trim();
      if (!text) return;
      if (isReply(message, index)) replies.push(truncate(text, REPLY_CHARS));
      else decisions.push(...decisionSentences(text));
      return;
    }
    for (const result of message.toolResults ?? []) {
      if (subagentCalls.has(result.tool_use_id)) {
        const handBack = handBackOf(result.text, INDEX_HAND_BACK_CHARS, callLabels.get(result.tool_use_id));
        if (!reportedCalls.has(result.tool_use_id)) addHandBack(handBack, handBack.key === result.text ? result.tool_use_id : handBack.key, resultAt(index, result.tool_use_id, result.isError));
      }
      if (userAnswerCalls.has(result.tool_use_id)) userLines.push(`User answered: ${truncate(result.text, PROMPT_CHARS)}`);
    }
    const text = message.text.trim();
    if (!text || PLUGIN_INSERT.test(text)) return;
    if (HAND_BACK.test(text)) {
      const handBack = handBackOf(text, INDEX_HAND_BACK_CHARS);
      addHandBack(handBack, handBack.key, textAt(index, 'user'));
    } else userLines.push(`User: ${truncate(text, PROMPT_CHARS)}`);
  });
  const list = (title: string, items: readonly string[]): string =>
    items.length === 0 ? '' : `${title}: ${items.join(' · ')}`;
  return [
    `${INDEX_PREFIX} | ${calls} calls folded; their full text and outputs (${charsOf(body)} chars) saved as ${fileNameOf(path)} in the offload dir; @L<n> is the line there, Read it with offset n]`,
    list('Changed (Read for the current content)', [...changed].filter(([target]) => target).map(([target, line]) => `${target}${line}`)),
    list('Ran', [...new Set(stateCommands)]),
    list('Fetched (rerun for the current state)', [...new Set(fetches)]),
    list('Read', [...reads].filter(Boolean).slice(0, LISTED_INDEX_READS)),
    ...userLines,
    ...[...handBacks.values()].map(({ facts }) => `Hand-back: ${facts}`),
    digest
      ? `Noted on the way:\n${digest}`
      : decisions.length > 0
        ? `Noted on the way:\n${withinChars(decisions, DECISIONS_CHARS).map((line) => `- ${line}`).join('\n')}`
        : '',
    ...replies.map((reply) => `Replied:\n${reply}`),
  ]
    .filter(Boolean)
    .join('\n');
}

const INDEX_SHORT_PREFIX = `${INDEX_PREFIX}, shortened`;
const ENTRY_SECTION = /^(Changed \(|Ran: |Fetched \(|Read: |User(?: \(queued\)| answered)?: |Hand-back: |Noted on the way:|Replied:)/;
const ENTRY_TURN_FILE = /saved (?:to|as) (\S+\.txt)/;
const ENTRY_CALLS = /(\d+) calls folded/;
const ENTRY_LINE_MARK = / @L\d+$/;
const SHORT_REPLY_CHARS = 1500;
const SHORT_CHANGED_FILES = 20;
const SHORT_CHANGED_SEGMENTS = 2;

function shortChangedLine(line: string): string {
  const targets = line
    .slice(line.indexOf('): ') + 3)
    .split(' · ')
    .map((target) => target.replace(ENTRY_LINE_MARK, '').split('/').slice(-SHORT_CHANGED_SEGMENTS).join('/'));
  const unique = [...new Set(targets.filter(Boolean))];
  const more = unique.length > SHORT_CHANGED_FILES ? ` · +${unique.length - SHORT_CHANGED_FILES} more` : '';
  return `Changed: ${unique.slice(0, SHORT_CHANGED_FILES).join(' · ')}${more}`;
}

function shortReply(lines: readonly string[]): string {
  let head = '';
  for (const paragraph of lines.slice(1).join('\n').trim().split(/\n\s*\n/)) {
    if (head && head.length + paragraph.length > SHORT_REPLY_CHARS) break;
    head += head ? `\n\n${paragraph}` : paragraph;
  }
  return `Replied:\n${truncate(head, SHORT_REPLY_CHARS)}`;
}

function shortIndexEntry(text: string, offloadDir: string): string | undefined {
  const [header = '', ...body] = text.split('\n');
  const turnFile = ENTRY_TURN_FILE.exec(header)?.[1];
  if (header.startsWith(INDEX_SHORT_PREFIX) || !turnFile) return undefined;
  const sections: { kind: string; lines: string[] }[] = [];
  for (const line of body) {
    const kind = ENTRY_SECTION.exec(line)?.[1];
    if (kind) sections.push({ kind, lines: [line] });
    else sections.at(-1)?.lines.push(line);
  }
  const pointer = turnFile.startsWith(`${offloadDir}/`) ? fileNameOf(turnFile) : turnFile;
  const calls = ENTRY_CALLS.exec(header)?.[1];
  const kept = sections.flatMap(({ kind, lines }) => {
    if (kind.startsWith('Changed')) return [shortChangedLine(lines[0]!)];
    if (kind.startsWith('Replied')) return [shortReply(lines)];
    return /^(?:User|Hand-back|Noted)/.test(kind) ? [lines.join('\n')] : [];
  });
  const shortened = [`${INDEX_SHORT_PREFIX} | ${calls ? `${calls} calls folded; ` : ''}commands, outputs and the rest of the reply are in ${pointer}: Grep or Read it]`, ...kept].join('\n');
  return shortened.length < text.length ? shortened : undefined;
}

export function shortenedIndexEntries(foldBefore: number, messages: readonly Message[], offloadDir: string | undefined): Replacement[] {
  if (!offloadDir) return [];
  return messages.slice(1, foldBefore).flatMap((message, offset): Replacement[] => {
    if (message.toolUses.length > 0 || !message.text.startsWith(INDEX_PREFIX)) return [];
    const text = shortIndexEntry(message.text, offloadDir);
    const index = offset + 1;
    return text === undefined ? [] : [{ firstFoldedIndex: index, lastFoldedIndex: index, text, roleKeepingAlternation: message.role }];
  });
}

export function turnIndexFoldsBefore(
  foldBefore: number,
  messages: readonly Message[],
  offloadDir: string | undefined,
  queuedPrompts: readonly QueuedPrompt[],
  digestsByPath: ReadonlyMap<string, string> = new Map(),
): StageFold[] {
  if (!offloadDir) return [];
  const anchoredIn = promptsAnchoredIn(messages, queuedPrompts);
  const folds: StageFold[] = [];
  let next = 1;
  while (next < foldBefore) {
    if (!foldableIntoIndex(messages[next]!)) {
      next += 1;
      continue;
    }
    let first = next;
    let last = next;
    while (last + 1 < foldBefore && foldableIntoIndex(messages[last + 1]!)) last += 1;
    next = last + 1;
    while (first <= last && messages[first]!.toolResults?.length) first += 1;
    while (last >= first && messages[last]!.role === 'assistant' && messages[last]!.toolUses.length > 0) last -= 1;
    if (last < first) continue;
    const body = messages.slice(first, last + 1);
    const firstCall = body.flatMap((m) => m.toolUses)[0];
    if (!firstCall || charsOf(body) < INDEX_MIN_FOLDED_CHARS) continue;
    const anchoredPrompts = anchoredIn(first, last);
    const path = `${offloadDir}/turn-${firstCall.tool_use_id}.txt`;
    const fullText = renderTranscript(body);
    const text = indexEntryText(body, path, anchoredPrompts, digestsByPath.get(path), fullText);
    if (text.length > charsOf(body) * LARGEST_FOLD_SHARE) continue;
    const between = [messages[first - 1]?.role, messages[last + 1]?.role];
    const roleKeepingAlternation = between.includes('assistant') ? 'user' : 'assistant';
    folds.push({ firstFoldedIndex: first, lastFoldedIndex: last, text, fullText, path, anchoredPrompts, roleKeepingAlternation, narration: narrationSentences(body) });
  }
  return folds;
}

const DIGEST_MAX_CHARS = 2500;
const DIGEST_SYSTEM = `You condense one finished stage of a coding assistant's session. The assistant will keep working without the stage's tool calls and narration; it keeps the user's messages, subagent reports and the stage's final report, which you need not repeat. Write what the later work may need from the rest:
- each decision taken, with its reason and the rejected alternative;
- identifiers verbatim: file paths, symbols and constants written or renamed, commands that worked, branch, commit, MR and ticket ids, config keys, values found;
- what was done and what stayed open at the stage's end, and anything found to be wrong or risky.
Plain lines starting with "- ", no preamble, at most ${DIGEST_MAX_CHARS} characters. Never invent; skip what the stage does not show.`;
const DIGEST_INPUT_CHARS = 120_000;
const DIGEST_MAX_TOKENS = 1500;

export interface DigestAsker {
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string>;
}

export async function stageDigests(folds: readonly StageFold[], asker: DigestAsker): Promise<Map<string, string>> {
  const entries = await Promise.all(
    folds.map(async (fold): Promise<[string, string] | undefined> => {
      const stage = fold.fullText.length > DIGEST_INPUT_CHARS
        ? `${fold.fullText.slice(0, DIGEST_INPUT_CHARS / 2)}\n[… middle of the stage left out …]\n${fold.fullText.slice(-DIGEST_INPUT_CHARS / 2)}`
        : fold.fullText;
      try {
        const digest = (await asker.complete({ system: DIGEST_SYSTEM, prompt: `Stage:\n${stage}`, maxTokens: DIGEST_MAX_TOKENS })).trim();
        return digest ? [fold.path, truncate(digest, DIGEST_MAX_CHARS)] : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is [string, string] => entry !== undefined));
}

const PICK_SYSTEM = `A coding assistant's conversation is being compacted. Below are sentences from its own narration between tool calls, one per line as "<id> <sentence>". Only the sentences you pick stay in its context; the rest stays searchable in saved files. Pick the sentences that record a decision and its reason, a rejected option, a cause or finding, a constraint or instruction to follow, or a fact needed later (an identifier, value or result, a line like "NAME=value" included). Leave out plans for the next step, progress chatter and restated questions. Reply with only a JSON array of the picked ids.`;
const PICK_SYSTEM_LISTED_EN = `The session's context is being compacted. Below are sentences from its
own narration between tool calls, one per line as
"<id> <sentence>". Only the sentences with decisions that you pick must stay in its
context. Instructions for picking:

Keep:
- reliable facts
- a decision of the user or of the agent/model, and its reasons
- rejected options and their reasons
- the cause of a problem, or a finding;
- a constraint or instruction to follow;
- a fact needed later (an identifier, value or result).

Do not take:
- plans for the next step;
- progress messages;
- restated questions.

Reply with only a JSON array of the picked ids.`;
const PICK_SYSTEMS: Record<PickPrompt, string> = { prose: PICK_SYSTEM, 'listed-en': PICK_SYSTEM_LISTED_EN };
const PICK_BATCH_CHARS = 60_000;
const PICK_MAX_TOKENS = 4000;
const PICKED_CHARS = 2000;

interface NarrationLine {
  id: string;
  path: string;
  text: string;
}

async function pickedIds(lines: readonly NarrationLine[], asker: DigestAsker, system: string): Promise<Set<string>> {
  const prompt = lines.map((line) => `${line.id} ${line.text}`).join('\n');
  try {
    const reply = await asker.complete({ system, prompt, maxTokens: PICK_MAX_TOKENS });
    const ids: unknown = JSON.parse(/\[[\s\S]*\]/.exec(reply)?.[0] ?? '[]');
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set(lines.filter((line) => decisionSentences(line.text).length > 0).map((line) => line.id));
  }
}

export async function pickedNarration(
  folds: readonly StageFold[],
  asker: DigestAsker,
  prompt: PickPrompt = 'prose',
): Promise<Map<string, string>> {
  const lines: NarrationLine[] = folds.flatMap((fold, f) => (fold.narration ?? []).map((text, k) => ({ id: `${f}.${k}`, path: fold.path, text })));
  const batches: NarrationLine[][] = [];
  let chars = Infinity;
  for (const line of lines) {
    if (chars + line.text.length > PICK_BATCH_CHARS) {
      batches.push([]);
      chars = 0;
    }
    batches.at(-1)!.push(line);
    chars += line.text.length;
  }
  const picked = new Set((await Promise.all(batches.map((batch) => pickedIds(batch, asker, PICK_SYSTEMS[prompt])))).flatMap((ids) => [...ids]));
  const byPath = new Map<string, string[]>();
  for (const line of lines) if (picked.has(line.id)) byPath.set(line.path, [...(byPath.get(line.path) ?? []), line.text]);
  return new Map(
    [...byPath].map(([path, texts]) => [path, withinChars(texts, PICKED_CHARS).map((text) => `- ${text}`).join('\n')]),
  );
}

export function withFoldsApplied(messages: readonly Message[], folds: readonly Replacement[]): Message[] {
  const foldAt = new Map(folds.map((fold) => [fold.firstFoldedIndex, fold]));
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const fold = foldAt.get(i);
    if (!fold) {
      out.push(messages[i]!);
      continue;
    }
    out.push({ role: fold.roleKeepingAlternation ?? 'assistant', text: fold.text, toolUses: [] });
    i = fold.lastFoldedIndex;
  }
  return out;
}
