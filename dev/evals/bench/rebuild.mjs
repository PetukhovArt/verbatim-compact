// Session jsonl + window -> the SessionMessage[] the engine hands `session.compact`.
// The context is the parentUuid chain from the cut back to the window start, not the
// line slice: a rewind leaves its abandoned branch in the file. Records off the chain
// that the engine still sends are parallel tool calls: assistant records sharing a chain
// record's message.id, and the tool results of every tool_use kept.
// One message per non-meta user/assistant record, text blocks joined, thinking and images
// dropped (an image result keeps its size; `imageTokens` counts what it cost).
// Attachment records (queued prompts included) are not messages: the engine does not pass
// them to the hook (a replay without them matches a logged run), and it drops the ones
// hanging off a message the plugin rebuilds.
import { readFileSync } from 'node:fs';

const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []);
const textOf = (content) =>
  blocksOf(content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

function toMessage(record) {
  const blocks = blocksOf(record.message.content);
  const message = {
    role: record.message.role,
    text: textOf(blocks),
    toolUses: blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ tool_use_id: b.id, tool: b.name, input: b.input })),
  };
  // An image result carries its size, as the hook passes it; the record's `toolUseResult` holds the dimensions.
  const size = record.toolUseResult?.file?.dimensions ?? {};
  const results = blocks
    .filter((b) => b.type === 'tool_result')
    .map((b) => {
      const result = { tool_use_id: b.tool_use_id, text: textOf(b.content), isError: Boolean(b.is_error) };
      if (blocksOf(b.content).some((c) => c.type === 'image')) result.image = { width: size.originalWidth ?? 0, height: size.originalHeight ?? 0 };
      return result;
    });
  if (results.length > 0) message.toolResults = results;
  return message;
}

/** Tokens of the images in a record's tool results, w*h/750 over the size the model was sent. */
function imageTokens(record) {
  const size = record.toolUseResult?.file?.dimensions;
  const images = blocksOf(record.message.content)
    .filter((b) => b.type === 'tool_result')
    .flatMap((b) => blocksOf(b.content).filter((c) => c.type === 'image'));
  return images.length * (size ? Math.round((size.displayWidth * size.displayHeight) / 750) : 0);
}

const isMessageRecord = (r) => (r.type === 'user' || r.type === 'assistant') && !r.isMeta;

/** `{ messages, lines, imageTokens }`: the messages, the jsonl line and the image tokens of each. */
export function rebuild({ session_file, window_from_line, cut_line, preserved_lines = [] }) {
  const records = new Map(); // line -> record
  const lineOf = new Map(); // uuid -> line
  readFileSync(session_file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      try {
        const record = JSON.parse(raw);
        records.set(i + 1, record);
        if (record.uuid) lineOf.set(record.uuid, i + 1);
      } catch {}
    });

  const isLinked = (line) => Boolean(records.get(line)?.uuid) && !records.get(line).isSidechain;
  const previous = (line) => {
    let l = line - 1;
    while (l >= window_from_line && !isLinked(l)) l -= 1;
    return l;
  };
  const chain = new Set();
  // A record a plugin compaction installed keeps its original parentUuid, which points
  // before the window; its parent in context is then the record written before it.
  for (let line = isLinked(cut_line) ? cut_line : previous(cut_line); line >= window_from_line; ) {
    chain.add(line);
    const record = records.get(line);
    const parent = record.parentUuid ?? record.logicalParentUuid;
    if (!parent) break;
    const parentLine = lineOf.get(parent) ?? 0;
    line = parentLine >= window_from_line && parentLine < line ? parentLine : previous(line);
  }

  const messageIds = new Set([...chain].map((l) => records.get(l).message?.id).filter(Boolean));
  const inWindow = [...records.keys()].filter((l) => l >= window_from_line && l <= cut_line);
  const siblings = inWindow.filter(
    (l) => !chain.has(l) && records.get(l).type === 'assistant' && messageIds.has(records.get(l).message?.id),
  );
  const kept = new Set([...chain, ...siblings]);
  const toolUseIds = new Set(
    [...kept].flatMap((l) => blocksOf(records.get(l).message?.content).filter((b) => b.type === 'tool_use').map((b) => b.id)),
  );
  for (const l of inWindow) {
    const blocks = records.get(l).type === 'user' ? blocksOf(records.get(l).message?.content) : [];
    if (blocks.some((b) => b.type === 'tool_result' && toolUseIds.has(b.tool_use_id))) kept.add(l);
  }

  const window = [...kept].sort((a, b) => a - b).filter((l) => isMessageRecord(records.get(l)));
  // The engine puts a compaction's preserved messages right after its summary.
  const preserved = preserved_lines.filter((l) => records.get(l) && isMessageRecord(records.get(l)));
  const lines = [...window.slice(0, 1), ...preserved, ...window.slice(1)];
  const messages = lines.map((l) => toMessage(records.get(l)));
  return {
    messages,
    lines,
    imageTokens: lines.map((l) => imageTokens(records.get(l))),
    attachments: queuedPrompts(records, chain, lines, messages),
  };
}

/**
 * The queued prompts on the chain, each with the index of the message it hangs off:
 * the nearest message before it, which a chain of attachments leads back to as well.
 * The model read them as the reminder the record holds. `toolUseId` names a tool block
 * of that message, the anchor the library's `queuedPrompts` option takes; `mode` is
 * `prompt` for a person's or a peer's prompt, `task-notification` for a task's notice.
 */
function queuedPrompts(records, chain, lines, messages) {
  const attachments = [];
  for (const line of [...chain].sort((a, b) => a - b)) {
    const record = records.get(line);
    if (record.attachment?.type !== 'queued_command') continue;
    const afterIndex = Math.max(0, lines.findLastIndex((l, i) => i > 0 && l < line));
    const rendered = (record.rendered ?? []).map((r) => r.content).filter((c) => typeof c === 'string').join('\n');
    const anchor = messages[afterIndex];
    const toolUseId = anchor.toolResults?.[0]?.tool_use_id ?? anchor.toolUses[0]?.tool_use_id;
    const prompt = String(record.attachment.prompt ?? '');
    attachments.push({ line, afterIndex, toolUseId, mode: record.attachment.commandMode, prompt, text: rendered || prompt });
  }
  return attachments;
}

/** The library's `queuedPrompts`: the prompts (not task notices) as typed, as the hook reads them. */
export const queuedPromptsOption = (attachments) =>
  attachments.filter((a) => a.mode === 'prompt').map((a) => ({ text: a.prompt, toolUseId: a.toolUseId }));

/**
 * The context as the model reads it: the messages, each queued prompt after the
 * message it hangs off, when that message came back untouched (the engine drops
 * the attachments of a message a plugin rebuilds).
 */
export function renderContext(input, output, attachments, renderTranscript) {
  const indexOf = new Map(input.map((m, i) => [m, i]));
  const withPrompts = output.flatMap((message) => {
    const index = indexOf.get(message);
    const prompts = index === undefined ? [] : attachments.filter((a) => a.afterIndex === index);
    return [message, ...prompts.map((a) => ({ role: 'user', text: `[queued_command attachment]\n${a.text}`, toolUses: [] }))];
  });
  return {
    text: renderTranscript(withPrompts),
    promptsKept: withPrompts.length - output.length,
  };
}
