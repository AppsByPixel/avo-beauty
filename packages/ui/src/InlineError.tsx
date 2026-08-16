export interface InlineErrorProps {
  /** Rendered verbatim. Product copy is written; do not paraphrase it here. */
  message: string;
  id?: string;
}

/**
 * The `--avo-danger-bg` banner from AVO Login.dc.html. `role="alert"` so a
 * validation failure is announced rather than silently appearing above the
 * submit button.
 *
 * The colour resolves through the token custom property in `ui.css`. It is not
 * written as a hex here, not even in a comment: a literal in a comment is the
 * one that survives a white-label change and then disagrees with the token it
 * claims to document.
 */
export function InlineError({ message, id }: InlineErrorProps) {
  return (
    <div className="avo-inline-error" role="alert" {...(id ? { id } : {})}>
      <span className="avo-inline-error__dot" aria-hidden="true" />
      <span className="avo-inline-error__text">{message}</span>
    </div>
  );
}
