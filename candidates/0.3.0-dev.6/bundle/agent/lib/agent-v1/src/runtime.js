import { createHash } from 'node:crypto';
import { AgentError, clone, ensure, integer, plain, stable, text } from "./common.js";
import { PolicyMemory } from "./policy-memory.js";
import { SelfGrowthEngine } from "./self-growth.js";
import { DurableOutbox } from "./outbox.js";
import { ConversationLedger } from "../../conversation-v1/src/ledger.js";
import { canonicalIdentity, conversationKey } from "../../conversation-v1/src/identity.js";
import { planTyping } from "../../social-v1/src/typing.js";
import { considerRepetition } from "../../social-v1/src/repetition.js";
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
const idFor = (e) => digest([e.key, e.bindingRevision, e.eventId]);
const accountFor = (i) => JSON.stringify([i.connector, i.issuer, i.accountId]);
const TURN_FAILURE_CODES = new Set(['RUNTIME_CLOSED', 'INVALID_INPUT', 'INVALID_CLOCK', 'NOT_FOUND', 'BINDING_CONFLICT', 'UNTRUSTED_INGRESS', 'ACCESS_DENIED', 'CONVERSATION_BUSY',
    'SOURCE_REVOKED', 'CONTACT_REFUSED', 'QUIET_HOURS', 'DAILY_LIMIT', 'UNANSWERED_LIMIT', 'MODEL_CHANGED', 'IDENTITY_CHANGED', 'CANCELLED', 'STYLE_REVIEW_UNAVAILABLE', 'STYLE_REVIEW_INVALID',
    'STORAGE_FAILURE', 'CAPACITY', 'NESTED_TRANSACTION', 'CONTEXT_STALE', 'CONTEXT_INVALID', 'PARTICIPATION_DISABLED', 'INTENTION_CHANGED', 'UNTRUSTED_REPETITION_SOURCE', 'REPETITION_EXPIRED', 'POLICY_CHANGED', 'CONFLICT',
    'MODEL_NOT_CONFIGURED', 'MODEL_INVALID_INPUT', 'MODEL_ENDPOINT_INVALID', 'MODEL_BUDGET_REQUIRED', 'MODEL_BUDGET_DENIED', 'MODEL_BUDGET_SETTLEMENT_FAILED', 'MODEL_CANCELLED', 'MODEL_TIMEOUT',
    'MODEL_CREDENTIAL_UNAVAILABLE', 'MODEL_CONTEXT_TOO_LARGE', 'MODEL_RESPONSE_INVALID', 'MODEL_REDIRECT_BLOCKED', 'MODEL_HTTP_FAILURE', 'MODEL_RESPONSE_TOO_LARGE', 'MODEL_RESPONSE_ENCODING',
    'MODEL_JSON_INVALID', 'MODEL_USAGE_INVALID', 'MODEL_INCOMPLETE', 'MODEL_UNEXPECTED_TOOLS', 'MODEL_OUTPUT_TOO_LARGE', 'MODEL_OUTPUT_INVALID', 'MODEL_RETRY_POLICY_UNSAFE', 'MODEL_REQUEST_FAILED', 'MODEL_OBSERVATION_INVALID']);
