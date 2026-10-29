export declare class AgentError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function ensure(ok: unknown, code?: string): asserts ok;
export declare function text(value: unknown, max?: number): asserts value is string;
export declare function integer(value: unknown, min?: number, max?: number): asserts value is number;
export declare function clone<T>(value: T): T;
export declare function plain(value: unknown, keys?: readonly string[]): asserts value is Record<string, unknown>;
/** Stable JSON is a comparison representation, never a cryptographic signature or permission. */
export declare function stable(value: unknown, depth?: number): string;
