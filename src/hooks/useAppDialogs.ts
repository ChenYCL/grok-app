/**
 * Central in-app dialog host state (WP-B5).
 * Never uses window.confirm / alert / prompt.
 */
import { useCallback, useState } from "react";

export type AppDialogState = unknown;

export function useAppDialogs<T = AppDialogState>() {
  const [appDialog, setAppDialog] = useState<T | null>(null);
  const closeDialog = useCallback(() => setAppDialog(null), []);
  const openDialog = useCallback((d: T) => setAppDialog(d), []);
  return { appDialog, setAppDialog, closeDialog, openDialog };
}
