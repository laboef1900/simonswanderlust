import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../src/auth.js';

describe('isAuthorized', () => {
  it('accepts the correct bearer token', () => {
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true);
  });
  it('rejects a wrong token', () => {
    expect(isAuthorized('Bearer nope', 'secret')).toBe(false);
  });
  it('rejects a missing header', () => {
    expect(isAuthorized(undefined, 'secret')).toBe(false);
  });
  it('rejects when no token is configured', () => {
    expect(isAuthorized('Bearer secret', '')).toBe(false);
  });
});
