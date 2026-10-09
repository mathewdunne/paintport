// Object and part names reach the core as raw XML attribute text (the classic tool never
// decoded them, and the parity suite pins that down). The document holds them as plain text,
// and `build3MF` escapes them again on the way out.

const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML 1.0 `Char`: the code points that may appear in a document. */
const isXmlChar = (cp: number): boolean =>
  cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

/**
 * Decodes the five predefined entities and numeric character references (`&#65;`, `&#x41;`)
 * in one pass, so `&amp;lt;` becomes `&lt;` and not `<`. Anything else that looks like a
 * reference but is not a valid one (`&foo;`, `&#xZZ;`, `&#0;`, a surrogate, a value past
 * U+10FFFF, a bare `&`) is left as it is.
 */
export function unescapeXml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#x([0-9A-Fa-f]{1,8})|#([0-9]{1,10})|(lt|gt|amp|quot|apos));/g, (whole, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return NAMED[name];
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    return isXmlChar(cp) ? String.fromCodePoint(cp) : whole;
  });
}
