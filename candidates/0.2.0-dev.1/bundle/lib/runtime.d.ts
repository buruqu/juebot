import type { CodeAuthorization, Conversation, CorePolicy, Gate, IdentityMode, InboundMessage, Permissions, TransportContext } from './contracts.ts';
/** In-process capabilities: copying an id or deserializing JSON does not recreate authority. */
export type InputTicket = Readonly<{
    id: string;
}>;
export type TaskHandle = Readonly<{
    id: string;
}>;
export type CodeDisplay = 'OFF' | 'ON' | 'DRAINING';
export type RouteResult = Readonly<{
    kind: 'rejected';
    reason: string;
}> | Readonly<{
    kind: 'duplicate';
}> | Readonly<{
    kind: 'control';
    enabled: boolean;
    display: CodeDisplay;
}> | Readonly<{
    kind: 'chat';
    message: InboundMessage;
    identityMode: IdentityMode;
    permissions: Permissions;
}> | Readonly<{
    kind: 'code-input';
    ticket: InputTicket;
    message: InboundMessage;
    learningAllowed: false;
}>;
/**
 * OFFLINE PROTOTYPE ONLY. No sockets, models, files, timers, tools or DSH services.
 * Host configuration methods must never be exposed directly to QQ or model tools.
 * Routing tickets are not durable accepted/queued jobs. There is deliberately no queue
 * or recovery policy here (Q006/Q007 remain Open). The future host must commit a real
 * task identity and execution authorization transactionally before executing a task.
 */
export declare class JuebotCore {
    #private;
    constructor(policy: CorePolicy, dedupeCapacity?: number);
    get display(): CodeDisplay;
    get runningTaskCount(): number;
    setIdentityMode(mode: IdentityMode): void;
    /** A trusted binding service must supply the verified result; this is not a binding flow. */
    configureAdmin(id: string | undefined, verified?: boolean): void;
    replacePolicy(policy: CorePolicy): void;
    configureCode(authorization: CodeAuthorization | undefined): void;
    /** Trusted management API, not a public UI endpoint. UI authentication is not implemented. */
    openAdmission(): Gate;
    /** D008: do not touch running tasks, task capabilities, budgets, or their result routes. */
    closeAdmission(): void;
    route(transport: TransportContext, rawMessage: unknown): RouteResult;
    beginTask(ticket: InputTicket): TaskHandle;
    /** Future tool guards also need real per-call scope, stop, filesystem and budget checks. */
    executionGate(handle: TaskHandle): Gate;
    completeTask(handle: TaskHandle): void;
    /** Explicit stop is a separate control operation, never called by closeAdmission(). */
    stopTask(handle: TaskHandle): void;
    resultDestination(handle: TaskHandle): Readonly<{
        allowed: false;
        reason: string;
    }> | Readonly<{
        allowed: true;
        taskId: string;
        conversation: Conversation;
    }>;
}
