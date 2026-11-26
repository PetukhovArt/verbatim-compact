# Writing bench probes for one window

A bench window is the part of a real session a compaction replaces. The bench compacts it with a plugin config, gives the compacted context to a model and asks it the probes. A probe is a question whose answer the session had in the window and needed again after the cut. Its score says whether the compacted context kept what the work needed.

Input, in `<dir>`, cut by `node bench/cut-window.mjs <session.jsonl> <name> [--nth N]` (the window ends at the session's nth compaction):
- `window.txt`: the window, one block per jsonl record, headed `=== L<line> · <role> · <kind> ===`.
- `after.txt`: the session after the cut, up to its next compaction.
- `window.json`: the session file and the line range.

Both text files are large: Grep them for the region you need and Read it with offset/limit. Never read them whole.

Output: `<dir>/probes.json`, the content of `window.json` plus `questions`, 15 to 20 items:

```json
{ "id": "q1", "q": "...", "answer": "...", "exact": false, "category": "decision", "used_after_cut": true, "evidence": "L6120", "used_at": "L7901" }
```

- `category`, at least two of each:
  - `decision`: why the session chose one approach over another (the answer is the reason, as the session stated it);
  - `identifier`: a path, MR or ticket id, commit hash, branch, test id, command or config key the session used, `exact: true`;
  - `state`: what was done and what remained at the cut;
  - `instruction`: a constraint or preference the user stated in the window that still binds after the cut;
  - `hand-back`: a fact that only a subagent's `<task-notification>` result holds, not restated by the assistant;
  - `pointer`: where the current value of something lives, the file path or the command that fetches it (`glab mr view 123`, a log path), for data that goes stale.
- `evidence` is the line in `window.txt` that holds the answer; `used_at` the line in `after.txt` where the session relied on it. Set `used_after_cut: false` and leave `used_at` out only for up to 3 probes about facts the session never needed again: they measure what a compaction may drop.
- Take the facts from the first two thirds of the window: the last few messages survive every compaction, so a probe there measures nothing.
- The answer is short (one line, at most 25 words), stated as the session stated it. A question has one right answer and names enough context to be unambiguous without the window ("In the review of MR !1234, why ...").
- Write the questions in the session's language (Russian for these sessions); identifiers stay verbatim.
- Do not ask about secrets (tokens, passwords).

Report: the path of `probes.json` and the count per category.
