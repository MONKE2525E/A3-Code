import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const commands = vi.hoisted(() => ({
  canManage: true,
  recreate: { permissionAtom: () => "recreate-permission" },
  reset: { permissionAtom: () => "reset-permission" },
  recreateRun: vi.fn(async () => ({ _tag: "Success", value: { started: true } })),
  resetRun: vi.fn(async () => ({ _tag: "Success", value: { started: true } })),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => commands.canManage,
}));
vi.mock("/src/state/grokBotComputer.ts", () => ({
  grokBotComputerRecreate: commands.recreate,
  grokBotComputerReset: commands.reset,
}));
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand: (command: unknown) =>
    command === commands.reset ? commands.resetRun : commands.recreateRun,
}));
vi.mock("/src/components/ui/toast.tsx", () => ({ toastManager: { add: vi.fn() } }));
import { GrokBotComputerMaintenance } from "./GrokBotComputerMaintenance";
const environmentId = EnvironmentId.make("env-1");
function setup() {
  commands.canManage = true;
  commands.recreateRun.mockClear();
  commands.resetRun.mockClear();
}
describe("GrokBotComputerMaintenance", () => {
  it("resets only after confirmation", async () => {
    setup();
    await using screen = await render(<GrokBotComputerMaintenance environmentId={environmentId} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset computer" }));
    expect(commands.resetRun).not.toHaveBeenCalled();
    await userEvent.click(
      page.getByRole("alertdialog").getByRole("button", { name: "Reset computer" }),
    );
    expect(commands.resetRun).toHaveBeenCalledWith({ environmentId, input: { confirm: true } });
    expect(commands.recreateRun).not.toHaveBeenCalled();
  });
  it("keeps account files when updating", async () => {
    setup();
    await using screen = await render(<GrokBotComputerMaintenance environmentId={environmentId} />);
    await userEvent.click(screen.getByRole("button", { name: "Update computer" }));
    await userEvent.click(
      page.getByRole("alertdialog").getByRole("button", { name: "Update computer" }),
    );
    expect(commands.recreateRun).toHaveBeenCalledWith({
      environmentId,
      input: { preserveData: true, confirm: true },
    });
    expect(commands.resetRun).not.toHaveBeenCalled();
  });
  it("sends nothing when confirmation is dismissed", async () => {
    setup();
    await using screen = await render(<GrokBotComputerMaintenance environmentId={environmentId} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset computer" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }));
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(commands.resetRun).not.toHaveBeenCalled();
    expect(commands.recreateRun).not.toHaveBeenCalled();
  });
  it("requires settings write access", async () => {
    setup();
    commands.canManage = false;
    await using screen = await render(<GrokBotComputerMaintenance environmentId={environmentId} />);
    await expect.element(screen.getByText("Needs settings write access")).toBeVisible();
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  });
});
