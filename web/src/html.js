/**
 * Escape a value for safe interpolation into HTML text or a quoted attribute.
 * Every piece of contract, wallet or user data must pass through this before
 * it is placed in a template string.
 */
export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