export class BotRuntime {
    memory;
    self;
    outbox;
    ledger;
    store;
    options;
    now;
    inflight = new Set();
    closed = false;
    controllers = new Set();
    constructor(store, ledger, options) {
        this.store = store;
        this.ledger = ledger;
        this.options = options;
        this.now = options.now ?? Date.now;
        const p = options.profile;
        text(p.botId);
        text(p.personaId);
        text(p.name);
        text(p.roleCore, 8000);
        ensure(['juejue', 'persona'].includes(p.mode));
        this.memory = new PolicyMemory(store, { botId: p.botId, personaId: p.personaId });
        this.self = new SelfGrowthEngine(store, { clock: this.now });
        this.outbox = new DurableOutbox(store);
    }
    get profile() { return clone(this.options.profile); }
    get modelConfigured() { return this.options.model !== null; }
    /** Caller must enforce its management principal; this projection never exposes prompts or message bodies. */
    trace(key) {
        this.conversation(key);
        const settings = this.memory.effective(key);
        ensure(settings.permissions.receive && settings.permissions.save, 'ACCESS_DENIED');
        const now = this.now();
        const recent = this.store.read('recent:' + key)?.value ?? [];
        const memoryIds = (context) => { if (!context)
            return []; try {
            this.memory.validateTicket(context, now);
            return context.items.map(item => item.id);
        }
        catch {
            return [];
        } };
        return { key, policyRevision: settings.revision, participation: settings.participation,
            turns: recent.map(row => this.store.read('turn:' + row.sourceId)?.value).filter((row) => !!row)
                .map(row => ({ id: row.id, status: row.status, reason: row.reason, draftId: row.draftId, observedAt: row.input.observedAt, memoryIds: memoryIds(row.context) })),
            deliveries: this.outbox.list().filter(row => row.conversation === key).slice(-64).map(row => ({ id: row.id, status: row.status, reason: row.reason, kind: row.kind,
                receipt: row.receipt, dueAt: row.dueAt, waitMs: row.status === 'queued' ? Math.max(0, row.dueAt - now) : 0, memoryIds: memoryIds(row.payload.context) })) };
    }
    register(identity, bindingRevision, label) {
        ensure(!this.closed, 'RUNTIME_CLOSED');
        text(label, 256);
        integer(bindingRevision);
        const canonical = canonicalIdentity(identity);
        ensure(canonical.botId === this.profile.botId && canonical.personaId === this.profile.personaId, 'SCOPE_MISMATCH');
        const key = conversationKey(canonical);
        this.ledger.registerConversation(canonical, bindingRevision, this.now());
        this.store.atomic(tx => {
            const s = tx.read('runtime:catalog');
            const catalog = s?.value ?? { items: [] };
            const old = catalog.items.find(i => i.key === key);
            if (old) {
                ensure(old.bindingRevision === bindingRevision, 'BINDING_CONFLICT');
                return;
            }
            ensure(catalog.items.length < 128, 'CAPACITY');
            catalog.items.push({ key, label, identity: canonical, bindingRevision });
            tx.write('runtime:catalog', s?.revision ?? 0, catalog);
        });
        this.scope(key);
        return key;
    }
    conversations() { return (this.store.read('runtime:catalog')?.value.items ?? []).filter(c => c.identity.botId === this.profile.botId && c.identity.personaId === this.profile.personaId); }
    conversation(key) {
        const item = this.store.read('runtime:catalog')?.value.items.find(i => i.key === key);
        ensure(item, 'NOT_FOUND');
        ensure(item.identity.botId === this.profile.botId && item.identity.personaId === this.profile.personaId, 'IDENTITY_CHANGED');
        ensure(this.ledger.getConversation(key)?.bindingRevision === item.bindingRevision, 'BINDING_CONFLICT');
        return item;
    }
    currentScope(key) { return { botId: this.profile.botId, personaId: this.profile.personaId, scope: key }; }
    scope(key) {
        this.conversation(key);
        // Experienced state is isolated per stream. Shared growth requires separately reviewed evidence;
        // simply switching memory retrieval mode never merges old affect or private relationships.
        const scope = this.currentScope(key);
        const modelVersion = this.options.model?.id ?? 'unconfigured';
        let current;
        try {
            current = this.self.get(scope);
        }
        catch (error) {
            if (!(error instanceof AgentError) || error.code !== 'NOT_FOUND')
                throw error;
        }
        if (!current)
            this.self.initialize({ ...scope, mode: this.profile.mode, name: this.profile.name, roleCore: this.profile.roleCore, modelVersion });
        else if (current.value.modelVersion !== modelVersion)
            this.self.setModelVersion(scope, modelVersion, current.revision);
        // Expiry is a revocation boundary even when no policy write occurred. Keep
        // expired observations out of the self state sent into the next model request.
        const sources = this.memory.readPolicy().value.sources;
        const dependencies = this.store.read('observation-sources:' + key)?.value ?? {};
        for (const [eventId, evidence] of Object.entries(this.self.get(scope).value.evidence))
            if (!evidence.revoked && (!this.sourceAllowed(sources[eventId], { sourceId: eventId, revision: evidence.revision }, key, 'draft')
                || !Object.hasOwn(dependencies, eventId) || !dependencies[eventId]?.length || dependencies[eventId].some(ref => !this.experienceSourceAllowed(key, ref))))
                this.self.revokeSource(scope, eventId, evidence.revision);
        return scope;
    }
    observe(key, event) {
        const scope = this.scope(key);
        if (event.kind === 'self') {
            this.self.observe(scope, event);
            return;
        }
        const settings = this.memory.effective(key);
        const summary = this.memory.isSummaryMaterial(event.eventId);
        ensure(settings.permissions.receive && settings.permissions.save && (summary || settings.permissions.learn), 'ACCESS_DENIED');
        if (summary)
            ensure(event.interestDelta === 0 && event.topic !== undefined && event.affect === undefined && event.relationshipTarget === undefined && event.relationshipDelta === undefined && event.feedback === 'interest', 'SUMMARY_OBSERVATION_INVALID');
        const policy = this.memory.readPolicy();
        const prior = policy.value.sources[event.eventId];
        if (prior)
            ensure(prior.conversationKey === key && this.experienceSourceAllowed(key, { sourceId: event.eventId, revision: event.revision }), 'SOURCE_REVOKED');
        else
            this.memory.putSource(policy.revision, { id: event.eventId, conversationKey: key, revision: event.revision, domain: 'social', status: 'active', purposes: ['read', 'learn', 'draft'], audiences: [key], expiresAt: null });
        this.store.atomic(tx => { this.self.observeIn(tx, scope, event); this.saveObservationSources(tx, key, event.eventId, [{ sourceId: event.eventId, revision: event.revision }]); });
    }
    saveObservationSources(tx, key, eventId, sources) {
        const saved = tx.read('observation-sources:' + key);
        const refs = saved?.value ?? {};
        Object.defineProperty(refs, eventId, { value: clone(sources), enumerable: true, writable: true, configurable: true });
        tx.write('observation-sources:' + key, saved?.revision ?? 0, refs);
    }
    /** Management route: revoke retrieval first, then idempotently invalidate experienced state. */
    revokeSource(sourceId, currentRevision, nextRevision) {
        text(sourceId);
        integer(currentRevision);
        integer(nextRevision, 1);
        const policy = this.memory.readPolicy();
        const source = policy.value.sources[sourceId];
        ensure(source, 'SOURCE_NOT_FOUND');
        if (!(source.status === 'revoked' && source.revision === nextRevision))
            this.memory.revokeSource(currentRevision, sourceId, nextRevision);
        for (const conversation of this.conversations()) {
            const scope = { botId: conversation.identity.botId, personaId: conversation.identity.personaId, scope: conversation.key };
            let state;
            try {
                state = this.self.get(scope);
            }
            catch (error) {
                if (error instanceof AgentError && error.code === 'NOT_FOUND')
                    continue;
                throw error;
            }
            const evidence = Object.hasOwn(state.value.evidence, sourceId) ? state.value.evidence[sourceId] : undefined;
            if (evidence && !evidence.revoked)
                this.self.revokeSource(scope, sourceId, evidence.revision);
        }
    }
    event(key, sourceEventId, eventType, body, causedBy = null, occurredAt = this.now()) {
        const c = this.conversation(key);
        return this.ledger.append({ conversationKey: key, bindingRevision: c.bindingRevision, sourceEventId,
            occurredAt, eventType, reasonCode: 'NONE', actorId: null, runId: sourceEventId, causedBy, body }).event.sequence;
    }
    sourceAllowed(source, ref, key, purpose) {
        return !!source && source.id === ref.sourceId && source.revision === ref.revision && source.status === 'active' && source.domain === 'social'
            && source.purposes.includes(purpose) && source.audiences.includes(key) && (source.expiresAt === null || source.expiresAt > this.now());
    }
    experienceSourceAllowed(key, ref) {
        if (this.memory.isSummaryMaterial(ref.sourceId))
            return this.memory.validateSummarySource(ref.sourceId, key, ref.revision, this.now());
        return this.sourceAllowed(this.memory.readPolicy().value.sources[ref.sourceId], ref, key, 'learn');
    }
    validateRaw(key, refs, purpose) {
        const policy = this.memory.readPolicy();
        const settings = this.memory.effective(key);
        ensure(settings.permissions.receive && settings.permissions.save && (purpose !== 'learn' || settings.permissions.learn), 'ACCESS_DENIED');
        for (const ref of refs)
            ensure(this.sourceAllowed(policy.value.sources[ref.sourceId], ref, key, purpose), 'SOURCE_REVOKED');
    }
    participationGate(key, action) {
        ensure(this.memory.effective(key).participation > 0, 'PARTICIPATION_DISABLED');
        const policy = this.memory.restrictParticipation(key, this.options.participation(key, action));
        const now = this.now();
        ensure(policy.enabled && policy.allowedTargets.includes(key) && !policy.deniedTargets.includes(key), 'CONTACT_REFUSED');
        integer(policy.timeZoneOffsetMinutes, -840, 840);
        const local = now + policy.timeZoneOffsetMinutes * 60000;
        const minute = Math.floor(((local % 86400000) + 86400000) % 86400000 / 60000);
        ensure(policy.windows.some(w => w.startMinute < w.endMinute ? minute >= w.startMinute && minute < w.endMinute : minute >= w.startMinute || minute < w.endMinute), 'QUIET_HOURS');
        if (action) {
            const count = this.self.get(this.currentScope(key)).value.counters[action];
            ensure(policy.dailyLimit > 0 && (!count || count.day !== Math.floor(local / 86400000) || count.count <= policy.dailyLimit), 'DAILY_LIMIT');
            ensure(policy.unansweredLimit > 0 && (!count || count.unanswered <= policy.unansweredLimit), 'UNANSWERED_LIMIT');
        }
    }
    saveTurn(turn) { this.store.atomic(tx => { const s = tx.read('turn:' + turn.id); tx.write('turn:' + turn.id, s?.revision ?? 0, turn); }); }
    validateObservation(o) {
        plain(o, ['topic', 'interestDelta', 'valence', 'intensity', 'relationshipDelta', 'feedback']);
        text(o.topic, 128);
        ensure(o.topic.trim() === o.topic && !/[\u0000-\u001f\u007f]/u.test(o.topic), 'MODEL_OBSERVATION_INVALID');
        integer(o.interestDelta, -10, 10);
        integer(o.relationshipDelta, -10, 10);
        integer(o.valence, -100, 100);
        integer(o.intensity, 0, 100);
        ensure(['support', 'disagreement', 'recovery', 'interest', 'disinterest'].includes(o.feedback), 'MODEL_OBSERVATION_INVALID');
        ensure(o.interestDelta === 0 || ['interest', 'disinterest'].includes(o.feedback), 'MODEL_OBSERVATION_INVALID');
        ensure(o.feedback !== 'interest' || o.interestDelta >= 0, 'MODEL_OBSERVATION_INVALID');
        ensure(o.feedback !== 'disinterest' || o.interestDelta <= 0, 'MODEL_OBSERVATION_INVALID');
    }
    acknowledgeIncoming(input) {
        const c = this.conversation(input.key);
        for (const row of this.outbox.list().filter(row => row.conversation === input.key && row.status === 'confirmed' && row.revisions.binding === input.bindingRevision)) {
            const initiative = row.payload.initiative;
            if (!initiative)
                continue;
            const stamp = 'response:' + row.id;
            if (this.store.read(stamp))
                continue;
            const confirmed = this.store.read('confirmed:' + row.id);
            if (!confirmed || input.observedAt < confirmed.value.at)
                continue;
            const exact = input.replyTo !== undefined && (input.replyTo === row.id || input.replyTo === row.receipt);
            const direct = c.identity.kind === 'direct' && initiative.targetActor === input.actor && input.observedAt > row.createdAt;
            if (!exact && !direct)
                continue;
            const scope = this.scope(input.key);
            this.store.atomic(tx => {
                if (tx.read(stamp))
                    return;
                this.self.acknowledgeResponseIn(tx, scope, initiative.action);
                tx.write(stamp, 0, { eventId: input.eventId, at: input.observedAt });
            });
            break;
        }
    }
    validate(envelope) {
        plain(envelope, ['key', 'bindingRevision', 'eventId', 'actor', 'actorKind', 'plain', 'text', 'observedAt', 'replyTo']);
        if (envelope.replyTo !== undefined)
            text(envelope.replyTo, 512);
        text(envelope.key, 4096);
        integer(envelope.bindingRevision);
        text(envelope.eventId);
        text(envelope.actor);
        text(envelope.text, 16000);
        integer(envelope.observedAt);
        ensure(['human', 'bot', 'unknown'].includes(envelope.actorKind) && typeof envelope.plain === 'boolean');
        const c = this.conversation(envelope.key);
        ensure(c.bindingRevision === envelope.bindingRevision, 'BINDING_CONFLICT');
        ensure(this.options.acceptIngress(clone(envelope), clone(c.identity)), 'UNTRUSTED_INGRESS');
        ensure(envelope.observedAt <= this.now(), 'INVALID_CLOCK');
    }
    async receive(envelope) {
        ensure(!this.closed, 'RUNTIME_CLOSED');
        this.validate(envelope);
        const input = clone(envelope);
        const id = idFor(input);
        const known = this.store.read('turn:' + id);
        if (known) {
            ensure(stable(known.value.input) === stable(input), 'EVENT_CONFLICT');
            return known.value;
        }
        const config = this.memory.effective(input.key);
        ensure(config.permissions.receive && config.permissions.save, 'ACCESS_DENIED');
        ensure(!this.inflight.has(input.key), 'CONVERSATION_BUSY');
        this.inflight.add(input.key);
        const turn = { id, key: input.key, input, status: 'received', reason: 'NONE', draftId: null, context: null };
        try {
            const sequence = this.event(input.key, 'in:' + id, 'message.received', input.text, null, input.observedAt);
            this.saveTurn(turn);
            if (input.actorKind !== 'human' || input.actor === this.profile.botId) {
                turn.status = 'skipped';
                turn.reason = 'NON_HUMAN';
                this.saveTurn(turn);
                return turn;
            }
            const purposes = config.permissions.learn ? ['read', 'learn', 'draft'] : ['read', 'draft'];
            this.memory.putSource(this.memory.readPolicy().revision, { id, conversationKey: input.key, revision: 1, domain: 'social', status: 'active', purposes, audiences: [input.key], expiresAt: null });
            this.store.atomic(tx => {
                const old = tx.read('recent:' + input.key);
                const items = old?.value ?? [];
                const next = [...items.filter(item => item.sourceId !== id), { sourceId: id, revision: 1, sequence, actor: input.actor, bindingRevision: input.bindingRevision, observedAt: input.observedAt, plain: input.plain, eventId: input.eventId }].slice(-32);
                tx.write('recent:' + input.key, old?.revision ?? 0, next);
            });
            this.acknowledgeIncoming(input);
            if (!config.permissions.reply) {
                turn.status = 'skipped';
                turn.reason = 'REPLY_DISABLED';
                this.saveTurn(turn);
                return turn;
            }
            const interests = this.self.get(this.scope(input.key)).value.interests;
            const knownTopic = Object.entries(interests).filter(([name]) => input.text.toLocaleLowerCase().includes(name.toLocaleLowerCase()))
                .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))[0]?.[0];
            const topic = knownTopic ?? (input.text.replace(/\s+/gu, ' ').slice(0, 128).trim() || 'conversation');
            const decision = this.self.decide(this.scope(input.key), { target: input.key, relationshipTarget: input.actor, topic, participation: config.participation, policy: this.memory.restrictParticipation(input.key, this.options.participation(input.key, null)) });
            this.event(input.key, 'decision:' + id, 'decision.recorded', JSON.stringify({ choice: decision.choice, reason: decision.reason }));
            if (decision.choice !== 'reply') {
                turn.status = 'skipped';
                turn.reason = decision.reason;
                this.saveTurn(turn);
                return turn;
            }
            const c = this.conversation(input.key);
            if (c.identity.kind === 'group' && input.plain && input.actor !== this.profile.botId) {
                const sources = this.memory.readPolicy().value.sources;
                const events = (this.store.read('recent:' + input.key)?.value ?? []).filter(row => row.eventId && row.bindingRevision === c.bindingRevision && row.plain && row.observedAt <= this.now() && this.sourceAllowed(sources[row.sourceId], row, input.key, 'draft'))
                    .map(row => ({ conversationKey: { namespace: c.identity.connector, opaqueId: c.identity.remoteId, accountKey: accountFor(c.identity), bindingRevision: c.bindingRevision },
                    id: row.eventId, actorKey: row.actor, actorVerified: true, observedAt: row.observedAt, senderKind: 'human', kind: 'text', text: this.ledger.readBody(input.key, c.bindingRevision, row.sequence) ?? '' }));
                const repeated = await this.repeatReviewed(input.key, events, true);
                if (repeated) {
                    turn.status = 'queued';
                    turn.reason = 'REPETITION_SELECTED';
                    turn.draftId = repeated;
                    this.saveTurn(turn);
                    return turn;
                }
            }
            return await this.generate(turn, topic, 'reply');
        }
        catch (error) {
            const code = error?.code;
            turn.status = 'failed';
            turn.reason = typeof code === 'string' && TURN_FAILURE_CODES.has(code) ? code : 'TURN_FAILED';
            this.saveTurn(turn);
            throw error;
        }
        finally {
            this.inflight.delete(input.key);
        }
    }
    async generate(turn, topic, kind, initiative) {
        ensure(this.options.model, 'MODEL_NOT_CONFIGURED');
        const key = turn.key;
        const c = this.conversation(key);
        const settings = this.memory.effective(key);
        const model = this.options.model;
        const modelVersion = model.id;
        const profileStamp = digest(this.profile);
        const context = this.memory.retrieve({ conversationKey: key, purpose: 'draft', query: topic, now: this.now(), maxItems: 12, maxChars: 6000 });
        turn.context = context;
        turn.status = 'generating';
        this.saveTurn(turn);
        const state = this.self.get(this.scope(key)).value;
        const policy = this.memory.readPolicy();
        const index = this.store.read('recent:' + key)?.value ?? [];
        const visible = index.filter(item => item.bindingRevision === c.bindingRevision && this.sourceAllowed(policy.value.sources[item.sourceId], item, key, 'draft')).slice(-8);
        const rawSources = visible.map(item => ({ sourceId: item.sourceId, revision: item.revision }));
        const recent = visible.map(item => ({ actor: item.actor, text: (this.ledger.readBody(key, c.bindingRevision, item.sequence) ?? '').slice(0, 1000) }));
        const allSources = [...new Map([...context.sourceEvidence, ...rawSources].map(item => [item.sourceId, item])).values()];
        const validate = () => {
            ensure(!this.closed, 'CANCELLED');
            this.memory.validateTicket(context, this.now());
            this.validateRaw(key, rawSources, 'draft');
            ensure(this.conversation(key).bindingRevision === turn.input.bindingRevision, 'BINDING_CONFLICT');
            ensure(this.options.model === model && this.options.model.id === modelVersion, 'MODEL_CHANGED');
            ensure(digest(this.profile) === profileStamp, 'IDENTITY_CHANGED');
            const latest = this.self.get(this.scope(key)).value;
            ensure(latest.identityRevision === state.identityRevision && latest.growthVersion === state.growthVersion, 'IDENTITY_CHANGED');
            this.participationGate(key, initiative?.action ?? null);
        };
        const controller = new AbortController();
        this.controllers.add(controller);
        let generated = null;
        let rewrite;
        let styleProof;
        try {
            if (settings.expressionPolicy.styleContracts.length)
                ensure(model.reviewStyle, 'STYLE_REVIEW_UNAVAILABLE');
            for (let attempt = 0; attempt <= settings.expressionPolicy.maxRewrites; attempt++) {
                validate();
                ensure(!controller.signal.aborted, 'CANCELLED');
                const request = { kind, name: state.name, roleCore: state.roleCore, prompt: settings.prompt, input: turn.input.text,
                    memories: context.items.map(i => ({ id: i.id, text: i.text })), recent, affect: { valence: state.affect.valence / 100, intensity: state.affect.intensity / 100 }, topic,
                    adaptation: clone(state.adaptation), participation: settings.participation,
                    expressionRules: settings.expressionPolicy.rules, styleContracts: settings.expressionPolicy.styleContracts, ...(rewrite ? { rewrite } : {}) };
                const output = await model.generate(clone(request), controller.signal);
                validate();
                ensure(!controller.signal.aborted, 'CANCELLED');
                plain(output, ['text', 'learning', 'observation']);
                text(output.text, 16000);
                ensure(Array.isArray(output.learning) && output.learning.length <= 8);
                if (output.observation !== undefined)
                    this.validateObservation(output.observation);
                for (const proposal of output.learning) {
                    plain(proposal, ['text', 'kind']);
                    text(proposal.text, 4000);
                    ensure(['knowledge', 'expression', 'preference'].includes(proposal.kind));
                }
                generated = clone(output);
                const literal = this.memory.checkExpression(key, generated.text, 'social', attempt);
                let reason = literal.action === 'rewrite' ? 'EXPRESSION_REWRITE_REQUIRED' : null;
                if (literal.action === 'blocked' || literal.action === 'recheck') {
                    turn.status = 'skipped';
                    turn.reason = 'EXPRESSION_BLOCKED';
                    this.saveTurn(turn);
                    return turn;
                }
                if (!reason && settings.expressionPolicy.styleContracts.length) {
                    const result = await model.reviewStyle({ text: generated.text, styleContracts: clone(settings.expressionPolicy.styleContracts) }, controller.signal);
                    validate();
                    ensure(!controller.signal.aborted, 'CANCELLED');
                    ensure(['pass', 'rewrite', 'block'].includes(result), 'STYLE_REVIEW_INVALID');
                    if (result === 'block') {
                        turn.status = 'skipped';
                        turn.reason = 'STYLE_BLOCKED';
                        this.saveTurn(turn);
                        return turn;
                    }
                    if (result === 'rewrite')
                        reason = 'STYLE_REWRITE_REQUIRED';
                    else
                        styleProof = { bodyHash: digest(generated.text), policyRevision: settings.revision, modelVersion };
                }
                if (!reason)
                    break;
                if (attempt === settings.expressionPolicy.maxRewrites) {
                    turn.status = 'skipped';
                    turn.reason = 'REWRITE_LIMIT';
                    this.saveTurn(turn);
                    return turn;
                }
                rewrite = { previousText: generated.text, reason };
                generated = null;
            }
        }
        finally {
            this.controllers.delete(controller);
        }
        ensure(generated, 'MODEL_OUTPUT_INVALID');
        validate();
        if (kind === 'reply' && settings.permissions.learn && generated.observation && allSources.every(ref => this.sourceAllowed(this.memory.readPolicy().value.sources[ref.sourceId], ref, key, 'learn'))) {
            // Provider fields describe a bounded experience; only the trusted runtime supplies provenance and target.
            const o = generated.observation;
            const observedScope = this.scope(key);
            this.store.atomic(tx => {
                this.self.observeIn(tx, observedScope, { eventId: turn.id, revision: 1, kind: 'external', topic: o.topic, ...(['interest', 'disinterest'].includes(o.feedback) ? { interestDelta: o.interestDelta } : {}),
                    affect: { valence: o.valence, intensity: o.intensity }, relationshipTarget: turn.input.actor, relationshipDelta: o.relationshipDelta, feedback: o.feedback });
                this.saveObservationSources(tx, key, turn.id, allSources);
            });
        }
        const now = this.now();
        const delay = planTyping(generated.text, 'social', settings.typing).delayMs;
        const previous = this.outbox.list().filter(i => i.conversation === key && i.kind === 'social' && i.status === 'queued').at(-1);
        const dueAt = Math.max(now, previous?.dueAt ?? now) + delay;
        const draftId = 'reply:' + turn.id;
        this.event(key, 'draft:' + turn.id, 'reply.draft', generated.text);
        const outgoing = { id: draftId, account: accountFor(c.identity), conversation: key, kind: 'social', body: generated.text,
            payload: { context, kind: 'social', rawSources, modelVersion, growthVersion: state.growthVersion, ...(initiative ? { initiative } : {}), ...(styleProof ? { styleProof } : {}) },
            revisions: { binding: c.bindingRevision, policy: settings.revision, memory: context.revision, identity: state.identityRevision, expression: settings.revision },
            sourceRefs: allSources.map(s => ({ id: s.sourceId, revision: s.revision })), createdAt: now, dueAt, expiresAt: now + 600000, costUnits: 1 };
        this.store.atomic(tx => {
            this.outbox.enqueueIn(tx, outgoing);
            if (settings.permissions.learn && kind === 'reply' && generated.learning.length) {
                const s = tx.read('learning:pending');
                const items = s?.value ?? [];
                ensure(items.length + generated.learning.length <= 1000, 'CAPACITY');
                generated.learning.forEach((p, index) => items.push({ id: `learn:${turn.id}:${index}`, key, text: p.text, kind: p.kind, sourceId: turn.id, status: 'pending',
                    sourceRefs: clone(allSources), derivedFrom: context.items.map(item => ({ memoryId: item.id, revision: item.revision })), context: clone(context),
                    bindingRevision: c.bindingRevision, modelVersion, provenanceComplete: rawSources.some(source => source.sourceId === turn.id) && allSources.length <= 32 }));
                tx.write('learning:pending', s?.revision ?? 0, items);
            }
            turn.status = 'queued';
            turn.draftId = draftId;
            const current = tx.read('turn:' + turn.id);
            tx.write('turn:' + turn.id, current?.revision ?? 0, turn);
        });
        return clone(turn);
    }
    learning() { return this.store.read('learning:pending')?.value ?? []; }
    /** Trusted Host intake only: caller identity is checked independently of all provider content. */
    proposeLearning(key, input, principal) {
        ensure(this.options.authorizeLearning(principal), 'ACCESS_DENIED');
        plain(input, ['id', 'text', 'kind', 'sourceId', 'sourceRevision']);
        text(input.id);
        text(input.text, 4000);
        text(input.sourceId);
        integer(input.sourceRevision, 1);
        ensure(['knowledge', 'expression', 'preference'].includes(input.kind));
        const c = this.conversation(key);
        const source = this.memory.readPolicy().value.sources[input.sourceId];
        ensure(source?.conversationKey === key, 'SOURCE_SCOPE_MISMATCH');
        const refs = [{ sourceId: input.sourceId, revision: input.sourceRevision }];
        this.validateRaw(key, refs, 'learn');
        const context = this.memory.retrieve({ conversationKey: key, purpose: 'learn', query: input.text.slice(0, 128), now: this.now(), maxItems: 1, maxChars: 1 });
        context.items = [];
        context.sourceEvidence = [];
        context.chars = 0;
        this.memory.validateTicket(context, this.now());
        const proposal = { id: input.id, key, text: input.text, kind: input.kind, sourceId: input.sourceId, status: 'pending', sourceRefs: refs, derivedFrom: [], context,
            modelVersion: this.options.model?.id ?? 'unconfigured', bindingRevision: c.bindingRevision, provenanceComplete: true, origin: 'host-source' };
        return this.store.atomic(tx => {
            const saved = tx.read('learning:pending');
            const list = saved?.value ?? [];
            const prior = list.find(item => item.id === input.id);
            if (prior) {
                ensure(prior.origin === 'host-source' && prior.key === key && prior.text === input.text && prior.kind === input.kind && stable(prior.sourceRefs) === stable(refs), 'EVENT_CONFLICT');
                return prior;
            }
            ensure(list.length < 1000, 'CAPACITY');
            list.push(proposal);
            tx.write('learning:pending', saved?.revision ?? 0, list);
            return proposal;
        });
    }
    reviewLearning(id, accepted, principal) {
        ensure(this.options.authorizeLearning(principal), 'ACCESS_DENIED');
        ensure(typeof accepted === 'boolean');
        this.store.atomic(tx => {
            const current = tx.read('learning:pending');
            const proposal = current?.value.find(p => p.id === id);
            ensure(current && proposal?.status === 'pending', 'NOT_FOUND');
            if (accepted) {
                ensure(proposal.provenanceComplete && Array.isArray(proposal.sourceRefs) && Array.isArray(proposal.derivedFrom), 'PROVENANCE_REQUIRED');
                ensure(this.conversation(proposal.key).bindingRevision === proposal.bindingRevision, 'BINDING_CONFLICT');
                if (proposal.origin !== 'host-source')
                    ensure(this.options.model?.id === proposal.modelVersion, 'MODEL_CHANGED');
                this.validateRaw(proposal.key, proposal.sourceRefs, 'learn');
                const policy = this.memory.readPolicy();
                this.memory.validateTicket({ ...proposal.context, revision: policy.revision, purpose: 'learn' }, this.now());
                const memory = { id: proposal.id, revision: 1, conversationKey: proposal.key, kind: proposal.kind, text: proposal.text, sourceRefs: clone(proposal.sourceRefs), derivedFrom: clone(proposal.derivedFrom),
                    sharing: { approved: false, approvedBy: null, ruleRevision: policy.revision, targets: [], purposes: ['read', 'learn', 'draft'], expiresAt: null } };
                this.memory.addMemoryIn(tx, policy.revision, memory);
            }
            proposal.status = accepted ? 'accepted' : 'rejected';
            tx.write('learning:pending', current.revision, current.value);
        });
    }
    prepareCreationIntention(key, topic) {
        ensure(!this.closed, 'RUNTIME_CLOSED');
        text(topic, 128);
        this.conversation(key);
        const settings = this.memory.effective(key);
        ensure(settings.permissions.receive && settings.permissions.save, 'ACCESS_DENIED');
        const scope = this.scope(key);
        const sources = this.memory.readPolicy().value.sources;
        const sourceFilter = [];
        for (const [eventId, evidence] of Object.entries(this.self.get(scope).value.evidence)) {
            const ref = { sourceId: eventId, revision: evidence.revision };
            const source = sources[eventId];
            if (!evidence.revoked && (source?.conversationKey !== key || !this.experienceSourceAllowed(key, ref) || !this.sourceAllowed(source, ref, key, 'draft')))
                this.self.revokeSource(scope, eventId, evidence.revision);
            else if (!evidence.revoked && (settings.permissions.learn || this.memory.isSummaryMaterial(eventId)))
                sourceFilter.push(eventId);
        }
        const decision = this.self.decide(scope, { target: key, topic, action: 'idle-topic', sourceFilter, participation: settings.participation, policy: this.memory.restrictParticipation(key, this.options.participation(key, 'idle-topic')) });
        if (decision.intention)
            for (const ref of decision.intention.sources)
                ensure(this.experienceSourceAllowed(key, { sourceId: ref.eventId, revision: ref.revision }), 'SOURCE_REVOKED');
        return decision;
    }
    async idle(key, topic, action) {
        ensure(!this.closed, 'RUNTIME_CLOSED');
        const c = this.conversation(key);
        const settings = this.memory.effective(key);
        ensure(settings.permissions.proactive && settings.permissions.reply, 'ACCESS_DENIED');
        const targetActor = this.store.read('recent:' + key)?.value.at(-1)?.actor;
        const scope = this.scope(key);
        const choice = this.self.decide(scope, { target: key, topic, action, participation: settings.participation, ...(targetActor ? { relationshipTarget: targetActor } : {}), policy: this.memory.restrictParticipation(key, this.options.participation(key, action)) });
        if (choice.choice !== 'reply' || !choice.intention)
            return choice;
        ensure(!this.inflight.has(key), 'CONVERSATION_BUSY');
        this.inflight.add(key);
        try {
            this.self.recordAttempt(scope, choice.intention.id, { responded: false });
            const id = digest([key, choice.intention.id]);
            const input = { key, bindingRevision: c.bindingRevision, eventId: choice.intention.id, actor: 'juebot', actorKind: 'bot', plain: true, text: topic, observedAt: this.now() };
            return await this.generate({ id, key, input, status: 'received', reason: 'INITIATIVE', draftId: null, context: null }, topic, 'initiative', { action, intentionId: choice.intention.id, ...(targetActor ? { targetActor } : {}) });
        }
        finally {
            this.inflight.delete(key);
        }
    }
    repetitionPlan(key, events, wantsToRepeat) {
        ensure(!this.closed, 'RUNTIME_CLOSED');
        const c = this.conversation(key);
        const settings = this.memory.effective(key);
        const now = this.now();
        this.participationGate(key, null);
        const conversation = { namespace: c.identity.connector, opaqueId: c.identity.remoteId, accountKey: accountFor(c.identity), bindingRevision: c.bindingRevision };
        const old = this.store.read('repeat:' + key);
        const decision = considerRepetition(events, { conversationKey: conversation, conversationKind: c.identity.kind === 'group' ? 'group' : 'direct', wantsToRepeat, enabled: settings.permissions.reply,
            outboundAllowed: settings.permissions.reply, botActorKey: this.profile.botId, now, lastAttemptAt: old?.value.at ?? null });
        if (decision.action !== 'candidate' || this.memory.checkExpression(key, decision.text, 'repetition').action !== 'allow')
            return null;
        const index = this.store.read('recent:' + key)?.value ?? [];
        const rawSources = [];
        let expiresAt = now + 120000;
        for (const eventId of decision.sourceEventIds) {
            const event = events.find(item => item.id === eventId);
            const sourceId = digest([key, c.bindingRevision, eventId]);
            const saved = index.find(item => item.sourceId === sourceId && item.bindingRevision === c.bindingRevision);
            ensure(event && saved && saved.plain && saved.actor === event.actorKey && saved.observedAt === event.observedAt, 'UNTRUSTED_REPETITION_SOURCE');
            ensure(this.ledger.readBody(key, c.bindingRevision, saved.sequence) === event.text, 'UNTRUSTED_REPETITION_SOURCE');
            expiresAt = Math.min(expiresAt, saved.observedAt + 120000);
            rawSources.push({ sourceId, revision: saved.revision });
        }
        this.validateRaw(key, rawSources, 'draft');
        const id = 'repeat:' + digest([key, decision.sourceEventIds]);
        const state = this.self.get(this.scope(key)).value;
        return { c, settings, now, old, decision, id, state, rawSources, expiresAt };
    }
    commitRepetition(key, plan, styleProof) {
        const { c, settings, old, decision, id, state, rawSources, expiresAt } = plan;
        const now = this.now();
        ensure(expiresAt > now, 'REPETITION_EXPIRED');
        ensure(this.memory.readPolicy().revision === settings.revision, 'POLICY_CHANGED');
        this.validateRaw(key, rawSources, 'draft');
        this.participationGate(key, null);
        ensure(this.conversation(key).bindingRevision === c.bindingRevision, 'BINDING_CONFLICT');
        const latest = this.self.get(this.scope(key)).value;
        ensure(latest.identityRevision === state.identityRevision && latest.growthVersion === state.growthVersion, 'IDENTITY_CHANGED');
        ensure(this.memory.checkExpression(key, decision.text, 'repetition').action === 'allow', 'EXPRESSION_BLOCKED');
        this.store.atomic(tx => {
            const current = tx.read('repeat:' + key);
            ensure((current?.revision ?? 0) === (old?.revision ?? 0), 'CONFLICT');
            this.outbox.enqueueIn(tx, { id, account: accountFor(c.identity), conversation: key, kind: 'repetition', body: decision.text,
                payload: { kind: 'repetition', rawSources, growthVersion: state.growthVersion, ...(styleProof ? { styleProof } : {}) },
                revisions: { binding: c.bindingRevision, policy: settings.revision, memory: settings.revision, expression: settings.revision, identity: state.identityRevision },
                sourceRefs: rawSources.map(ref => ({ id: ref.sourceId, revision: ref.revision })), createdAt: now, dueAt: now, expiresAt, costUnits: 1 });
            tx.write('repeat:' + key, current?.revision ?? 0, { at: now });
        });
        return id;
    }
    repeat(key, events, wantsToRepeat) {
        const plan = this.repetitionPlan(key, events, wantsToRepeat);
        if (!plan)
            return null;
        // Preserve the synchronous API without pretending that literal matching reviews style.
        if (plan.settings.expressionPolicy.styleContracts.length)
            return null;
        return this.commitRepetition(key, plan);
    }
    async repeatReviewed(key, events, wantsToRepeat) {
        const plan = this.repetitionPlan(key, events, wantsToRepeat);
        if (!plan)
            return null;
        if (!plan.settings.expressionPolicy.styleContracts.length)
            return this.commitRepetition(key, plan);
        const model = this.options.model;
        ensure(model?.reviewStyle, 'STYLE_REVIEW_UNAVAILABLE');
        const modelVersion = model.id;
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            const result = await model.reviewStyle({ text: plan.decision.text, styleContracts: clone(plan.settings.expressionPolicy.styleContracts) }, controller.signal);
            ensure(!this.closed && !controller.signal.aborted, 'CANCELLED');
            ensure(this.options.model === model && model.id === modelVersion, 'MODEL_CHANGED');
            ensure(['pass', 'rewrite', 'block'].includes(result), 'STYLE_REVIEW_INVALID');
            // A rewritten copy is no longer the same +1. Only an unchanged semantic pass may queue.
            if (result !== 'pass')
                return null;
            return this.commitRepetition(key, plan, { bodyHash: digest(plan.decision.text), policyRevision: plan.settings.revision, modelVersion });
        }
        finally {
            this.controllers.delete(controller);
        }
    }
    sendGate(item) {
        try {
            ensure(!this.closed, 'RUNTIME_CLOSED');
            const c = this.conversation(item.conversation);
            const settings = this.memory.effective(item.conversation);
            ensure(c.bindingRevision === item.revisions.binding && accountFor(c.identity) === item.account, 'BINDING_CONFLICT');
            ensure(settings.permissions.reply, 'ACCESS_DENIED');
            ensure(settings.revision === item.revisions.policy, 'POLICY_CHANGED');
            const currentSelf = this.self.get(this.currentScope(item.conversation)).value;
            ensure(currentSelf.identityRevision === item.revisions.identity, 'IDENTITY_CHANGED');
            ensure(item.kind === 'social' || item.kind === 'repetition', 'UNSUPPORTED_SEND_KIND');
            const payload = item.payload;
            this.participationGate(item.conversation, payload.initiative?.action ?? null);
            if (payload.initiative) {
                ensure(settings.permissions.proactive, 'ACCESS_DENIED');
                const self = currentSelf;
                const intention = self.intents.find(intent => intent.id === payload.initiative.intentionId);
                ensure(intention && intention.status === 'attempted' && intention.action === payload.initiative.action && intention.target === item.conversation && intention.expiresAt > this.now(), 'INTENTION_CHANGED');
                for (const ref of intention.sources) {
                    ensure(self.evidence[ref.eventId]?.revision === ref.revision && !self.evidence[ref.eventId].revoked, 'SOURCE_REVOKED');
                    this.validateRaw(item.conversation, [{ sourceId: ref.eventId, revision: ref.revision }], 'draft');
                }
            }
            if (item.kind === 'repetition') {
                ensure(Array.isArray(payload.rawSources) && payload.rawSources.length >= 3, 'PROVENANCE_REQUIRED');
                this.validateRaw(item.conversation, payload.rawSources, 'draft');
            }
            if (item.kind === 'social') {
                ensure(payload.context && Array.isArray(payload.rawSources), 'PROVENANCE_REQUIRED');
                this.memory.validateTicket(payload.context, this.now());
                this.validateRaw(item.conversation, payload.rawSources, 'draft');
                ensure(payload.modelVersion === this.options.model?.id, 'MODEL_CHANGED');
                ensure(payload.growthVersion === currentSelf.growthVersion, 'IDENTITY_CHANGED');
            }
            if (settings.expressionPolicy.styleContracts.length) {
                const proof = payload.styleProof;
                ensure(proof && proof.bodyHash === digest(item.body) && proof.policyRevision === settings.revision && proof.modelVersion === this.options.model?.id, 'STYLE_REVIEW_REQUIRED');
            }
            ensure(this.memory.checkExpression(item.conversation, item.body, item.kind === 'repetition' ? 'repetition' : 'social').action === 'allow', 'EXPRESSION_BLOCKED');
            return { allowed: true, reason: 'NONE' };
        }
        catch (error) {
            return { allowed: false, reason: error instanceof AgentError ? error.code : 'RECHECK_FAILED' };
        }
    }
    async dispatch(account, owner, budget, send) {
        const item = this.outbox.claim(account, owner, this.now(), 30000, budget, e => this.sendGate(e));
        if (!item)
            return null;
        const current = this.outbox.list().find(row => row.id === item.id);
        const gate = this.sendGate(item);
        if (!current || current.status !== 'sending' || current.claim !== item.claim || current.leaseUntil <= this.now() || !gate.allowed)
            return this.outbox.finish(item.id, item.claim, this.now(), 'failed', 'not-submitted:' + gate.reason, 'not-submitted');
        let result;
        try {
            result = await send(clone(item));
        }
        catch {
            result = { status: 'unknown', receipt: null };
        }
        const finished = this.outbox.finish(item.id, item.claim, this.now(), result.status, result.receipt);
        this.recordDelivery(finished);
        return finished;
    }
    recordDelivery(item) {
        if (item.kind !== 'social' && item.kind !== 'repetition')
            return;
        if (item.status === 'confirmed' && item.payload.initiative)
            this.store.atomic(tx => { if (!tx.read('confirmed:' + item.id))
                tx.write('confirmed:' + item.id, 0, { at: this.now() }); });
        // A later evidence reconciliation is a distinct fact, not a replacement for
        // the earlier uncertain result. Repeating the same outcome remains deduped.
        try {
            this.event(item.conversation, 'delivery:' + digest(item.id) + ':' + item.status, item.status === 'confirmed' ? 'reply.confirmed' : item.status === 'failed' ? 'reply.failed' : 'reply.unknown', null);
        }
        catch { /* committed Outbox is authoritative; audit repair never triggers a resend */ }
    }
    close() { this.closed = true; for (const controller of this.controllers)
        controller.abort(); this.controllers.clear(); }
}
