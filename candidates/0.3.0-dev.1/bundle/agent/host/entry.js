import { installAgentPlane, inject } from './console-host.js';
import { openApplication } from './application.js';
export { inject };
export async function apply(ctx, config = {}) { return installAgentPlane(ctx, config, { openApplication }); }
