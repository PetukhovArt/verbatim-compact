// Named bench configs. `options` go to the library's compact() as they are; models
// default to the plugin's, and a cell `<config>@<model>[:<effort>]` overrides both
// stages. `baseline` configs do not run the plugin: `full` is no compaction, `native`
// the engine's built-in summary (its default model unless the cell names one).
// The variants re-shorten parts an earlier compaction already shortened. `restoreQueued`
// is the hook's switch: the bench then hands the library the window's queued prompts.
const SONNET = 'claude-sonnet-5';
// The library's defaults before the tiered one, so a config means what it meant when it was run.
const NEUTRAL = { recentFraction: 1, headFraction: 0, shortMarkers: false, inputFieldChars: 300, keepEdits: 0, keepDocs: 'none', keepExternalChars: 0, minCutChars: 0, supersede: false, keepImages: -1 };
const variant = (options) => ({ options: { reshorten: true, ...NEUTRAL, ...options } });
// Per-tool for the oldest 10% and newest 25% of the calls, note-only between; short markers.
const TIERED = { format: 'per-tool', oldFormat: 'note-only', recentFraction: 0.25, headFraction: 0.1, shortMarkers: true, restoreQueued: true, scoring: 'none' };

export const CONFIGS = {
  full: { baseline: 'full' },
  native: { baseline: 'native', model: 'claude-sonnet-5-5' },
  // The plugin as installed: library defaults plus the hook's restoreQueued default.
  defaults: { options: { restoreQueued: true } },
  current: { options: { ...NEUTRAL, format: 'current', scoring: 'blind', reshorten: false } },
  'per-tool': variant({ format: 'per-tool' }),
  'note-only': variant({ format: 'note-only' }),
  'per-tool-rule': variant({ format: 'per-tool', scoring: 'none' }),
  'note-only-rule': variant({ format: 'note-only', scoring: 'none' }),
  'blind-brief': variant({ brief: 'blind' }),
  'note-only-blind-rule': variant({ format: 'note-only', brief: 'blind', scoring: 'none' }),
  'per-tool-blind-content': variant({ format: 'per-tool', brief: 'blind', scoring: 'content' }),
  'per-tool-full-content': variant({ format: 'per-tool', brief: 'full', scoring: 'content' }),
  'note-only-full-rule': variant({ format: 'note-only', brief: 'full', scoring: 'none' }),
  tiered: variant(TIERED),
  'tiered-in150': variant({ ...TIERED, inputFieldChars: 150 }),
  'tiered-edits': variant({ ...TIERED, keepEdits: 40 }),
  'tiered-in150-edits': variant({ ...TIERED, inputFieldChars: 150, keepEdits: 40 }),
  'tiered-docs': variant({ ...TIERED, inputFieldChars: 150, keepEdits: 40, keepDocs: 'head', docHeadChars: 8000 }),
  'tiered-docs-ext': variant({ ...TIERED, inputFieldChars: 150, keepEdits: 40, keepDocs: 'head', docHeadChars: 8000, keepExternalChars: 2000 }),
  'docs-whole': variant({ ...TIERED, inputFieldChars: 150, keepEdits: 40, keepDocs: 'head', keepExternalChars: 2000, minCutChars: 200 }),
  'docs-whole-lean': variant({ ...TIERED, recentFraction: 0.15, inputFieldChars: 100, keepEdits: 40, keepDocs: 'head', keepExternalChars: 2000, minCutChars: 200 }),
  // Cut by live source and supersession instead of by tier.
  source: variant({ ...TIERED, recentFraction: 0.15, inputFieldChars: 100, keepEdits: 40, keepDocs: 'head', keepExternalChars: 2000, minCutChars: 200, strategy: 'source' }),
  // docs-whole-lean plus supersession on top of the tiers.
  hybrid: variant({ ...TIERED, recentFraction: 0.15, inputFieldChars: 100, keepEdits: 40, keepDocs: 'head', keepExternalChars: 2000, minCutChars: 200, supersede: true }),
  // docs-whole-lean dropping image results older than the newest 3, or all of them.
  'images-3': variant({ ...TIERED, recentFraction: 0.15, inputFieldChars: 100, keepEdits: 40, keepDocs: 'head', keepExternalChars: 2000, minCutChars: 200, keepImages: 3 }),
  'images-0': variant({ ...TIERED, recentFraction: 0.15, inputFieldChars: 100, keepEdits: 40, keepDocs: 'head', keepExternalChars: 2000, minCutChars: 200, keepImages: 0 }),
  // docs-whole-lean plus supersession and the newest 3 images: the candidate default.
  candidate: variant({ ...TIERED, recentFraction: 0.15, inputFieldChars: 100, keepEdits: 40, keepDocs: 'head', keepExternalChars: 2000, minCutChars: 200, supersede: true, keepImages: 3 }),
  'tiered-blind': variant({ ...TIERED, brief: 'blind' }),
  'defaults-fold-stages': { options: { restoreQueued: true, foldStages: true } },
  'defaults-fold-log': { options: { restoreQueued: true, foldStages: true, foldStyle: 'log', stageDigest: 'rules' } },
  'index': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'rules' } },
  'index-lines': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'rules' } },
  'index-pick': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-handbacks': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-control': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-bisect': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-bisect1': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-bisect2': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-handbacks2': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-sentences': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-pointer': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'prose' } },
  'index-pick-en': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'pick', pickPrompt: 'listed-en' } },
  'index-tail5': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', recentFraction: 0.05 } },
  'index-digest': { options: { restoreQueued: true, foldStages: true, foldStyle: 'index', stageDigest: 'model' } },
  'defaults-fold-digest': { options: { restoreQueued: true, foldStages: true, stageDigest: 'model' } },
  'note-only-short': variant({ format: 'note-only', shortMarkers: true, restoreQueued: true, scoring: 'none' }),
};

export const DEFAULT_MODELS = { scoringModel: SONNET, briefModel: SONNET };
