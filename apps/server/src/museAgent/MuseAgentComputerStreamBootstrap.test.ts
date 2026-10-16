import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { exposeMuseComputerStreamFactory } from "./MuseAgentComputerStreamBootstrap.ts";

describe("native computer stream constructor exposure", () => {
  const source = `let initialized=false; const init_useNoiseBrowserSession=()=>{initialized=true}; const useNoiseBrowserSession_exports={}; const NoiseWebSocketShim=class extends EventTarget{};
function connectNoiseBrowserSession({gatewayUrl:gatewayUrl,taskId:taskId,vmName:vmName}){return {initialized,gatewayUrl,taskId,vmName}}`;
  it("calls the original constructor after its native initializer without copying its implementation", () => {
    const window: { __t3MuseNativeComputerStream?: (input: unknown) => unknown } = {};
    const patched = exposeMuseComputerStreamFactory(source);
    expect(
      patched?.includes(source.slice(source.indexOf("function connectNoiseBrowserSession"))),
    ).toBe(true);
    NodeVM.runInNewContext(patched!, { window, EventTarget });
    expect(
      window.__t3MuseNativeComputerStream!({
        gatewayUrl: "https://gateway.invalid",
        taskId: "task",
        vmName: "vm",
      }),
    ).toEqual({
      initialized: true,
      gatewayUrl: "https://gateway.invalid",
      taskId: "task",
      vmName: "vm",
    });
  });
  it("fails closed for unrelated, ambiguous and changed native module markers", () => {
    expect(exposeMuseComputerStreamFactory("function unrelated() {} ")).toBeNull();
    expect(exposeMuseComputerStreamFactory(source + source)).toBeNull();
    expect(
      exposeMuseComputerStreamFactory(
        source.replace("init_useNoiseBrowserSession=", "changed_initializer="),
      ),
    ).toBeNull();
    expect(
      exposeMuseComputerStreamFactory(
        source.replace(
          "NoiseWebSocketShim=class extends EventTarget",
          "ChangedShim=class extends EventTarget",
        ),
      ),
    ).toBeNull();
    expect(exposeMuseComputerStreamFactory(source)?.includes("__t3MuseNativeComputerStream")).toBe(
      true,
    );
  });

  it("loads the original hosted constructor export without rendering or connecting", async () => {
    const source = `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([154006,e=>{"use strict";var r=e.i(773309);let u1=(0,r.lazy)(()=>e.A(781471).then(e=>({default:e.BrowserSessionSidePanel})));}]);`;
    const sidePanel = `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([100768,e=>{"use strict";var r=e.i(773309);async function dormant(){let{connectNoiseBrowserSession:t}=await e.A(558113)}e.s(["BrowserSessionSidePanel",0,function(){throw Error("must not render")}]);}]);`;
    const window: {
      __t3MusePreloadComputerModule?: () => Promise<void>;
      __t3MuseLoadComputerStreamFactory?: () => Promise<void>;
      __t3MuseNativeComputerStream?: (input: unknown) => unknown;
    } = {};
    const context = { window, TURBOPACK: [] as [number, (input: unknown) => void][] };
    const imports: number[] = [];
    let connects = 0;
    const nativeConstructor = (input: unknown) => {
      connects++;
      return input;
    };
    const runtime = {
      i: () => ({ lazy: (_load: unknown) => ({}) }),
      s: (_exports: unknown) => {},
      A: (id: number): Promise<unknown> => {
        imports.push(id);
        if (id === 781471) {
          NodeVM.runInNewContext(exposeMuseComputerStreamFactory(sidePanel)!, context);
          context.TURBOPACK.at(-1)![1](runtime);
          return Promise.resolve({});
        }
        expect(id).toBe(558113);
        return Promise.resolve({ connectNoiseBrowserSession: nativeConstructor });
      },
    };
    NodeVM.runInNewContext(exposeMuseComputerStreamFactory(source)!, context);
    context.TURBOPACK[0]![1](runtime);
    expect(imports).toEqual([]);
    await window.__t3MusePreloadComputerModule!();
    expect(imports).toEqual([781471, 558113]);
    expect(connects).toBe(0);
    expect(window.__t3MuseNativeComputerStream).toBe(nativeConstructor);
    expect(window.__t3MuseNativeComputerStream!({ taskId: "task" })).toEqual({ taskId: "task" });
    expect(connects).toBe(1);
    expect(exposeMuseComputerStreamFactory(source + source)).toBeNull();
    expect(exposeMuseComputerStreamFactory(source.replace("773309", "773310"))).toBeNull();
    expect(exposeMuseComputerStreamFactory(source.replace("781471", "781472"))).toBeNull();
    expect(exposeMuseComputerStreamFactory(sidePanel + sidePanel)).toBeNull();
    expect(exposeMuseComputerStreamFactory(sidePanel.replace("558113", "558114"))).toBeNull();
    expect(exposeMuseComputerStreamFactory(sidePanel.replace("100768", "100769"))).toBeNull();
  });
});
