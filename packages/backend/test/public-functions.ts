/**
 * Every public Convex function, found the way Convex finds them: the modules `convex/_generated/api`
 * lists, and each export the runtime registered as public. The access suite calls each one with
 * sessions that must be refused, so a function added without an `authorize` call fails it even if
 * nobody remembers to add a test.
 */
import type { Value } from "convex/values";
import { Match, Predicate } from "effect";

import type { ValidatorJson } from "./validator-json";
import { apiModules } from "./stack-env";
import { parseExportedValidator } from "./validator-json";

/** A public query, mutation, or action and the shape of its arguments. */
export interface PublicFunction {
  readonly path: `${string}:${string}`;
  readonly kind: "query" | "mutation" | "action";
  readonly args: ValidatorJson | null;
}

/** A module export the Convex runtime registered: a callable object with `isPublic` and kind flags. */
interface Registered {
  readonly isPublic: unknown;
}

const flag = (
  value: Registered,
  name: "isQuery" | "isMutation" | "isAction" | "isPublic",
): boolean => Predicate.hasProperty(value, name) && value[name] === true;

/** The Convex runtime's `exportArgs`; `parseExportedValidator` checks what it returns. */
const isExporter = (value: unknown): value is () => string => Predicate.isFunction(value);

const exportedArgs = (value: Registered): ValidatorJson | null =>
  Predicate.hasProperty(value, "exportArgs") && isExporter(value.exportArgs)
    ? parseExportedValidator(value.exportArgs())
    : null;

const kindOf = (value: Registered): PublicFunction["kind"] | null => {
  if (flag(value, "isQuery")) return "query";

  if (flag(value, "isMutation")) return "mutation";

  return flag(value, "isAction") ? "action" : null;
};

/** Loads every module and lists the functions the Convex runtime would serve publicly. */
export const publicFunctions = async (): Promise<ReadonlyArray<PublicFunction>> => {
  const modules = await Promise.all(
    apiModules().map(async (name) => {
      const loaded: unknown = await import(new URL(`../convex/${name}.ts`, import.meta.url).href);

      return { name, loaded };
    }),
  );

  return modules.flatMap(({ name, loaded }) =>
    Predicate.isObject(loaded)
      ? Object.entries(loaded).flatMap(([exportName, value]): ReadonlyArray<PublicFunction> => {
          // Registered functions are callable objects, so look for the runtime's flag directly.
          if (!Predicate.hasProperty(value, "isPublic") || value.isPublic !== true) return [];
          const kind = kindOf(value);

          return kind === null
            ? []
            : [{ path: `${name}:${exportName}`, kind, args: exportedArgs(value) }];
        })
      : [],
  );
};

const none = (): ReadonlyArray<string> => [];

/** The tables a validator names in `v.id`. */
export const tablesIn = (json: ValidatorJson | null): ReadonlyArray<string> =>
  json === null
    ? []
    : Match.value(json).pipe(
        Match.discriminatorsExhaustive("type")({
          id: (node) => [node.tableName],
          array: (node) => tablesIn(node.value),
          record: (node) => [...tablesIn(node.keys), ...tablesIn(node.values.fieldType)],
          union: (node) => node.value.flatMap(tablesIn),
          object: (node) => Object.values(node.value).flatMap((field) => tablesIn(field.fieldType)),
          string: none,
          number: none,
          boolean: none,
          null: none,
          any: none,
          bigint: none,
          bytes: none,
          literal: none,
        }),
      );

/** The smallest value a validator accepts: required fields only, empty arrays, first union member. */
export const sampleValue = (json: ValidatorJson, ids: ReadonlyMap<string, string>): Value =>
  Match.value(json).pipe(
    Match.discriminatorsExhaustive("type")({
      string: () => "x",
      number: () => 0,
      boolean: () => false,
      null: () => null,
      any: () => null,
      bigint: () => 0n,
      bytes: () => new ArrayBuffer(0),
      literal: (node) => node.value,
      id: (node) => {
        const sampled = ids.get(node.tableName);

        if (sampled === undefined) throw new Error(`No sample ID for ${node.tableName}`);

        return sampled;
      },
      array: () => [],
      record: () => ({}),
      union: (node) => {
        const [first] = node.value;

        if (first === undefined) throw new Error("An empty union accepts nothing");

        return sampleValue(first, ids);
      },
      object: (node) =>
        Object.fromEntries(
          Object.entries(node.value).flatMap(([key, field]) =>
            field.optional ? [] : [[key, sampleValue(field.fieldType, ids)]],
          ),
        ),
    }),
  );
