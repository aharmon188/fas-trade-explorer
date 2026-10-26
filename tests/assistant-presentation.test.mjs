import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { formatUsdAmounts, installAssistantPresentation, unwrapTextBlocks } from "../prototype/assistant-presentation.ts";

test("live SDK parts payload renders prose through the installed presentation handler", () => {
  const prose = "Mexico had the highest wheat exports, at **126343112 USD**.";
  const serialized = JSON.stringify([{ type: "text", text: prose, index: 0 }]);
  const text = { slot: "", content: undefined };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => text };
  try {
    let handler;
    const assistant = {
      children: [],
      addEventListener: (_name, callback) => { handler = callback; },
      append: child => assistant.children.push(child),
    };
    installAssistantPresentation(assistant);
    handler({ detail: {
      name: "block", slotName: "live-response",
      data: { block: { type: "text", data: { parts: [serialized.slice(0, 30), serialized.slice(30)] } } },
    } });
    assert.equal(assistant.children.length, 1, "Live streamed text must get a custom prose renderer");
    assert.equal(text.content, "Mexico had the highest wheat exports, at **$126,343,112**.");
    assert.equal(text.slot, "live-response");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("completed SDK HTML parts use the raw message content, not rendered HTML", () => {
  const prose = "Mexico had the highest wheat exports, at **126343112 USD**.";
  const serialized = JSON.stringify([{ type: "text", text: prose, index: 0 }]);
  const parts = marked.lexer(serialized).filter(token => token.type !== "space")
    .map(token => marked.parser([token]));
  assert.match(parts[0], /<p>/);
  const block = { type: "text", data: { parts } };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ slot: "", content: undefined }) };
  try {
    let handler;
    const assistant = {
      children: [],
      addEventListener: (_name, callback) => { handler = callback; },
      append: child => assistant.children.push(child),
    };
    installAssistantPresentation(assistant);
    handler({ detail: {
      name: "block", slotName: "completed-response",
      data: { block, index: 0, message: {
        id: "completed", role: "assistant", content: serialized,
        isStreaming: false, blocks: [block],
      } },
    } });
    assert.equal(assistant.children.length, 1, "SDK HTML parts must not bypass the prose adapter");
    assert.equal(assistant.children[0].content, "Mexico had the highest wheat exports, at **$126,343,112**.");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("screenshot response becomes prose without changing its unverified number", () => {
  const prose = "**Mexico** had the highest wheat exports, valued at **126343112 USD**.";
  assert.equal(unwrapTextBlocks(JSON.stringify([{ type: "text", text: prose, index: 0 }])), prose);
  assert.equal(unwrapTextBlocks('[{"type":"text","text":"First"},{"type":"text","text":"Second"}]'), "First\n\nSecond");
});

test("ordinary text, incomplete streams, and non-text or unrecognized JSON stay with the SDK", () => {
  for (const content of [
    "Ordinary **Markdown**", '[{"type":"text","text":"unfinished', "[]",
    '[{"type":"chart","text":"Not prose"}]', '[{"type":"text","text":"x","action":"unknown"}]',
    '[{"type":"text","text":42}]', '[null]', undefined,
  ]) assert.equal(unwrapTextBlocks(content), null);
});

test("USD presentation adds dollar signs and grouping without changing precision", () => {
  for (const [input, expected] of [
    ["126343112 USD", "$126,343,112"],
    ["**126343112 USD**", "**$126,343,112**"],
    ["USD 1184773992", "$1,184,773,992"],
    ["$126343112", "$126,343,112"],
    ["$126,343,112 USD", "$126,343,112"],
    ["126343112.50 USD", "$126,343,112.50"],
    ["9007199254740993.01 USD", "$9,007,199,254,740,993.01"],
    ["-1234.50 USD and -$5678", "-$1,234.50 and -$5,678"],
    ["0 USD; 12 usd; $1,234.00", "$0; $12; $1,234.00"],
    ["2026, 12 months, 240 records, 10%, 9962 MT, 1234 EUR", "2026, 12 months, 240 records, 10%, 9962 MT, 1234 EUR"],
    ["`1234 USD` and [source](https://example.test/1234USD)", "`1234 USD` and [source](https://example.test/1234USD)"],
    ["1.2e6 USD; 12,34 USD", "1.2e6 USD; 12,34 USD"],
  ]) {
    assert.equal(formatUsdAmounts(input), expected, input);
    assert.equal(formatUsdAmounts(expected), expected, "Formatting should be idempotent");
  }
});

test("ordinary completed prose also receives USD formatting through the handler", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ slot: "", content: undefined }) };
  try {
    let handler;
    const assistant = {
      children: [],
      addEventListener: (_name, callback) => { handler = callback; },
      append: child => assistant.children.push(child),
    };
    installAssistantPresentation(assistant);
    const block = { type: "text", data: { parts: ["<p>Value: 1234567 USD</p>"] } };
    handler({ detail: {
      name: "block", slotName: "plain-response",
      data: { block, message: { role: "assistant", content: "Value: 1234567 USD", blocks: [block], isStreaming: false } },
    } });
    assert.equal(assistant.children[0].content, "Value: $1,234,567");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
