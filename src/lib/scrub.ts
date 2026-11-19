/** Removes obvious identifiers from text before it leaves the server (error trackers, third-party AI APIs). */
export function scrubPii(s: string): string {
  return s
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]')
    .replace(/\b\d{9}\b/g, '[SSN]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[CARD]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/(?<![\d-])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, '[PHONE]');
}
