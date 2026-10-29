import type { SiteBuilder } from '../src/build.js';

/** Routes unrelated to build history share an explicitly empty status record. */
export const idleBuildState: Pick<SiteBuilder, 'initialize' | 'status'> = {
  initialize: async () => {},
  status: async () => ({ live: null, running: null, last: null, record: 'missing' }),
};
