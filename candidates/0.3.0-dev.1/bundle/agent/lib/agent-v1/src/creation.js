import { createHash } from 'node:crypto';
import { AgentError, stable } from "./common.js";
const actions = ['qqspace', 'bili.comment', 'bili.reply', 'bili.dynamic', 'bili.video'];
const copy = (value) => structuredClone(value);
function requireValue(value, code = 'CREATION_INVALID_INPUT') { if (!value)
    throw new AgentError(code); }
function revision(value) { requireValue(Number.isSafeInteger(value) && value >= 0); }
function string(value, max, empty = false) {
    requireValue(typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !value.includes('\u0000'));
}
function identifier(value) {
    requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value));
}
function object(value, keys) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
    requireValue(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    requireValue(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)));
    requireValue(keys.every(key => Object.hasOwn(value, key)));
    requireValue(Object.values(Object.getOwnPropertyDescriptors(value)).every(item => !item.get && !item.set));
}
function target(value) {
    object(value, ['objectId', 'parentId', 'visibility', 'category']);
    for (const key of ['objectId', 'parentId', 'category'])
        if (value[key] !== null)
            string(value[key], 256);
    string(value.visibility, 256);
    return copy(value);
}
function sources(value) {
    requireValue(Array.isArray(value) && value.length <= 64);
    const seen = new Set();
    return value.map(item => {
        object(item, ['id', 'revision', 'personLinkRevision']);
        identifier(item.id);
        revision(item.revision);
        if (item.personLinkRevision !== null)
            revision(item.personLinkRevision);
        requireValue(!seen.has(item.id));
        seen.add(item.id);
        return { id: item.id, revision: item.revision, personLinkRevision: item.personLinkRevision };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function asset(value) {
    object(value, ['ref', 'sha256', 'previewRef']);
    // These tokens are registry handles, never filesystem paths, URLs or upload locations.
    for (const key of ['ref', 'previewRef'])
        requireValue(typeof value[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value[key]));
    requireValue(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256));
    return { ref: value.ref, sha256: value.sha256, previewRef: value.previewRef };
}
function assetList(value) { requireValue(Array.isArray(value) && value.length <= 32); return value.map(asset); }
function finalManifest(value) {
    object(value, ['accountId', 'target', 'title', 'description', 'tags', 'text', 'video', 'audio', 'subtitles', 'cover', 'attachments']);
    identifier(value.accountId);
    string(value.title, 256, true);
    string(value.description, 8000, true);
    string(value.text, 16000, true);
    requireValue(Array.isArray(value.tags) && value.tags.length <= 32);
    for (const tag of value.tags)
        string(tag, 64);
    return { accountId: value.accountId, target: target(value.target), title: value.title, description: value.description,
        tags: [...value.tags], text: value.text, video: value.video === null ? null : asset(value.video),
        audio: assetList(value.audio), subtitles: assetList(value.subtitles), cover: value.cover === null ? null : asset(value.cover), attachments: assetList(value.attachments) };
}
function hash(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
function snapshotHash(value) {
    return hash({ workId: value.workId, action: value.action, version: value.version, manifest: value.manifest, sources: value.sources,
        policyRevision: value.policyRevision, accountRevision: value.accountRevision, contextRevision: value.contextRevision });
}
function createInput(value) {
    object(value, ['id', 'action', 'intention', 'accountId', 'target', 'sources']);
    identifier(value.id);
    identifier(value.accountId);
    requireValue(actions.includes(value.action));
    string(value.intention, 4000);
    const destination = target(value.target);
    if (value.action === 'bili.comment' || value.action === 'bili.reply')
        requireValue(destination.objectId !== null);
    if (value.action === 'bili.reply')
        requireValue(destination.parentId !== null);
    if (value.action === 'bili.video')
        requireValue(destination.category !== null);
    return { id: value.id, action: value.action, intention: value.intention, accountId: value.accountId,
        target: destination, sources: sources(value.sources) };
}
/** Durable preparation and approval only. No upload, platform client, model, or synthetic media generator. */
export class CreationService {
    store;
    dependencies;
    constructor(store, dependencies) { this.store = store; this.dependencies = dependencies; }
    key(id) { identifier(id); return `creation:work:${id}`; }
    read(id) { return this.store.read(this.key(id)); }
    /** Host-only metadata projection. Does not expose intention, sources, targets, accounts or private media. */
    list(limit = 100) {
        requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
        const index = this.store.read('creation:index');
        if (!index)
            return [];
        requireValue(Array.isArray(index.value.ids) && index.value.ids.length <= 1000, 'CREATION_INDEX_INVALID');
        return index.value.ids.slice(-limit).reverse().map(id => {
            const work = this.read(id);
            requireValue(work, 'CREATION_INDEX_INVALID');
            return { id: work.value.id, revision: work.revision, action: work.value.action, stage: work.value.stage,
                version: work.value.version, readyForReview: work.value.stage === 'final-review' && work.value.final !== null && work.value.review === null
                    && (!work.value.workflow || work.value.workflow.phase === 'ready') };
        });
    }
    create(input) {
        const value = createInput(input);
        return this.store.atomic(tx => {
            const index = tx.read('creation:index');
            const ids = index?.value.ids ?? [];
            requireValue(Array.isArray(ids) && ids.length < 1000, 'CREATION_CAPACITY');
            const saved = tx.write(this.key(value.id), 0, { ...value, stage: 'intention', version: 1,
                brief: null, script: null, assets: [], final: null, approval: null, submission: null, workflow: null, review: null });
            tx.write('creation:index', index?.revision ?? 0, { ids: [...ids, value.id] });
            return saved;
        });
    }
    /** Host-only workflow journal. It never grants approval or changes final assets/submission state. */
    setWorkflow(id, expectedRevision, value) {
        object(value, ['intentId', 'phase', 'reasonCode', 'policyRevision', 'materialsRevision', 'publication', 'selfScope', 'intentionSources', 'identityRevision', 'growthVersion', 'modelVersion', 'mode']);
        identifier(value.intentId);
        revision(value.policyRevision);
        object(value.selfScope, ['botId', 'personaId', 'scope']);
        for (const field of ['botId', 'personaId', 'scope'])
            string(value.selfScope[field], 4096);
        revision(value.identityRevision);
        string(value.growthVersion, 256);
        string(value.modelVersion, 256);
        requireValue(value.mode === 'juejue' || value.mode === 'persona');
        requireValue(Array.isArray(value.intentionSources) && value.intentionSources.length > 0 && value.intentionSources.length <= 16);
        const seen = new Set();
        for (const source of value.intentionSources) {
            object(source, ['eventId', 'revision']);
            string(source.eventId, 256);
            revision(source.revision);
            requireValue(!seen.has(source.eventId));
            seen.add(source.eventId);
        }
        if (value.materialsRevision !== null)
            revision(value.materialsRevision);
        requireValue(['planning', 'producing', 'ready', 'failed'].includes(value.phase));
        requireValue(value.phase === 'failed' ? ['INTENTION_UNAVAILABLE', 'POLICY_CHANGED', 'MATERIALS_CHANGED', 'INVALID_PLAN', 'PLAN_FAILED', 'PRODUCTION_FAILED', 'CREATION_FAILED'].includes(value.reasonCode ?? '') : value.reasonCode === null);
        if (value.publication !== null) {
            object(value.publication, ['title', 'description', 'tags', 'text']);
            string(value.publication.title, 256, true);
            string(value.publication.description, 8000, true);
            string(value.publication.text, 16000, true);
            requireValue(Array.isArray(value.publication.tags) && value.publication.tags.length <= 32);
            value.publication.tags.forEach(tag => string(tag, 64));
        }
        return this.store.atomic(tx => {
            const current = this.loaded(tx, id, expectedRevision);
            const work = copy(current.value);
            requireValue(work.submission === null && work.approval === null, 'CREATION_ALREADY_SUBMITTED');
            requireValue(!work.workflow || (work.workflow.intentId === value.intentId && work.workflow.policyRevision === value.policyRevision
                && stable(this.workflowContext(work.workflow)) === stable(this.workflowContext(value))
                && work.workflow.phase !== 'failed' && (work.workflow.phase !== 'ready' || value.phase === 'failed')), 'CREATION_WORKFLOW_CONFLICT');
            if (value.phase === 'ready')
                requireValue(work.stage === 'final-review' && work.final !== null, 'CREATION_FINAL_REQUIRED');
            work.workflow = copy(value);
            return tx.write(this.key(id), current.revision, work);
        });
    }
    workflowContext(value) {
        return [value.selfScope, value.intentionSources, value.identityRevision, value.growthVersion, value.modelVersion, value.mode];
    }
    loaded(tx, id, expectedRevision) {
        revision(expectedRevision);
        const current = tx.read(this.key(id));
        requireValue(current, 'CREATION_NOT_FOUND');
        requireValue(current.revision === expectedRevision, 'CREATION_REVISION_CONFLICT');
        return current;
    }
    change(id, expectedRevision, mutate) {
        return this.store.atomic(tx => {
            const current = this.loaded(tx, id, expectedRevision);
            const work = copy(current.value);
            requireValue(work.submission === null, 'CREATION_ALREADY_SUBMITTED');
            requireValue(work.version < Number.MAX_SAFE_INTEGER, 'CREATION_VERSION_EXHAUSTED');
            mutate(work);
            work.version++;
            work.final = null;
            work.approval = null;
            return tx.write(this.key(id), current.revision, work);
        });
    }
    revise(id, expectedRevision, input) {
        const checked = createInput({ ...input, id });
        return this.change(id, expectedRevision, work => { Object.assign(work, checked); work.stage = 'intention'; work.brief = null; work.script = null; work.assets = []; });
    }
    setBrief(id, expectedRevision, brief) {
        string(brief, 8000);
        return this.change(id, expectedRevision, work => { work.brief = brief; work.stage = 'brief'; });
    }
    setScript(id, expectedRevision, script) {
        string(script, 16000);
        return this.change(id, expectedRevision, work => { requireValue(work.brief !== null, 'CREATION_BRIEF_REQUIRED'); work.script = script; work.stage = 'script'; });
    }
    setAssets(id, expectedRevision, references) {
        const checked = assetList(references);
        return this.change(id, expectedRevision, work => { work.assets = checked; work.stage = 'assets'; });
    }
    authority(work) {
        const authority = copy(this.dependencies.currentAuthority(copy(work)));
        revision(authority.policyRevision);
        revision(authority.accountRevision);
        revision(authority.contextRevision ?? 0);
        requireValue(authority.publishAllowed === true, 'CREATION_PUBLISH_NOT_AUTHORIZED');
        requireValue(Array.isArray(authority.sources) && authority.sources.length <= 64, 'CREATION_SOURCE_CHANGED');
        const stamps = authority.sources.map(source => {
            requireValue(source.publishAllowed === true, 'CREATION_SOURCE_REVOKED');
            return { id: source.id, revision: source.revision, personLinkRevision: source.personLinkRevision };
        });
        requireValue(stable(sources(stamps)) === stable(work.sources), 'CREATION_SOURCE_CHANGED');
        return authority;
    }
    verifyAssets(work, manifest) {
        const verify = (reference, kind) => {
            const actual = this.dependencies.resolveAsset(reference.ref);
            requireValue(actual && actual.ready === true && actual.ref === reference.ref && actual.sha256 === reference.sha256
                && actual.previewRef === reference.previewRef && (!kind || actual.kind === kind), 'CREATION_ASSET_NOT_READY');
        };
        if (manifest.video)
            verify(manifest.video, 'video');
        if (manifest.cover)
            verify(manifest.cover, 'image');
        manifest.audio.forEach(item => verify(item, 'audio'));
        manifest.subtitles.forEach(item => verify(item, 'subtitles'));
        manifest.attachments.forEach(item => verify(item));
        if (work.action === 'bili.video')
            requireValue(manifest.video && manifest.cover && manifest.audio.length > 0
                && manifest.subtitles.length > 0 && manifest.title.trim().length > 0, 'CREATION_FINAL_VIDEO_REQUIRED');
        else
            requireValue(manifest.text.trim().length > 0 || manifest.attachments.length > 0 || manifest.video !== null, 'CREATION_EMPTY_FINAL');
    }
    prepareFinal(id, expectedRevision, value) {
        const manifest = finalManifest(value);
        return this.store.atomic(tx => {
            const current = this.loaded(tx, id, expectedRevision);
            const work = copy(current.value);
            requireValue(work.submission === null, 'CREATION_ALREADY_SUBMITTED');
            requireValue(manifest.accountId === work.accountId && stable(manifest.target) === stable(work.target), 'CREATION_TARGET_CHANGED');
            if (work.review && work.review.decision !== 'revoked')
                requireValue(work.review.rejectedManifestHash !== hash(manifest), 'CREATION_REVISION_REQUIRED');
            this.verifyAssets(work, manifest);
            const authority = this.authority(work);
            requireValue(work.version < Number.MAX_SAFE_INTEGER, 'CREATION_VERSION_EXHAUSTED');
            work.version++;
            const base = { workId: work.id, action: work.action, version: work.version, manifest, sources: copy(work.sources), policyRevision: authority.policyRevision, accountRevision: authority.accountRevision, contextRevision: authority.contextRevision ?? 0 };
            work.final = { ...base, manifestHash: hash(base) };
            work.approval = null;
            work.review = null;
            work.stage = 'final-review';
            return tx.write(this.key(id), current.revision, work);
        });
    }
    async produce(id, expectedRevision) {
        requireValue(this.dependencies.productionProvider, 'CREATION_PROVIDER_MISSING');
        const current = this.read(id);
        requireValue(current && current.revision === expectedRevision, 'CREATION_REVISION_CONFLICT');
        requireValue(current.value.submission === null, 'CREATION_ALREADY_SUBMITTED');
        let result;
        try {
            result = await this.dependencies.productionProvider.produce(copy(current.value));
        }
        catch {
            throw new AgentError('CREATION_PRODUCTION_FAILED');
        }
        return this.prepareFinal(id, expectedRevision, result);
    }
    human(principal) { identifier(principal); requireValue(this.dependencies.authorizeHuman(principal) === true, 'CREATION_HUMAN_REQUIRED'); }
    currentFinal(work) {
        requireValue(!work.workflow || work.workflow.phase === 'ready', 'CREATION_WORKFLOW_NOT_READY');
        if (work.workflow) {
            let allowed = false;
            try {
                allowed = this.dependencies.validateWorkflow?.(copy(work)) === true;
            }
            catch { /* Unavailable authorization fails closed. */ }
            requireValue(allowed, 'CREATION_WORKFLOW_INVALID');
        }
        const final = work.final;
        requireValue(final && final.workId === work.id && final.action === work.action
            && final.version === work.version && snapshotHash(final) === final.manifestHash, 'CREATION_FINAL_REQUIRED');
        this.verifyAssets(work, final.manifest);
        const authority = this.authority(work);
        requireValue(final.accountRevision === authority.accountRevision && final.policyRevision === authority.policyRevision
            && final.contextRevision === (authority.contextRevision ?? 0), 'CREATION_AUTHORITY_CHANGED');
        return final;
    }
    approve(id, expectedRevision, principal, expiresAt) {
        this.human(principal);
        revision(expiresAt);
        return this.store.atomic(tx => {
            const current = this.loaded(tx, id, expectedRevision);
            const work = copy(current.value);
            requireValue(work.stage === 'final-review' && (!work.review || work.review.decision === 'revoked'), 'CREATION_FINAL_REQUIRED');
            const final = this.currentFinal(work);
            const now = this.dependencies.now();
            revision(now);
            requireValue(expiresAt > now, 'CREATION_APPROVAL_EXPIRED');
            work.approval = { principal, approvedAt: now, expiresAt, snapshotHash: final.manifestHash };
            work.stage = 'approved';
            return tx.write(this.key(id), current.revision, work);
        });
    }
    review(id, expectedRevision, principal, reason, decision) {
        this.human(principal);
        string(reason, 4000);
        return this.store.atomic(tx => {
            const current = this.loaded(tx, id, expectedRevision);
            const work = copy(current.value);
            requireValue(work.submission === null, 'CREATION_ALREADY_SUBMITTED');
            work.approval = null;
            work.stage = decision === 'rejected' ? 'rejected' : 'final-review';
            work.review = { decision, reason, principal, rejectedManifestHash: work.final ? hash(work.final.manifest) : work.review?.rejectedManifestHash ?? null };
            return tx.write(this.key(id), current.revision, work);
        });
    }
    reject(id, revision, principal, reason) { return this.review(id, revision, principal, reason, 'rejected'); }
    requestChanges(id, revision, principal, reason) { return this.review(id, revision, principal, reason, 'changes-requested'); }
    revoke(id, revision, principal, reason) { return this.review(id, revision, principal, reason, 'revoked'); }
    /** Outbox insertion and approval consumption share the caller's store transaction. Callback must not perform IO. */
    submit(id, expectedRevision, enqueue) {
        return this.store.atomic(tx => {
            const existing = tx.read(this.key(id));
            requireValue(existing, 'CREATION_NOT_FOUND');
            if (existing.value.submission)
                return { intentId: existing.value.submission.intentId, duplicate: true, work: existing };
            const current = this.loaded(tx, id, expectedRevision);
            const work = copy(current.value);
            const approval = work.approval;
            requireValue(work.stage === 'approved' && approval, 'CREATION_APPROVAL_REQUIRED');
            this.human(approval.principal);
            const now = this.dependencies.now();
            revision(now);
            requireValue(now < approval.expiresAt, 'CREATION_APPROVAL_EXPIRED');
            const final = this.currentFinal(work);
            requireValue(approval.snapshotHash === final.manifestHash, 'CREATION_APPROVAL_STALE');
            const intentId = enqueue(tx, copy({ ...final, workId: work.id, action: work.action, approval }));
            identifier(intentId);
            work.approval = null;
            work.submission = { intentId, state: 'queued', platformObjectId: null };
            work.stage = 'submission';
            return { intentId, duplicate: false, work: tx.write(this.key(id), current.revision, work) };
        });
    }
    recordOutcome(id, expectedRevision, state, platformObjectId) {
        requireValue(['unknown', 'accepted', 'pending-review', 'published', 'failed', 'removed'].includes(state));
        if (platformObjectId !== null)
            string(platformObjectId, 256);
        return this.store.atomic(tx => {
            const current = this.loaded(tx, id, expectedRevision);
            const work = copy(current.value);
            requireValue(work.submission, 'CREATION_NOT_SUBMITTED');
            requireValue(!['published', 'removed'].includes(work.submission.state) || state === 'removed', 'CREATION_OUTCOME_CONFLICT');
            work.submission.state = state;
            work.submission.platformObjectId = platformObjectId;
            return tx.write(this.key(id), current.revision, work);
        });
    }
    /** Revalidate the consumed human approval and immutable work again at the actual send boundary. */
    validateSubmission(snapshot, intentId) {
        const current = this.read(snapshot.workId);
        requireValue(current, 'CREATION_NOT_FOUND');
        const work = current.value;
        requireValue(work.submission?.intentId === intentId && work.submission.state === 'queued', 'CREATION_SUBMISSION_STALE');
        this.human(snapshot.approval.principal);
        requireValue(this.dependencies.now() < snapshot.approval.expiresAt, 'CREATION_APPROVAL_EXPIRED');
        const final = this.currentFinal(work);
        const { approval: _approval, ...savedFinal } = snapshot;
        void _approval;
        requireValue(final.manifestHash === snapshot.manifestHash && snapshot.approval.snapshotHash === final.manifestHash
            && stable(final) === stable(savedFinal), 'CREATION_APPROVAL_STALE');
    }
}
