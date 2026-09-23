import assert from "node:assert/strict";
import test from "node:test";
import { toDeclarations } from "../src/telegram/catalog.js";
import { normalizePhone, readConfig, DEFAULT_MODELS } from "../src/telegram/config.js";
import { markdownToTelegramHtml, splitMessage } from "../src/telegram/format.js";
import { cleanSchema } from "../src/telegram/schema.js";

test("the schema cleaner removes a nullable anyOf and keeps a parameter named title", () => {
  const cleaned = cleanSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: "AddCategoryArgs",
    additionalProperties: false,
    properties: {
      title: { type: "string", title: "Title", description: "The category's name." },
      hint: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "Where it is." },
      items: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: { title: { type: "string" } } }
      }
    },
    required: ["title"]
  });
  assert.deepEqual(cleaned, {
    type: "object",
    properties: {
      title: { type: "string", description: "The category's name." },
      hint: { type: "string", description: "Where it is." },
      items: { type: "array", items: { type: "object", properties: { title: { type: "string" } } } }
    },
    required: ["title"]
  });
});

test("the schema cleaner keeps a union that is more than nullable", () => {
  const cleaned = cleanSchema({ anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] });
  assert.deepEqual(cleaned, { anyOf: [{ type: "string" }, { type: "integer" }] });
});

test("declarations drop the excluded tool and the hidden parameter", () => {
  const declarations = toDeclarations([
    {
      name: "shopping_add_category",
      description: "Add a category.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, response_format: { type: "string" } },
        required: ["title", "response_format"]
      }
    },
    { name: "shopping_delete_list", inputSchema: { type: "object", properties: {} } }
  ]);
  assert.deepEqual(declarations, [
    {
      name: "shopping_add_category",
      description: "Add a category.",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
    }
  ]);
});

test("the built catalog was generated and is clean", async () => {
  const { BUILT_CATALOG } = await import("../src/telegram/catalog-data.js");
  assert.ok(BUILT_CATALOG, "npm run build should have generated the catalog");
  assert.equal(BUILT_CATALOG.length, 15);
  const addCategory = BUILT_CATALOG.find(tool => tool.name === "shopping_add_category");
  assert.ok(Object.keys(addCategory!.parameters.properties as object).includes("title"));
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      assert.ok(!["$schema", "additionalProperties", "$ref"].includes(key), `found ${key}`);
      walk(value);
    }
  };
  for (const tool of BUILT_CATALOG) {
    walk(tool.parameters);
    assert.ok(!("response_format" in (tool.parameters.properties as object)));
  }
});

test("phones compare equal however they are written", () => {
  for (const written of ["052-1234567", "0521234567", "+972 52 123 4567", "972521234567", "00972521234567"]) {
    assert.equal(normalizePhone(written), "972521234567", written);
  }
});

test("config needs the token and the webhook secret, and splits its lists", () => {
  assert.equal(readConfig({ TELEGRAM_BOT_TOKEN: "t" }), null);
  const config = readConfig({
    TELEGRAM_BOT_TOKEN: " t ",
    TELEGRAM_WEBHOOK_SECRET: "s",
    BOT_ALLOWED_USER_IDS: "1, 2\n3, nope",
    BOT_ALLOWED_PHONES: "052-1234567; +972501111111",
    BOT_MODEL: "a , b"
  });
  assert.deepEqual([...config!.allowedUserIds], [1, 2, 3]);
  assert.deepEqual([...config!.allowedPhones], ["972521234567", "972501111111"]);
  assert.deepEqual(config!.models, ["a", "b"]);
  assert.equal(config!.geminiKey, null);
  assert.deepEqual(readConfig({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s" })!.models, DEFAULT_MODELS);
});

test("Markdown becomes Telegram HTML, escaped", () => {
  assert.equal(
    markdownToTelegramHtml("# כותרת\n- **חלב** & <ביצים>\n[הרשימה](https://example.com/?a=1&b=2)"),
    '<b>כותרת</b>\n• <b>חלב</b> &amp; &lt;ביצים&gt;\n<a href="https://example.com/?a=1&amp;b=2">הרשימה</a>'
  );
});

test("splitting prefers line breaks and cuts an overlong line", () => {
  const chunks = splitMessage(["a".repeat(30), "b".repeat(30), "c".repeat(90)].join("\n"), 64);
  assert.deepEqual(chunks, ["a".repeat(30) + "\n" + "b".repeat(30), "c".repeat(64), "c".repeat(26)]);
});
