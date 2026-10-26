import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

function keepDisclosureSpace(event: KeyboardEvent<HTMLElement>) {
  // The canvas listens for Space on window; preserve native summary activation.
  if (event.key === " ") event.stopPropagation();
}
// Small, safe Markdown renderer: builds React elements only (no HTML injection, no links
// that navigate, no images). Supports headings, lists, fenced/inline code, bold, italics.
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0,
    n = 0,
    m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    out.push(
      t.startsWith("`") ? (
        <code key={k}>{t.slice(1, -1)}</code>
      ) : t.startsWith("**") ? (
        <strong key={k}>{t.slice(2, -2)}</strong>
      ) : (
        <em key={k}>{t.slice(1, -1)}</em>
      ),
    );
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = "b" + i;
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().split(/\s+/, 1)[0];
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```"))
        code.push(lines[i++]);
      i++;
      const body = (
        <pre>
          <code>{code.join("\n")}</code>
        </pre>
      );
      blocks.push(
        code.length > 10 || code.join("\n").length > 600 ? (
          <details className="markdown-code" key={key}>
            <summary>
              {language ? `${language} · ` : ""}
              {code.length} lines of code
            </summary>
            {body}
          </details>
        ) : (
          <div className="markdown-code" key={key}>
            {body}
          </div>
        ),
      );
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)![0].length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(
        <Tag key={key}>{inline(line.replace(/^#+\s*/, ""), key)}</Tag>,
      );
      i++;
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(
          <li key={"l" + i}>
            {inline(lines[i].replace(/^\s*[-*]\s+/, ""), "l" + i)}
          </li>,
        );
        i++;
      }
      blocks.push(<ul key={key}>{items}</ul>);
    } else if (!line.trim()) i++;
    else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith("```") &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i])
      )
        para.push(lines[i++]);
      blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
    }
  }
  return <div className="markdown">{blocks}</div>;
}

export function MessageMarkdown({
  text,
  collapsible = false,
}: {
  text: string;
  collapsible?: boolean;
}) {
  const long = text.length > 2200 || text.split("\n").length > 32;
  if (!collapsible || !long) return <Markdown text={text} />;
  const preview = text
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/[`*_#>-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const description =
    preview.length > 180 ? preview.slice(0, 177) + "…" : preview;
  return (
    <details className="message-disclosure">
      <summary onKeyDown={keepDisclosureSpace}>
        <ChevronRight
          className="message-disclosure-chevron"
          size={14}
          aria-hidden="true"
        />
        <span className="message-disclosure-label">Long reply</span>
        <span className="message-disclosure-preview">{description}</span>
      </summary>
      <Markdown text={text} />
    </details>
  );
}
