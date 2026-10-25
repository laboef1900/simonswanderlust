import { tsImport } from 'tsx/esm/api';

// This bootstrap must establish the TS/.js-resolution loader before loading
// application modules. Static imports cannot run after that initialization;
// inherited tsx/Vitest execArgv are deliberately not the worker's contract.
await tsImport('./gpx-worker-main.ts', import.meta.url);
