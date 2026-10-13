import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GrokBotHostMachines } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  grokBotHostMachinesQuery,
  grokBotHostMachineUpdate,
  grokBotNetworkQuery,
  grokBotNetworkSet,
} from "~/state/grokBotHost";

type Machine = (typeof GrokBotHostMachines.Type.machines)[number];
const permissions = { never: "Never allow", ask: "Ask every time", always: "Always allow" };
function MachineRow({
  environmentId,
  machine,
}: {
  readonly environmentId: EnvironmentId;
  readonly machine: Machine;
}) {
  const allowed = useAtomValue(grokBotHostMachineUpdate.permissionAtom(environmentId));
  const update = useAtomCommand(grokBotHostMachineUpdate, { reportFailure: false });
  const [label, setLabel] = useState(machine.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (input: { permission?: Machine["permission"]; label?: string }) => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { machineId: machine.machineId, ...input },
    });
    setBusy(false);
    if (result._tag !== "Success")
      setError("Could not update this computer. Check the GrokBot connection and try again.");
  };
  return (
    <SettingsRow
      title={machine.label || "Computer"}
      description={
        machine.connected === null
          ? "Registered with GrokBot. Auto-review still checks local actions."
          : machine.connected
            ? "Connected to GrokBot. Auto-review still checks local actions."
            : "Offline. Execution resumes when this computer reconnects."
      }
      control={
        <div className="grid min-w-0 gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Input
              size="sm"
              aria-label={`Name for ${machine.label}`}
              value={label}
              disabled={!allowed || busy}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Button
              size="sm"
              disabled={!allowed || busy || !label.trim() || label.trim() === machine.label}
              onClick={() => void save({ label: label.trim() })}
            >
              Save
            </Button>
          </div>
          <Select
            value={machine.permission}
            disabled={!allowed || busy}
            onValueChange={(value) => {
              if (value === "never" || value === "ask" || value === "always")
                void save({ permission: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={`Execution on ${machine.label}`}>
              <SelectValue>{permissions[machine.permission]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(permissions).map(([value, text]) => (
                <SelectItem key={value} value={value}>
                  {text}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
export function GrokBotHostSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const machines = useEnvironmentQuery(grokBotHostMachinesQuery({ environmentId, input: {} }));
  const network = useEnvironmentQuery(grokBotNetworkQuery({ environmentId, input: {} }));
  const allowed = useAtomValue(grokBotNetworkSet.permissionAtom(environmentId));
  const setNetwork = useAtomCommand(grokBotNetworkSet, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    const result = await setNetwork({ environmentId, input: { enabled } });
    setBusy(false);
    if (result._tag !== "Success")
      setError("Could not change routing. Check the GrokBot connection and try again.");
  };
  const status = network.data?.state;
  return (
    <>
      <SettingsSection title="Network">
        <SettingsRow
          title="Route traffic through this computer"
          description="Route GrokBot's cloud-computer traffic through the computer hosting this T3 environment. Applies to new connections, including when you control T3 from your phone."
          control={
            <Switch
              size="sm"
              aria-label="Route traffic through this computer"
              checked={network.data?.enabled ?? false}
              disabled={!allowed || busy || network.data === null}
              onCheckedChange={(enabled) => void toggle(enabled)}
            />
          }
        />
        {network.data?.enabled ? (
          <SettingsRow
            title={
              status === "connected"
                ? "Routing connected"
                : status === "standby"
                  ? "Another computer is routing traffic"
                  : status === "error"
                    ? "Routing unavailable"
                    : "Connecting routing"
            }
            description={
              status === "standby"
                ? "T3 is standing by and will connect when the other computer releases the tunnel."
                : (network.data.error ??
                  `${network.data.activeStreams} active connections · ${network.data.relayedStreams} relayed`)
            }
          />
        ) : null}
        {error || network.error ? (
          <p role="alert" className="text-xs text-destructive">
            {error ?? "Could not read routing status."}
          </p>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Local computers">
        {machines.data?.machines.map((machine) => (
          <MachineRow
            key={`${machine.machineId}:${machine.label}`}
            environmentId={environmentId}
            machine={machine}
          />
        ))}
        {!machines.data ? (
          <SettingsRow
            title="Registered computers"
            description={
              machines.error
                ? "Could not read GrokBot's computers. Try refreshing the connection."
                : "Loading registered computers…"
            }
          />
        ) : machines.data.machines.length === 0 ? (
          <SettingsRow
            title="No registered computers"
            description="Open and sign in to GrokBot on the computer you want to use for local execution."
          />
        ) : null}
      </SettingsSection>
    </>
  );
}
