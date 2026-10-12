import { EnvironmentId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Button } from "~/components/ui/button";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const commands = vi.hoisted(() => ({
  canManage: true,
  recreate: { permissionAtom: () => "recreate-permission" },
  reset: { permissionAtom: () => "reset-permission" },
  recreateRun: vi.fn(async () => ({ _tag: "Success", value: { started: true } })),
  resetRun: vi.fn(async () => ({ _tag: "Success", value: { started: true } })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => commands.canManage,
}));

vi.mock("~/state/grokBotComputer", () => ({
  grokBotComputerRecreate: commands.recreate,
  grokBotComputerReset: commands.reset,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === commands.reset ? commands.resetRun : commands.recreateRun,
}));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import {
  describeComputerUpgradeSchedule,
  GrokBotComputerMaintenance,
} from "./GrokBotComputerMaintenance";

const environmentId = EnvironmentId.make("env-1");

function renderMaintenance(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return GrokBotComputerMaintenance({ environmentId }) as ReactElement<Record<string, unknown>>;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

function findButton(tree: unknown, variant: string, label: string) {
  return visitElements(
    tree,
    (element) =>
      element.type === Button &&
      element.props.variant === variant &&
      textOf(element.props.children as ReactNode).includes(label),
  );
}

function findConfirmButton(tree: unknown, variant: "default" | "destructive") {
  return visitElements(
    tree,
    (element) => element.type === Button && element.props.variant === variant,
  );
}

function clickButton(element: ReactElement<Record<string, unknown>> | null) {
  const onClick = element?.props.onClick as (() => void) | undefined;
  if (!onClick) throw new Error("expected a clickable button");
  onClick();
}

describe("GrokBotComputerMaintenance", () => {
  beforeEach(() => {
    hooks.reset();
    commands.canManage = true;
    commands.recreateRun.mockClear();
    commands.resetRun.mockClear();
  });

  it("sends reset through the reset command only, after confirmation", () => {
    clickButton(findButton(renderMaintenance(), "destructive-outline", "Reset computer"));

    const confirm = findConfirmButton(renderMaintenance(), "destructive");
    clickButton(confirm);

    expect(commands.resetRun).toHaveBeenCalledWith({
      environmentId,
      input: { confirm: true },
    });
    expect(commands.recreateRun).not.toHaveBeenCalled();
  });

  it("keeps the account's files when updating, through the recreate command", () => {
    clickButton(findButton(renderMaintenance(), "outline", "Update computer"));

    clickButton(findConfirmButton(renderMaintenance(), "default"));

    expect(commands.recreateRun).toHaveBeenCalledWith({
      environmentId,
      input: { preserveData: true, confirm: true },
    });
    expect(commands.resetRun).not.toHaveBeenCalled();
  });

  it("sends nothing when the reset confirmation is dismissed", () => {
    clickButton(findButton(renderMaintenance(), "destructive-outline", "Reset computer"));

    const dialog = visitElements(renderMaintenance(), (element) => "onOpenChange" in element.props);
    (dialog?.props.onOpenChange as (open: boolean) => void)(false);

    const afterCancel = visitElements(
      renderMaintenance(),
      (element) => "onOpenChange" in element.props,
    );
    expect(afterCancel?.props.open).toBe(false);
    expect(commands.resetRun).not.toHaveBeenCalled();
    expect(commands.recreateRun).not.toHaveBeenCalled();
  });

  it("shows no maintenance actions without settings write access", () => {
    commands.canManage = false;

    const tree = renderMaintenance();

    expect(findButton(tree, "outline", "Update computer")).toBeNull();
    expect(findButton(tree, "destructive-outline", "Reset computer")).toBeNull();
  });
});

describe("describeComputerUpgradeSchedule", () => {
  it("says so when nothing is scheduled", () => {
    expect(describeComputerUpgradeSchedule(null)).toBe("No upgrade is scheduled.");
  });

  it("reports the native schedule fields without inventing any", () => {
    const text = describeComputerUpgradeSchedule({
      localTime: "03:00",
      timezone: "UTC",
      targetImageTag: "2026.10",
      state: "pending",
      failureReason: "image pull timed out",
    });
    expect(text).toContain("Runs at 03:00 UTC");
    expect(text).toContain("Target image 2026.10");
    expect(text).toContain("State: pending");
    expect(text).toContain("Last attempt failed: image pull timed out");
    expect(text).not.toContain("Next");
  });

  it("falls back to a neutral line when the schedule has no fields", () => {
    expect(describeComputerUpgradeSchedule({})).toBe("An upgrade is scheduled.");
  });
});
