/**
 * Inline edit for the last user bubble — simple local form, not the main composer.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  isDraftEmpty,
  parseUserMessageContent,
  plainTextOf,
  serializeStored,
} from "@/lib/draftDoc";
import { SkillChip } from "@/components/SkillChip";
import { cn } from "@/lib/utils";

export function InlineUserEdit({
  content,
  busy,
  cancelLabel,
  resendLabel,
  placeholder,
  onCancel,
  onSubmit,
}: {
  content: string;
  busy?: boolean;
  cancelLabel: string;
  resendLabel: string;
  placeholder?: string;
  onCancel: () => void;
  onSubmit: (storedContent: string) => void;
}) {
  const skills = useMemo(() => {
    return parseUserMessageContent(content)
      .filter((s): s is { type: "skill"; name: string } => s.type === "skill")
      .map((s) => s.name);
  }, [content]);

  const initialText = useMemo(
    () => plainTextOf(parseUserMessageContent(content)),
    [content],
  );
  const [text, setText] = useState(initialText);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(initialText);
  }, [initialText]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.selectionStart = el.value.length;
    el.selectionEnd = el.value.length;
    // Grow to content
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  const canSubmit =
    !busy &&
    !isDraftEmpty([
      ...skills.map((name) => ({ type: "skill" as const, name })),
      { type: "text" as const, text },
    ]);

  const submit = () => {
    if (!canSubmit) return;
    const segs = [
      ...skills.map((name) => ({ type: "skill" as const, name })),
      { type: "text" as const, text },
    ];
    onSubmit(serializeStored(segs));
  };

  return (
    <div className="lobe-inline-edit" data-testid="inline-user-edit">
      {skills.length > 0 ? (
        <div className="lobe-inline-edit__skills">
          {skills.map((name) => (
            <SkillChip key={name} name={name} size="sm" />
          ))}
        </div>
      ) : null}
      <textarea
        ref={taRef}
        className="lobe-inline-edit__textarea"
        value={text}
        disabled={busy}
        placeholder={placeholder}
        rows={2}
        // Textarea is plain-text by default; still strip just in case of OS rich paste.
        onPaste={(e) => {
          e.preventDefault();
          const plain =
            e.clipboardData?.getData("text/plain") ??
            e.clipboardData?.getData("text") ??
            "";
          if (!plain) return;
          const el = e.currentTarget;
          const start = el.selectionStart ?? text.length;
          const end = el.selectionEnd ?? text.length;
          const next =
            text.slice(0, start) +
            plain.replace(/\r\n/g, "\n").replace(/\r/g, "\n") +
            text.slice(end);
          setText(next);
          requestAnimationFrame(() => {
            const pos = start + plain.length;
            el.selectionStart = pos;
            el.selectionEnd = pos;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
          });
        }}
        onChange={(e) => {
          setText(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="lobe-inline-edit__actions">
        <button
          type="button"
          className="lobe-inline-edit__btn lobe-inline-edit__btn--ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={cn(
            "lobe-inline-edit__btn lobe-inline-edit__btn--primary",
            !canSubmit && "is-disabled",
          )}
          disabled={!canSubmit}
          onClick={submit}
        >
          {resendLabel}
        </button>
      </div>
    </div>
  );
}
