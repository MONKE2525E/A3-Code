import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { managedMusePrompt } from "../museAgent/MuseAgentT3Skill.ts";
import { grokBotManagedPrompt } from "./Adapters/GrokBotManagedBinding.ts";
import { messageWithExecutionIdentity } from "./messageOrigin.ts";

it.each([
  { name: "Muse", prompt: managedMusePrompt },
  { name: "Grok Bot", prompt: grokBotManagedPrompt },
])("preserves sender and explicit remote routing in $name's native message", ({ prompt }) => {
  const environment: ExecutionEnvironmentDescriptor = {
    environmentId: EnvironmentId.make("test-linux-server"),
    label: "private-account-label",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    capabilities: { repositoryIdentity: true },
  };
  const message = messageWithExecutionIdentity(
    {
      text: "Work on my other machine",
      attachments: [],
      origin: { deviceType: "mobile", os: "iOS" },
    },
    environment,
  );
  const nativeText = prompt(message.text);
  expect(nativeText).toContain('"deviceType":"mobile","os":"iOS"');
  expect(nativeText).toContain('"environmentId":"test-linux-server"');
  expect(nativeText).toContain("Native provider tools may run elsewhere");
  expect(nativeText).toContain("pass that environmentId explicitly to delegate_task");
  expect(nativeText).not.toContain(environment.label);
});
