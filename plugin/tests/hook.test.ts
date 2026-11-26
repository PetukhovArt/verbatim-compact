import { describe, expect, test as it } from 'claude-code/testing';
import {
  compactSession,
  parseAnswers,
  decisionLog,
  decisionLogLines,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/claude-compact.ts';
import { applyDecisions } from '../src/compact.ts';
import type { Message } from '../src/types.ts';

type SessionMessage = Message & { handle?: string };

/** The pre-tiered defaults these tests were written against. */
const LEGACY = {
  recentFraction: 1,
  headFraction: 0,
  shortMarkers: false,
  inputFieldChars: 300,
  keepEdits: 0,
  keepDocs: 'none',
  keepExternalChars: 0,
  minCutChars: 0,
} as const;

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function fakeComplete(answer: (name: string) => number, models: string[] = []) {
  return async (request: { model: string; prompt: string }) => {
    models.push(request.model);
    const names = [...request.prompt.matchAll(/^((?:input|result)_\w+):/gm)].map((m) => m[1]!);
    const answers = Object.fromEntries(names.map((name) => [name, answer(name)]));
    return { isAnswered: true as const, text: JSON.stringify(answers) };
  };
}

const offload = { dir: '/tmp', write: async () => {} };

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      restoreQueued: true,
      minReductionRatio: 0.25,
      scoringModel: 'sonnet',
      briefModel: 'haiku',
    });
    expect(
      resolveHookConfig({ keepImages: 1, scoring: 'blind', keepThreshold: 0.3, model: 'm-x', minReductionRatio: 'no' }),
    ).toEqual({
      restoreQueued: true,
      keepImages: 1,
      scoring: 'blind',
      scoringModel: 'sonnet',
      briefModel: 'haiku',
      minReductionRatio: 0.25,
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects before the first rebuilt message and handle-less copies from it on', () => {
    const messages = transcript();
    const out = toSessionMessages(messages, applyDecisions(messages, new Map([['tool-1', { text: 'short' }]])));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toBe('short');
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]).toEqual({ tool_use_id: 'tool-1', text: 'short', isError: false });
    expect(out.slice(3).map((m) => m.handle)).toEqual([undefined, undefined, undefined, undefined]);
    expect(out[4]?.toolResults).toEqual(messages[4]?.toolResults);
  });
});

describe('compactSession', () => {
  it('runs the library over the model and reports the outcome', async () => {
    const models: string[] = [];
    const config = { ...resolveHookConfig({}), ...LEGACY, preserveRecentMessages: 1, format: 'current' as const, scoring: 'blind' as const, scoringModel: 'm-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      fakeComplete((name) => (name === 'result_t2' ? 0.9 : 0.1), models),
      offload,
    );
    expect(models).toEqual(['m-x']);
    expect(output.decisions.map((d) => [d.input, d.result])).toEqual([['keep', 'drop'], ['keep', 'keep']]);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 results truncated; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:input=keep@1.00/result=drop@0.10 t2:Bash:input=keep@1.00/result=keep@0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({}), ...LEGACY, preserveRecentMessages: 1, format: 'current' as const, scoring: 'blind' as const };
    const { result: output } = await compactSession(transcript(), config, fakeComplete(() => 0.1), offload);
    const lines = decisionLogLines(output, 70);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:input=keep@1.00/result=drop@0.10',
      'decisions (2/2): t2:Bash:input=keep@1.00/result=keep@0.10',
    ]);
    expect(lines.every((line) => line.length <= 70)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws when the model does not answer so the hook falls back', async () => {
    const config = { ...resolveHookConfig({}), ...LEGACY, preserveRecentMessages: 1, format: 'current' as const, scoring: 'blind' as const };
    await expect(
      compactSession(transcript(), config, async () => ({ isAnswered: false as const, reason: 'api-error' })),
    ).rejects.toThrow(/api-error/);
  });
});

describe('parseAnswers', () => {
  it('reads a fenced JSON object', () => {
    expect(parseAnswers('Sure:\n```json\n{"a": 0.2, "b": 0.8}\n```', ['a', 'b'])).toEqual({
      answers: { a: { noul: 0.2 }, b: { noul: 0.8 } },
    });
  });

  it('keeps a question whose answer is missing or invalid', () => {
    expect(parseAnswers('{"a": 0.2, "b": 0.1, "c": "yes"}', ['a', 'b', 'c', 'd'])).toEqual({
      answers: { a: { noul: 0.2 }, b: { noul: 0.1 }, c: { noul: 1 }, d: { noul: 1 } },
    });
  });

  it('throws when more than half the answers are missing', () => {
    expect(() => parseAnswers('{"a": 0.2}', ['a', 'b', 'c'])).toThrow(/2\/3 answers missing/);
    expect(() => parseAnswers('no json', ['a'])).toThrow(/missing/);
  });
});
