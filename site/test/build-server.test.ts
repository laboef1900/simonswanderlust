import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../build-server.mjs';

describe('build-server isAuthorized', () => {
  it('accepts the matching secret and rejects others/empty', () => {
    expect(isAuthorized('s3cret', 's3cret')).toBe(true);
    expect(isAuthorized('nope', 's3cret')).toBe(false);
    expect(isAuthorized(undefined, 's3cret')).toBe(false);
    expect(isAuthorized('s3cret', '')).toBe(false);
  });
});
