const componentsOf = (version: string): ReadonlyArray<number> =>
  (/^\d+(?:\.\d+)*/u.exec(version.trim())?.[0] ?? "").split(".").flatMap((part) => {
    const value = Number.parseInt(part, 10);

    return Number.isFinite(value) ? [value] : [];
  });

/** Whether `version` is `minimum` or later; versions without leading digits are never supported. */
export const isVersionAtLeast = (version: string, minimum: string): boolean => {
  const actual = componentsOf(version);
  const wanted = componentsOf(minimum);

  if (actual.length === 0) return false;
  const length = Math.max(actual.length, wanted.length);

  for (let index = 0; index < length; index += 1) {
    const left = actual[index] ?? 0;
    const right = wanted[index] ?? 0;

    if (left !== right) return left > right;
  }

  return true;
};
