/**
 * Skeleton for the Exact XML API (XMLUpload.aspx). Only the envelope, escaping and the
 * response message parser live here; topic bodies (MatchSets) come in a later task.
 *
 * The response parser is a small regex reader, not an XML engine: it never processes a DTD and
 * never expands entities other than the five predefined ones and numeric character references.
 * A response that declares a DOCTYPE or ENTITY is refused outright (XXE / billion-laughs).
 */
import { ExactApiError } from "./transport";

/** Characters XML 1.0 cannot carry at all, even escaped (C0 controls except tab, LF, CR). */
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
/** An unpaired UTF-16 surrogate: not a character at all, so not encodable in an XML document. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function xmlEscape(text: string): string {
  if (INVALID_XML_CHAR_RE.test(text) || LONE_SURROGATE_RE.test(text))
    throw new RangeError("text contains characters XML cannot carry");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fromCodePointSafe(cp: number): string {
  // Out of range or surrogate: never throw on hostile input, use the replacement character.
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return "\uFFFD";
  }
  return String.fromCodePoint(cp);
}

/** Decode the five predefined entities and numeric references in one pass (no double decode). */
export function xmlUnescape(text: string): string {
  return text.replace(
    /&(lt|gt|quot|apos|amp|#\d{1,8}|#x[0-9a-fA-F]{1,6});/g,
    (whole, ent: string) => {
      switch (ent) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "amp":
          return "&";
        default:
          return ent.startsWith("#x")
            ? fromCodePointSafe(parseInt(ent.slice(2), 16))
            : ent.startsWith("#")
              ? fromCodePointSafe(Number(ent.slice(1)))
              : whole;
      }
    },
  );
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Wrap an already-built topic element string (for example `<MatchSets>...</MatchSets>`). */
export function buildXmlEnvelope(topicXml: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<eExact xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    `xsi:noNamespaceSchemaLocation="eExact-XML.xsd">${topicXml}</eExact>`
  );
}

/** Build a simple element. Attribute values are escaped; `children` must already be XML. */
export function xmlElement(
  name: string,
  attrs: Record<string, string> = {},
  children: string | null = null,
): string {
  if (!NAME_RE.test(name)) throw new RangeError("invalid XML element name");
  const a = Object.entries(attrs)
    .map(([k, v]) => {
      if (!NAME_RE.test(k)) throw new RangeError("invalid XML attribute name");
      return ` ${k}="${xmlEscape(v)}"`;
    })
    .join("");
  return children === null ? `<${name}${a}/>` : `<${name}${a}>${children}</${name}>`;
}

/** Element containing escaped text. */
export function xmlTextElement(name: string, text: string): string {
  return xmlElement(name, {}, xmlEscape(text));
}

export type XmlMessageSeverity = "info" | "warning" | "error" | "fatal";

export interface XmlMessage {
  severity: XmlMessageSeverity;
  description: string;
}

export interface XmlUploadResult {
  messages: XmlMessage[];
  /**
   * No error or fatal message. NOT proof that anything was booked: until ADR 0014 item 13 is
   * verified, callers that book money must read the result back (for example the MatchSet).
   */
  ok: boolean;
}

/**
 * Message type codes. DOUBTFUL, MUST VERIFY before any MatchSet goes live (ADR 0014 item 13):
 * our best recollection of Exact's XML responses is 0 error, 1 warning, 2 success ("Aangemaakt"),
 * 3 fatal. Unknown codes are treated as errors (fail closed).
 */
export const XML_MESSAGE_SEVERITY: Readonly<Record<string, XmlMessageSeverity>> = {
  "0": "error",
  "1": "warning",
  "2": "info",
  "3": "fatal",
};

function textOf(raw: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw.trim());
  return cdata ? (cdata[1] ?? "") : xmlUnescape(raw);
}

/**
 * Extract `<Message type="n"><Description>..</Description></Message>` entries from a response.
 * Throws ExactApiError BAD_XML when the body is not an eExact document (an HTML error or login
 * page must never read as "ok") or when it declares a DOCTYPE/ENTITY.
 */
export function parseXmlResponse(xml: string): XmlUploadResult {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new ExactApiError(200, "Exact XML response declares a DTD; refused", "BAD_XML");
  }
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<eExact\b/.test(xml.replace(/^\uFEFF/, ""))) {
    throw new ExactApiError(200, "Exact XML response is not an eExact document", "BAD_XML");
  }
  const messages: XmlMessage[] = [];
  const re = /<Message\b([^>]*?)(\/?)>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const attrs = m[1] ?? "";
    const type = /\btype\s*=\s*["'](\d+)["']/.exec(attrs)?.[1] ?? "unknown";
    let desc = "";
    if (m[2] !== "/") {
      const end = xml.indexOf("</Message>", re.lastIndex);
      const inner = end === -1 ? "" : xml.slice(re.lastIndex, end);
      if (end !== -1) re.lastIndex = end + "</Message>".length;
      desc = /<Description>([\s\S]*?)<\/Description>/.exec(inner)?.[1] ?? "";
    }
    messages.push({
      severity: XML_MESSAGE_SEVERITY[type] ?? "error",
      description: textOf(desc).trim(),
    });
  }
  const ok = !messages.some((x) => x.severity === "error" || x.severity === "fatal");
  return { messages, ok };
}
