/* tslint:disable */
/* eslint-disable */

export class WatchPartySyncEngine {
    free(): void;
    [Symbol.dispose](): void;
    get_status(): string;
    ingest_master_state(state: any): any;
    ingest_schedule(event: any): any;
    constructor();
    reset(): void;
    set_mode(mode: string): any;
    tick(snapshot: any): any;
    update_clock_offset(result: any): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_watchpartysyncengine_free: (a: number, b: number) => void;
    readonly watchpartysyncengine_get_status: (a: number) => [number, number];
    readonly watchpartysyncengine_ingest_master_state: (a: number, b: any) => [number, number, number];
    readonly watchpartysyncengine_ingest_schedule: (a: number, b: any) => [number, number, number];
    readonly watchpartysyncengine_new: () => number;
    readonly watchpartysyncengine_reset: (a: number) => void;
    readonly watchpartysyncengine_set_mode: (a: number, b: number, c: number) => [number, number, number];
    readonly watchpartysyncengine_tick: (a: number, b: any) => [number, number, number];
    readonly watchpartysyncengine_update_clock_offset: (a: number, b: any) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
