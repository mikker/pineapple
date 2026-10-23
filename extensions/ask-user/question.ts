import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AskUserInput } from "./index.ts";

// Only the native, signal-aware dialogs are needed, in both TUI and RPC mode.
type QuestionContext = {
  hasUI: boolean;
  ui: Pick<ExtensionUIContext, "select" | "input">;
};

export async function askQuestion(
  params: AskUserInput,
  ctx: QuestionContext,
  signal?: AbortSignal,
) {
  if (params.options.length < 2 || params.options.length > 5) {
    throw new Error(
      `ask_user requires between 2 and 5 options (got ${params.options.length}). Retry with a valid number of options.`,
    );
  }
  if (signal?.aborted) return { kind: "cancelled" } as const;
  if (!ctx.hasUI) return { kind: "no-ui" } as const;

  // Numbering keeps duplicate labels and the free-form entry unambiguous even
  // though the native/RPC selector returns a string rather than an index.
  const choices = params.options.map(
    (option, index) =>
      `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
  );
  const customChoice = "Write my own answer…";

  while (true) {
    const selected = await ctx.ui.select(
      params.question,
      [...choices, customChoice],
      { signal },
    );
    if (signal?.aborted) return { kind: "cancelled" } as const;
    if (selected === undefined) return { kind: "dismissed" } as const;

    if (selected === customChoice) {
      const answer = (
        await ctx.ui.input(
          params.question,
          "Your answer (Esc returns to choices)",
          {
            signal,
          },
        )
      )?.trim();
      if (signal?.aborted) return { kind: "cancelled" } as const;
      if (answer) return { kind: "custom", answer } as const;
      // Escape or a blank answer returns to the choices, never invents an answer.
      continue;
    }

    const index = choices.indexOf(selected);
    if (index < 0) {
      // RPC clients must return one of the exact choices they were sent.
      throw new Error("ask_user received an unknown selection from the UI.");
    }
    return {
      kind: "selected",
      answer: params.options[index].label,
      index: index + 1,
    } as const;
  }
}
