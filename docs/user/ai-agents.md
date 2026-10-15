# AI Agents

The **AI Agents** section of the sidebar holds your personal agents: your Grok Bots and Muse. This section and the marketplace appear only after you enable Muse or Grok Bot in Providers. When both are enabled, the marketplace lets you switch between them. Their chats are ordinary threads that stay with the environment you picked, and they never appear in project lists.

## Muse

Choose **Settings → Providers → Add provider → Muse**, then **Sign in to Muse**. Complete sign-in in the private browser window and choose **Finish sign-in**. No companion app is required. Remote clients use the selected server's Muse account.

- **One agent:** Muse has a single personal agent. Choose its row to open the chat.
- **Your look:** the name and avatar come from your Muse profile. A video avatar plays only while Muse is working and the row is on screen, and stays still when your system asks for reduced motion.
- **Tools:** Muse does not need a public endpoint to use T3 Code's tools.

Muse Code, the coding provider, is separate and unchanged.

Open **Muse features** from the chat header or provider settings to search memories and see connections, skills, and computer status. Manage side conversations from Muse's sidebar menu. View and delete Muse routines in **Settings → Scheduled Tasks**. To create or edit a routine, ask Muse in chat.

The profile editor updates Muse's Identity, Personality, and Memory files. Changes require **Save**. If a file changed elsewhere, reload it before saving again.

Connection authorization opens in a separate tab. Refresh afterwards to check whether Muse connected it. API keys and consent can be entered directly in T3 Code. Other authentication methods may still require Muse. Credentials requested during a conversation appear in a separate private form; they are sent directly to Muse’s credential store and never added to chat.

Messages support images within a combined 10 MiB inline budget and files up to 50 MiB each, with a 128 MiB total limit. Computer tasks show a still preview in **Muse features → Computer**. Voice calls and the ambient overlay are not currently available through this integration.

### Controlling Muse's computer

Choose a task, then **Take control** and confirm. Muse pauses on that task while you drive its browser in a live view; there is no view-only mode. Choose **Release control** when you are done. The view closes if control expires, the connection drops, or you hide the task, and you can take control again to reconnect. You need permission to operate on the environment, and a task Muse is using is never taken without your confirmation.

### Dictation

**Muse features → Dictation** turns speech into text on the machine running Muse, so audio never goes to a cloud service. Choose **Record**, speak for up to 60 seconds, then **Stop and transcribe**. Edit the text and choose **Use in chat** to add it below anything already in Muse's composer. It is never sent for you; **Discard** throws it away.

Your browser asks for microphone access the first time, and needs HTTPS or localhost. If the tab says dictation is unavailable, prepare the speech helper and model in Muse for Linux, then choose **Check again**.

## Grok Bots

Grok Bot setup, bot editing, history, voice, and computer controls keep their own labels under Settings → Providers.
