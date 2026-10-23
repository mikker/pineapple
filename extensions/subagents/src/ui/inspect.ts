import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { latestText } from "../domain.ts";
import type { SubagentReadModel } from "../manager.ts";

/** Use Pi's dialogs rather than owning a second editor and terminal lifecycle. */
export async function inspectSubagents(
  ui: Pick<ExtensionCommandContext["ui"], "select" | "editor">,
  view: Pick<SubagentReadModel, "list" | "get">,
) {
  while (true) {
    const choices = view.list().map((snap) => ({
      id: snap.id,
      label: `${snap.id} [${snap.status}] ${snap.backend} · ${snap.title}`,
    }));
    const selected = await ui.select(
      "Subagents (reopen to refresh)",
      choices.map((choice) => choice.label),
    );
    const id = choices.find((choice) => choice.label === selected)?.id;
    if (!id) return;
    const snap = view.get(id);
    if (!snap) continue;
    await ui.editor(
      `${snap.id} [${snap.status}] ${snap.title} — inspection only`,
      [
        `Backend: ${snap.backend}`,
        `Model: ${snap.meta.modelLabel ?? "default"}`,
        `Directory: ${snap.cwd}`,
        `Transcript: ${snap.meta.sessionFilePath ?? "unavailable"}`,
        ...(snap.errorText ? [`Error: ${snap.errorText}`] : []),
        "",
        latestText(snap) || "(no output yet)",
      ].join("\n"),
    );
  }
}
