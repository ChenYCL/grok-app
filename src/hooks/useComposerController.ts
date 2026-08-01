/**
 * Composer domain controller (slash / draft / attachments / model·effort·policy UI state).
 * Extracted from App workbench; onSend/session boundary stays in AppWorkbench.
 */
import { useCallback, useMemo, useState } from "react";

export type ComposerControllerState = {
  draft: string;
  setDraft: (v: string) => void;
  attachments: string[];
  setAttachments: React.Dispatch<React.SetStateAction<string[]>>;
  slashOpen: boolean;
  setSlashOpen: (v: boolean) => void;
  atOpen: boolean;
  setAtOpen: (v: boolean) => void;
  plusOpen: boolean;
  setPlusOpen: (v: boolean) => void;
  clearComposer: () => void;
};

/**
 * Local composer UI state. AppWorkbench may still own some composer fields during
 * migration; this hook is the SoT for newly extracted composer chrome.
 */
export function useComposerController(
  initialDraft = "",
): ComposerControllerState {
  const [draft, setDraft] = useState(initialDraft);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);

  const clearComposer = useCallback(() => {
    setDraft("");
    setAttachments([]);
    setSlashOpen(false);
    setAtOpen(false);
    setPlusOpen(false);
  }, []);

  return useMemo(
    () => ({
      draft,
      setDraft,
      attachments,
      setAttachments,
      slashOpen,
      setSlashOpen,
      atOpen,
      setAtOpen,
      plusOpen,
      setPlusOpen,
      clearComposer,
    }),
    [
      draft,
      attachments,
      slashOpen,
      atOpen,
      plusOpen,
      clearComposer,
    ],
  );
}
