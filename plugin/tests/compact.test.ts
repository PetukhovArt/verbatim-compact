import { describe, expect, test as it } from 'claude-code/testing';
import {
  batchCalls,
  compact,
  decideCall,
  reductionRatio,
  resolveOptions,
  salvageLines,
  type Offload,
} from '../src/compact.ts';
import { collectToolCalls, estimateTokens, fitState } from '../src/state.ts';
import type { HistoryToolCall, JevAsker, JevQuestions, Message, ToolCall } from '../src/types.ts';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

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

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

type Seen = { state: unknown; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: 'fix the test',
};

describe('options', () => {
  it('fills in defaults and ignores non-finite values', () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.65,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 500,
    });
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
    })).toMatchObject({
      keepThreshold: 0.65,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });
});

describe('token estimate', () => {
  it('charges words, digits and symbols separately and never undercounts JSON badly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('state fitting', () => {
  it('sends the whole history with tool results replaced by a note', () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit);
    expect(stage).toBe('full');
    const json = JSON.stringify(state);
    expect(json).not.toContain('export const a = 1;');
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
      id: 't1',
      tool: 'Read',
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect((state.history[4]?.tool_calls?.[0] as HistoryToolCall).result).toMatch(/^error, /);
  });

  it('defaults the goal to the latest user prompts', () => {
    const { state } = fitState(transcript(), [], { ...fit, goal: '' });
    expect(state.goal).toContain('Fix the failing test');
    expect(state.goal).toContain('go ahead');
  });

  it('puts the explicit goal first and leaves engine-written user texts out', () => {
    const messages = [
      message('user', 'Goal set: ship MR !12'),
      message('user', '<task-notification><task-id>a1</task-id></task-notification>'),
      message('user', 'Another Claude session sent a message: hi'),
      message('user', 'check the tests'),
    ];
    const { state } = fitState(messages, [], { ...fit, goal: '', instructions: 'focus on CI' });
    expect(state.goal).toBe('focus on CI\nGoal set: ship MR !12\ncheck the tests');
  });

  it('truncates tool inputs before touching message text', () => {
    const messages = [
      message('user', 'start'),
      call('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) }, 'ok'),
      result('w', 'ok'),
      message('assistant', 'written'),
    ];
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 340,
    });
    expect(stage).toBe('inputs<=200');
    expect(tokens).toBeLessThanOrEqual(340);
    expect(state.history[0]?.text).toBe('start');
    expect((state.history[1]?.tool_calls?.[0] as HistoryToolCall).input.length).toBeLessThanOrEqual(200);
  });

  it('shrinks old tool calls to one line each when nothing else is left to cut', () => {
    const messages = [message('user', 'start')];
    for (let i = 0; i < 40; i += 1) {
      messages.push(call(`c${i}`, 'Read', { file_path: `/repo/src/module-${i}.ts` }, 'x'), result(`c${i}`, 'x'));
    }
    messages.push(message('assistant', 'done'));
    const calls = collectToolCalls(messages, 1);
    const full = fitState(messages, calls, { ...fit, preserveRecentMessages: 1 });
    const compacted = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.8),
    });
    expect(compacted.stage).toBe('old calls compacted');
    expect(compacted.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
    expect(compacted.tokens).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(compacted.state)));
    expect(compacted.state.history[1]?.tool_calls?.[0]).toBe(
      't1 Read file_path=/repo/src/module-0.ts → ok 1ch',
    );
    expect(compacted.state.history.at(-1)?.text).toBe('done');

    const merged = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.45),
    });
    expect(merged.stage).toBe('old calls merged');
    expect(merged.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.45));
    expect(merged.state.history).toHaveLength(3);
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
    expect(merged.state.history[1]?.tool_calls?.[39]).toMatch(/^t40 Read /);
    expect(merged.state.history[0]?.text).toBe('start');
    expect(merged.state.history[2]?.text).toBe('done');
  });

  it('abridges long texts oldest-first and collapses old messages last', () => {
    const long = (n: number) => `${n} ` + 'lorem ipsum '.repeat(300);
    const messages = [
      message('user', long(0)),
      message('assistant', long(1)),
      message('user', long(2)),
      message('assistant', long(3)),
      message('user', 'latest'),
    ];
    const abridged = fitState(messages, [], { ...fit, maxStateTokens: 1800, preserveRecentMessages: 1 });
    expect(abridged.stage).toBe('texts abridged');
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain('chars omitted');
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe('latest');

    const collapsed = fitState(messages, [], { ...fit, maxStateTokens: 420, preserveRecentMessages: 1 });
    expect(collapsed.stage).toBe('old messages collapsed');
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain('lorem');
    expect(collapsed.state.history[4]?.text).toBe('latest');
  });

  it('throws when the history cannot be fitted', () => {
    const messages = [message('user', 'a'.repeat(2000)), message('assistant', 'b')];
    expect(() => fitState(messages, [], { ...fit, maxStateTokens: 50 })).toThrow(/too large/);
  });
});

