import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  external: vi.fn().mockResolvedValue(true),
  params: undefined as unknown,
  projects: [
    {
      id: "project-a",
      environmentId: "env-a",
      repositoryIdentity: {
        canonicalKey: "github.com/example/app",
        provider: "github",
        displayName: "example/app",
        owner: "example",
        name: "app",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/example/app.git",
        },
      },
    },
  ],
}));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: mocks.dispatch }),
  useRoute: () => ({ params: mocks.params }),
  StackActions: {
    push: (name: string, params: unknown) => ({ type: "PUSH", name, params }),
    replace: (name: string, params: unknown) => ({ type: "REPLACE", name, params }),
  },
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: mocks.external }));
vi.mock("../../state/projects", () => ({ environmentProjects: { projectsAtom: "projects" } }));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) =>
      atom === "projects"
        ? mocks.projects
        : { environment: { capabilities: { pullRequests: true, threadPullRequests: true } } },
  },
}));

import { useRouteOpenPullRequest } from "./useRouteOpenPullRequest";

describe("opening a PR from a route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.params = undefined;
  });

  it("prefers an explicit draft environment over the route's environment", async () => {
    mocks.params = { environmentId: "env-route", threadId: "thread-a" };
    const open = useRouteOpenPullRequest();
    expect(await open("https://github.com/example/app/pull/42", "env-a")).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "PUSH",
      name: "PullRequest",
      params: {
        environmentId: "env-a",
        projectId: "project-a",
        repository: "example/app",
        number: 42,
        host: "github.com",
        threadId: "thread-a",
      },
    });
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("uses the first route environment and thread when the link names neither", async () => {
    mocks.params = { environmentId: ["env-a", "env-x"], threadId: ["thread-a", "thread-b"] };
    const open = useRouteOpenPullRequest();
    expect(await open("https://github.com/example/app/pull/42")).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PUSH",
        name: "PullRequest",
        params: expect.objectContaining({ environmentId: "env-a", threadId: "thread-a" }),
      }),
    );
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("opens the link externally when no environment is known", async () => {
    mocks.params = { threadId: "thread-a" };
    const open = useRouteOpenPullRequest();
    expect(await open("https://github.com/example/app/pull/42")).toBe(true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.external).toHaveBeenCalledWith(
      "https://github.com/example/app/pull/42",
      "pull-request",
    );
  });
});
