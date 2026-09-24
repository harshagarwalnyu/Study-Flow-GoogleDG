/**
 * Structure-aware chunking for course material.
 *
 * Fixed-width windows cut theorems, worked examples and formulas in half, and a chunk from the
 * middle of a section loses what the section is about. Instead: split into paragraphs, track the
 * current heading, pack whole paragraphs up to a target size, and prefix each chunk with its
 * heading so the embedding (and the prompt) keeps the topic. Only a paragraph that is itself
 * too long is split, at sentence boundaries.
 */

export const TARGET_CHUNK_CHARS = 900;
export const MAX_CHUNK_CHARS = 1500;
const MAX_HEADING_CHARS = 90;

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
// Headings as they appear in PDF-extracted lecture notes, where markdown markers are gone.
// Keywords match any case, but a trailing title must really start uppercase ("3.2 Limits",
// not "3.14 is roughly pi"), so the pattern is built without the /i flag.
const anyCase = (word: string) => word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const NUMBERED_KEYWORDS = ["chapter", "section", "week", "lecture", "unit", "part", "module"].map(anyCase).join("|");
const BLOCK_KEYWORDS = ["theorem", "definition", "lemma", "corollary", "proposition", "example", "remark", "exercise", "problem"].map(anyCase).join("|");
const STRUCTURAL_HEADING = new RegExp(
  `^(?:(?:${NUMBERED_KEYWORDS})\\s+\\d+[\\w.]*|(?:${BLOCK_KEYWORDS})(?:\\s+\\d+[\\w.]*)?|\\d+(?:\\.\\d+)+)` +
    `(?:\\s*[:.\\-–—(]\\s*.*|\\s+[A-Z(].*)?$`,
);

interface Block {
  heading: string;
  text: string;
}

function isHeading(line: string): string | null {
  const md = line.match(MARKDOWN_HEADING);
  if (md) return md[2].trim();
  if (line.length <= MAX_HEADING_CHARS && STRUCTURAL_HEADING.test(line) && !/[.?!]$/.test(line.replace(/\d+\.$/, ""))) {
    return line;
  }
  return null;
}

/** Paragraphs with the heading they sit under. Headings nest by markdown level where known. */
function toBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const stack: Array<{ level: number; title: string; markdown: boolean }> = [];
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const headingPath = () => stack.map((h) => h.title).join(" > ");
  const flush = () => {
    const body = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (body) blocks.push({ heading: headingPath(), text: body });
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const title = isHeading(line);
    if (title) {
      flush();
      const md = line.match(MARKDOWN_HEADING);
      // Structural headings (Theorem 2, Example 3) sit one level below the enclosing markdown
      // heading, so consecutive ones replace each other instead of nesting.
      const level = md ? md[1].length : (stack.filter((h) => h.markdown).at(-1)?.level ?? 0) + 1;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title, markdown: Boolean(md) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Split an over-long paragraph at sentence ends, falling back to hard cuts for unbroken text. */
function splitLong(text: string, limit: number): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current) out.push(current);
      current = "";
      for (let i = 0; i < sentence.length; i += limit) out.push(sentence.slice(i, i + limit));
      continue;
    }
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > limit && current) {
      out.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  return out;
}

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let heading = "";
  let body: string[] = [];

  const header = (h: string) => (h ? `${h}\n` : "");
  const emit = () => {
    if (body.length) chunks.push(`${header(heading)}${body.join("\n")}`.trim());
    body = [];
  };
  const size = () => header(heading).length + body.reduce((n, p) => n + p.length + 1, 0);

  for (const block of toBlocks(text)) {
    if (block.heading !== heading) {
      emit();
      heading = block.heading;
    }
    const room = MAX_CHUNK_CHARS - header(heading).length;
    const pieces = block.text.length > room ? splitLong(block.text, Math.max(200, room)) : [block.text];
    for (const piece of pieces) {
      if (body.length && size() + piece.length + 1 > TARGET_CHUNK_CHARS) emit();
      body.push(piece);
    }
  }
  emit();
  return chunks;
}
