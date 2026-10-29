import { installAgentPlane } from './console-host.js';
import { openDshApplication } from './dsh-application.js';

export const inject = ['connection'];

/** The console plane stays connection-only until a native model is explicitly
 * enabled. Cordis owns the child fiber: llm appearance/replacement/removal
 * rebuilds/disposes its routes and application, including late async opens. */
export function installDshAgent(ctx, config = {}, dependencies = {}) {
  const openApplication = dependencies.openApplication ?? openDshApplication;
  if (config.enabled === true && config.dshModel?.enabled === true) {
    return ctx.inject(['llm'], child => installAgentPlane(child, config, { openApplication }));
  }
  return installAgentPlane(ctx, config, { openApplication });
}

export function apply(ctx, config = {}) {
  if (config.enabled === true && config.dshModel?.enabled === true) {
    // Do not await an inactive dependency fiber: the parent remains loaded and
    // Cordis activates its child when the optional configured service appears.
    installDshAgent(ctx, config);
    return;
  }
  return installDshAgent(ctx, config);
}
