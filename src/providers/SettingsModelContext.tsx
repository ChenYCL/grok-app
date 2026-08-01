/**
 * Settings model context — collapses SettingsPage prop waterfall (WP-B4).
 * Routing props (section/tab/onBack/…) stay on SettingsPage; values+setters live here.
 */
import { createContext, useContext, type ReactNode } from "react";

// Loose bag during migration; AppWorkbench provides the full settings model object.
export type SettingsModel = Record<string, unknown>;

const SettingsModelContext = createContext<SettingsModel | null>(null);

export function SettingsModelProvider({
  value,
  children,
}: {
  value: SettingsModel;
  children: ReactNode;
}) {
  return (
    <SettingsModelContext.Provider value={value}>
      {children}
    </SettingsModelContext.Provider>
  );
}

export function useSettingsModel<T extends SettingsModel = SettingsModel>(): T {
  const ctx = useContext(SettingsModelContext);
  if (!ctx) {
    throw new Error("useSettingsModel must be used within SettingsModelProvider");
  }
  return ctx as T;
}