describe('question batching', () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));
  const options = { maxRequestTokens: 30_000 };

  it('puts everything in one request when it fits', () => {
    expect(batchCalls(calls, 1000, options)).toHaveLength(1);
  });

  it('splits questions across requests when the state leaves little room', () => {
    const batches = batchCalls(calls, 29_600, options);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it('throws when a single question does not fit', () => {
    expect(() => batchCalls(calls, 29_990, options)).toThrow(/no room/);
  });
});

describe('decisions', () => {
  const options = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('decides the input and the result separately, never the call', () => {
    expect(decideCall(unpinned, { keepInput: 0.2, keepResult: 0.7 }, options)).toMatchObject({
      input: 'drop',
      result: 'keep',
    });
    expect(decideCall(unpinned, { keepInput: 0.7, keepResult: 0.2 }, options)).toMatchObject({
      input: 'keep',
      result: 'drop',
    });
    expect(decideCall({ ...unpinned, pinned: true }, { keepInput: 0, keepResult: 0 }, options)).toMatchObject({
      pinned: true,
      input: 'keep',
      result: 'keep',
    });
  });
});

describe('salvageLines', () => {
  it('keeps identifier and error lines, deduplicated and capped', () => {
    const text = [
      'plain prose line',
      'commit 3f1328cab12 on main',
      'src/app/foo.ts:42 unused',
      'see README.md',
      'Switched to branch feature/WC-1234-login',
      'origin/main is ahead',
      'fatal: not a git repository',
      'Process exited with exit code 2',
      'commit 3f1328cab12 on main',
      'timestamp 1234567890',
      'just words here',
    ].join('\n');
    expect(salvageLines(text)).toEqual([
      'commit 3f1328cab12 on main',
      'src/app/foo.ts:42 unused',
      'see README.md',
      'Switched to branch feature/WC-1234-login',
      'origin/main is ahead',
      'fatal: not a git repository',
      'Process exited with exit code 2',
    ]);
    expect(salvageLines(text, 2)).toHaveLength(2);
    expect(salvageLines(text, 40, 60)).toEqual(['commit 3f1328cab12 on main', 'src/app/foo.ts:42 unused']);
  });
});

/** The model-scored path; the defaults cut by rule without asking. */
const SCORED = { ...LEGACY, format: 'current', scoring: 'blind', reshorten: false } as const;

