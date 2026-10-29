import { AgentError, ensure, text, integer, clone } from "./common.js";
import { canonicalIdentity, conversationKey } from "../../conversation-v1/src/identity.js";
import { DEFAULT_TYPING_CONFIG, validateTypingConfig } from "../../social-v1/src/typing.js";
import { checkExpression as checkPolicyExpression, validateExpressionPolicy } from "../../social-v1/src/expression-policy.js";
const permissions = ['receive', 'save', 'learn', 'reply', 'proactive'];
const purposes = ['read', 'learn', 'draft', 'publish'];
const MAX_RECORDS = 1024;
function shape(value, keys) {
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
    ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    for (const name of Reflect.ownKeys(value)) {
        ensure(typeof name === 'string' && keys.includes(name));
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        ensure('value' in descriptor && descriptor.enumerable);
    }
}
function body(value, max) {
    ensure(typeof value === 'string' && value.length <= max && !value.includes('\0'));
}
function expiry(value) { if (value !== null)
    integer(value); }
function live(until, now) { return until === null || until > now; }
function array(value, max) { ensure(Array.isArray(value) && value.length <= max); }
function safeId(value) { text(value); ensure(value !== '__proto__' && value !== 'constructor' && value !== 'prototype'); }
function initial() {
    return { mode: 'isolated', global: { permissions: { receive: false, save: false, learn: false, reply: false, proactive: false },
            prompt: '', typing: { ...DEFAULT_TYPING_CONFIG }, expressionRules: [], styleContracts: [], participation: 0.5 }, locals: {}, sources: {}, memories: {} };
}
/** Trusted Host service: no model/HTTP/file/driver or account authority is exposed. */
export class PolicyMemory {
    store;
    stateKey;
    botId;
    personaId;
    constructor(store, options) {
        shape(options, ['botId', 'personaId']);
        text(options.botId);
        text(options.personaId);
        this.store = store;
        this.botId = options.botId;
        this.personaId = options.personaId;
        this.stateKey = JSON.stringify(['policy-memory-v1', options.botId, options.personaId]);
    }
    key(value) {
        text(value, 4096);
        try {
            const tuple = JSON.parse(value);
            ensure(Array.isArray(tuple) && tuple.length === 8 && tuple[0] === 'juebot-conversation-v1');
            const identity = canonicalIdentity({ botId: tuple[1], personaId: tuple[2], connector: tuple[3], issuer: tuple[4], accountId: tuple[5], kind: tuple[6], remoteId: tuple[7] });
            ensure(identity.botId === this.botId && identity.personaId === this.personaId && conversationKey(identity) === value, 'MEMORY_SCOPE_MISMATCH');
        }
        catch (error) {
            if (error instanceof AgentError)
                throw error;
            throw new AgentError('INVALID_CONVERSATION_KEY');
        }
    }
    read(tx) {
        return clone((tx ?? this.store).read(this.stateKey) ?? { revision: 0, value: initial() });
    }
    readPolicy() { return this.read(); }
    change(expectedRevision, fn) {
        return this.store.atomic(tx => this.changeIn(tx, expectedRevision, fn));
    }
    changeIn(tx, expectedRevision, fn) {
        integer(expectedRevision);
        const current = this.read(tx);
        ensure(current.revision === expectedRevision, 'REVISION_CONFLICT');
        fn(current.value);
        return tx.write(this.stateKey, expectedRevision, current.value);
    }
    expression(rules, prefix) {
        return rules.map(rule => ({ ...rule, ruleId: `${prefix}:${rule.ruleId}`, scope: { kind: 'global' } }));
    }
    styles(contracts, prefix) {
        // The canonical stream was resolved before this projection; no raw key enters the
        // expression library's narrower physical scope field. Rules use the same projection.
        return contracts.map(contract => ({ ...contract, contractId: `${prefix}:style:${contract.contractId}`, scope: { kind: 'global' } }));
    }
    effectiveFrom(state, revision, key) {
        const local = state.locals[key];
        const global = state.global;
        const effectivePermissions = { ...global.permissions };
        for (const permission of permissions)
            effectivePermissions[permission] = global.permissions[permission] && local?.permissions?.[permission] !== false;
        const styleContracts = [...(global.styleContracts ?? []), ...(local?.styleContracts ?? [])];
        const expressionPolicy = { revision, rules: [...this.expression(global.expressionRules, 'g'), ...this.expression(local?.expressionRules ?? [], 'l')],
            styleContracts: [...this.styles(global.styleContracts ?? [], 'g'), ...this.styles(local?.styleContracts ?? [], 'l')], maxRewrites: 2 };
        return { permissions: effectivePermissions, prompt: [global.prompt, local?.prompt ?? ''].filter(Boolean).join('\n'),
            typing: { ...global.typing, ...local?.typing }, expressionRules: [...global.expressionRules, ...(local?.expressionRules ?? [])], styleContracts,
            participation: local?.participation ?? global.participation,
            memoryMode: state.mode === 'isolated' || local?.memoryMode === 'isolated' ? 'isolated' : 'shared', expressionPolicy, revision };
    }
    effective(key) {
        this.key(key);
        const current = this.read();
        return clone(this.effectiveFrom(current.value, current.revision, key));
    }
    configure(expectedRevision, patch, key) {
        shape(patch, ['mode', 'memoryMode', 'permissions', 'prompt', 'typing', 'expressionRules', 'styleContracts', 'participation']);
        ensure(Object.keys(patch).length > 0);
        if (key !== undefined)
            this.key(key);
        ensure(key === undefined ? patch.memoryMode === undefined : patch.mode === undefined);
        if (patch.mode !== undefined)
            ensure(patch.mode === 'isolated' || patch.mode === 'shared');
        if (patch.memoryMode !== undefined)
            ensure(patch.memoryMode === 'inherit' || patch.memoryMode === 'isolated');
        if (patch.permissions !== undefined) {
            shape(patch.permissions, permissions);
            for (const value of Object.values(patch.permissions))
                ensure(typeof value === 'boolean');
        }
        if (patch.prompt !== undefined)
            body(patch.prompt, 4000);
        if (patch.participation !== undefined)
            ensure(Number.isFinite(patch.participation) && patch.participation >= 0 && patch.participation <= 1);
        if (patch.typing !== undefined)
            shape(patch.typing, Object.keys(DEFAULT_TYPING_CONFIG));
        if (patch.expressionRules !== undefined) {
            array(patch.expressionRules, 64);
            for (const rule of patch.expressionRules) {
                shape(rule, ['ruleId', 'match', 'phrase', 'action']);
                text(rule.ruleId, 80);
            }
            try {
                validateExpressionPolicy({ revision: 0, rules: this.expression(patch.expressionRules, 'v'), styleContracts: [], maxRewrites: 2 });
            }
            catch {
                throw new AgentError('INVALID_EXPRESSION_POLICY');
            }
        }
        if (patch.styleContracts !== undefined) {
            array(patch.styleContracts, 32);
            for (const contract of patch.styleContracts) {
                shape(contract, ['contractId', 'policyText', 'counterexamples']);
                text(contract.contractId, 80);
                body(contract.policyText, 4000);
                array(contract.counterexamples, 8);
                for (const example of contract.counterexamples)
                    body(example, 512);
            }
            try {
                validateExpressionPolicy({ revision: 0, rules: [], styleContracts: this.styles(patch.styleContracts, 'v'), maxRewrites: 2 });
            }
            catch {
                throw new AgentError('INVALID_EXPRESSION_POLICY');
            }
        }
        return this.change(expectedRevision, state => {
            if (key === undefined) {
                if (patch.mode !== undefined)
                    state.mode = patch.mode;
                const { mode: ignored, ...settings } = patch;
                void ignored;
                state.global = { ...state.global, ...settings, permissions: { ...state.global.permissions, ...patch.permissions }, typing: { ...state.global.typing, ...patch.typing } };
            }
            else {
                ensure(Object.hasOwn(state.locals, key) || Object.keys(state.locals).length < 128, 'CAPACITY_EXCEEDED');
                for (const permission of permissions)
                    if (patch.permissions?.[permission] === true)
                        ensure(state.global.permissions[permission], 'HARD_PERMISSION_DENIED');
                state.locals[key] = { ...state.locals[key], memoryMode: state.locals[key]?.memoryMode ?? 'inherit', ...patch,
                    permissions: { ...state.locals[key]?.permissions, ...patch.permissions }, typing: { ...state.locals[key]?.typing, ...patch.typing } };
            }
            try {
                validateTypingConfig(key === undefined ? state.global.typing : this.effectiveFrom(state, 0, key).typing);
            }
            catch {
                throw new AgentError('INVALID_TYPING_CONFIG');
            }
            try {
                // A global edit must also preserve the combined limit for every existing local.
                validateExpressionPolicy({ revision: 0, rules: this.expression(state.global.expressionRules, 'g'),
                    styleContracts: this.styles(state.global.styleContracts ?? [], 'g'), maxRewrites: 2 });
                for (const localKey of key === undefined ? Object.keys(state.locals) : [key])
                    validateExpressionPolicy(this.effectiveFrom(state, 0, localKey).expressionPolicy);
            }
            catch {
                throw new AgentError('INVALID_EXPRESSION_POLICY');
            }
        });
    }
    checkExpression(key, value, kind = 'social', rewriteCount = 0) {
        this.key(key);
        body(value, 32000);
        integer(rewriteCount);
        const config = this.effective(key);
        return checkPolicyExpression(config.expressionPolicy, { kind, text: value, conversationKey: 'resolved-scope', personaId: this.personaId, policyRevision: config.revision, rewriteCount });
    }
    purposeList(value) {
        array(value, 4);
        ensure(value.length > 0 && new Set(value).size === value.length && value.every(item => purposes.includes(item)));
    }
    targets(value) {
        array(value, 128);
        for (const item of value)
            this.key(item);
        ensure(new Set(value).size === value.length);
    }
    putSource(expectedRevision, input) {
        shape(input, ['id', 'conversationKey', 'revision', 'domain', 'status', 'purposes', 'audiences', 'expiresAt']);
        safeId(input.id);
        this.key(input.conversationKey);
        integer(input.revision, 1);
        expiry(input.expiresAt);
        ensure(input.domain === 'social' || input.domain === 'code');
        ensure(input.status === 'active' || input.status === 'revoked');
        this.purposeList(input.purposes);
        this.targets(input.audiences);
        const source = clone(input);
        return this.change(expectedRevision, state => {
            const prior = state.sources[source.id];
            ensure(!prior || (prior.conversationKey === source.conversationKey && prior.domain === source.domain && source.revision > prior.revision), 'SOURCE_CONFLICT');
            ensure(!prior || prior.status !== 'revoked' || source.status === 'revoked', 'SOURCE_REVOKED');
            ensure(prior || Object.keys(state.sources).length < MAX_RECORDS, 'CAPACITY_EXCEEDED');
            state.sources[source.id] = source;
            this.cascade(state);
        });
    }
    revokeSource(expectedRevision, sourceId, nextSourceRevision) {
        safeId(sourceId);
        integer(nextSourceRevision, 1);
        return this.change(expectedRevision, state => {
            const source = state.sources[sourceId];
            ensure(source, 'SOURCE_NOT_FOUND');
            ensure(nextSourceRevision > source.revision, 'SOURCE_CONFLICT');
            state.sources[sourceId] = { ...source, revision: nextSourceRevision, status: 'revoked' };
            this.cascade(state);
        });
    }
    cascade(state) {
        for (let pass = 0; pass <= MAX_RECORDS; pass++) {
            let changed = false;
            for (const memory of Object.values(state.memories)) {
                if (memory.status === 'revoked')
                    continue;
                if (memory.sourceRefs.some(ref => !state.sources[ref.sourceId] || state.sources[ref.sourceId].status !== 'active' || state.sources[ref.sourceId].revision !== ref.revision)
                    || memory.derivedFrom.some(ref => !state.memories[ref.memoryId] || state.memories[ref.memoryId].status !== 'active' || state.memories[ref.memoryId].revision !== ref.revision)) {
                    memory.status = 'revoked';
                    changed = true;
                }
            }
            if (!changed)
                return;
        }
        throw new AgentError('DERIVATION_LIMIT');
    }
    addMemory(expectedRevision, input) {
        return this.store.atomic(tx => this.addMemoryIn(tx, expectedRevision, input));
    }
    /** Trusted Host only: join a caller-owned transaction without weakening candidate validation. */
    addMemoryIn(tx, expectedRevision, input) {
        shape(input, ['id', 'revision', 'conversationKey', 'kind', 'text', 'sourceRefs', 'derivedFrom', 'sharing']);
        safeId(input.id);
        integer(input.revision, 1);
        this.key(input.conversationKey);
        body(input.text, 16000);
        ensure(input.text.trim().length > 0);
        ensure(['knowledge', 'expression', 'preference', 'private'].includes(input.kind));
        array(input.sourceRefs, 32);
        array(input.derivedFrom, 16);
        ensure(input.sourceRefs.length > 0);
        for (const ref of input.sourceRefs) {
            shape(ref, ['sourceId', 'revision']);
            safeId(ref.sourceId);
            integer(ref.revision, 1);
        }
        for (const ref of input.derivedFrom) {
            shape(ref, ['memoryId', 'revision']);
            safeId(ref.memoryId);
            integer(ref.revision, 1);
            ensure(ref.memoryId !== input.id, 'DERIVATION_CYCLE');
        }
        ensure(new Set(input.sourceRefs.map(ref => ref.sourceId)).size === input.sourceRefs.length);
        ensure(new Set(input.derivedFrom.map(ref => ref.memoryId)).size === input.derivedFrom.length);
        shape(input.sharing, ['approved', 'approvedBy', 'ruleRevision', 'targets', 'purposes', 'expiresAt']);
        ensure(typeof input.sharing.approved === 'boolean');
        integer(input.sharing.ruleRevision);
        expiry(input.sharing.expiresAt);
        this.targets(input.sharing.targets);
        this.purposeList(input.sharing.purposes);
        if (input.sharing.approved)
            text(input.sharing.approvedBy);
        else
            ensure(input.sharing.approvedBy === null && input.sharing.targets.length === 0);
        const memory = clone(input);
        return this.changeIn(tx, expectedRevision, state => {
            const permissions = this.effectiveFrom(state, 0, memory.conversationKey).permissions;
            ensure(permissions.receive && permissions.save && permissions.learn, 'MEMORY_WRITE_DENIED');
            const prior = state.memories[memory.id];
            ensure(!prior || (prior.conversationKey === memory.conversationKey && prior.status !== 'revoked' && memory.revision > prior.revision), 'MEMORY_CONFLICT');
            ensure(prior || Object.keys(state.memories).length < MAX_RECORDS, 'CAPACITY_EXCEEDED');
            for (const ref of memory.sourceRefs) {
                const source = state.sources[ref.sourceId];
                ensure(source && source.status === 'active' && source.revision === ref.revision && source.domain === 'social', 'SOURCE_NOT_ALLOWED');
                // Keep facts on their source card. Cross-stream use happens through
                // approved retrieval, never by silently copying a foreign fact locally.
                ensure(source.conversationKey === memory.conversationKey, 'SOURCE_SCOPE_MISMATCH');
                ensure(source.purposes.includes('learn') && source.audiences.includes(memory.conversationKey), 'SOURCE_NOT_ALLOWED');
            }
            for (const ref of memory.derivedFrom) {
                const parent = state.memories[ref.memoryId];
                ensure(parent && parent.status === 'active' && parent.revision === ref.revision, 'DERIVATION_INVALID');
                // No provenance laundering: every ancestor source must remain explicitly inherited.
                ensure(parent.sourceRefs.every(source => memory.sourceRefs.some(candidate => candidate.sourceId === source.sourceId && candidate.revision === source.revision)), 'SOURCE_INHERITANCE_REQUIRED');
                let visits = 0;
                const inspect = (id, path) => {
                    ensure(!path.has(id), 'DERIVATION_CYCLE');
                    ensure(++visits <= 128, 'DERIVATION_LIMIT');
                    const next = new Set(path).add(id);
                    for (const ancestor of state.memories[id].derivedFrom)
                        inspect(ancestor.memoryId, next);
                };
                inspect(parent.id, new Set([memory.id]));
            }
            state.memories[memory.id] = { ...memory, status: 'active' };
            this.cascade(state);
        });
    }
    readable(state, memory, key, purpose, now, visited = new Set()) {
        if (visited.has(memory.id) || visited.size >= 128 || memory.status !== 'active')
            return false;
        const next = new Set(visited).add(memory.id);
        const target = this.effectiveFrom(state, 0, key);
        const origin = this.effectiveFrom(state, 0, memory.conversationKey);
        if (!target.permissions.receive || !target.permissions.save || !origin.permissions.receive || !origin.permissions.save)
            return false;
        if (purpose === 'learn' && !target.permissions.learn)
            return false;
        if ((purpose === 'draft' || purpose === 'publish') && !target.permissions.reply)
            return false;
        if (memory.conversationKey !== key) {
            if (target.memoryMode !== 'shared' || origin.memoryMode !== 'shared' || !memory.sharing.approved
                || !memory.sharing.targets.includes(key) || !memory.sharing.purposes.includes(purpose) || !live(memory.sharing.expiresAt, now))
                return false;
        }
        for (const ref of memory.sourceRefs) {
            const source = state.sources[ref.sourceId];
            if (!source || source.domain !== 'social' || source.status !== 'active' || source.revision !== ref.revision
                || !source.purposes.includes(purpose) || !source.audiences.includes(key) || !live(source.expiresAt, now))
                return false;
        }
        return memory.derivedFrom.every(ref => {
            const parent = state.memories[ref.memoryId];
            return parent !== undefined && parent.revision === ref.revision && this.readable(state, parent, key, purpose, now, next);
        });
    }
    retrieve(request) {
        shape(request, ['conversationKey', 'purpose', 'query', 'now', 'maxItems', 'maxChars']);
        this.key(request.conversationKey);
        ensure(purposes.includes(request.purpose));
        body(request.query, 2048);
        integer(request.now);
        const maxItems = request.maxItems ?? 8;
        const maxChars = request.maxChars ?? 8000;
        integer(maxItems, 1, 32);
        integer(maxChars, 1, 16000);
        const snapshot = this.read();
        const terms = [...new Set(request.query.normalize('NFKC').toLocaleLowerCase('en').split(/\s+/u).filter(Boolean))].slice(0, 32);
        const candidates = Object.values(snapshot.value.memories).filter(memory => this.readable(snapshot.value, memory, request.conversationKey, request.purpose, request.now))
            .map(memory => ({ memory, score: terms.reduce((score, term) => score + (memory.text.normalize('NFKC').toLocaleLowerCase('en').includes(term) ? 1 : 0), 0) }))
            .filter(item => terms.length === 0 || item.score > 0).sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id, 'en'));
        const items = [];
        let chars = 0;
        for (const item of candidates) {
            if (items.length >= maxItems)
                break;
            if (chars + item.memory.text.length > maxChars)
                continue;
            items.push(clone(item.memory));
            chars += item.memory.text.length;
        }
        const sourceEvidence = [...new Map(items.flatMap(item => item.sourceRefs).map(ref => [ref.sourceId, ref])).values()].map(clone);
        const ticket = { schemaVersion: 1, botId: this.botId, personaId: this.personaId, revision: snapshot.revision,
            conversationKey: request.conversationKey, purpose: request.purpose, issuedAt: request.now, items, sourceEvidence, chars, bounded: true, method: 'keyword' };
        this.validateTicket(ticket, request.now); // Recheck after building, not merely before ranking.
        return ticket;
    }
    validateTicket(ticket, now) {
        integer(now);
        ensure(ticket && ticket.schemaVersion === 1 && ticket.botId === this.botId && ticket.personaId === this.personaId, 'CONTEXT_INVALID');
        this.key(ticket.conversationKey);
        ensure(purposes.includes(ticket.purpose), 'CONTEXT_INVALID');
        const snapshot = this.read();
        ensure(snapshot.revision === ticket.revision, 'CONTEXT_STALE');
        ensure(Array.isArray(ticket.items) && ticket.items.length <= 32, 'CONTEXT_INVALID');
        for (const item of ticket.items) {
            const memory = snapshot.value.memories[item.id];
            ensure(memory && JSON.stringify(memory) === JSON.stringify(item)
                && this.readable(snapshot.value, memory, ticket.conversationKey, ticket.purpose, now), 'CONTEXT_STALE');
        }
        const evidence = [...new Map(ticket.items.flatMap(item => item.sourceRefs).map(ref => [ref.sourceId, ref])).values()];
        ensure(JSON.stringify(evidence) === JSON.stringify(ticket.sourceEvidence), 'CONTEXT_INVALID');
        ensure(ticket.chars === ticket.items.reduce((sum, item) => sum + item.text.length, 0), 'CONTEXT_INVALID');
        return true;
    }
    card(key, now) {
        this.key(key);
        integer(now);
        const current = this.read();
        return { conversationKey: key, personaId: this.personaId, revision: current.revision,
            mode: this.effectiveFrom(current.value, current.revision, key).memoryMode,
            items: Object.values(current.value.memories).filter(memory => memory.conversationKey === key && this.readable(current.value, memory, key, 'read', now)).map(clone) };
    }
}
