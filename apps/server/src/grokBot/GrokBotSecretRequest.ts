/**
 * Secret questions in the Grok Bot transcript: `{id, kind:"send-message", message:{type:
 * "secret-request", secretRequest:{label, target:{kind, name, ...}}}}`. `label`, `target` and
 * `secretProvided` are verified against the desktop bundle; the description is read from likely
 * keys. Only what the user needs to choose a request is kept: no target name, never a value.
 */

export interface GrokBotSecretRequest {
  readonly entryId: string;
  readonly title: string;
  readonly description: string | undefined;
  /** `responded` once native has recorded an answer on the entry. */
  readonly state: "pending" | "responded";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : undefined;

export function decodeGrokBotSecretRequest(value: unknown): GrokBotSecretRequest | undefined {
  if (!isRecord(value) || value.kind !== "send-message") return undefined;
  if (!isRecord(value.message) || value.message.type !== "secret-request") return undefined;
  const request = value.message.secretRequest;
  if (!isRecord(request) || !isRecord(request.target)) return undefined;
  const entryId = text(value.id, 1024);
  const title = text(request.label, 1024);
  if (entryId === undefined || title === undefined) return undefined;
  // The desktop card marks an answered secure input with `secretProvided`; it has no dismissal.
  const answered = value.secretProvided === true;
  return {
    entryId,
    title,
    description: text(request.description, 4096) ?? text(request.reason, 4096),
    state: answered ? "responded" : "pending",
  };
}

/** Every secret request in a transcript tail, newest entry last as the transcript is ordered. */
export const secretRequestsIn = (entries: readonly unknown[]): readonly GrokBotSecretRequest[] =>
  entries.flatMap((entry) => {
    const request = decodeGrokBotSecretRequest(entry);
    return request === undefined ? [] : [request];
  });
