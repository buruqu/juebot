import {
  ALLOW, CoreError, channelKey, deny, isId, isQQId, isRecord, normalizeMessage,
  permissionsFor, requireCondition, snapshotPolicy,
} from './contracts.ts';
import type {
  CodeAuthorization, Conversation, CorePolicy, Gate, IdentityMode, InboundMessage,
  Permissions, TransportContext,
} from './contracts.ts';

/** In-process capabilities: copying an id or deserializing JSON does not recreate authority. */
export type InputTicket = Readonly<{ id: string }>;
export type TaskHandle = Readonly<{ id: string }>;
export type CodeDisplay = 'OFF' | 'ON' | 'DRAINING';
export type RouteResult =
  | Readonly<{ kind: 'rejected'; reason: string }>
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{ kind: 'control'; enabled: boolean; display: CodeDisplay }>
  | Readonly<{ kind: 'chat'; message: InboundMessage; identityMode: IdentityMode; permissions: Permissions }>
  | Readonly<{ kind: 'code-input'; ticket: InputTicket; message: InboundMessage; learningAllowed: false }>;

type Admission = {
  message: InboundMessage;
  adminEpoch: number;
  admissionEpoch: number;
  botId: string;
  connectionId: string;
  authorization: CodeAuthorization;
};
type Task = Admission & { id: string; status: 'running' | 'completed' | 'stopped' };
const rejected = (reason: string): RouteResult => ({ kind: 'rejected', reason });

/**
 * OFFLINE PROTOTYPE ONLY. No sockets, models, files, timers, tools or DSH services.
 * Host configuration methods must never be exposed directly to QQ or model tools.
 * Routing tickets are not durable accepted/queued jobs. There is deliberately no queue
 * or recovery policy here (Q006/Q007 remain Open). The future host must commit a real
 * task identity and execution authorization transactionally before executing a task.
 */
export class JuebotCore {
  #policy: CorePolicy;
  #identityMode: IdentityMode = 'juejue';
  #admin: { id: string; verified: boolean } | undefined;
  #adminEpoch = 0;
  #authorization: CodeAuthorization | undefined;
  #enabled = false;
  #admissionEpoch = 0;
  #serial = 0;
  #seen = new Set<string>();
  #dedupeCapacity: number;
  #tickets = new WeakMap<InputTicket, Admission>();
  #tasks = new WeakMap<TaskHandle, Task>();
  #running = new Set<Task>();

  constructor(policy: CorePolicy, dedupeCapacity = 10000) {
    this.#policy = snapshotPolicy(policy);
    requireCondition(Number.isSafeInteger(dedupeCapacity) && dedupeCapacity > 0 && dedupeCapacity <= 100000, 'INVALID_DEDUPE_CAPACITY');
    this.#dedupeCapacity = dedupeCapacity;
  }

