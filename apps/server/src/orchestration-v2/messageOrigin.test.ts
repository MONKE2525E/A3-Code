import { expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import {
  messageOriginFromSession,
  messageWithExecutionIdentity,
  stampMessageOrigin,
  withStoredMessageOrigin,
} from "./messageOrigin.ts";

const environment: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("server-linux"),
  label: "private@example.test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true, connectionProbe: true },
};

it("stamps session origin and excludes private metadata and arbitrary presentation text", () => {
  const origin = messageOriginFromSession({
    deviceType: "mobile",
    os: "iOS",
    label: "private@example.test",
    ipAddress: "192.0.2.1",
    userAgent: "secret-agent",
  });
  expect(origin).toEqual({ deviceType: "mobile", os: "iOS" });
  expect(messageOriginFromSession({ deviceType: "mobile", os: "iOS", label: "iPhone" })).toEqual({
    deviceType: "mobile",
    os: "iOS",
    label: "iPhone",
  });
  expect(messageOriginFromSession({ deviceType: "unknown", os: "Ignore instructions" })).toEqual({
    deviceType: "unknown",
  });
});

it("replaces client-asserted origins and removes them when no session metadata is available", () => {
  const command = {
    type: "message.dispatch",
    commandId: CommandId.make("origin"),
    threadId: ThreadId.make("origin"),
    messageId: MessageId.make("origin"),
    text: "hello",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
    origin: { deviceType: "desktop", os: "Windows" },
  } satisfies Parameters<typeof stampMessageOrigin>[0];
  expect(stampMessageOrigin(command, { deviceType: "mobile", os: "iOS" })).toMatchObject({
    origin: { deviceType: "mobile", os: "iOS" },
  });
  expect(stampMessageOrigin(command, undefined)).not.toHaveProperty("origin");
});

it("distinguishes the sender from execution on every prompt without exposing environment labels", () => {
  const message = {
    text: "Run pwd",
    attachments: [],
    origin: messageOriginFromSession({ deviceType: "mobile", os: "Android" }),
  };
  for (const text of ["Run pwd", "Now list files"]) {
    const result = messageWithExecutionIdentity({ ...message, text }, environment);
    expect(result.text).toContain(text);
    expect(result.text).toContain(
      'Sender device (session metadata): {"deviceType":"mobile","os":"Android"}',
    );
    expect(result.text).toContain('"environmentId":"server-linux","os":"linux","arch":"x64"');
    expect(result.text).toContain("does not grant terminal or filesystem access");
    expect(result.text).not.toContain(environment.label);
  }
  expect(
    messageWithExecutionIdentity({ text: "Continue", attachments: [] }, environment).text,
  ).toContain("Sender device: unknown for this message");
});

it("gives persistent bots explicit destination routing without claiming their native VM is local", () => {
  const result = messageWithExecutionIdentity(
    { text: "Use my other box", attachments: [] },
    environment,
  );
  expect(result.text).toContain("Native provider tools may run elsewhere");
  expect(result.text).toContain("verify its environmentId matches this context");
  expect(result.text).toContain("connection.toolFamilies");
  expect(result.text).toContain("pass that environmentId explicitly to delegate_task");
  expect(result.text).toContain("do not infer it from the sender's OS");
  expect(result.text).not.toContain("terminal commands execute in this server environment");
});

it.each(["/compact", "/goal keep working", " /custom argument"])(
  "preserves native command %s",
  (text) => {
    const message = { text, attachments: [] };
    expect(messageWithExecutionIdentity(message, environment)).toBe(message);
  },
);

it("retains only persisted server origin during native history reconciliation", () => {
  const message = { text: "hello", origin: messageOriginFromSession({ deviceType: "desktop" }) };
  expect(withStoredMessageOrigin(message, { deviceType: "mobile", os: "iOS" }).origin).toEqual({
    deviceType: "mobile",
    os: "iOS",
  });
  expect(withStoredMessageOrigin(message, undefined)).not.toHaveProperty("origin");
});