describe('offload', () => {
  function offloadTo(files: Map<string, string>, fail = false): Offload {
    return {
      dir: '/home/u/.claude/compact-offload/s1',
      write: async (path, text) => {
        if (fail) throw new Error('EACCES');
        files.set(path, text);
      },
    };
  }

  it('saves a dropped result before truncating it and keeps every call', async () => {
    const messages = transcript();
    const bigError = `${'x'.repeat(600)}\nerror TS2322 in src/b.ts:7\n${'y'.repeat(600)}`;
    messages[7]!.toolResults![0]!.text = bigError;
    const files = new Map<string, string>();
    const output = await compact(messages, fakeJev(() => 0.1), { ...LEGACY, preserveRecentMessages: 1 }, offloadTo(files));

    expect(output.messages).toHaveLength(messages.length);
    expect(output.messages[0]).toBe(messages[0]);
    const path = '/home/u/.claude/compact-offload/s1/tool-3.txt';
    expect(files.get(path)).toBe(bigError);
    expect(files.get('/home/u/.claude/compact-offload/s1/tool-1.txt')).toBe(fileA);
    expect(output.messages[7]?.toolResults?.[0]).toEqual({
      tool_use_id: 'tool-3',
      isError: true,
      text: `${'x'.repeat(500)}\n[claude-compact: lines with identifiers or errors from the rest]\nerror TS2322 in src/b.ts:7\n[claude-compact: full output (${bigError.length} chars) saved to ${path}; Read it if needed]`,
    });
    expect(output.messages[6]?.toolUses[0]).toMatchObject({
      input: { command: 'npm test' },
      text: output.messages[7]?.toolResults?.[0]?.text,
    });
  });

  it('saves a dropped long input and keeps its short fields and the head of long ones', async () => {
    const content = 'const x = 1;\n'.repeat(400);
    const messages = [
      message('user', 'write it'),
      call('w', 'Write', { file_path: 'src/x.ts', content }, 'File created'),
      result('w', 'File created'),
      call('r', 'Read', { file_path: 'src/x.ts' }, content),
      result('r', content),
      message('assistant', 'done'),
    ];
    const files = new Map<string, string>();
    const seen: Seen[] = [];
    const output = await compact(
      messages,
      fakeJev((name) => (name.startsWith('input_') ? 0.1 : 0.9), seen),
      { preserveRecentMessages: 1, ...SCORED },
      offloadTo(files),
    );

    expect(seen.flatMap((r) => r.questions).sort()).toEqual(['input_t1', 'result_t1', 'result_t2']);
    const path = '/home/u/.claude/compact-offload/s1/w.input.json';
    expect(JSON.parse(files.get(path)!)).toEqual({ file_path: 'src/x.ts', content });
    expect(output.messages[1]?.toolUses[0]?.input).toEqual({
      file_path: 'src/x.ts',
      content: `${content.slice(0, 300)}… [${content.length - 300} chars omitted]`,
      claude_compact: `full input (${JSON.stringify({ file_path: 'src/x.ts', content }).length} chars) saved to ${path}; Read it if needed`,
    });
    expect(output.messages[1]?.toolUses[0]?.text).toBe('File created');
    expect(output.messages[2]).toBe(messages[2]);
    expect(output.stats).toMatchObject({ inputsDropped: 1, resultsDropped: 0 });
  });

  it('leaves a part an earlier compaction shortened as it is and never saves it again', async () => {
    const content = 'const x = 1;\n'.repeat(400);
    const messages = [
      message('user', 'write it'),
      call('w', 'Write', { file_path: 'src/x.ts', content }, 'File created'),
      result('w', 'File created'),
      call('r', 'Read', { file_path: 'src/x.ts' }, content),
      result('r', content),
      message('assistant', 'done'),
    ];
    const options = { ...LEGACY, preserveRecentMessages: 1 };
    const once = await compact(messages, fakeJev(() => 0.1), options, offloadTo(new Map()));
    const files = new Map<string, string>();
    const twice = await compact(once.messages, fakeJev(() => 0.1), options, offloadTo(files));
    expect(files.size).toBe(0);
    expect(twice.messages[1]?.toolUses[0]?.input).toEqual(once.messages[1]?.toolUses[0]?.input);
    expect(twice.messages[4]?.toolResults?.[0]?.text).toBe(once.messages[4]?.toolResults?.[0]?.text);

    const noted = await compact(
      once.messages,
      fakeJev(() => 0.1),
      { ...options, format: 'note-only', reshorten: true },
      offloadTo(files),
    );
    expect(files.size).toBe(0);
    expect(noted.messages[4]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^\\[claude-compact: full output \\(${content.length} chars\\) saved to /home/u/\\.claude/compact-offload/s1/r\\.txt; Read it if needed\\] · Read src/x\\.ts`),
    );
  });

  it('keeps a result whole when its write fails or no offload is given', async () => {
    for (const offload of [offloadTo(new Map(), true), undefined]) {
      const messages = transcript();
      const output = await compact(messages, fakeJev(() => 0.1), { preserveRecentMessages: 1 }, offload);
      expect(output.messages).toEqual(messages);
      expect(output.decisions.slice(0, 2).map((d) => d.result)).toEqual(['offload_failed', 'offload_failed']);
      expect(reductionRatio(output)).toBe(0);
    }
  });
});

describe('compact', () => {
  it('resends the full state with every batch and merges the answers', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: '',
      preserveRecentMessages: 1,
    }).tokens;
    const output = await compact(
      messages,
      fakeJev(() => 0.1, seen),
      { preserveRecentMessages: 1, maxRequestTokens: stateTokens + 120, ...SCORED },
      { dir: '/tmp', write: async () => {} },
    );

    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.flatMap((r) => r.questions).sort()).toEqual([
      'result_t1',
      'result_t2',
      'result_t3',
    ]);
    expect(new Set(seen.map((r) => JSON.stringify(r.state))).size).toBe(1);
    expect(output.decisions.map((d) => d.result)).toEqual(['drop', 'drop', 'keep']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 2, kept: 1, offloadFailed: 0, pinned: 0 });
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeJev(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: '', calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports a tiny reduction when Jev wants everything kept', async () => {
    const output = await compact(transcript(), fakeJev(() => 0.95), { preserveRecentMessages: 1, ...SCORED });
    expect(output.decisions.every((d) => d.input === 'keep' && d.result === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it('inserts the brief before the pinned tail, never between a tool call and its result', async () => {
    const brief = { goal: 'fix b.test.ts', stage: 'fixing', next_steps: [], key_facts: [{ fact: 'b.ts', pointer: 't2' }] };
    const briefAsker = { complete: async () => JSON.stringify(brief) };
    const output = await compact(
      transcript(),
      fakeJev(() => 0.9),
      { ...LEGACY, preserveRecentMessages: 5, brief: 'blind', scoring: 'none' },
      { dir: '/tmp', write: async () => {} },
      briefAsker,
    );
    const index = output.messages.findIndex((m) => m.text.startsWith('[claude-compact brief]'));
    expect(index).toBe(4);
    expect(output.messages[index + 1]?.toolUses[0]?.tool_use_id).toBe('tool-2');
    expect(output.messages[index]?.text).toContain('"pointer": "tool-2"');
  });

  it('repeats in the notes only the queued prompts of messages it rebuilt', async () => {
    const output = await compact(
      transcript(),
      fakeJev(() => 0),
      {
        preserveRecentMessages: 3,
        foldStages: false,
        scoring: 'none',
        queuedPrompts: [
          { text: 'also check c.ts', toolUseId: 'tool-1' },
          { text: 'keep it short', toolUseId: 'tool-3' },
        ],
      },
      { dir: '/tmp', write: async () => {} },
    );
    const notes = output.messages.find((m) => m.text.startsWith('[claude-compact notes]'));
    expect(notes?.text).toContain('- also check c.ts');
    expect(notes?.text).not.toContain('keep it short');
  });

  it('keeps a document read in the oldest calls whole and cuts a later one', async () => {
    const doc = '# Handoff\nNever push to develop.\n'.repeat(40);
    const messages = [
      message('user', 'continue from the handoff'),
      call('d1', 'Read', { file_path: 'C:\\tmp\\handoff.md' }, doc),
      result('d1', doc),
      call('d2', 'Bash', { command: 'cat docs/status.md' }, doc),
      result('d2', doc),
      message('user', 'go on'),
    ];
    const output = await compact(
      messages,
      fakeJev(() => 0),
      { preserveRecentMessages: 1, scoring: 'none', headFraction: 0.5, keepDocs: 'head', foldStages: false },
      { dir: '/tmp', write: async () => {} },
    );
    expect(output.messages[2]).toBe(messages[2]);
    expect(output.messages[4]?.toolResults?.[0]?.text.length).toBeLessThan(doc.length);
  });

  it('drops an image outside keepImages, or after the first rebuilt message, to a marker', async () => {
    const image = (id: string): Message =>
      message('user', '', { toolResults: [{ tool_use_id: id, text: '', image: { width: 800, height: 600 } }] });
    const messages = [
      message('user', 'compare the screenshots'),
      call('i1', 'Read', { file_path: 'C:/tmp/old.png' }, ''),
      image('i1'),
      message('assistant', '', {
        toolUses: [
          { tool_use_id: 'i2', tool: 'Read', input: { file_path: 'C:/tmp/new.png' } },
          { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test' } },
        ],
      }),
      message('user', '', {
        toolResults: [
          { tool_use_id: 'i2', text: '', image: { width: 800, height: 600 } },
          { tool_use_id: 'b1', text: 'FAIL a.test.ts\n'.repeat(100) },
        ],
      }),
      message('user', 'go on'),
    ];
    const output = await compact(
      messages,
      fakeJev(() => 0),
      { preserveRecentMessages: 1, scoring: 'none', keepImages: 1 },
      { dir: '/tmp', write: async () => {} },
    );
    expect(output.messages[2]?.toolResults?.[0]?.text).toBe(
      '[claude-compact: image dropped to save context, C:/tmp/old.png, 800x600. The Read returned it and you viewed it before the drop, so what you said about it stands; Read the file to see it again]',
    );
    expect(output.messages[4]?.toolResults?.[0]?.text).toContain('image dropped to save context, C:/tmp/new.png');
    expect(output.messages[4]?.toolResults?.[1]).toBe(messages[4]!.toolResults![1]);
  });

  it('rejects malformed answers', async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { result_t1: { noul: 0.5 } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1, ...SCORED })).rejects.toThrow(
      /Invalid answer/,
    );
  });
});
