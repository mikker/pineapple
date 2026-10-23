import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  resolvePiModel,
  shutdownAndDisposeChildSession,
} from "./src/backends/pi.ts";

test("Pi model resolution uses the current SDK runtime without provider requests", async () => {
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModels()[0];
  assert.ok(model, "installed Pi has a static model catalog");
  const inherited = { provider: model.provider, id: model.id };
  assert.equal(resolvePiModel(runtime, undefined, inherited), model);
  assert.equal(resolvePiModel(runtime, model.id, inherited), model);
  assert.equal(
    resolvePiModel(runtime, `${model.provider}/${model.id}`, undefined),
    model,
  );
  assert.equal(resolvePiModel(runtime, undefined, undefined), undefined);
  assert.throws(
    () => resolvePiModel(runtime, "missing-provider/missing-model", inherited),
    /Unknown model/,
  );
  assert.throws(
    () =>
      resolvePiModel(runtime, undefined, {
        provider: "missing",
        id: "missing",
      }),
    /Unknown inherited model/,
  );
});

test("child shutdown emits session_shutdown before disposing even if a hook fails", async () => {
  const calls: string[] = [];
  await shutdownAndDisposeChildSession({
    extensionRunner: {
      hasHandlers: () => true,
      emit: async (event) => {
        calls.push(event.type);
        throw new Error("shutdown hook failed");
      },
    },
    dispose: () => {
      calls.push("dispose");
    },
  });
  assert.deepEqual(calls, ["session_shutdown", "dispose"]);
});
