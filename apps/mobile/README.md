# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

For simulator/emulator development, select and boot a device, then ensure its native client matches
this checkout before starting Metro:

```bash
node ../../scripts/mobile-native-client.ts ensure ios <simulator-udid>
# Or: node ../../scripts/mobile-native-client.ts ensure android <emulator-serial>
vp run dev:client
```

The helper compares a local Expo fingerprint and the installed binary with its last successful
build record. It builds and installs missing, stale, or unverified clients and reuses matching ones.
Use `check` instead of `ensure` for a read-only decision: exit 0 means compatible, 2 means a build is
needed, and 1 means an operational error. Run it on the simulator host; no EAS login is required.
An externally installed client is unverified until the helper builds it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```

## Custom Android APK

The custom build installs as **T3 Code Custom**, using `com.monke2525e.t3code.custom`
and the `t3code-custom` URL scheme. It can coexist with the official app. Official
Expo updates are disabled, so they cannot replace your local changes.

Use a source revision compatible with your server. An older mobile runtime can
be rejected after an orchestration protocol upgrade.

From the repository root, with the Android SDK and JDK 21 configured:

```bash
pnpm install --frozen-lockfile
# Include the public T3 Connect configuration for sign-in and remote access.
# If you already have a .env, add the relevant values instead of replacing it.
cp -n .env.example .env
node scripts/build-custom-mobile.ts
```

This builds for ARM64 Android phones, including the Z Fold. Add `--emulator`
to include x86_64 for local emulator verification.

The signed, standalone APK is written to `.t3/artifacts/T3-Code-Custom.apk`.
It runs without Metro. Install it on your Android device, allow installation from that source,
and pair your existing environment through Add environment.

The script stores its signing key and password in `~/.local/share/t3-custom-mobile`
outside the checkout. Keep that directory private and backed up: future APKs need
the same key to update an existing installation. The build requires public T3 Connect
configuration so updates cannot silently disable cloud routes. Use `--offline-only`
explicitly for a LAN/tailnet-only APK without cloud sign-in.

Custom APKs check [this fork's releases](https://github.com/MONKE2525E/t3code/releases)
at launch and when returning to the app after 15 minutes. Settings > About > Check
for mobile updates also checks manually. Download the offered APK and open it in
Android's installer. Updates preserve the app's data when signed with the same key.
The PC continues running official upstream T3 Code nightly.

Before publishing, verify this client against the newest published upstream nightly
server as required by `AGENTS.md`. The build script prints the release tag
`mobile-build-<versionCode>`. Upload `.t3/artifacts/T3-Code-Custom.apk` to a release
with that exact tag. Prereleases are supported. You can set
`T3CODE_MOBILE_BUILD_NUMBER` explicitly, but it must increase for every published
APK. Do not rename the APK or reuse a build number. iOS updates are unchanged.

The Pull requests button on Home and in the sidebar opens the native viewer.
Pull request links in chat, linked pull requests, context chips and Thread Git
controls open in-app when the link is a pull request URL for a repository on the
thread's environment, resolved with the same shared reader and project matching as
desktop. Any other link, and any host or repository the environment does not
hold, opens externally as before. The viewer shares desktop's list, detail,
activity, and paginated diff queries, with Summary, Timeline, and Code tabs.
On wider screens its own PR list replaces the thread sidebar, leaving space
for the selected PR. Comment and review controls follow host capabilities and
viewer permissions. Merge actions and inline review comments remain on the host.

For direct LAN pairing, enter the complete server origin, including its port
(for example, `http://192.168.0.187:3773`). The computer must accept connections
on that port from the phone, and both devices must be on a reachable network.
