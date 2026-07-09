// Minimal shim. usfm-js ships no .d.ts; the surface we use client-side is just
// toUSFM (and toJSON in tests). Anything beyond that is untyped any. Mirrors
// api/src/usfm-js.d.ts.
declare module "usfm-js" {
  interface ToUsfmOptions {
    forcedNewLines?: boolean;
    [key: string]: unknown;
  }
  interface UsfmModule {
    toJSON(raw: string, options?: Record<string, unknown>): {
      headers?: unknown[];
      chapters?: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    };
    toUSFM(input: { chapters: Record<string, unknown>; headers?: unknown[] }, options?: ToUsfmOptions): string;
  }
  const usfm: UsfmModule;
  export default usfm;
}
