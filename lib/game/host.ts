export interface HostCandidate {
  uid: string;
  /** Unix seconds when the member joined the group (CometChat `joinedAt`). */
  joinedAt: number;
  online: boolean;
}

/**
 * The host is the oldest member (earliest joinedAt) who is currently online.
 * Ties break on uid. Every client sees the same membership + presence, so every
 * client elects the same host without coordination. Pooled bots never hold a
 * socket, so they are never online and never elected.
 */
export function electHost(members: HostCandidate[]): string | null {
  const online = members.filter((m) => m.online);
  if (online.length === 0) return null;
  online.sort((a, b) => a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid));
  return online[0].uid;
}
