import assert from "node:assert/strict";
import { test } from "node:test";
import { BINDING_KEY, readBinding } from "../src/binding.ts";

const binding = { credentialId: "c0-Credential_id", rpId: "localhost", recipeVersion: "v1", fingerprint: "a".repeat(64) };
const storage = (value) => ({ getItem: (key) => key === BINDING_KEY ? value : null });

test("opens only a valid public binding", () => {
  assert.deepEqual(readBinding(storage(JSON.stringify(binding))), binding);
  assert.equal(readBinding(storage(null)), null);
});

test("corrupt, legacy, or wrong-RP binding never creates a new wallet", () => {
  for (const raw of ["{", JSON.stringify({ ...binding, recipeVersion: "c0-2770" }), JSON.stringify({ ...binding, rpId: "elsewhere" }), JSON.stringify({ ...binding, fingerprint: "secret" }), JSON.stringify({ ...binding, credentialId: "" }), JSON.stringify({ ...binding, mnemonicWords: ["secret"] })]) {
    assert.throws(() => readBinding(storage(raw)), /Saved wallet binding is invalid/);
  }
});
