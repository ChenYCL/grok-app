/**
 * In-app dialog + context-menu state shapes.
 * window.prompt/confirm are unreliable in Tauri WebView — use these instead.
 */

export type ContextMenuState =
  | { kind: "project"; id: string; x: number; y: number }
  | { kind: "project-policy"; id: string; x: number; y: number }
  | { kind: "project-sandbox"; id: string; x: number; y: number }
  | { kind: "project-color"; id: string; x: number; y: number }
  | { kind: "session"; id: string; x: number; y: number }
  | { kind: "archive-older"; x: number; y: number }
  | null;

/** In-app dialogs — window.prompt/confirm are unreliable in Tauri WebView. */
export type AppDialog =
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel?: string;
      danger?: boolean;
      onConfirm: () => void | Promise<void>;
    }
  | {
      kind: "prompt";
      title: string;
      initial: string;
      /** Optional secondary copy above the input (e.g. compact confirm). */
      message?: string;
      placeholder?: string;
      /** Primary submit button label (default: common.save). */
      submitLabel?: string;
      onSubmit: (value: string) => void | Promise<void>;
    }
  | null;
