import {
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getSkills } from "../inline-skills/skills.ts";
import { PromptBoxEditor } from "./editor.ts";
import { promptStatus, readGitStatus } from "./status.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ImagePathLabels } from "./images.ts";

export default function promptBox(pi: ExtensionAPI) {
  let images: ImagePathLabels | undefined;
  let refresh: (() => Promise<void>) | undefined;
  let stop: (() => void) | undefined;
  pi.on("input", (event) => {
    const text = images?.expand(event.text) ?? event.text;
    if (text !== event.text) return { action: "transform", text };
  });
  pi.on("tool_execution_end", async () => {
    await refresh?.();
  });
  pi.on("agent_end", async () => {
    await refresh?.();
  });
  pi.on("session_shutdown", () => {
    stop?.();
    refresh = undefined;
    images = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || ctx.ui.getEditorComponent()) return;
    images = new ImagePathLabels({ cwd: ctx.cwd });
    let git: Awaited<ReturnType<typeof readGitStatus>>;
    let getStatuses: () => ReadonlyMap<string, string> = () => new Map();
    let requestRender = () => {};
    let active = true;
    let pending: Promise<void> | undefined;
    stop = () => {
      active = false;
    };
    refresh = () =>
      (pending ??= readGitStatus(ctx.cwd)
        .then((value) => {
          if (active) {
            git = value;
            requestRender();
          }
        })
        .finally(() => {
          pending = undefined;
        }));

    ctx.ui.setFooter((tui, _theme, data) => {
      requestRender = () => tui.requestRender();
      getStatuses = () => data.getExtensionStatuses();
      const unsubscribe = data.onBranchChange(() => {
        void refresh?.();
      });
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width) {
          const remaining = [...getStatuses()]
            .filter(([key]) => key !== "codex-booster")
            .map(([, text]) => text);
          return remaining.length
            ? [truncateToWidth(remaining.join("  "), width)]
            : [];
        },
      };
    });
    void refresh();
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
          {
            dim: (text) => ctx.ui.theme.fg("dim", text),
            status: () =>
              promptStatus(
                ctx.cwd,
                git,
                ctx.model?.id,
                pi.getThinkingLevel(),
                getStatuses().get("codex-booster"),
                ctx.ui.theme,
              ),
          },
          images,
        ),
    );
  });
}
