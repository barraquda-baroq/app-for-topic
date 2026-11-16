// scripts/lib/samplesOut.mjs の型（e2e/samples/samples.spec.ts が TypeScript から読むため。中身は samplesOut.mjs）
export declare const REPO_ROOT: string
export declare const DEFAULT_SAMPLES_OUT: string
export declare function samplesOutDir(env?: Record<string, string | undefined>, root?: string): string
export declare function samplesPartsDir(env?: Record<string, string | undefined>, root?: string): string
