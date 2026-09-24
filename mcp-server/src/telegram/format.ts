/**
 * Turning the model's Markdown into something Telegram displays well.
 *
 * Telegram's Markdown modes are strict and fail on stray characters, which a model produces all
 * the time, so replies go out as Telegram HTML instead, with a plain-text resend if even that is
 * refused.
 */

/** Telegram's hard limit on one message's text. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Convert the Markdown a model typically writes into Telegram's HTML subset. */
export function markdownToTelegramHtml(markdown: string): string {
  return markdown
    .split("\n")
    .map(line => {
      let html = escapeHtml(line);
      // Headings have no Telegram equivalent; bold is the closest.
      html = html.replace(/^#{1,6}\s+(.+)$/, "<b>$1</b>");
      html = html.replace(/^(\s*)[-*]\s+/, "$1• ");
      html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
      html = html.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        // The URL was already escaped with the line; only quotes still need escaping.
        (_, text: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${text}</a>`
      );
      return html;
    })
    .join("\n");
}

/**
 * Split text into chunks Telegram accepts, preferring line breaks over cutting mid-line.
 *
 * Split before converting to HTML, so a tag never spans two messages: every conversion above
 * works within one line.
 */
export function splitMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT - 96): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim()) chunks.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let start = 0; start < line.length; start += limit) chunks.push(line.slice(start, start + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks.length ? chunks : [text.slice(0, limit) || "…"];
}
