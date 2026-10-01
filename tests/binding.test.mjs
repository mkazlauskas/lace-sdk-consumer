import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingKey, readBinding } from "../src/binding.ts";

const signer = "https://passkey-preview.lace.io";
const binding = "a".repeat(128);
const storage = (value) => ({ getItem: (key) => key === bindingKey(signer) ? value : null });

test("opens only a valid public binding", () => {
  assert.equal(readBinding(storage(JSON.stringify(binding)), signer), binding);
  assert.equal(readBinding(storage(null), signer), null);
  assert.equal(readBinding(storage(JSON.stringify(binding)), "https://passkey.lace.io"), null);
  assert.equal(bindingKey(`${signer}/path`), bindingKey(signer));
});

test("corrupt or legacy binding fails closed", () => {
  for (const raw of ["{", "null", JSON.stringify({ credentialId: "old", rpId: "localhost" }), JSON.stringify("a".repeat(64)), JSON.stringify("g".repeat(128)), JSON.stringify("")]) {
    assert.throws(() => readBinding(storage(raw), signer), /Saved wallet binding is invalid/);
  }
});
