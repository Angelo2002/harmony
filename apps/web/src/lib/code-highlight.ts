/**
 * Loads the highlighter on first use, the same way the unicode emoji set is
 * loaded: most sessions never see a code block with a language on it, so the
 * highlighter is not part of the app until one does.
 */
type Highlighter = typeof import('./highlighter');

let pending: Promise<Highlighter> | null = null;

/**
 * The code as highlighted HTML, or null when the language is unknown or the
 * highlighter could not be fetched. A failure is not remembered, so the next
 * code block gets another try instead of staying plain for the whole session.
 */
export async function highlightCode(code: string, language: string): Promise<string | null> {
  pending ??= import('./highlighter').catch((cause: unknown) => {
    pending = null;
    throw cause;
  });
  try {
    return (await pending).highlight(code, language);
  } catch {
    return null;
  }
}
