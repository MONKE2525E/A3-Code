# T3 Code Mobile

Personal mobile-focused fork of [T3 Code](https://github.com/pingdotgg/t3code).

This fork includes an expandable composer with keyboard and safe-area handling for iOS and Android, plus a native pull request viewer with saved filters, direct links from threads, and PR actions.

The full monorepo stays here because the mobile client builds against its shared runtime and contracts. See [mobile setup and custom builds](apps/mobile/README.md) and the [mobile PR viewer guide](docs/user/mobile-pull-requests.md).

## Open indicator threads on Android

The Fold 7 Agent Activity Indicator can open `https://<host>.ts.net[:port]/<environmentId>/<threadId>` directly in this app. Pair the environment in the mobile app first. Links use that saved connection, including its existing direct, tailnet, or tunnel settings. Missing connections and unknown threads show an in-app message.

On the phone, open **Settings > Apps > T3 Code Custom > Open by default > Add link**, then enable the `*.ts.net` link. Some Android versions call this **Open supported links** or list individual supported addresses. These domains are deliberately unverified, so Android 12 and newer require this one-time choice. If the phone does not offer the domain, select this app explicitly in the indicator's "Open threads in" setting or use `t3code://thread/<environmentId>/<threadId>` instead. Encode each ID separately with `encodeURIComponent`, including any slash inside an ID.

Choose the matching package in the indicator:

| Build                                                | Android package                |
| ---------------------------------------------------- | ------------------------------ |
| Custom signed APK, including custom debug/dev builds | `com.monke2525e.t3code.custom` |
| Development without `T3CODE_ANDROID_CUSTOM=1`        | `com.t3tools.t3code.dev`       |
| Preview without `T3CODE_ANDROID_CUSTOM=1`            | `com.t3tools.t3code.preview`   |
| Production without `T3CODE_ANDROID_CUSTOM=1`         | `com.t3tools.t3code`           |

The custom package stays the same across debug and release build types. A debug signing key cannot update a release APK signed with the custom release key. The custom scheme can be claimed by several installed variants, so setting an explicit package in the indicator avoids an app chooser.

To test native delivery, run this while the app is closed and again while it is open. `ENV/THREAD` placeholders should show the missing-environment message; use real IDs from a paired environment to verify navigation:

```bash
adb shell am start -a android.intent.action.VIEW -d "https://example.ts.net:37668/ENV/THREAD" com.monke2525e.t3code.custom
adb shell am start -a android.intent.action.VIEW -d "t3code://thread/ENV/THREAD" com.monke2525e.t3code.custom
```

There is no fixed port in the Android filter. The native filter accepts two or more path segments; the app validates exactly two IDs, with an optional trailing slash. Existing pairing and app-navigation schemes remain available.

## Upstream project

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
