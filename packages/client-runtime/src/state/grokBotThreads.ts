/**
 * Threads the server opens as a Grok Bot's own work surface. They live in no project and
 * stay out of ordinary thread lists; the bot dropdown still reads them directly for activity.
 *
 * The predicate lives in contracts so server and clients share one marker. Legacy threads
 * under a managed Grok Bot instance look like ordinary provider threads, so they stay visible
 * until the server migrates them.
 */
export { isGrokBotBackingThread } from "@t3tools/contracts";
