/**
 * Commit/reveal for the secret bot roster.
 *
 * At round start the server publishes sha256(input) where input binds the round id,
 * the sorted bot uids and a secret salt. At reveal it publishes the uids and salt, and
 * every client recomputes the hash. The host cannot have changed who was a bot mid-round.
 */
export function commitmentInput(roundId: string, botUids: string[], salt: string): string {
  return `nab:v1|${roundId}|${[...botUids].sort().join(",")}|${salt}`;
}

export async function sha256HexWeb(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyCommitment(
  commitment: string,
  roundId: string,
  botUids: string[],
  salt: string,
): Promise<boolean> {
  return (await sha256HexWeb(commitmentInput(roundId, botUids, salt))) === commitment;
}
