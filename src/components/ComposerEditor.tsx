/**
 * Contenteditable composer: plain text + inline skill chips.
 * Value is stored form with [[skill:name]] tokens.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import {
  detectSlashQuery,
  parseStoredContent,
  serializeStored,
  type DraftSegment,
} from "@/lib/draftDoc";

function clearNode(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function appendTextWithBreaks(el: HTMLElement, text: string) {
  const parts = text.split("\n");
  parts.forEach((part, i) => {
    if (part) el.appendChild(document.createTextNode(part));
    if (i < parts.length - 1) el.appendChild(document.createElement("br"));
  });
}

function makeSkillChipEl(name: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "skill-chip skill-chip--sm skill-chip--editor";
  wrap.contentEditable = "false";
  wrap.dataset.skill = name;
  wrap.setAttribute("data-skill", name);

  const icon = document.createElement("span");
  icon.className = "skill-chip__glyph";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⚒";

  const label = document.createElement("span");
  label.className = "skill-chip__name";
  label.textContent = name;

  wrap.appendChild(icon);
  wrap.appendChild(label);
  return wrap;
}

function renderSegmentsInto(el: HTMLElement, segments: DraftSegment[]) {
  clearNode(el);
  for (const seg of segments) {
    if (seg.type === "text") {
      appendTextWithBreaks(el, seg.text);
    } else {
      el.appendChild(makeSkillChipEl(seg.name));
    }
  }
}

export function serializeDom(el: HTMLElement): string {
  const segs: DraftSegment[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      if (t) segs.push({ type: "text", text: t });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const he = node as HTMLElement;
    if (he.dataset?.skill) {
      segs.push({ type: "skill", name: he.dataset.skill });
      return;
    }
    if (he.tagName === "BR") {
      segs.push({ type: "text", text: "\n" });
      return;
    }
    he.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  const merged: DraftSegment[] = [];
  for (const s of segs) {
    if (s.type === "text") {
      const last = merged[merged.length - 1];
      if (last?.type === "text") last.text += s.text;
      else merged.push({ type: "text", text: s.text });
    } else {
      merged.push(s);
    }
  }
  return serializeStored(
    merged.length ? merged : [{ type: "text", text: "" }],
  );
}

function getTextBeforeCaret(el: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const frag = pre.cloneContents();
  const tmp = document.createElement("div");
  tmp.appendChild(frag);
  return serializeDom(tmp);
}

function placeCaretAtEnd(el: HTMLElement) {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Paste as plain text only — strip HTML / rich styles from clipboard.
 * Uses insertText when available (keeps undo); falls back to Range insert.
 */