  get display(): CodeDisplay {
    return this.#enabled ? 'ON' : this.#running.size > 0 ? 'DRAINING' : 'OFF';
  }
  get runningTaskCount(): number { return this.#running.size; }

  setIdentityMode(mode: IdentityMode): void {
    requireCondition(mode === 'juejue' || mode === 'persona', 'INVALID_IDENTITY_MODE');
    this.#identityMode = mode;
  }

  /** A trusted binding service must supply the verified result; this is not a binding flow. */
  configureAdmin(id: string | undefined, verified = false): void {
    requireCondition(id === undefined || (isQQId(id) && id !== this.#policy.botId), 'INVALID_ADMIN_ID');
    requireCondition(typeof verified === 'boolean', 'INVALID_BINDING_STATE');
    this.#admin = id === undefined ? undefined : { id, verified };
    this.#adminEpoch += 1;
    this.closeAdmission();
    // Existing task objects remain for audit; epoch checks deny old execution/delivery.
    // This is an explicit binding change, never the semantics of ordinary Code OFF.
  }

  replacePolicy(policy: CorePolicy): void {
    const next = snapshotPolicy(policy);
    if (next.botId !== this.#policy.botId || next.connectionId !== this.#policy.connectionId) {
      // Rebinding a different transport/account needs fresh administrator verification.
      this.#admin = undefined;
      this.#adminEpoch += 1;
      this.closeAdmission();
    }
    this.#policy = next;
  }

  configureCode(authorization: CodeAuthorization | undefined): void {
    if (authorization === undefined) { this.#authorization = undefined; return; }
    requireCondition(isRecord(authorization) && isId(authorization.id)
      && isId(authorization.sessionId) && typeof authorization.workspace === 'string'
      && authorization.workspace.trim().length > 0 && authorization.workspace.length <= 4096
      && !/[\u0000-\u001f\u007f]/u.test(authorization.workspace), 'INVALID_CODE_AUTHORIZATION');
    requireCondition(['modelConfigured', 'budgetAvailable', 'sandboxVerified', 'toolsRestricted']
      .every(key => typeof authorization[key as keyof CodeAuthorization] === 'boolean'), 'INVALID_CODE_CHECKS');
    this.#authorization = Object.freeze({
      id: authorization.id, workspace: authorization.workspace, sessionId: authorization.sessionId,
      modelConfigured: authorization.modelConfigured, budgetAvailable: authorization.budgetAvailable,
      sandboxVerified: authorization.sandboxVerified, toolsRestricted: authorization.toolsRestricted,
    });
  }

  #ready(): Gate {
    const a = this.#authorization;
    if (!this.#admin?.verified) return deny('ADMIN_NOT_VERIFIED');
    if (!a) return deny('CODE_NOT_CONFIGURED');
    if (!a.modelConfigured) return deny('MODEL_NOT_CONFIGURED');
    if (!a.budgetAvailable) return deny('BUDGET_UNAVAILABLE');
    if (!a.sandboxVerified || !a.toolsRestricted) return deny('TOOL_POLICY_NOT_VERIFIED');
    return ALLOW;
  }

  #codeChannel(channel: Conversation): Gate {
    const p = permissionsFor(this.#policy, channel);
    if (channel.kind !== 'private' || channel.id !== this.#admin?.id) return deny('ADMIN_PRIVATE_ONLY');
    if (!p?.receive || !p.save || !p.send) return deny('CODE_CHANNEL_NOT_AUTHORIZED');
    return ALLOW;
  }

  /** Trusted management API, not a public UI endpoint. UI authentication is not implemented. */
  openAdmission(): Gate {
    const ready = this.#ready();
    if (!ready.allowed) return ready;
    const channel = this.#codeChannel({ kind: 'private', id: this.#admin!.id });
    if (!channel.allowed) return channel;
    if (this.#seen.size >= this.#dedupeCapacity) return deny('DEDUPE_CAPACITY');
    if (!this.#enabled) { this.#enabled = true; this.#admissionEpoch += 1; }
    return ALLOW;
  }

  /** D008: do not touch running tasks, task capabilities, budgets, or their result routes. */
  closeAdmission(): void {
    if (this.#enabled) { this.#enabled = false; this.#admissionEpoch += 1; }
  }

  route(transport: TransportContext, rawMessage: unknown): RouteResult {
    if (!isRecord(transport) || transport.connectionId !== this.#policy.connectionId
      || transport.selfId !== this.#policy.botId) return rejected('UNTRUSTED_TRANSPORT');
    const message = normalizeMessage(rawMessage);
    if (!message) return rejected('MALFORMED_MESSAGE');
    if (message.senderId === this.#policy.botId) return rejected('SELF_ECHO');
    const permissions = permissionsFor(this.#policy, message.conversation);
    if (!permissions?.receive) return rejected('CHANNEL_NOT_AUTHORIZED');
    if (!this.#admin?.verified) return rejected('ADMIN_NOT_VERIFIED');
    const eventKey = JSON.stringify([transport.connectionId, transport.selfId, channelKey(message.conversation), message.eventId]);
    if (this.#seen.has(eventKey)) return { kind: 'duplicate' };
    if (this.#seen.size >= this.#dedupeCapacity) {
      // Never evict old control ids and accidentally execute a replayed ON command.
      // Exhaustion closes new admission, but does not stop existing work (D008).
      this.closeAdmission();
      return rejected('DEDUPE_CAPACITY');
    }
    this.#seen.add(eventKey);
    const isCommand = message.form === 'plain' && (message.text === '/开启code' || message.text === '/关闭code');
    if (isCommand) {
      if (message.senderId !== this.#admin.id || message.conversation.kind !== 'private') return rejected('ADMIN_PRIVATE_ONLY');
      if (message.text === '/关闭code') this.closeAdmission();
      else {
        const gate = this.openAdmission();
        if (!gate.allowed) return rejected(gate.reason);
      }
      return { kind: 'control', enabled: this.#enabled, display: this.display };
    }
    if (this.#enabled && message.senderId === this.#admin.id && message.conversation.kind === 'private') {
      const ready = this.#ready();
      if (!ready.allowed) return rejected(ready.reason);
      const channel = this.#codeChannel(message.conversation);
      if (!channel.allowed) return rejected(channel.reason);
      const ticket = Object.freeze({ id: `input-${++this.#serial}` });
      this.#tickets.set(ticket, {
        message, adminEpoch: this.#adminEpoch, admissionEpoch: this.#admissionEpoch,
        botId: this.#policy.botId, connectionId: this.#policy.connectionId,
        authorization: this.#authorization!,
      });
      return { kind: 'code-input', ticket, message, learningAllowed: false };
    }
    return { kind: 'chat', message, identityMode: this.#identityMode, permissions };
  }

  #sameAuthorization(admission: Admission): boolean {
    const a = this.#authorization;
    return !!a && a.id === admission.authorization.id
      && a.workspace === admission.authorization.workspace && a.sessionId === admission.authorization.sessionId;
  }

  beginTask(ticket: InputTicket): TaskHandle {
    const admission = this.#tickets.get(ticket);
    requireCondition(admission, 'UNKNOWN_OR_CONSUMED_TICKET');
    requireCondition(this.#enabled && admission.admissionEpoch === this.#admissionEpoch, 'STALE_ADMISSION');
    requireCondition(admission.adminEpoch === this.#adminEpoch, 'ADMIN_AUTHORIZATION_CHANGED');
    requireCondition(this.#sameAuthorization(admission), 'CODE_AUTHORIZATION_CHANGED');
    const ready = this.#ready();
    if (!ready.allowed) throw new CoreError(ready.reason);
    const channel = this.#codeChannel(admission.message.conversation);
    if (!channel.allowed) throw new CoreError(channel.reason);
    requireCondition(this.#running.size < 100, 'ACTIVE_TASK_CAPACITY');
    const handle = Object.freeze({ id: `task-${++this.#serial}` });
    const task: Task = { ...admission, id: handle.id, status: 'running' };
    this.#tickets.delete(ticket);
    this.#tasks.set(handle, task);
    this.#running.add(task);
    return handle;
  }

  #ownerStillAuthorized(task: Task): Gate {
    if (!this.#admin?.verified || task.adminEpoch !== this.#adminEpoch
      || task.message.senderId !== this.#admin.id) return deny('ADMIN_AUTHORIZATION_CHANGED');
    if (task.botId !== this.#policy.botId || task.connectionId !== this.#policy.connectionId) return deny('TRANSPORT_CHANGED');
    return this.#codeChannel(task.message.conversation);
  }

  /** Future tool guards also need real per-call scope, stop, filesystem and budget checks. */
  executionGate(handle: TaskHandle): Gate {
    const task = this.#tasks.get(handle);
    if (!task) return deny('UNKNOWN_TASK');
    if (task.status !== 'running') return deny('TASK_NOT_RUNNING');
    const owner = this.#ownerStillAuthorized(task);
    if (!owner.allowed) return owner;
    if (!this.#sameAuthorization(task)) return deny('CODE_AUTHORIZATION_CHANGED');
    // Deliberately no #enabled/admissionEpoch check: closing admission is not revocation.
    return this.#ready();
  }

  completeTask(handle: TaskHandle): void {
    const task = this.#tasks.get(handle);
    requireCondition(task, 'UNKNOWN_TASK');
    if (task.status === 'completed') return;
    requireCondition(task.status === 'running', 'TASK_NOT_RUNNING');
    task.status = 'completed';
    this.#running.delete(task);
  }

  /** Explicit stop is a separate control operation, never called by closeAdmission(). */
  stopTask(handle: TaskHandle): void {
    const task = this.#tasks.get(handle);
    requireCondition(task && task.status === 'running', 'TASK_NOT_RUNNING');
    task.status = 'stopped';
    this.#running.delete(task);
  }

  resultDestination(handle: TaskHandle):
    | Readonly<{ allowed: false; reason: string }>
    | Readonly<{ allowed: true; taskId: string; conversation: Conversation }> {
    const task = this.#tasks.get(handle);
    if (!task || task.status !== 'completed') return { allowed: false, reason: 'RESULT_NOT_READY' };
    const owner = this.#ownerStillAuthorized(task);
    if (!owner.allowed) return owner;
    if (!this.#sameAuthorization(task)) return { allowed: false, reason: 'CODE_AUTHORIZATION_CHANGED' };
    // Budget availability is not required to deliver an already completed result.
    // This is a destination decision, NOT a send operation, delivery receipt or Outbox.
    return { allowed: true, taskId: task.id, conversation: task.message.conversation };
  }
}
