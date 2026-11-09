/** Escape text (a file path, a message) so it matches literally inside a RegExp. */
export const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
