import assert from "node:assert/strict";
import test from "node:test";
import { askUserTool } from "./index.ts";

test("loads against current Pi and retains the existing callable question/options contract", () => {
  assert.equal(askUserTool.name, "ask_user");
  assert.equal(askUserTool.executionMode, "parallel");
  assert.deepEqual(askUserTool.parameters.required, ["question", "options"]);
  assert.equal(askUserTool.parameters.properties.options.minItems, 2);
  assert.equal(askUserTool.parameters.properties.options.maxItems, 5);
  assert.ok(askUserTool.promptGuidelines);
  assert.match(askUserTool.promptGuidelines.join(" "), /next model turn waits/);
});