function insertPlainTextAtSelection(text: string) {
  if (!text) return;
  // Normalize exotic line endings; keep \n for serializeDom.
  const plain = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Preferred: browser handles caret + undo stack.
  try {
    if (document.queryCommandSupported?.("insertText")) {
      const ok = document.execCommand("insertText", false, plain);
      if (ok) return;
    }
  } catch {
    /* fall through */
  }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();

  // Insert as text + <br> so multiline paste matches our editor model.
  const frag = document.createDocumentFragment();
  const parts = plain.split("\n");
  parts.forEach((part, i) => {
    if (part) frag.appendChild(document.createTextNode(part));
    if (i < parts.length - 1) frag.appendChild(document.createElement("br"));
  });
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

export type ComposerEditorProps = {
  value: string;
  onChange: (stored: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onSlashQueryChange?: (
    q: { start: number; query: string; end: number } | null,
  ) => void;
  editorRef?: Ref<HTMLDivElement | null>;
  /**
   * When clipboard has files/images (screenshot paste, file copy), parent
   * should attach them. Called after preventDefault on the paste event.
   * Plain text is still inserted when present alongside files.
   */
  onPasteFiles?: (files: File[]) => void;
};

export function ComposerEditor({
  value,
  onChange,
  disabled,
  placeholder,
  className,
  onKeyDown,
  onSlashQueryChange,
  editorRef,
  onPasteFiles,
}: ComposerEditorProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const lastValue = useRef(value);
  const composing = useRef(false);
  const focused = useRef(false);

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      elRef.current = node;
      if (typeof editorRef === "function") editorRef(node);
      else if (editorRef && "current" in editorRef) {
        (editorRef as { current: HTMLDivElement | null }).current = node;
      }
    },
    [editorRef],
  );

  const resize = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const line = 22;
    const min = line;
    const max = line * 10;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
  }, []);

  const emitSlashRef = useRef<() => void>(() => {});

  const emitSlash = useCallback(() => {
    const el = elRef.current;
    if (!el || !onSlashQueryChange) return;
    // Prefer caret-based token; fall back to full draft (IME/caret can lag).
    const beforeCaret = getTextBeforeCaret(el);
    const full = serializeDom(el);
    const fromCaret =
      beforeCaret != null ? detectSlashQuery(beforeCaret) : null;
    const fromFull = detectSlashQuery(full);
    const q = fromCaret ?? fromFull;
    if (!q) {
      // Keep previous slash state if caret is momentarily unreadable (IME).
      if (composing.current) return;
      onSlashQueryChange(null);
      return;
    }
    const end =
      fromCaret && beforeCaret != null ? beforeCaret.length : full.length;
    onSlashQueryChange({ start: q.start, query: q.query, end });
  }, [onSlashQueryChange]);

  emitSlashRef.current = emitSlash;

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    // Never rewrite DOM mid-IME — would abort composition and break Chinese filter.
    if (composing.current) return;
    const current = serializeDom(el);
    if (current === value && el.childNodes.length > 0) {
      lastValue.current = value;
      resize();
      return;
    }
    // Don't clobber caret on every keystroke — only when external change
    if (focused.current && value === lastValue.current) {
      resize();
      return;
    }
    if (focused.current && value !== lastValue.current) {
      // Parent applied skill insert etc. — re-render and caret end
      renderSegmentsInto(el, parseStoredContent(value));
      lastValue.current = value;
      placeCaretAtEnd(el);
      resize();
      emitSlashRef.current();
      return;
    }
    renderSegmentsInto(el, parseStoredContent(value));
    lastValue.current = value;
    resize();
  }, [value, resize]);

  const commitFromDom = useCallback(
    (el: HTMLElement) => {
      let stored = serializeDom(el);
      // Paste of raw tokens → rehydrate chips
      if (
        /\[\[skill:[a-zA-Z0-9_.:-]+\]\]/.test(stored) &&
        !el.querySelector("[data-skill]")
      ) {
        renderSegmentsInto(el, parseStoredContent(stored));
        stored = serializeDom(el);
        placeCaretAtEnd(el);
      }
      lastValue.current = stored;
      onChange(stored);
      emitSlash();
      resize();
    },
    [onChange, emitSlash, resize],
  );

  const onInput = (e: FormEvent<HTMLDivElement>) => {
    // During IME composition, still refresh slash filter from live DOM so
    // Chinese pinyin / candidates can narrow the panel in real time.
    // Do not commit to parent state until composition ends (avoids caret thrash).
    if (composing.current) {
      // rAF: composition text is often not in the DOM until after the event.
      requestAnimationFrame(() => {
        emitSlash();
        resize();
      });
      return;
    }
    commitFromDom(e.currentTarget);
  };

  /**
   * Paste: files/images → parent attach; text → plain text only (no rich HTML).
   * Screenshot / image clipboard often has empty text + image/* items.
   */
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const filesFromList = e.clipboardData?.files
      ? Array.from(e.clipboardData.files)
      : [];
    const filesFromItems: File[] = [];
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || item.kind !== "file") continue;
        const f = item.getAsFile();
        if (f) filesFromItems.push(f);
      }
    }
    // Prefer FileList; fall back to items (screenshots often only appear there).
    const fileMap = new Map<string, File>();
    for (const f of [...filesFromList, ...filesFromItems]) {
      const key = `${f.name}:${f.size}:${f.type}:${f.lastModified}`;
      if (!fileMap.has(key)) fileMap.set(key, f);
    }
    const files = Array.from(fileMap.values());
    if (files.length && onPasteFiles) {
      onPasteFiles(files);
    }

    const plain =
      e.clipboardData?.getData("text/plain") ??
      e.clipboardData?.getData("text") ??
      "";
    // If we only got files/images, skip empty text insert.
    if (!plain) return;
    // Avoid pasting file:// URI lists as body text when files were attached.
    if (files.length && /^file:\/\//i.test(plain.trim())) return;
    insertPlainTextAtSelection(plain);
    const el = elRef.current;
    if (el) commitFromDom(el);
  };

  const isEmpty =
    !value.trim() ||
    (parseStoredContent(value).every(
      (s) => s.type === "text" && !s.text.trim(),
    ) &&
      !value.includes("[[skill:"));

  return (
    <div className="composer-editor-wrap">
      {isEmpty && placeholder ? (
        <div className="composer-editor__placeholder" aria-hidden>
          {placeholder}
        </div>
      ) : null}
      <div
        ref={setRefs}
        className={className ?? "composer__input"}
        contentEditable={!disabled}
        role="textbox"
        aria-multiline
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onInput={onInput}
        onPaste={onPaste}
        onKeyUp={() => emitSlash()}
        onClick={() => emitSlash()}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionUpdate={() => {
          // IME intermediate text (pinyin / candidates) — update slash query only.
          requestAnimationFrame(() => emitSlash());
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          // Commit composed characters + refresh slash filter.
          commitFromDom(e.currentTarget);
          // Second pass after browser finalizes composition node.
          requestAnimationFrame(() => emitSlash());
        }}
        onKeyDown={(e) => {
          // Never intercept keys while IME is composing (Chinese etc.).
          const ne = e.nativeEvent;
          if (ne.isComposing || ne.keyCode === 229) {
            return;
          }
          onKeyDown?.(e);
        }}
      />
    </div>
  );
}

export function focusComposerEnd(el: HTMLDivElement | null) {
  placeCaretAtEnd(el!);
}
