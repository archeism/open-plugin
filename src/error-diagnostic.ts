/** Render any thrown value as stable, nonempty diagnostic text. */
export function unknownErrorDiagnostic(value: unknown): string {
  try {
    if (value instanceof Error) {
      const message = value.message.trim();
      if (message.length > 0) return message;
      const name = value.name.trim();
      if (name.length > 0) return name;
    }
  } catch {
    // Fall through for hostile proxies and Error subclasses.
  }
  try {
    const text = String(value).trim();
    if (text.length > 0) return text;
  } catch {
    // A thrown value may itself reject primitive conversion.
  }
  return 'unknown thrown value';
}
