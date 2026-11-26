// One model request through `claude -p`, tool-less unless `tools` names some, isolated from the user's setup:
// --safe-mode drops CLAUDE.md, skills, plugins, hooks and MCP; --setting-sources ''
// drops the user/project/local settings; the session-bound CLAUDE_CODE_* vars go,
// so the child neither joins this session's messaging nor loads its plugin dirs.
import { spawn } from 'node:child_process';

const DROPPED_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(PLUGIN_DIRS|SESSION_ID|CHILD_SESSION|MESSAGING_\w+|BRIDGE_\w+|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|AUTO_COMPACT_WINDOW|ENABLE_FUNCTION_HOOKS))$/;
const MINIMAL_SYSTEM = 'You answer the request in the user message exactly as it asks.';

export function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED_ENV.test(name)));
}

/**
 * Resolves `{ text, isError, durationApiMs, durationMs, usage, costUsd, toolCalls }`; the prompt
 * goes through stdin. Never rejects on a model failure: `isError` says so, `text` has the reason.
 * `tools` (e.g. `Read,Grep`) are allowed without a prompt, `addDirs` widen where they reach;
 * `toolCalls` lists each call as `{ tool, input, isError }`.
 */
export function ask({ model, prompt, system = MINIMAL_SYSTEM, effort, tools = '', addDirs = [] }) {
  const argv = [
    '-p',
    '--model', model,
    '--output-format', tools ? 'stream-json' : 'json',
    ...(tools ? ['--verbose', '--allowedTools', tools, ...(addDirs.length ? ['--add-dir', ...addDirs] : [])] : []),
    '--system-prompt', system,
    '--tools', tools,
    '--no-session-persistence',
    '--safe-mode',
    '--setting-sources', '',
    '--strict-mcp-config',
    ...(effort ? ['--effort', effort] : []),
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', argv, { env: isolatedEnv(), shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let json;
      const toolCalls = [];
      try {
        if (!tools) json = JSON.parse(out);
        else {
          const events = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
          const results = events.flatMap((e) => (e.type === 'user' && Array.isArray(e.message.content) ? e.message.content : [])).filter((b) => b.type === 'tool_result');
          const errors = new Set(results.filter((b) => b.is_error).map((b) => b.tool_use_id));
          const returnedChars = new Map(results.map((b) => [b.tool_use_id, (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).length]));
          for (const e of events) {
            if (e.type !== 'assistant') continue;
            for (const b of e.message.content) {
              if (b.type === 'tool_use') toolCalls.push({ tool: b.name, input: b.input, isError: errors.has(b.id), returnedChars: returnedChars.get(b.id) ?? 0 });
            }
          }
          json = events.findLast((e) => e.type === 'result');
          if (!json) throw new Error('no result event');
        }
      } catch {
        json = { is_error: true, result: `exit ${code}: ${(err || out).slice(0, 500)}` };
      }
      resolve({
        text: json.result ?? '',
        isError: Boolean(json.is_error),
        durationApiMs: json.duration_api_ms ?? 0,
        durationMs: Date.now() - started,
        usage: json.usage ?? {},
        costUsd: json.total_cost_usd ?? 0,
        toolCalls,
      });
    });
    child.stdin.end(prompt);
  });
}
