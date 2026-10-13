import * as Effect from "effect/Effect";

import * as DirectTools from "../mcp/direct/NativeAgentDirectTools.ts";
import { toolkitRegistration } from "../mcp/direct/toolkit.ts";
import * as AttachmentHandlers from "../mcp/toolkits/attachment/handlers.ts";
import { AttachmentToolkit } from "../mcp/toolkits/attachment/tools.ts";
import * as DeviceHandlers from "../mcp/toolkits/device/handlers.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit } from "../mcp/toolkits/device/tools.ts";
import * as EnvironmentHandlers from "../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import * as HtmlHandlers from "../mcp/toolkits/html/handlers.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit } from "../mcp/toolkits/html/tools.ts";
import * as OrchestratorHandlers from "../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "../mcp/toolkits/preview/handlers.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "../mcp/toolkits/preview/tools.ts";
import * as PreviewControlsHandlers from "../mcp/toolkits/previewControls/handlers.ts";
import { PreviewControlsToolkit } from "../mcp/toolkits/previewControls/tools.ts";
import * as ProjectHandlers from "../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as PullRequestsHandlers from "../mcp/toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";
import * as ThreadHandlers from "../mcp/toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as WorktreeHandlers from "../mcp/toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "../mcp/toolkits/worktree/tools.ts";

/** Native Muse shares T3's checked services. Grok's completion/identity tools are not advertised. */
export const tools = Effect.all([
  toolkitRegistration(AttachmentToolkit, AttachmentHandlers.layer),
  toolkitRegistration(DeviceStandardToolkit, DeviceHandlers.layerStandard),
  toolkitRegistration(DeviceScreenshotToolkit, DeviceHandlers.layerScreenshot),
  toolkitRegistration(EnvironmentToolkit, EnvironmentHandlers.layer),
  toolkitRegistration(HtmlPreviewToolkit, HtmlHandlers.layerPreview),
  toolkitRegistration(HtmlRenderToolkit, HtmlHandlers.layerRender),
  toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
  toolkitRegistration(PreviewStandardToolkit, PreviewHandlers.layerStandard),
  toolkitRegistration(PreviewSnapshotToolkit, PreviewHandlers.layerSnapshot),
  toolkitRegistration(PreviewControlsToolkit, PreviewControlsHandlers.layer),
  toolkitRegistration(ProjectToolkit, ProjectHandlers.layer),
  toolkitRegistration(PullRequestsToolkit, PullRequestsHandlers.layer),
  toolkitRegistration(ThreadToolkit, ThreadHandlers.layer),
  toolkitRegistration(WorktreeToolkit, WorktreeHandlers.layer),
]).pipe(Effect.map((groups) => groups.flat()));

export const layer = DirectTools.layer(tools);
