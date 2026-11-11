// Lightweight duplicate detection: token-set similarity on titles.
// Good enough to stop "dark mode" being filed ten times; no ML dependency.

const STOP = new Set(
  ('a an the and or of to in on for with is are be it this that please add ' +
    'support allow can could would should i we you my our der die das und oder ' +
    'ein eine zu mit für ist bitte im in von').split(' '),
);

export function tokens(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
      .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t)),
  );
}

export function similarity(a, b) {
  const A = a instanceof Set ? a : tokens(a);
  const B = b instanceof Set ? b : tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  // Overlap coefficient weighted towards Jaccard: robust for short queries.
  const jaccard = inter / (A.size + B.size - inter);
  const overlap = inter / Math.min(A.size, B.size);
  return 0.5 * jaccard + 0.5 * overlap;
}

export function findSimilar(query, posts, { threshold = 0.34, limit = 5 } = {}) {
  const q = tokens(query);
  return posts
    .map((p) => ({ ...p, score: similarity(q, `${p.title}`) }))
    .filter((p) => p.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Hacker-News style decay: fresh posts with momentum rise. */
export function trendingScore(votes, createdAtIso, now = Date.now()) {
  const ageHours = Math.max(0, (now - Date.parse(createdAtIso)) / 3.6e6);
  return (votes + 1) / Math.pow(ageHours + 2, 1.5);
}
