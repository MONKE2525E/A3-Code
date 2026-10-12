# Connect GrokBot

GrokBot uses the account signed in to the GrokBot desktop app on the computer hosting your T3 environment. You can finish setup from the T3 desktop app, a desktop browser, or a phone browser. The hosting computer must remain online.

1. Sign in to the GrokBot desktop app and choose your primary bot there. T3 sends setup to the bot marked with the star.
2. Enable T3 Connect for this environment in **Settings → Connections**. Sign in and publish the environment if prompted. Each T3 installation needs its own connection.
3. In **Settings → Providers**, add or select GrokBot and click **Send setup prompt**. T3 configures the provider and installs its optional CLI bridge if needed. The prompt appears in your primary bot's normal chat.
4. The bot installs the shared T3 skill and connects the account-wide T3 MCP connector. Click **Authorize T3 connection** in setup, or open the authorization link the bot returns, and approve the access you want it to have. Choose access that allows orchestration; read-only access cannot finish setup.
5. If the authorization page asks for a pairing code, run the command shown in setup on the **hosting computer**, then enter the resulting code on that page. The command targets this T3 installation's data directory and uses the standard scopes. Do not add restrictive scope flags or paste the code into the bot chat. A failed approval consumes the code; run the command again to create a fresh one.

Setup completes when the bot calls back through the authorized T3 MCP connection with the current setup challenge. A chat reply saying “done” does not complete the check. The setup button disappears after that check passes. The shared skill applies to every bot in the account; it keeps temporary managed-turn credentials out of saved instructions.

## If setup stops

Open the primary bot's normal conversation to see whether it needs an approval or returned an error. **Check again** refreshes setup status. After 15 minutes without verification, T3 shows a timeout and offers a retry. Retrying asks the bot to reuse a connector with the same address rather than replace another environment's connection.

If T3 Connect is unavailable, fix the connection before sending setup. If the account has reached its tunnel limit, unlink an environment you no longer need before publishing another one.

If this environment was connected before guided setup was added but its MCP address is missing, reconnect this environment in **Settings → Connections** once. Older UI-created connections did not save the public address needed by GrokBot.

The expandable manual prompt installs or repairs the shared skill. It does not replace the MCP authorization and verification steps. If you change accounts, the primary bot, the public endpoint, or the required skill version, setup must be checked again.

## Authorize a connector

When a bot asks you to connect an MCP service, use its connection card in the conversation to open the service's sign-in page. Plugin connections can also be authorized from the Marketplace. Approve access in your browser; T3 sends the returned authorization code to the environment that started the sign-in. If the return page cannot finish automatically, paste its full address into the waiting connection card.

## Use the hosting computer

In **Settings → Providers → GrokBot**, enable network routing to send GrokBot's cloud-computer traffic through the computer hosting this T3 environment. Your phone controls that setting; it does not become the routing host. The host must remain online. If another computer owns the routing tunnel, T3 waits for it to disconnect. Turn routing off to stop it. Signing out or changing GrokBot accounts also disables routing.

The same settings page lists computers registered with GrokBot. You can rename them and choose whether local execution is never allowed, asks each time, or is always allowed. These are GrokBot's native settings, shared with its desktop app. Auto-review still checks local actions, and team restrictions may limit access.
