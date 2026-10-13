/**
 * Muse threads are keyed by the account's canonical identity. Main chat is that identity alone; each
 * side chat appends its native session id, percent-encoded so the id never contains a colon.
 */
const CANONICAL_THREAD = /^muse-agent:([0-9a-f]{64})$/;
const SESSION_THREAD = /^muse-agent:([0-9a-f]{64}):([^:]+)$/;

/** The thread id for a Muse conversation: Main chat when `sessionId` is absent. */
export function museThreadIdForSession(identity: string, sessionId?: string): string {
  return sessionId === undefined
    ? `muse-agent:${identity}`
    : `muse-agent:${identity}:${encodeURIComponent(sessionId)}`;
}

/** The account identity a Muse thread belongs to, or null for any other thread. */
export function museIdentityOfThread(threadId: string): string | null {
  return CANONICAL_THREAD.exec(threadId)?.[1] ?? SESSION_THREAD.exec(threadId)?.[1] ?? null;
}

/** The native session a Muse thread is bound to, or undefined for Main chat (the primary session). */
export function museSessionOfThread(threadId: string): string | undefined {
  const session = SESSION_THREAD.exec(threadId)?.[2];
  return session === undefined ? undefined : decodeURIComponent(session);
}
