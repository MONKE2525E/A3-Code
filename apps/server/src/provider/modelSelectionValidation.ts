import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderModelSelectionError extends Schema.TaggedError<ProviderModelSelectionError>()(
  "ProviderModelSelectionError",
  {
    instanceId: ProviderInstanceId,
    model: Schema.String,
    reason: Schema.Literals(["provider_unavailable", "model_unavailable", "invalid_options"]),
    problems: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider_unavailable":
        return `Provider instance ${this.instanceId} is not registered.`;
      case "model_unavailable":
        return `Model ${this.model} is not advertised by provider ${this.instanceId}.`;
      case "invalid_options":
        return `Model ${this.model} on provider ${this.instanceId} rejected options: ${this.problems.join(" ")}`;
    }
  }
}

/** Missing descriptors permit provider-specific options; duplicates always fail. */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

/** Validate against the current catalog, including configured custom models. */
export const validateModelSelection = Effect.fnUntraced(function* (
  provider: ServerProvider | undefined,
  selection: ModelSelection,
  validateModel = true,
) {
  const common = { instanceId: selection.instanceId, model: selection.model };
  if (provider === undefined || provider.instanceId !== selection.instanceId) {
    return yield* new ProviderModelSelectionError({
      ...common,
      reason: "provider_unavailable",
      problems: [],
    });
  }
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  // A provider without a catalog cannot validate model slugs. Inherited
  // delegation models retain that same behavior when no model was requested.
  if (validateModel && provider.models.length > 0 && model === undefined) {
    return yield* new ProviderModelSelectionError({
      ...common,
      reason: "model_unavailable",
      problems: [],
    });
  }
  if (selection.options === undefined) return;
  const problems = invalidOptionSelections(
    selection.options,
    model?.capabilities?.optionDescriptors,
  );
  if (problems.length > 0) {
    return yield* new ProviderModelSelectionError({
      ...common,
      reason: "invalid_options",
      problems,
    });
  }
});
