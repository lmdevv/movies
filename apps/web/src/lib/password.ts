/** The shortest password the server accepts for a new account. */
export const MIN_PASSWORD_LENGTH = 8;

/** The `14 characters` check line under a new password, once it is long enough. */
export const passwordHint = (password: string): string | undefined =>
  password.length >= MIN_PASSWORD_LENGTH ? `${password.length} characters` : undefined;
