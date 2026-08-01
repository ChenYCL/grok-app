import type { SettingsEntry } from "../types";

/** Settings catalog entries — about section. */
export const ABOUT_ENTRIES: readonly SettingsEntry[] = [
  // ── about ──
  {
    id: "about.app",
    section: "about",
    anchorId: "settings-anchor-about",
    labelKey: "settings.aboutApp",
    keywords: ["about", "version", "update"],
  },
  {
    id: "about.cli",
    section: "about",
    anchorId: "settings-anchor-aboutCli",
    labelKey: "settings.cliUpdate",
    descKeys: [
      "settings.cliUpdateDesc",
      "settings.cliChannel.switchHint",
      "settings.cliChannel.pinLabel",
    ],
    keywords: [
      "cli",
      "grok update",
      "channel",
      "alpha",
      "stable",
      "cli version",
    ],
  },
  {
    id: "about.tutorial",
    section: "about",
    anchorId: "settings-anchor-tutorial",
    labelKey: "tutorial.replay",
    descKeys: ["tutorial.replayDesc", "tutorial.menu"],
    keywords: [
      "tutorial",
      "product tour",
      "onboarding",
      "walkthrough",
      "help",
      "guide",
    ],
  },
];
