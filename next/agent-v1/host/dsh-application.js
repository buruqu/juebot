import { openApplication } from './application.js';
import { DshModelProvider } from './dsh-model-provider.js';
import { ModelBudget } from './model-budget.js';
import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const need = (ok, code = 'APPLICATION_INVALID_CONFIG') => { if (!ok) fail(code); };
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const positive = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value > 0 && value <= max;
const localIdentity = profile => ({ botId: profile.botId, personaId: profile.personaId, connector: 'local-test',
  issuer: 'dsh-owner', accountId: 'local-owner', kind: 'direct', remoteId: 'owner' });
function matches(identity, profile) {
  const expected = localIdentity(profile);
  return identity && Object.keys(identity).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => identity[key] === value);
}

/** Real Host entry point: no model/default profile/credential lookup unless
 * explicitly enabled; local owner chat grants no platform/Code authority. */
export async function openDshApplication(ctx, config, scope, deps = {}) {
  if (config.enabled !== true) return openApplication(ctx, config, scope);
  need(scope && validText(scope.principal));
  need(config.localChat === undefined || typeof config.localChat === 'boolean');
  const principal = scope.principal; const localChat = config.localChat === true;
  const modelConfig = config.dshModel === undefined ? undefined : structuredClone(config.dshModel);
  if (modelConfig !== undefined) {
    need(modelConfig && typeof modelConfig === 'object' && !Array.isArray(modelConfig)
      && typeof modelConfig.enabled === 'boolean' && Object.keys(modelConfig).every(key => ['enabled', 'provider', 'model', 'maxTokens', 'timeoutMs', 'dailyUnits'].includes(key)));
  }
  const enabled = modelConfig?.enabled === true;
  let BlockAssembler;
  if (enabled) {
    need(validText(modelConfig.provider) && validText(modelConfig.model) && positive(modelConfig.maxTokens, 8192)
      && positive(modelConfig.timeoutMs, 60000) && positive(modelConfig.dailyUnits));
    need(ctx?.llm && typeof ctx.llm.prepareCall === 'function', 'APPLICATION_MODEL_UNAVAILABLE');
    try { BlockAssembler = deps.BlockAssembler ?? (await import('@deepseek-ai/dsh-llm')).BlockAssembler; }
    catch { fail('APPLICATION_MODEL_UNAVAILABLE'); }
    need(typeof BlockAssembler === 'function', 'APPLICATION_MODEL_UNAVAILABLE');
  }
  const now = deps.now ?? Date.now; need(typeof now === 'function');
  let runtime; let localKey = null; let bindingRevision = null; let budget = null;
  const currentLocal = key => localChat && runtime && key === localKey
    && runtime.conversations().some(item => item.key === key && item.bindingRevision === bindingRevision && matches(item.identity, runtime.profile));
  const ports = {
    now,
    onStore(store) {
      if (enabled) {
        budget = new ModelBudget(store, { dailyUnits: modelConfig.dailyUnits, now });
        const id = 'dsh:' + createHash('sha256').update(JSON.stringify([modelConfig.provider, modelConfig.model])).digest('hex');
        ports.model = new DshModelProvider({ id,
          llm: ctx.llm, BlockAssembler, provider: modelConfig.provider, model: modelConfig.model, budget,
          maxTokens: modelConfig.maxTokens, timeoutMs: modelConfig.timeoutMs });
      }
    },
    onRuntime(next) {
      runtime = next; localKey = null; bindingRevision = null;
      if (localChat) {
        const identity = localIdentity(next.profile);
        const existing = next.conversations().find(item => matches(item.identity, next.profile));
        bindingRevision = existing?.bindingRevision ?? 1;
        localKey = next.register(identity, bindingRevision, '本地所有者会话');
      }
    },
    authorizeHuman: actor => actor === principal,
    codeAuthorization: () => null,
    access: async actor => {
      const owner = actor === principal;
      const allowed = owner && currentLocal(localKey);
      // Source/memory writes do not change owner authorization. Grant contents
      // and bindings still change immediately when the active identity changes.
      return { revision: 0, readKeys: allowed ? [localKey] : [], bodyKeys: allowed ? [localKey] : [],
        bindingRevisions: allowed ? { [localKey]: bindingRevision } : {}, manage: owner, review: owner };
    },
    acceptIngress: (envelope, identity) => currentLocal(envelope.key) && matches(identity, runtime.profile)
      && envelope.bindingRevision === bindingRevision && envelope.actor === principal && envelope.actorKind === 'human' && envelope.plain === true,
    participation: key => {
      const permissions = currentLocal(key) ? runtime.memory.effective(key).permissions : {};
      return { enabled: permissions.receive === true && permissions.save === true && permissions.reply === true,
        allowedTargets: currentLocal(key) ? [key] : [], deniedTargets: [], timeZoneOffsetMinutes: 0,
        windows: [{ startMinute: 0, endMinute: 1440 }], cooldownMs: 0, dailyLimit: 1, unansweredLimit: 1 };
    }
  };
  const app = await openApplication(ctx, config, scope, ports);
  Object.defineProperty(app, 'modelBudget', { get: () => budget });
  return app;
}
