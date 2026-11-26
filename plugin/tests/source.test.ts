import { describe, expect, test as it } from 'claude-code/testing';
import { liveSource } from '../src/source.ts';

const bash = (command: string) => ({ tool: 'Bash', input: { command } });

describe('live source', () => {
  it('points a read, a search or a read-only command at its source and leaves anything that writes whole', () => {
    const table: [{ tool: string; input: Record<string, unknown> }, string | undefined][] = [
      [{ tool: 'Read', input: { file_path: 'src/a.ts', offset: 10, limit: 20 } }, 'Read src/a.ts offset=10 limit=20'],
      [{ tool: 'Grep', input: { pattern: 'foo|bar', path: 'src' } }, 'rerun: Grep foo|bar src'],
      [{ tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }, 'git diff -- src/a.ts'],
      [bash('sed -n 1,80p src/a.ts'), 'Read src/a.ts'],
      [bash('cd repo && git log --oneline -5 2>&1 | head -3'), 'rerun: cd repo && git log --oneline -5 2>&1 | head -3'],
      [bash('grep -i foo src/a.ts'), 'rerun: grep -i foo src/a.ts'],
      [bash('glab mr view 12'), 'rerun: glab mr view 12'],
      [bash('cat a.ts > b.ts'), undefined],
      [bash('sed -i s/a/b/ a.ts'), undefined],
      [bash('git commit -m x && git log -1'), undefined],
      [bash('npx vitest run a.test.ts'), undefined],
      [bash('find . -name x -delete'), undefined],
      [bash('git branch -D old'), undefined],
      [{ tool: 'Agent', input: { prompt: 'look' } }, undefined],
    ];
    for (const [call, pointer] of table) expect(liveSource(call)).toBe(pointer);
  });
});
