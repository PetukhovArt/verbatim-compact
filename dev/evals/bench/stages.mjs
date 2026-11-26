// Scores `detectStages` against the hand-marked stages of the bench sessions: a
// ground-truth boundary (its `opened_by` line) is found when a detected stage opens
// within ±N messages of the first message at or after that line. The first stage of
// either side opens at the window start and is not scored.
// Usage: node bench/stages.mjs [--n=2] [--bench=out/bench]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagesLib } from './lib.mjs';
import { rebuild } from './rebuild.mjs';

const flag = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const N = Number(flag('n', 2));
const sessionsDir = join(flag('bench', join(dirname(fileURLToPath(import.meta.url)), '../out/bench')), 'sessions');

let truth = 0;
let found = 0;
let detected = 0;
let matched = 0;
for (const session of readdirSync(sessionsDir)) {
  const file = join(sessionsDir, session, 'probes.json');
  const probes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!Array.isArray(probes.stages)) continue;
  const { messages, lines } = rebuild(probes);
  const stages = stagesLib.detectStages(messages);
  const openings = stages.slice(1).map((s) => s.openedBy);
  const used = new Set();
  console.log(`${session}: ${messages.length} messages, ${stages.length} stages detected`);
  for (const stage of probes.stages.slice(1)) {
    const index = lines.findIndex((l) => l >= stage.opened_by);
    const hit = openings.filter((o) => Math.abs(o - index) <= N).sort((a, b) => Math.abs(a - index) - Math.abs(b - index))[0];
    truth += 1;
    if (hit !== undefined) {
      found += 1;
      used.add(hit);
    }
    const at = hit === undefined ? 'MISSED' : `hit #${hit} L${lines[hit]} (${hit - index >= 0 ? '+' : ''}${hit - index})`;
    console.log(`  ${stage.id} L${stage.opened_by} -> #${index} L${lines[index]}  ${at}`);
  }
  for (const o of openings.filter((o) => !used.has(o))) {
    console.log(`  extra #${o} L${lines[o]} ${messages[o].role}: ${JSON.stringify(messages[o].text.slice(0, 80))}`);
  }
  detected += openings.length;
  matched += used.size;
}
const pct = (a, b) => (b === 0 ? 'n/a' : `${Math.round((100 * a) / b)}% (${a}/${b})`);
console.log(`precision ${pct(matched, detected)}  recall ${pct(found, truth)}  N=±${N}`);
