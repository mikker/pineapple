import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { askQuestion } from "./question.ts";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const AskUserParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(
    Type.Object({
      label: Type.String({
        description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
      }),
      description: Type.Optional(
        Type.String({
          description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
        }),
      ),
    }),
    {
      minItems: 2,
      maxItems: 5,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
    },
  ),
});

export type AskUserInput = Static<typeof AskUserParams>;

export const askUserTool = defineTool({
  name: "ask_user",
  label: "Ask User",
  description: ASK_USER_TOOL_DESCRIPTION,
  promptSnippet: ASK_USER_PROMPT_SNIPPET,
  promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
  parameters: AskUserParams,
  // Independent sibling tools may run while the dialog is open. The next model
  // turn still waits for this result, like every other tool in the batch.
  executionMode: "parallel",

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const outcome = await askQuestion(params, ctx, signal);
    const answered = outcome.kind === "selected" || outcome.kind === "custom";
    return {
      content: [{ type: "text", text: buildAskUserResultMessage(outcome) }],
      details: {
        question: params.question,
        options: params.options.map((option) => option.label),
        answer: answered ? outcome.answer : null,
        wasCustom: outcome.kind === "custom",
        cancelled: !answered,
        // Keep the original details fields for existing sessions/consumers.
        outcome: outcome.kind,
      },
    };
  },

  renderCall(args, theme) {
    return new Text(
      theme.fg("toolTitle", theme.bold("ask_user ")) +
        theme.fg(
          "muted",
          typeof args.question === "string" ? args.question : "",
        ),
      0,
      0,
    );
  },

  renderResult(result, _options, theme) {
    // The text also distinguishes no UI, abort, and dismissal; old sessions and
    // failed results need no details migration or unsafe casts.
    const first = result.content[0];
    return new Text(
      theme.fg("toolOutput", first?.type === "text" ? first.text : ""),
      0,
      0,
    );
  },
});

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool(askUserTool);
}
