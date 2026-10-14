/** The letter an avatar without a picture shows: the name's first, upper-cased. */
export const monogramOf = (name: string): string => name.trim().slice(0, 1).toUpperCase();
