/**
 * Expo's Metro configuration, which already handles the pnpm workspace, plus one guard: the app
 * must bundle exactly one copy of each package in `SINGLETONS`. Two Reacts break hooks, and two
 * copies of Convex or Effect split the client from the SDK's runtime. A second copy fails the
 * bundle loudly instead of shipping.
 */
import { realpathSync } from "node:fs";
import { sep } from "node:path";

import { getDefaultConfig } from "expo/metro-config";

type Resolver = NonNullable<ReturnType<typeof getDefaultConfig>["resolver"]["resolveRequest"]>;

const SINGLETONS = ["react", "react-dom", "react-native", "convex", "effect"] as const;

const defaults = getDefaultConfig(import.meta.dirname);

/** The package folder a resolved file belongs to, or null when it is not inside `name`. */
const packageRoot = (filePath: string, name: string): string | null => {
  const real = realpathSync(filePath);
  const marker = `${sep}node_modules${sep}${name}${sep}`;
  const at = real.lastIndexOf(marker);

  return at === -1 ? null : real.slice(0, at + marker.length - 1);
};

/** The one folder each singleton resolved to so far. */
const seen = new Map<string, string>();

const resolveRequest: Resolver = (context, moduleName, platform) => {
  const resolution = (defaults.resolver.resolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );

  const name = SINGLETONS.find((pkg) => moduleName === pkg || moduleName.startsWith(`${pkg}/`));

  if (name === undefined || resolution.type !== "sourceFile") return resolution;

  const root = packageRoot(resolution.filePath, name);
  const first = seen.get(name);

  if (root === null) return resolution;

  if (first === undefined) seen.set(name, root);
  else if (first !== root)
    throw new Error(`Two copies of ${name} in the bundle:\n${first}\n${root}`);

  return resolution;
};

export default { ...defaults, resolver: { ...defaults.resolver, resolveRequest } };
