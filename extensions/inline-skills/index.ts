import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAutocompleteProvider,
  expandSkills,
  getSkills,
} from "./skills.ts";

export default function inlineSkills(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) =>
      createAutocompleteProvider(() => getSkills(pi.getCommands()), current),
    );
  });
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    try {
      const text = await expandSkills(event.text, getSkills(pi.getCommands()));
      return text === undefined
        ? { action: "continue" }
        : { action: "transform", text, images: event.images };
    } catch (error) {
      // Input-handler exceptions are reported and swallowed by the host. Consume
      // the input explicitly: never send a prompt with missing instructions.
      ctx.ui.notify(
        `Could not load inline skills: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return { action: "handled" };
    }
  });
}
