import type { PostStore, PublishTokens } from '../src/posts.js';

/** Test setup only: capture a deliberate current review before publishing. */
export async function publishTokens(store: PostStore, tk: string): Promise<PublishTokens> {
  const state = await store.getPublishState(tk);
  if (!state) throw new Error('Missing publish fixture');
  return { baseUpdatedAt: state.pair.updatedAt, baseRouteVersion: state.routeVersion };
}

export async function publishBody(store: PostStore, tk: string) {
  const tokens = await publishTokens(store, tk);
  return { ...tokens, baseUpdatedAt: tokens.baseUpdatedAt.toISOString() };
}
