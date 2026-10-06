/**
 * Pure bot-seat assignment: pick `needed` pool bots that are not already in the room
 * and whose names don't collide with anyone seated (a duplicate name is a tell).
 */
export interface PoolBot {
  uid: string;
  name: string;
}

export function pickBots(
  pool: PoolBot[],
  seated: { uid: string; name: string }[],
  needed: number,
  random: () => number = Math.random,
): PoolBot[] {
  if (needed <= 0) return [];
  const seatedUids = new Set(seated.map((s) => s.uid));
  const takenNames = new Set(seated.map((s) => s.name.trim().toLowerCase().split(/\s|_/)[0]));
  const candidates = pool.filter(
    (b) => !seatedUids.has(b.uid) && !takenNames.has(b.name.trim().toLowerCase().split(/\s|_/)[0]),
  );
  // Fisher–Yates with injected RNG so tests are deterministic.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, needed);
}

export function isPoolBot(uid: string, poolUids: ReadonlySet<string>): boolean {
  return poolUids.has(uid);
}
