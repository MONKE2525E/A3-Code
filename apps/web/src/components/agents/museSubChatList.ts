const SIDE_CHAT_THREAD_ID = /^muse-agent:[0-9a-f]{64}:.+$/;

export interface MuseSubChatCandidate {
  readonly id: string;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly archivedAt: unknown;
  readonly pinnedAt?: unknown;
}

export interface MuseSubChatEntry {
  readonly id: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly active: boolean;
}

export interface MuseSubChatList {
  /** Pinned side chats first, then the open side chat when it is not pinned. */
  readonly pinned: ReadonlyArray<MuseSubChatEntry>;
  /** The open side chat when it is unpinned; it gets the connector. */
  readonly open: MuseSubChatEntry | null;
}

/** Main chat is never a sub-chat; only side-chat thread ids qualify. */
export function isMuseSideChatThreadId(threadId: string): boolean {
  return SIDE_CHAT_THREAD_ID.test(threadId);
}

/**
 * Which side chats the sidebar lists under the Muse row: every pinned one, plus the open one
 * while it is unpinned. Other unpinned chats stay in the row's menu.
 */
export function resolveMuseSubChatList(input: {
  readonly threads: ReadonlyArray<MuseSubChatCandidate>;
  readonly providerInstanceId: string;
  readonly routeThreadId: string | null;
}): MuseSubChatList {
  const sideChats = input.threads.filter(
    (thread) =>
      thread.providerInstanceId === input.providerInstanceId &&
      thread.archivedAt === null &&
      isMuseSideChatThreadId(thread.id),
  );
  const toEntry = (thread: MuseSubChatCandidate): MuseSubChatEntry => ({
    id: thread.id,
    title: thread.title.trim() || "Untitled conversation",
    pinned: thread.pinnedAt != null,
    active: thread.id === input.routeThreadId,
  });
  const pinned = sideChats.filter((thread) => thread.pinnedAt != null).map(toEntry);
  const openThread = sideChats.find(
    (thread) => thread.id === input.routeThreadId && thread.pinnedAt == null,
  );
  return { pinned, open: openThread ? toEntry(openThread) : null };
}

export interface MuseConnectorGeometry {
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Path from the avatar's bottom-centre straight down, then one quarter-curve into the left edge of
 * the open row's text. Coordinates are relative to the SVG's top-left, which sits at the avatar's
 * bottom-centre. The radius shrinks when the available space is smaller than the preferred one.
 */
export function museConnectorGeometry(input: {
  /** Distance down to the open row's vertical centre. */
  readonly dy: number;
  /** Distance right to the open row's text left edge. */
  readonly dx: number;
  readonly radius?: number;
}): MuseConnectorGeometry {
  const dy = Math.max(input.dy, 0);
  const dx = Math.max(input.dx, 0);
  const r = Math.min(input.radius ?? 17, dy, dx);
  const path = `M 0 0 V ${dy - r} Q 0 ${dy} ${r} ${dy} H ${dx}`;
  return { path, width: dx, height: dy };
}
