import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFirstUnclosedCandidate } from './reconcile-prepare.js';

test('pickFirstUnclosedCandidate skips CLOSED dates and picks earliest open', () => {
  const closed = new Set(['2026-01-31', '2026-01-18']);
  const picked = pickFirstUnclosedCandidate(
    ['2026-02-28', '2026-01-31', '2026-01-18', '2026-02-06'],
    closed
  );
  assert.equal(picked, '2026-02-06');
});

test('pickFirstUnclosedCandidate returns first target when nothing closed', () => {
  const picked = pickFirstUnclosedCandidate(
    ['2026-01-18', '2026-02-28'],
    new Set()
  );
  assert.equal(picked, '2026-01-18');
});

test('pickFirstUnclosedCandidate falls back to last candidate when all closed', () => {
  const closed = new Set(['2026-01-18', '2026-02-28']);
  const picked = pickFirstUnclosedCandidate(['2026-01-18', '2026-02-28'], closed);
  assert.equal(picked, '2026-02-28');
});
