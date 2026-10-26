import type { ArcgisAssistant } from "@arcgis/ai-components/components/arcgis-assistant";

export function unwrapTextBlocks(content: unknown): string | null {
  if (typeof content !== "string" || !content.trim().startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const text: string[] = [];
  for (const block of parsed) {
    if (typeof block !== "object" || block === null ||
        block.type !== "text" || typeof block.text !== "string" ||
        Object.keys(block).some(key => !["type", "text", "index"].includes(key))) return null;
    text.push(block.text);
  }
  return text.join("\n\n");
}

export function formatUsdAmounts(content: string): string {
  const amount = String.raw`-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
  const currency = new RegExp(
    String.raw`(?<![\w.,])(?:(-?)\$\s*(${amount})(?:\s+USD\b)?|USD\s+(${amount})|(${amount})\s+USD\b)(?![\d,]|\.\d|[eE][+-]?\d)`,
    "gi",
  );
  // Leave code, links, and URLs untouched rather than rewriting examples or destinations.
  return content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|!?\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s<>]+)/g)
    .map((part, index) => index % 2 ? part : part.replace(currency, (
      _match, prefixSign: string | undefined, dollars: string | undefined,
      usdPrefix: string | undefined, usdSuffix: string | undefined,
    ) => {
      const value = dollars ?? usdPrefix ?? usdSuffix!;
      const negative = prefixSign === "-" || value.startsWith("-");
      const [whole, fraction] = value.replace(/^-/, "").replaceAll(",", "").split(".");
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return `${negative ? "-" : ""}$${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
    })).join("");
}

export function installAssistantPresentation(assistant: ArcgisAssistant): void {
  // Retain SDK actions, errors, and sanitized Markdown rendering.
  assistant.addEventListener("arcgisSlottableRequest", event => {
    const { name, slotName, data } = event.detail;
    if (name !== "block" || data?.block?.type !== "text") return;
    // SDK parts are rendered HTML; the completed message retains the original model text.
    // Message content is only equivalent to this block when it is the sole response block.
    const rawMessage = data.message?.blocks?.length === 1 && !data.message.isStreaming
      ? data.message.content : undefined;
    const messageContent = unwrapTextBlocks(rawMessage);
    const parts: unknown = data.block.data?.parts;
    const source = Array.isArray(parts) && parts.every(part => typeof part === "string")
      ? parts.join("") : data.block.data?.content;
    const unwrapped = messageContent ?? unwrapTextBlocks(source);
    const rawContent = rawMessage ?? data.block.data?.content;
    const prose = unwrapped ?? (typeof rawContent === "string" ? rawContent : null);
    const formatted = prose === null ? null : formatUsdAmounts(prose);
    const content = unwrapped !== null || formatted !== prose ? formatted : null;
    const existing = Array.from(assistant.children).find(child => child.slot === slotName);
    if (content === null) {
      existing?.remove();
      return;
    }
    const text = document.createElement("arcgis-assistant-message-text");
    text.slot = slotName;
    text.content = content;
    if (existing) existing.replaceWith(text);
    else assistant.append(text);
  });
}
