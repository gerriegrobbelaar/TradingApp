/**
 * Skeleton for the Exact XML API (XMLUpload.aspx). Only the envelope, escaping and the
 * response message parser live here; topic bodies (MatchSets) come in a later task.
 */

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
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
  ok: boolean;
}

// Message type codes: 0 info, 1 warning, 2 error, 3 fatal. VERIFY with real credentials (0014).
const SEVERITY: Record<string, XmlMessageSeverity> = {
  "0": "info",
  "1": "warning",
  "2": "error",
  "3": "fatal",
};

/** Extract `<Message type="n"><Description>..</Description></Message>` entries from a response. */
export function parseXmlResponse(xml: string): XmlUploadResult {
  const messages: XmlMessage[] = [];
  const re = /<Message\b([^>]*)>([\s\S]*?)<\/Message>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const type = /\btype="(\d+)"/.exec(m[1] ?? "")?.[1] ?? "2";
    const desc = /<Description>([\s\S]*?)<\/Description>/.exec(m[2] ?? "")?.[1] ?? "";
    messages.push({ severity: SEVERITY[type] ?? "error", description: xmlUnescape(desc.trim()) });
  }
  const ok = !messages.some((x) => x.severity === "error" || x.severity === "fatal");
  return { messages, ok };
}
