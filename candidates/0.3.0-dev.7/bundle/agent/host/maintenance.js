const fail = code => { throw Object.assign(new Error(code), { code }); };
const need = (ok, code = 'MAINTENANCE_INVALID_INPUT') => { if (!ok) fail(code); };
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function shape(value, keys, required = keys) {
  need(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  need(Reflect.ownKeys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key)));
  need(Object.values(Object.getOwnPropertyDescriptors(value)).every(item => !item.get && !item.set));
}
function trusted(callback, input) {
  let result; try { result = callback?.(input); } catch { fail('MAINTENANCE_NOT_AUTHORIZED'); }
  if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  need(result === true, 'MAINTENANCE_NOT_AUTHORIZED');
}
/** Host capability only. No HTTP body or model tool can inject these authority callbacks. */
export function createMaintenance({ code, getRuntime, getRunner, getProfile, creation, isClosed, ports, now }) {
  const quiet = () => {
    need(!isClosed(), 'MAINTENANCE_CLOSED');
    const runner = getRunner()?.status(); need(!runner || (!runner.started || runner.closed) && !runner.running && runner.pendingIngress === 0, 'MAINTENANCE_BUSY');
    need(!code.snapshot().value.enabled && !code.list().some(task => task.state === 'running'), 'MAINTENANCE_CODE_ACTIVE');
    need(getRuntime().outbox.state().paused && !getRuntime().outbox.list().some(item => item.status === 'sending'), 'MAINTENANCE_OUTBOX_ACTIVE');
    let binding; try { binding = ports?.binding?.(); } catch { fail('MAINTENANCE_BINDING_REQUIRED'); }
    if (binding && typeof binding.then === 'function') Promise.resolve(binding).catch(() => {});
    need(binding?.verified === true && typeof binding.then !== 'function' && binding.code === code && same(binding.profile, getProfile().profile)
      && binding.bridgeIdle === true && binding.interactions && typeof binding.interactions.list === 'function' && typeof binding.interactions.get === 'function', 'MAINTENANCE_BINDING_REQUIRED');
    need(!binding.interactions.list().some(row => row.status === 'pending'), 'MAINTENANCE_BUSY'); return binding;
  };
  const scopeTask = task => {
    let tuple; try { tuple = JSON.parse(task.input.conversationKey); } catch { fail('MAINTENANCE_SCOPE_CHANGED'); }
    const profile = getProfile().profile;
    need(Array.isArray(tuple) && tuple.length === 8 && tuple[1] === profile.botId && tuple[2] === profile.personaId && tuple[6] === 'direct'
      && task.authorization.conversationKey === task.input.conversationKey && task.authorization.adminActor === task.input.actor && task.authorization.account === task.input.account, 'MAINTENANCE_SCOPE_CHANGED');
  };
  const scopeDelivery = item => {
    if (item.kind === 'creation') {
      const work = creation.read(item.payload?.workId)?.value;
      need(work?.submission?.intentId === item.id && work.final?.contextRevision === getProfile().revision, 'MAINTENANCE_SCOPE_CHANGED'); return;
    }
    let tuple; try { tuple = JSON.parse(item.conversation); } catch { fail('MAINTENANCE_SCOPE_CHANGED'); }
    const profile = getProfile().profile; need(Array.isArray(tuple) && tuple.length === 8 && tuple[1] === profile.botId && tuple[2] === profile.personaId, 'MAINTENANCE_SCOPE_CHANGED');
  };
  const authorize = (reviewer, proof) => {
    need(typeof reviewer === 'string' && reviewer.trim() && reviewer.length <= 256);
    const initial = getProfile(); quiet(); trusted(ports?.authorize, copy({ ...proof, reviewer, identityRevision: initial.revision, profile: initial.profile }));
    const binding = quiet(); need(same(initial, getProfile()), 'MAINTENANCE_SCOPE_CHANGED'); return binding;
  };
  const dependencies = (domain, items, binding) => {
    for (const item of items) {
      if (domain === 'code') {
        scopeTask(item); need(!binding.interactions.list().some(row => row.taskId === item.id), 'MAINTENANCE_INTERACTIONS_NOT_ARCHIVED');
        need(getRuntime().outbox.list().filter(row => row.payload?.taskId === item.id).every(row => ['confirmed', 'failed', 'cancelled'].includes(row.status)), 'MAINTENANCE_DELIVERY_UNSETTLED');
      } else {
        scopeDelivery(item);
        if (item.kind === 'code-interaction') {
          const interaction = binding.interactions.get(item.payload?.requestId);
          need(interaction.archive && interaction.taskId === item.payload?.taskId, 'MAINTENANCE_INTERACTIONS_NOT_ARCHIVED'); scopeTask(code.get(interaction.taskId));
        } else if (item.kind === 'code-result') {
          const task = code.get(item.payload?.taskId); scopeTask(task);
          need(task.resultDelivery === 'delivered' && item.id === `${task.id}:result`, 'MAINTENANCE_CODE_RESULT_UNSETTLED');
        }
      }
    }
  };
  const service = domain => { need(['code', 'outbox'].includes(domain)); return domain === 'code' ? code : getRuntime().outbox; };
  return {
    inspect(input) {
      shape(input, ['domain', 'ids', 'reviewer']); const request = copy(input), selected = service(request.domain); const binding = authorize(request.reviewer, { operation: 'inspect', ...request });
      const items = request.ids.map(id => selected.get(id)); dependencies(request.domain, items, binding);
      const result = selected.inspectArchive(request.ids); authorize(request.reviewer, { operation: 'inspect', ...request }); return result;
    },
    archive(input) {
      shape(input, ['domain', 'ids', 'expectedRevision', 'reviewer', 'reason']); const request = copy(input), selected = service(request.domain);
      const binding = authorize(request.reviewer, { operation: 'archive', ...request }); dependencies(request.domain, request.ids.map(id => selected.get(id)), binding);
      const profile = copy(getProfile());
      return selected.archive(request.ids, { expectedRevision: request.expectedRevision, reviewer: request.reviewer, reason: request.reason, now: now(),
        authorize(proof) { const current = authorize(request.reviewer, { operation: 'archive', proof }); need(same(profile, getProfile()), 'MAINTENANCE_SCOPE_CHANGED'); dependencies(request.domain, proof.items, current); return true; } });
    },
    list(input) {
      shape(input, ['domain', 'reviewer', 'offset', 'limit'], ['domain', 'reviewer']); const request = copy(input); authorize(request.reviewer, { operation: 'list', ...request });
      const result = service(request.domain).listArchives({ ...(request.offset === undefined ? {} : { offset: request.offset }), ...(request.limit === undefined ? {} : { limit: request.limit }) });
      for (const row of result) { const archived = service(request.domain).readArchive(row.id); if (request.domain === 'code') scopeTask(archived.task); else scopeDelivery(archived.delivery); }
      authorize(request.reviewer, { operation: 'list', ...request }); return result;
    },
    read(input) {
      shape(input, ['domain', 'id', 'reviewer']); const request = copy(input); authorize(request.reviewer, { operation: 'read', ...request });
      const result = service(request.domain).readArchive(request.id); if (request.domain === 'code') scopeTask(result.task); else scopeDelivery(result.delivery);
      authorize(request.reviewer, { operation: 'read', ...request }); return result;
    },
  };
}
