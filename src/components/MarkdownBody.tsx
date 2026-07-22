/**
 * Assistant message body — GFM markdown with safe defaults.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownBody({
  children,
  streaming,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <div
      className={
        "md-body" + (streaming ? " md-body--streaming" : "")
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {c}
            </a>
          ),
          pre: ({ children: c }) => <pre className="md-body__pre">{c}</pre>,
          code: ({ className, children: c }) => {
            const inline = !className;
            if (inline) {
              return <code className="md-body__code-inline">{c}</code>;
            }
            return <code className={className}>{c}</code>;
          },
        }}
      >
        {children || (streaming ? " " : "")}
      </ReactMarkdown>
    </div>
  );
}
