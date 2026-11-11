import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, similarity, findSimilar, trendingScore } from '../src/similar.js';

test('tokens: lowercases, strips stopwords, accents and plural s', () => {
  const t = tokens('Please add Dark Modes for the Dashböard');
  assert.deepEqual([...t].sort(), ['dark', 'dashboard', 'mode']);
});

test('tokens: drops single characters', () => {
  assert.deepEqual([...tokens('a b c xy')], ['xy']);
});

test('similarity: identical = 1, disjoint = 0, empty = 0', () => {
  assert.equal(similarity('dark mode', 'dark mode'), 1);
  assert.equal(similarity('dark mode', 'export csv'), 0);
  assert.equal(similarity('', 'dark mode'), 0);
});

test('similarity: partial overlap between 0 and 1', () => {
  const s = similarity('dark mode', 'dark mode for dashboard');
  assert.ok(s > 0.5 && s < 1, String(s));
});

test('findSimilar: ranks, filters by threshold, limits', () => {
  const posts = [
    { id: 1, title: 'Dark mode for dashboard' },
    { id: 2, title: 'CSV export' },
    { id: 3, title: 'Dark theme' },
  ];
  const hits = findSimilar('dashboard dark mode', posts);
  assert.equal(hits[0].id, 1);
  assert.ok(!hits.some((h) => h.id === 2));
  assert.equal(findSimilar('dark', posts, { limit: 1 }).length, 1);
});

test('trendingScore: newer beats older at equal votes; more votes beats fewer', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  const fresh = trendingScore(5, '2026-01-09T23:00:00Z', now);
  const old = trendingScore(5, '2026-01-01T00:00:00Z', now);
  assert.ok(fresh > old);
  assert.ok(trendingScore(10, '2026-01-09T00:00:00Z', now) > trendingScore(1, '2026-01-09T00:00:00Z', now));
});

test('trendingScore: future dates clamp to age 0', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(trendingScore(0, '2026-02-01T00:00:00Z', now), 1 / Math.pow(2, 1.5));
});
