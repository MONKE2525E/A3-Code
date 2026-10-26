import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";

export interface DirectToolResult {
  readonly isError: boolean;
  readonly value: Schema.Json;
}

interface DirectToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Schema.Json;
  readonly invoke: (
    params: Readonly<Record<string, Schema.Json>>,
    invokeId: string,
    scope: McpInvocationContext.McpThreadInvocationScope,
  ) => Effect.Effect<DirectToolResult>;
}

const builtHere: unique symbol = Symbol("t3/mcp/direct/toolkit");
let checkedTool: (spec: DirectToolSpec) => DirectTool;

/** Only toolkitRegistration can build a dispatcher, retaining the nominal handler gate. */
export class DirectTool {
  readonly #spec: DirectToolSpec;
  private constructor(token: typeof builtHere, spec: DirectToolSpec) {
    if (token !== builtHere) throw new TypeError("Direct tools require checked toolkit handlers.");
    this.#spec = spec;
  }
  static {
    checkedTool = (spec) => new DirectTool(builtHere, spec);
  }
  get name() {
    return this.#spec.name;
  }
  get description() {
    return this.#spec.description;
  }
  get parameters() {
    return this.#spec.parameters;
  }
  get invoke() {
    return this.#spec.invoke;
  }
}

const json = Schema.decodeUnknownEffect(Schema.Json);

/** Builds an in-process dispatcher only from the nominally checked handler layer. */
export const toolkitRegistration = Effect.fn("toolkit.toolkitRegistration")(
  function* <Tools extends Record<string, Tool.Any>, EX, RX>(
    toolkit: Toolkit.Toolkit<Tools>,
    _handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
  ) {
    const built = yield* toolkit;
    // Handler services are captured once, but invocation authority is supplied afresh below.
    const services =
      yield* Effect.context<
        Exclude<Tool.HandlerServices<Tools[keyof Tools]>, McpInvocationContext.McpInvocationContext>
      >();
    return yield* Effect.forEach(Object.values(toolkit.tools), (tool) =>
      Effect.gen(function* () {
        const parameters = yield* json(Schema.toJsonSchemaDocument(tool.parametersSchema));
        const invoke: DirectTool["invoke"] = (params, invokeId, scope) => {
          // Exclude<T, Invocation> plus Invocation restores T, but TS cannot simplify
          // that identity for generic handler services. Only the context is widened.
          const invocationServices = Context.add(
            services,
            McpInvocationContext.McpInvocationContext,
            scope,
          ) as Context.Context<Tool.HandlerServices<Tools[keyof Tools]>>;
          return Effect.gen(function* () {
            // The dynamic name retains the same tool object and checked handlers. The toolkit
            // decodes parameters and encodes both success and failure using its own schemas.
            const stream = yield* built.handle(
              tool.name as keyof Tools,
              params as Tool.ParametersEncoded<Tools[keyof Tools]>,
              invokeId,
              { onExcessProperty: "error" },
            );
            const final = yield* Stream.runFold(
              stream,
              (): DirectToolResult | undefined => undefined,
              (previous, result) =>
                result.preliminary
                  ? previous
                  : {
                      isError: result.isFailure,
                      value: result.encodedResult as Schema.Json,
                    },
            );
            return final ?? { isError: true, value: { code: "missing_result" } };
          }).pipe(
            // The checked toolkit produces JSON-compatible encoded results; decode it once
            // more at this boundary so a malformed result cannot escape into a device reply.
            Effect.flatMap((result) =>
              json(result.value).pipe(Effect.map((value) => ({ ...result, value }))),
            ),
            Effect.provide(invocationServices),
            Effect.catchCause(() =>
              Effect.succeed({ isError: true, value: { code: "tool_failed" } }),
            ),
          );
        };
        return checkedTool({
          name: tool.name,
          description: tool.description ?? tool.name,
          parameters,
          invoke,
        });
      }),
    );
  },
  (effect, toolkit, handlers) =>
    effect.pipe(Effect.provide(McpToolAccess.HandlersLayer.layer(handlers))),
);
