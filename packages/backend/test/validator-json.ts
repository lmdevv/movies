/**
 * Bridges Effect Schema and Convex validators for the equivalence test: both sides become Convex's
 * validator JSON (what `exportArgs()` and `exportReturns()` emit), normalized so union order and
 * object key order do not matter.
 */
import { CONVEX_TABLE_ANNOTATION } from "@movies/contracts/ids";
import { Match, Predicate, Schema, SchemaAST } from "effect";

/** Convex's JSON description of a validator. */
export type ValidatorJson =
  | { readonly type: "string" | "number" | "boolean" | "null" | "any" | "bigint" | "bytes" }
  | { readonly type: "id"; readonly tableName: string }
  | { readonly type: "literal"; readonly value: string | number | boolean }
  | { readonly type: "array"; readonly value: ValidatorJson }
  | { readonly type: "record"; readonly keys: ValidatorJson; readonly values: FieldJson }
  | { readonly type: "union"; readonly value: ReadonlyArray<ValidatorJson> }
  | { readonly type: "object"; readonly value: Readonly<Record<string, FieldJson>> };

/** One object field in Convex's validator JSON. */
interface FieldJson {
  readonly fieldType: ValidatorJson;
  readonly optional: boolean;
}

const Validator: Schema.Codec<ValidatorJson> = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["string", "number", "boolean", "null", "any", "bigint", "bytes"]),
  }),
  Schema.Struct({ type: Schema.Literal("id"), tableName: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("literal"),
    value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  }),
  Schema.Struct({ type: Schema.Literal("array"), value: Schema.suspend(() => Validator) }),
  Schema.Struct({
    type: Schema.Literal("record"),
    keys: Schema.suspend(() => Validator),
    values: Schema.suspend(() => Field),
  }),
  Schema.Struct({
    type: Schema.Literal("union"),
    value: Schema.Array(Schema.suspend(() => Validator)),
  }),
  Schema.Struct({
    type: Schema.Literal("object"),
    value: Schema.Record(
      Schema.String,
      Schema.suspend(() => Field),
    ),
  }),
]);

const Field: Schema.Codec<FieldJson> = Schema.Struct({
  fieldType: Schema.suspend(() => Validator),
  optional: Schema.Boolean,
});

/** Parses the JSON string `exportArgs()` or `exportReturns()` returns; `null` means no validator. */
export const parseExportedValidator = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(Validator)),
);

const unsupported = (node: SchemaAST.AST): never => {
  throw new Error(`No Convex validator matches the schema ${String(node)}`);
};

/** Describes a schema's encoded side as Convex validator JSON. */
export const validatorFromSchema = (ast: SchemaAST.AST): ValidatorJson =>
  // Wire values are the encoded side. Only schemas with an encoding differ from their type side,
  // and walking the type side keeps annotations such as an ID's Convex table.
  Match.valueTags(ast.encoding === undefined ? ast : SchemaAST.toEncoded(ast), {
    String: (node): ValidatorJson => {
      const table = SchemaAST.resolve(node)?.[CONVEX_TABLE_ANNOTATION];

      return Predicate.isString(table) ? { type: "id", tableName: table } : { type: "string" };
    },
    Number: (): ValidatorJson => ({ type: "number" }),
    Boolean: (): ValidatorJson => ({ type: "boolean" }),
    Null: (): ValidatorJson => ({ type: "null" }),
    Literal: (node): ValidatorJson =>
      Predicate.isBigInt(node.literal)
        ? unsupported(node)
        : { type: "literal", value: node.literal },
    Arrays: (node): ValidatorJson => {
      const [element] = node.rest;

      return node.elements.length > 0 || element === undefined || node.rest.length > 1
        ? unsupported(node)
        : { type: "array", value: validatorFromSchema(element) };
    },
    Objects: (node): ValidatorJson => {
      const [index] = node.indexSignatures;

      if (index !== undefined && node.propertySignatures.length === 0) {
        return {
          type: "record",
          keys: validatorFromSchema(index.parameter),
          values: { fieldType: validatorFromSchema(index.type), optional: false },
        };
      }

      return {
        type: "object",
        value: Object.fromEntries(
          node.propertySignatures.map((property) => [
            String(property.name),
            {
              fieldType: validatorFromSchema(property.type),
              optional: SchemaAST.isOptional(property.type),
            },
          ]),
        ),
      };
    },
    Union: (node): ValidatorJson => ({ type: "union", value: node.types.map(validatorFromSchema) }),
    Suspend: (node): ValidatorJson => validatorFromSchema(node.thunk()),
    Any: unsupported,
    BigInt: unsupported,
    Declaration: unsupported,
    Enum: unsupported,
    Never: unsupported,
    ObjectKeyword: unsupported,
    Symbol: unsupported,
    TemplateLiteral: unsupported,
    Undefined: unsupported,
    UniqueSymbol: unsupported,
    Unknown: unsupported,
    Void: unsupported,
  });

/** A canonical form: nested unions flattened, members sorted and deduplicated, keys sorted. */
export const normalizeValidator = (json: ValidatorJson): ValidatorJson => {
  if (json.type === "array") return { type: "array", value: normalizeValidator(json.value) };

  if (json.type === "record") {
    return {
      type: "record",
      keys: normalizeValidator(json.keys),
      values: { ...json.values, fieldType: normalizeValidator(json.values.fieldType) },
    };
  }

  if (json.type === "object") {
    return {
      type: "object",
      value: Object.fromEntries(
        Object.entries(json.value)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, field]) => [
            key,
            { ...field, fieldType: normalizeValidator(field.fieldType) },
          ]),
      ),
    };
  }

  if (json.type !== "union") return json;

  const members = json.value
    .map(normalizeValidator)
    .flatMap((member) => (member.type === "union" ? member.value : [member]));

  const unique = [...new Map(members.map((member) => [JSON.stringify(member), member])).entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, member]) => member);

  return unique.length === 1 && unique[0] !== undefined
    ? unique[0]
    : { type: "union", value: unique };
};
