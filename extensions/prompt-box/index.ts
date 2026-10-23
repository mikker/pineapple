import {
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getSkills } from "../inline-skills/skills.ts";
import { PromptBoxEditor } from "./editor.ts";

export default function promptBox(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || ctx.ui.getEditorComponent()) return;
    const maxVisible = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    }).getAutocompleteMaxVisible();
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new PromptBoxEditor(
          tui,
          theme,
          keybindings,
          () => getSkills(pi.getCommands()),
          (text) => ctx.ui.theme.fg("accent", text),
          maxVisible,
        ),
    );
  });
}
