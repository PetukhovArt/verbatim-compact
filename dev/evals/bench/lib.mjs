// Loads the plugin's TypeScript under plain node (type stripping): its imports say
// `./state.js` for files named `.ts`, so a failed `.js` resolve retries as `.ts`.
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.endsWith('.js')) throw error;
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

// COMPACT_PLUGIN: another plugin folder to bench, such as a worktree holding the released version.
const plugin = process.env.COMPACT_PLUGIN ? pathToFileURL(resolve(process.env.COMPACT_PLUGIN)).href : '../../../plugin';
export const compactLib = await import(`${plugin}/src/compact.ts`);
export const stateLib = await import(`${plugin}/src/state.ts`);
export const hookLib = await import(`${plugin}/hooks/claude-compact.ts`);
export const stagesLib = await import(`${plugin}/src/stages.ts`);
