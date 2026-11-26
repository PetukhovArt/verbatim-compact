// Usage: node jsonl-readable.mjs <session.jsonl> <from> <to> <out.txt>  (1-based, inclusive line numbers)
import { readFileSync, writeFileSync } from 'node:fs';
const [file, from, to, out] = process.argv.slice(2);
const lines = readFileSync(file, 'utf8').split('\n');
const blocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c ?? []);
const resultText = (c) =>
  blocks(c).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? `[image, ${b.source?.data?.length ?? 0} base64 chars]` : `[${b.type}]`)).join('\n');
const parts = [];
for (let n = Number(from); n <= Number(to); n++) {
  if (!lines[n - 1]) continue;
  const o = JSON.parse(lines[n - 1]);
  if (o.type === 'system') {
    parts.push(`=== L${n} · system · ${o.subtype} ===\n${o.content ?? ''}${o.compactMetadata ? '\n' + JSON.stringify(o.compactMetadata) : ''}`);
    continue;
  }
  if (o.type !== 'user' && o.type !== 'assistant') continue;
  for (const b of blocks(o.message?.content)) {
    if (b.type === 'text') parts.push(`=== L${n} · ${o.type}${o.isMeta ? ' (meta)' : ''} · text ===\n${b.text}`);
    else if (b.type === 'tool_use') parts.push(`=== L${n} · assistant · tool_use ${b.name} (${b.id}) ===\n${JSON.stringify(b.input, null, 2)}`);
    else if (b.type === 'tool_result') {
      const text = resultText(b.content);
      const mark = text.includes('[claude-compact:') ? ' · TRUNCATED' : '';
      parts.push(`=== L${n} · user · tool_result (${b.tool_use_id})${b.is_error ? ' · error' : ''}${mark} ===\n${text}`);
    }
  }
}
writeFileSync(out, parts.join('\n\n') + '\n');
console.log(`${parts.length} blocks, ${readFileSync(out).length} bytes`);
