export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message; `image` when it holds an image, with its size (0 when unknown). */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
  image?: { width: number; height: number };
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Jev's probability that the full input still needs to stay verbatim; 1 when not asked. */
  keepInput: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

/** What happens to one part of a call: `offload_failed` is a drop kept whole. */
export type PartAction = 'keep' | 'drop' | 'offload_failed';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  pinned: boolean;
  input: PartAction;
  result: PartAction;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

/** How a dropped result is shortened; `current` is the head plus salvaged identifier lines. */
export type ResultFormat = 'current' | 'per-tool' | 'note-only';
/** Which history the brief is written over: none, outputs omitted, or outputs included. */
export type BriefMode = 'none' | 'blind' | 'full';
/** What scoring sees: the history without outputs, the brief plus output heads, or nothing (rule only). */
export type ScoringMode = 'blind' | 'content' | 'none';
/**
 * How candidates are cut: `tiers` by age and score per `format`/`oldFormat`;
 * `source` by live source and supersession alone, with no scoring (see GLOSSARY.md).
 */
export type Strategy = 'tiers' | 'source';

export interface CompactOptions {
  /** Ongoing task description; defaults to the explicit goal, then the last few user prompts. */
  goal?: string;
  /** The text after `/compact`; an explicit goal ahead of the derived one. */
  instructions?: string;
  /** Default `tiers`. */
  strategy?: Strategy;
  /**
   * Under `tiers`, a call a later one superseded (see Supersession in
   * GLOSSARY.md) keeps the marker only, and near-identical assistant texts
   * collapse to the last. Default false.
   */
  supersede?: boolean;
  format?: ResultFormat;
  brief?: BriefMode;
  scoring?: ScoringMode;
  /**
   * Shorten a result an earlier compaction already shortened again, when
   * `format` makes it shorter, pointing at its existing saved copy. Default false.
   */
  reshorten?: boolean;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result to retain. Default 500. */
  truncateHeadChars?: number;
  /** Format of the candidate calls outside `recentFraction` and `headFraction`. Default `note-only`. */
  oldFormat?: ResultFormat;
  /** Share of the candidate calls, newest first, shortened per `format`. Default 0.15. */
  recentFraction?: number;
  /**
   * Share of the candidate calls, oldest first, shortened per `format` too: the
   * reads a window opens with (a handoff, a status file) stay useful. Default 0.1.
   */
  headFraction?: number;
  /** Markers name no path or target; the notes message names the offload dir once. Default true. */
  shortMarkers?: boolean;
  /** The newest this many Edit/Write/MultiEdit/NotebookEdit inputs stay whole. Default 40. */
  keepEdits?: number;
  /** Longest input field a shortened input keeps whole. Default 100. */
  inputFieldChars?: number;
  /**
   * Reads of prose documents (`.md`, `.txt`, `.adoc`, `.rst`: handoffs, status
   * files, AGENTS.md, specs) by `Read` or a Bash `cat`/`head`/`sed`: `all`
   * keep `docHeadChars`, `head` only those in the oldest `headFraction`,
   * `latest` only the latest read of each path (earlier ones note-only).
   * Default `head`.
   */
  keepDocs?: DocMode;
  /** Head a kept document read keeps; 0 keeps it whole. Default 0. */
  docHeadChars?: number;
  /** A Bash result of glab/gh/jira/curl/git log/git show up to this many characters stays whole. Default 2000. */
  keepExternalChars?: number;
  /** A result under this many characters is never cut. Default 200. */
  minCutChars?: number;
  /**
   * The newest this many image results outside the preserved messages stay;
   * an older one becomes a marker naming its file and size. A message holding
   * a kept image stays whole, its other results too. -1 (default) keeps every image.
   */
  keepImages?: number;
  foldStages?: boolean;
  stageDigest?: StageDigestMode;
  pickPrompt?: PickPrompt;
  foldStyle?: FoldStyle;
  /**
   * Prompts the person queued mid-turn, each with a tool_use_id of the message
   * it hangs off. The engine drops those of a rebuilt message; the notes
   * message repeats them verbatim.
   */
  queuedPrompts?: QueuedPrompt[];
}

export type StageDigestMode = 'rules' | 'model' | 'pick';

export type PickPrompt = 'prose' | 'listed-en';

export type FoldStyle = 'grouped' | 'log' | 'index';

export type DocMode ='none' | 'all' | 'head' | 'latest';

export interface QueuedPrompt {
  text: string;
  toolUseId?: string;
}

export interface ResolvedCompactOptions {
  goal: string;
  instructions: string;
  strategy: Strategy;
  supersede: boolean;
  format: ResultFormat;
  brief: BriefMode;
  scoring: ScoringMode;
  reshorten: boolean;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  oldFormat: ResultFormat;
  recentFraction: number;
  headFraction: number;
  shortMarkers: boolean;
  keepEdits: number;
  inputFieldChars: number;
  keepDocs: DocMode;
  docHeadChars: number;
  keepExternalChars: number;
  minCutChars: number;
  keepImages: number;
  foldStages: boolean;
  stageDigest: StageDigestMode;
  pickPrompt: PickPrompt;
  foldStyle: FoldStyle;
  queuedPrompts: QueuedPrompt[];
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    /** Unpinned calls left whole. */
    kept: number;
    inputsDropped: number;
    resultsDropped: number;
    /** Parts (inputs or results) kept whole because their write failed. */
    offloadFailed: number;
    pinned: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    /** Model requests, the brief included. */
    requests: number;
    /** Characters of the inserted brief message, 0 without one. */
    briefChars: number;
    /** Characters of the inserted notes (offload dir, queued prompts), 0 without one. */
    notesChars: number;
    stagesFolded: number;
    noteRequestsFailed: number;
    ms: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}

/** Answers one free-text request; the brief is written through it. */
export interface TextAsker {
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string>;
}

export interface Brief {
  goal: string;
  stage: string;
  next_steps: string[];
  /** `pointer` is the tool_use id holding the fact, or '' for conversation text. */
  key_facts: { fact: string; pointer: string }[];
}
