import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

export function GrokBotLimitations({ className }: { readonly className?: string }) {
  return (
    <p className={cn("text-xs leading-5 text-muted-foreground", className)}>
      Bot chats are ordinary threads. Timezone, auto-review, and remote computer controls are not
      available here yet. Weekly limits are on the{" "}
      <Link to="/usage" className="underline underline-offset-2 hover:text-foreground">
        Usage page
      </Link>
      .
    </p>
  );
}
