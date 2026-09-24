/**
 * Making the tools' JSON Schemas acceptable to Gemini.
 *
 * Gemini's function-declaration format is a subset of JSON Schema and rejects a whole request
 * over one keyword it does not know, so these are removed recursively:
 *
 *  - `$schema`, `$id` and `additionalProperties`
 *  - a `title` annotation, but only when it is a string label
 *  - a nullable union `anyOf: [X, {type: "null"}]`, which becomes X, along with `default: null`
 *
 * Property names are never treated as keywords. The first version of this in the
 * book-recommender bot dropped every key called `title`, which silently deleted a real parameter
 * called `title`; `shopping_add_category` has exactly such a parameter.
 */

type Json = unknown;

const DROPPED_KEYWORDS = new Set(["$schema", "$id", "additionalProperties"]);
/** Keywords whose value is a map from names to schemas, rather than a schema itself. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"]);

const isObject = (value: Json): value is Record<string, Json> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNullSchema = (value: Json): boolean => isObject(value) && value.type === "null";

export function cleanSchema(node: Json): Json {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!isObject(node)) return node;

  let source = node;
  if (Array.isArray(node.anyOf) && node.anyOf.some(isNullSchema)) {
    const { anyOf, ...rest } = node;
    const members = (anyOf as Json[]).filter(member => !isNullSchema(member));
    if (members.length === 1 && isObject(members[0])) {
      // Keep the outer description and similar annotations, which zod puts beside the anyOf.
      source = { ...members[0], ...rest };
    } else {
      source = { ...rest, anyOf: members };
    }
    if (source.default === null) delete source.default;
  }

  const cleaned: Record<string, Json> = {};
  for (const [key, value] of Object.entries(source)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "title" && typeof value === "string") continue;
    if (key === "default" && value === null) continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, cleanSchema(schema)])
      );
      continue;
    }
    cleaned[key] = cleanSchema(value);
  }
  return cleaned;
}
