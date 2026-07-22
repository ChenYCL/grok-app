/**
 * Assistant message body — GFM markdown with safe defaults.
 * Images open the global lightbox; right-click offers copy image.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Locale } from "@/i18n";
import { ImageUi, imageUiLabels } from "@/components/ImageUi";

export function MarkdownBody({
  children,
  streaming,
  locale = "zh",
}: {
  children: string;
  streaming?: boolean;
  locale?: Locale;
}) {
  const imageLabels = useMemo(() => imageUiLabels(locale), [locale]);

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
          img: ({ src, alt }) => {
            if (!src) return null;
            // Local absolute path in markdown → enable reveal / copy path
            const local =
              src.startsWith("/") || /^[A-Za-z]:[\\/]/.test(src)
                ? src
                : undefined;
            return (
              <ImageUi
                className="md-body__img"
                src={src}
                alt={alt ?? ""}
                path={local}
                labels={imageLabels}
              />
            );
          },
        }}
      >
        {children || (streaming ? " " : "")}
      </ReactMarkdown>
    </div>
  );
}
