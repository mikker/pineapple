import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TerminalReadModel } from "../manager.ts";
import { buildStatusResult, describeTerminal } from "../prompt.ts";
import { sanitizeText } from "./output-view.ts";

export function inspectionText(view: TerminalReadModel, id = "") {
  if (id) {
    const snap = view.get(id);
    return snap ? buildStatusResult(snap) : `Unknown terminal id "${id}".`;
  }
  return (
    view.list().map(describeTerminal).join("\n") || "No background terminals."
  );
}

/** No custom screen, timers, subscriptions, or second scrolling implementation. */
export async function openTerminalPicker(
  ctx: ExtensionCommandContext,
  view: TerminalReadModel,
  id = "",
) {
  if (!ctx.hasUI) return;
  const text = sanitizeText(inspectionText(view, id));
  if (ctx.mode === "tui" && id)
    await ctx.ui.editor(`Background terminal ${id} (inspection only)`, text);
  else
    ctx.ui.notify(
      text +
        (view.size() && !id
          ? "\n/ps <id> to inspect output; use bg_kill to stop."
          : ""),
      "info",
    );
}
