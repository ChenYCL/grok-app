/**
 * Settings → Extensions: Skills + MCP + Plugins.
 * Skills/MCP from `grok inspect` with enable toggles (extensions.json / ACP inject).
 * Plugins from `grok plugin list/install/update/…` (config.toml disabled list).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import {
  IconDoctor,
  IconEdit,
  IconExternalLink,
  IconFolder,
  IconPlus,
  IconPlug,
  IconPuzzle,
  IconRefresh,
  IconSkills,
  IconTrash,
} from "@/components/icons";
import {
  filterPluginsByLoadState,
  isCliMissingError,
  isExtensionEnabled,
  mcpMetaLine,
  mergeInspectErrors,
  normalizePluginInstallSource,
  pluginMetaLine,
  pluginProvidesLine,
  pluginRowKey,
  pluginStatusTone,
  shortPathLabel,
  skillMetaLine,
  skillSourceTone,
  sortMcpByName,
  sortPluginsByName,
  sortSkillsByName,
  type PluginFilter,
} from "@/lib/extensionsUi";
import {
  buildPluginValidateExceptionPresentation,
  buildPluginValidatePreflightError,
  buildPluginValidatePresentation,
  formatPluginValidateMessages,
  normalizePluginValidateResult,
  pluginValidateBadgeTone,
  pluginValidateHint,
  pluginValidateKindLabel,
  pluginValidateRowTone,
  pluginValidateTarget,
  type PluginValidateKind,
  type PluginValidatePresentation,
  type PluginValidateResult,
} from "@/lib/pluginValidate";
import {
  indexDoctorServerStatuses,
  lookupServerStatus,
  mcpAuthGuidanceKey,
  mcpStatusBadgeMod,
  mcpStatusLabelKey,
  redactMcpText,
  type McpServerStatus,
  type McpStatusIndex,
} from "@/lib/mcpStatus";
import {
  classifyMcpOauthFromStatus,
  mcpOauthActionLabelKey,
  type McpOauthAction,
} from "@/lib/mcpOauth";
import { McpOauthWizard } from "@/components/McpOauthWizard";
import {
  isSkillEditable,
  resolveSkillMdPath,
} from "@/lib/skillEditPath";
import { sanitizeSkillFolderName } from "@/lib/skillScaffold";
import {
  buildSkillHostErrorPresentation,
  buildSkillSaveOkPresentation,
  buildSkillSavePreflightError,
  buildSkillValidatePresentation,
  skillEditBadgeTone,
  skillEditHint,
  skillEditKindLabel,
  type SkillEditKind,
  type SkillEditPresentation,
} from "@/lib/skillEditFeedback";
import {
  isFsWriteConflict,
  isResourceDraftDirty,
} from "@/lib/resourceEdit";
import { ExtensionsBuildExtras } from "@/components/ExtensionsBuildExtras";
import { ExtensionsHooksPanel } from "@/components/ExtensionsHooksPanel";
import {
  installedPluginDetailModel,
  type AvailablePluginDetailModel,
  type PluginComponentBadgeKind,
} from "@/lib/pluginMarketplace";

type SkillEditorState = {
  skill: api.SkillDto;
  path: string;
  baselineText: string;
  draftText: string;
  mtimeMs: number | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  savedHint: string | null;
};

export type ExtensionsTabId =
  | "plugins"
  | "skills"
  | "mcp"
  | "agents"
  | "hooks"
  | "market";

export interface ExtensionsPanelProps {
  locale: Locale;
  /** Active workbench project path (inspect cwd). */
  projectPath?: string | null;
  /** Whether CLI probe found a binary (for empty-state copy). */
  cliFound?: boolean;
  /** Page tab from settings hash (`#/settings/extensions/{tab}`). */
  activeTab?: ExtensionsTabId;
  onTabChange?: (tab: ExtensionsTabId) => void;
  /** Navigate to Settings → Runtime when CLI is missing. */
  onOpenRuntime?: () => void;
  /** Fired after skill enable prefs change so slash palette can refresh. */
  onSkillsPrefsChanged?: () => void;
}

export function ExtensionsPanel({
  locale,
  projectPath = null,
  cliFound = true,
  activeTab = "plugins",
  onTabChange,
  onOpenRuntime,
  onSkillsPrefsChanged,
}: ExtensionsPanelProps) {
  const tr = useMemo(() => createT(locale), [locale]);

  const pluginValidateKindLabels = useMemo(
    (): Partial<Record<PluginValidateKind, string>> => ({
      ok: tr("ext.plugins.validate.kind.ok"),
      cli_too_old: tr("ext.plugins.validate.kind.cliTooOld"),
      cli_missing: tr("ext.plugins.validate.kind.cliMissing"),
      empty_source: tr("ext.plugins.validate.kind.emptySource"),
      path_only: tr("ext.plugins.validate.kind.pathOnly"),
      not_found: tr("ext.plugins.validate.kind.notFound"),
      not_a_directory: tr("ext.plugins.validate.kind.notADirectory"),
      no_manifest: tr("ext.plugins.validate.kind.noManifest"),
      parse_error: tr("ext.plugins.validate.kind.parseError"),
      missing_field: tr("ext.plugins.validate.kind.missingField"),
      invalid_manifest: tr("ext.plugins.validate.kind.invalidManifest"),
      host_only: tr("ext.plugins.validate.kind.hostOnly"),
      host_error: tr("ext.plugins.validate.kind.hostError"),
      other: tr("ext.plugins.validate.kind.other"),
    }),
    [tr],
  );

  const pluginValidateKindHints = useMemo(
    (): Partial<Record<PluginValidateKind, string>> => ({
      ok: tr("ext.plugins.validate.hint.ok"),
      cli_too_old: tr("ext.plugins.validate.hint.cliTooOld"),
      cli_missing: tr("ext.plugins.validate.hint.cliMissing"),
      empty_source: tr("ext.plugins.validate.hint.emptySource"),
      path_only: tr("ext.plugins.validate.hint.pathOnly"),
      not_found: tr("ext.plugins.validate.hint.notFound"),
      not_a_directory: tr("ext.plugins.validate.hint.notADirectory"),
      no_manifest: tr("ext.plugins.validate.hint.noManifest"),
      parse_error: tr("ext.plugins.validate.hint.parseError"),
      missing_field: tr("ext.plugins.validate.hint.missingField"),
      invalid_manifest: tr("ext.plugins.validate.hint.invalidManifest"),
      host_only: tr("ext.plugins.validate.hint.hostOnly"),
      host_error: tr("ext.plugins.validate.hint.hostError"),
      other: tr("ext.plugins.validate.hint.other"),
    }),
    [tr],
  );

  const openPluginValidatePresentation = useCallback(
    (
      presentation: PluginValidatePresentation,
      pluginName: string | null,
    ) => {
      setValidateModal({ open: true, presentation, pluginName });
    },
    [],
  );
  const [skills, setSkills] = useState<api.SkillDto[]>([]);
  const [skillRoots, setSkillRoots] = useState<string[]>([]);
  const [servers, setServers] = useState<api.McpDto[]>([]);
  const [plugins, setPlugins] = useState<api.PluginDto[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentHome, setAgentHome] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [pathHint, setPathHint] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorSource, setActionErrorSource] = useState<
    "plugin" | "mcp" | null
  >(null);
  const [uninstallTarget, setUninstallTarget] = useState<api.PluginDto | null>(
    null,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTitle, setDetailsTitle] = useState("");
  const [detailsBody, setDetailsBody] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  /** Structured detail when provides / marketplace meta is available. */
  const [detailsModel, setDetailsModel] =
    useState<AvailablePluginDetailModel | null>(null);
  /** Grok Build Plugins tab filter: all | enabled | disabled */
  const [pluginFilter, setPluginFilter] = useState<PluginFilter>("all");
  const [installSource, setInstallSource] = useState("");
  /** Per-row `plugin validate` result (keyed by pluginRowKey). Shown in-panel. */
  const [validateByKey, setValidateByKey] = useState<
    Record<string, PluginValidateResult>
  >({});
  /** Per-row classified presentation for kind chips / soft-fail tone. */
  const [validatePresByKey, setValidatePresByKey] = useState<
    Record<string, PluginValidatePresentation>
  >({});
  /** Pre-install validate for advanced path/git install field. */
  const [installValidate, setInstallValidate] =
    useState<PluginValidateResult | null>(null);
  const [installValidatePres, setInstallValidatePres] =
    useState<PluginValidatePresentation | null>(null);
  /** GlassModal result for last validate (row or advanced install). */
  const [validateModal, setValidateModal] = useState<{
    open: boolean;
    presentation: PluginValidatePresentation | null;
    /** Installed plugin display name, or null for pre-install path. */
    pluginName: string | null;
  }>({ open: false, presentation: null, pluginName: null });
  /** In-app SKILL.md light editor (Settings → Extensions → Skills). */
  const [skillEditor, setSkillEditor] = useState<SkillEditorState | null>(null);
  const [skillDiscardOpen, setSkillDiscardOpen] = useState(false);
  const [skillConflictOpen, setSkillConflictOpen] = useState(false);
  /** Classified validate / load / save feedback (GlassModal — no window.confirm). */
  const [skillFeedback, setSkillFeedback] =
    useState<SkillEditPresentation | null>(null);
  const [skillFeedbackOpen, setSkillFeedbackOpen] = useState(false);
  const skillEditorSeq = useRef(0);
  /** New skill scaffold modal (Extensions → Skills). */
  const [skillNewOpen, setSkillNewOpen] = useState(false);
  const [skillNewName, setSkillNewName] = useState("");
  const [skillNewDesc, setSkillNewDesc] = useState("");
  const [skillNewScope, setSkillNewScope] = useState<"user" | "project">("user");
  const [skillNewError, setSkillNewError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCommand, setAddCommand] = useState("");
  const [addArgs, setAddArgs] = useState("");
  const [addEnv, setAddEnv] = useState("");
  const [removeTarget, setRemoveTarget] = useState<api.McpDto | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorReport, setDoctorReport] =
    useState<any>(null);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [doctorFocus, setDoctorFocus] = useState<string | null>(null);
  /** Last successful doctor run (ms) — shown as lightweight timestamp. */
  const [doctorLastAt, setDoctorLastAt] = useState<number | null>(null);
  /**
   * Cumulative per-server status from doctor runs.
   * Focused doctor re-runs merge in so other servers keep their last tone.
   */
  const [doctorStatusIndex, setDoctorStatusIndex] = useState<McpStatusIndex>(
    () => new Map(),
  );
  /** OAuth recovery wizard target (Authorize / Retry / How to refresh). */
  const [oauthWizardTarget, setOauthWizardTarget] = useState<{
    action: McpOauthAction;
    status: McpServerStatus;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!api.isTauri()) {
      setSkills([]);
      setSkillRoots([]);
      setServers([]);
      setPlugins([]);
      setSkillsError(tr("ext.needTauri"));
      setMcpError(null);
      setPluginsError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setSkillsError(null);
    setMcpError(null);
    setPluginsError(null);
    setPathHint(null);
    const cwd = projectPath?.trim() || null;
    const [skillsRes, mcpRes, pluginsRes, providersRes] = await Promise.all([
      api.skillsList(cwd).catch((e) => ({
        skills: [] as api.SkillDto[],
        skillRoots: [] as string[],
        error: String(e),
      })),
      api.inspectMcp(cwd).catch((e) => ({
        servers: [] as api.McpDto[],
        error: String(e),
      })),
      api.pluginsList().catch((e) => ({
        plugins: [] as api.PluginDto[],
        error: String(e),
      })),
      api.providersList().catch(() => null),
    ]);
    setSkills(sortSkillsByName(skillsRes.skills ?? []));
    setSkillRoots(
      Array.isArray(skillsRes.skillRoots)
        ? skillsRes.skillRoots.filter((r) => typeof r === "string" && r.trim())
        : [],
    );
    setServers(sortMcpByName(mcpRes.servers ?? []));
    setPlugins(sortPluginsByName(pluginsRes.plugins ?? []));
    setSkillsError(skillsRes.error?.trim() ? skillsRes.error : null);
    setMcpError(mcpRes.error?.trim() ? mcpRes.error : null);
    setPluginsError(pluginsRes.error?.trim() ? pluginsRes.error : null);
    if (providersRes) {
      setAgentHome(providersRes.agentHome?.trim() || null);
      setConfigPath(providersRes.configPath?.trim() || null);
    }
    setLoading(false);
  }, [projectPath, tr]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bannerError = useMemo(
    () => mergeInspectErrors(skillsError, mcpError, pluginsError),
    [skillsError, mcpError, pluginsError],
  );
  const cliMissing =
    !cliFound ||
    isCliMissingError(skillsError) ||
    isCliMissingError(mcpError) ||
    isCliMissingError(pluginsError);

  const scopeLabel = projectPath?.trim()
    ? tr("ext.scope.project")
    : tr("ext.scope.global");
  const scopePath = projectPath?.trim() || null;

  const mcpOffCount = useMemo(
    () => servers.filter((s) => !isExtensionEnabled(s.enabled)).length,
    [servers],
  );
  const skillsOffCount = useMemo(
    () => skills.filter((s) => !isExtensionEnabled(s.enabled)).length,
    [skills],
  );

  const reveal = async (path: string | null | undefined) => {
    const p = (path ?? "").trim();
    if (!p || !api.isTauri()) return;
    try {
      await api.pathReveal(p);
      setPathHint(null);
    } catch (e) {
      setPathHint(String(e));
    }
  };

  const toggleMcp = async (name: string, next: boolean) => {
    if (!api.isTauri() || busyKey) return;
    setBusyKey(`mcp:${name}`);
    setServers((prev) =>
      prev.map((s) => (s.name === name ? { ...s, enabled: next } : s)),
    );
    try {
      await api.extensionsSetMcp(name, next);
    } catch (e) {
      setPathHint(String(e));
      setServers((prev) =>
        prev.map((s) => (s.name === name ? { ...s, enabled: !next } : s)),
      );
    } finally {
      setBusyKey(null);
    }
  };

  const toggleSkill = async (name: string, next: boolean) => {
    if (!api.isTauri() || busyKey) return;
    setBusyKey(`skill:${name}`);
    setSkills((prev) =>
      prev.map((s) => (s.name === name ? { ...s, enabled: next } : s)),
    );
    try {
      await api.extensionsSetSkill(name, next);
      onSkillsPrefsChanged?.();
    } catch (e) {
      setPathHint(String(e));
      setSkills((prev) =>
        prev.map((s) => (s.name === name ? { ...s, enabled: !next } : s)),
      );
    } finally {
      setBusyKey(null);
    }
  };

  const enableAllMcp = async () => {
    if (!api.isTauri() || busyKey || servers.length === 0) return;
    setBusyKey("mcp:all");
    const names = servers.map((s) => s.name);
    setServers((prev) => prev.map((s) => ({ ...s, enabled: true })));
    try {
      await api.extensionsEnableAllMcp(names);
    } catch (e) {
      setPathHint(String(e));
      await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const enableAllSkills = async () => {
    if (!api.isTauri() || busyKey || skills.length === 0) return;
    setBusyKey("skill:all");
    const names = skills.map((s) => s.name);
    setSkills((prev) => prev.map((s) => ({ ...s, enabled: true })));
    try {
      await api.extensionsEnableAllSkills(names);
      onSkillsPrefsChanged?.();
    } catch (e) {
      setPathHint(String(e));
      await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const skillEditorDirty = isResourceDraftDirty(
    skillEditor?.draftText,
    skillEditor?.baselineText,
  );

  const skillKindLabels = useMemo((): Partial<Record<SkillEditKind, string>> => {
    return {
      ok: tr("ext.skills.feedback.kind.ok"),
      empty: tr("ext.skills.feedback.kind.empty"),
      too_large: tr("ext.skills.feedback.kind.tooLarge"),
      missing_frontmatter: tr("ext.skills.feedback.kind.missingFrontmatter"),
      unclosed_frontmatter: tr("ext.skills.feedback.kind.unclosedFrontmatter"),
      invalid_frontmatter: tr("ext.skills.feedback.kind.invalidFrontmatter"),
      missing_name: tr("ext.skills.feedback.kind.missingName"),
      invalid_name: tr("ext.skills.feedback.kind.invalidName"),
      name_mismatch: tr("ext.skills.feedback.kind.nameMismatch"),
      missing_description: tr("ext.skills.feedback.kind.missingDescription"),
      empty_body: tr("ext.skills.feedback.kind.emptyBody"),
      conflict: tr("ext.skills.feedback.kind.conflict"),
      path_denied: tr("ext.skills.feedback.kind.pathDenied"),
      path_outside: tr("ext.skills.feedback.kind.pathOutside"),
      bundled_readonly: tr("ext.skills.feedback.kind.bundledReadonly"),
      not_found: tr("ext.skills.feedback.kind.notFound"),
      not_a_file: tr("ext.skills.feedback.kind.notAFile"),
      already_exists: tr("ext.skills.feedback.kind.alreadyExists"),
      host_only: tr("ext.skills.feedback.kind.hostOnly"),
      host_error: tr("ext.skills.feedback.kind.hostError"),
      other: tr("ext.skills.feedback.kind.other"),
    };
  }, [tr]);

  const skillKindHints = useMemo((): Partial<Record<SkillEditKind, string>> => {
    return {
      ok: tr("ext.skills.feedback.hint.ok"),
      empty: tr("ext.skills.feedback.hint.empty"),
      too_large: tr("ext.skills.feedback.hint.tooLarge"),
      missing_frontmatter: tr("ext.skills.feedback.hint.missingFrontmatter"),
      unclosed_frontmatter: tr("ext.skills.feedback.hint.unclosedFrontmatter"),
      invalid_frontmatter: tr("ext.skills.feedback.hint.invalidFrontmatter"),
      missing_name: tr("ext.skills.feedback.hint.missingName"),
      invalid_name: tr("ext.skills.feedback.hint.invalidName"),
      name_mismatch: tr("ext.skills.feedback.hint.nameMismatch"),
      missing_description: tr("ext.skills.feedback.hint.missingDescription"),
      empty_body: tr("ext.skills.feedback.hint.emptyBody"),
      conflict: tr("ext.skills.feedback.hint.conflict"),
      path_denied: tr("ext.skills.feedback.hint.pathDenied"),
      path_outside: tr("ext.skills.feedback.hint.pathOutside"),
      bundled_readonly: tr("ext.skills.feedback.hint.bundledReadonly"),
      not_found: tr("ext.skills.feedback.hint.notFound"),
      not_a_file: tr("ext.skills.feedback.hint.notAFile"),
      already_exists: tr("ext.skills.feedback.hint.alreadyExists"),
      host_only: tr("ext.skills.feedback.hint.hostOnly"),
      host_error: tr("ext.skills.feedback.hint.hostError"),
      other: tr("ext.skills.feedback.hint.other"),
    };
  }, [tr]);

  const openSkillFeedback = useCallback(
    (presentation: SkillEditPresentation) => {
      setSkillFeedback(presentation);
      setSkillFeedbackOpen(true);
    },
    [],
  );

  const closeSkillEditor = useCallback(() => {
    skillEditorSeq.current += 1;
    setSkillEditor(null);
    setSkillDiscardOpen(false);
    setSkillConflictOpen(false);
    setSkillFeedbackOpen(false);
    setSkillFeedback(null);
  }, []);

  const requestCloseSkillEditor = useCallback(() => {
    if (skillEditor?.saving) return;
    if (skillEditorDirty) {
      setSkillDiscardOpen(true);
      return;
    }
    closeSkillEditor();
  }, [closeSkillEditor, skillEditor?.saving, skillEditorDirty]);

  const openSkillEditor = useCallback(
    async (skill: api.SkillDto, opts?: { force?: boolean }) => {
      if (!api.isTauri()) {
        const presentation = buildSkillHostErrorPresentation(
          tr("ext.needTauri"),
          "load",
          {
            labels: skillKindLabels,
            fallbackTitle: tr("ext.skills.editLoadError"),
          },
        );
        openSkillFeedback(presentation);
        setPathHint(tr("ext.needTauri"));
        return;
      }
      // `force` skips client allowlist (e.g. right after create, roots state may lag).
      if (!opts?.force && !isSkillEditable(skill, skillRoots)) return;
      const mdPath = resolveSkillMdPath(skill.path) ?? skill.path?.trim() ?? "";
      if (!mdPath) return;
      const seq = ++skillEditorSeq.current;
      setSkillDiscardOpen(false);
      setSkillConflictOpen(false);
      setSkillFeedbackOpen(false);
      setSkillFeedback(null);
      setSkillEditor({
        skill,
        path: mdPath,
        baselineText: "",
        draftText: "",
        mtimeMs: null,
        loading: true,
        saving: false,
        error: null,
        savedHint: null,
      });
      try {
        const res = await api.skillRead(mdPath, projectPath);
        if (seq !== skillEditorSeq.current) return;
        setSkillEditor({
          skill,
          path: res.path || mdPath,
          baselineText: res.content ?? "",
          draftText: res.content ?? "",
          mtimeMs:
            typeof res.mtimeMs === "number" && Number.isFinite(res.mtimeMs)
              ? res.mtimeMs
              : null,
          loading: false,
          saving: false,
          error: null,
          savedHint: null,
        });
      } catch (e) {
        if (seq !== skillEditorSeq.current) return;
        const presentation = buildSkillHostErrorPresentation(e, "load", {
          path: mdPath,
          labels: skillKindLabels,
          fallbackTitle: tr("ext.skills.editLoadError"),
        });
        setSkillEditor({
          skill,
          path: mdPath,
          baselineText: "",
          draftText: "",
          mtimeMs: null,
          loading: false,
          saving: false,
          error: presentation.summary || tr("ext.skills.editLoadError"),
          savedHint: null,
        });
        openSkillFeedback(presentation);
      }
    },
    [openSkillFeedback, projectPath, skillKindLabels, skillRoots, tr],
  );

  const validateSkillEditor = useCallback(() => {
    if (!skillEditor || skillEditor.loading) return;
    const presentation = buildSkillValidatePresentation(skillEditor.draftText, {
      expectedName: skillEditor.skill.name,
      path: skillEditor.path,
      labels: skillKindLabels,
      titles: {
        ok: tr("ext.skills.feedback.validateOk"),
        fail: tr("ext.skills.feedback.validateFail"),
      },
    });
    setSkillEditor((s) =>
      s
        ? {
            ...s,
            error: presentation.blocking ? presentation.summary : null,
            savedHint: presentation.blocking
              ? null
              : presentation.summary || tr("ext.skills.feedback.validateOk"),
          }
        : s,
    );
    openSkillFeedback(presentation);
  }, [openSkillFeedback, skillEditor, skillKindLabels, tr]);

  const saveSkillEditor = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!skillEditor || skillEditor.loading || skillEditor.saving) return;
      if (
        !isResourceDraftDirty(skillEditor.draftText, skillEditor.baselineText) &&
        !opts?.force
      ) {
        return;
      }

      // Client-side SKILL.md validate before host write (force overwrite still validates).
      const preflight = buildSkillSavePreflightError(skillEditor.draftText, {
        isTauri: api.isTauri(),
        expectedName: skillEditor.skill.name,
        path: skillEditor.path,
        labels: skillKindLabels,
        hostOnlyTitle: tr("ext.needTauri"),
      });
      if (preflight) {
        setSkillEditor((s) =>
          s
            ? {
                ...s,
                error: preflight.summary,
                savedHint: null,
              }
            : s,
        );
        openSkillFeedback(preflight);
        return;
      }

      setSkillEditor((s) =>
        s ? { ...s, saving: true, error: null, savedHint: null } : s,
      );
      try {
        const expected = opts?.force ? null : skillEditor.mtimeMs;
        const w = await api.skillWrite(
          skillEditor.path,
          skillEditor.draftText,
          expected,
          projectPath,
        );
        const saved = skillEditor.draftText;
        const okPresentation = buildSkillSaveOkPresentation({
          path: w.path || skillEditor.path,
          name: skillEditor.skill.name,
          sizeBytes: w.size,
          labels: skillKindLabels,
          title: tr("ext.skills.editSaved"),
        });
        setSkillEditor((s) =>
          s
            ? {
                ...s,
                saving: false,
                baselineText: saved,
                draftText: saved,
                mtimeMs: w.mtimeMs,
                path: w.path || s.path,
                error: null,
                savedHint: tr("ext.skills.editSaved"),
              }
            : s,
        );
        setSkillFeedback(okPresentation);
        // Reload Extensions list + composer skills picker.
        await refresh();
        onSkillsPrefsChanged?.();
      } catch (e) {
        if (isFsWriteConflict(e)) {
          setSkillEditor((s) => (s ? { ...s, saving: false } : s));
          setSkillConflictOpen(true);
          return;
        }
        const presentation = buildSkillHostErrorPresentation(e, "save", {
          path: skillEditor.path,
          labels: skillKindLabels,
          fallbackTitle: tr("ext.skills.editSaveError"),
        });
        setSkillEditor((s) =>
          s
            ? {
                ...s,
                saving: false,
                error: presentation.summary || tr("ext.skills.editSaveError"),
              }
            : s,
        );
        openSkillFeedback(presentation);
      }
    },
    [
      onSkillsPrefsChanged,
      openSkillFeedback,
      projectPath,
      refresh,
      skillEditor,
      skillKindLabels,
      tr,
    ],
  );

  const skillNewSanitized = useMemo(
    () => sanitizeSkillFolderName(skillNewName),
    [skillNewName],
  );

  const openSkillNew = useCallback(() => {
    setSkillNewName("");
    setSkillNewDesc("");
    setSkillNewScope("user");
    setSkillNewError(null);
    setSkillNewOpen(true);
  }, []);

  const submitSkillNew = useCallback(async () => {
    if (!api.isTauri() || actionBusy) return;
    const safe = sanitizeSkillFolderName(skillNewName);
    if (!safe) {
      setSkillNewError(tr("ext.skills.newNameInvalid"));
      return;
    }
    const scope: "user" | "project" =
      skillNewScope === "project" && projectPath?.trim()
        ? "project"
        : "user";
    if (skillNewScope === "project" && !projectPath?.trim()) {
      setSkillNewError(tr("ext.skills.newScopeProjectNeed"));
      return;
    }
    setActionBusy("skill:create");
    setSkillNewError(null);
    setActionError(null);
    try {
      const res = await api.skillCreate({
        name: safe,
        description: skillNewDesc,
        projectPath,
        scope,
      });
      setSkillNewOpen(false);
      setSkillNewName("");
      setSkillNewDesc("");
      await refresh();
      onSkillsPrefsChanged?.();
      // Reuse existing SKILL.md editor open flow.
      const dto: api.SkillDto = {
        name: res.name,
        description: skillNewDesc.trim(),
        source: scope === "project" ? "project" : "user",
        path: res.path,
        userInvocable: true,
        enabled: true,
      };
      // Roots React state may lag one frame after refresh — force open by path.
      void openSkillEditor(dto, { force: true });
    } catch (e) {
      const presentation = buildSkillHostErrorPresentation(e, "create", {
        labels: skillKindLabels,
        fallbackTitle: tr("ext.skills.newError"),
      });
      setSkillNewError(presentation.summary || tr("ext.skills.newError"));
      openSkillFeedback(presentation);
    } finally {
      setActionBusy(null);
    }
  }, [
    actionBusy,
    onSkillsPrefsChanged,
    openSkillEditor,
    openSkillFeedback,
    projectPath,
    refresh,
    skillKindLabels,
    skillNewDesc,
    skillNewName,
    skillNewScope,
    tr,
  ]);

  const runPluginAction = async (
    key: string,
    action: () => Promise<unknown>,
  ) => {
    setActionBusy(key);
    setActionError(null);
    setActionErrorSource(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setActionError(String(e));
      setActionErrorSource("plugin");
    } finally {
      setActionBusy(null);
    }
  };

  const togglePlugin = (p: api.PluginDto) => {
    const key = pluginRowKey(p);
    void runPluginAction(key, async () => {
      if (p.enabled) {
        await api.pluginDisable(p.name);
      } else {
        await api.pluginEnable(p.name);
      }
    });
  };

  const confirmUninstall = async () => {
    const target = uninstallTarget;
    if (!target) return;
    const key = pluginRowKey(target);
    setUninstallTarget(null);
    await runPluginAction(key, async () => {
      await api.pluginUninstall(target.name);
    });
  };

  const installPlugin = async () => {
    if (!api.isTauri() || actionBusy || cliMissing) return;
    const source = normalizePluginInstallSource(installSource);
    if (!source) {
      setActionError(tr("ext.plugins.installEmpty"));
      return;
    }
    await runPluginAction("install", async () => {
      await api.pluginInstall(source);
      setInstallSource("");
    });
  };

  const updatePlugin = (p: api.PluginDto) => {
    const key = `update:${pluginRowKey(p)}`;
    void runPluginAction(key, async () => {
      await api.pluginUpdate(p.name);
    });
  };

  const updateAllPlugins = () => {
    if (!api.isTauri() || actionBusy || cliMissing || plugins.length === 0) {
      return;
    }
    void runPluginAction("update:all", async () => {
      await api.pluginUpdate(null);
    });
  };

  const applyValidateResult = (
    res: api.PluginValidateResult,
  ): PluginValidateResult => normalizePluginValidateResult(res);

  const presentValidateResult = (
    res: PluginValidateResult,
  ): PluginValidatePresentation =>
    buildPluginValidatePresentation(res, {
      kinds: pluginValidateKindLabels,
      okTitle: tr("ext.plugins.validateOk"),
      failTitle: tr("ext.plugins.validateFailed"),
    });

  /** Validate an installed plugin (path preferred) — row + GlassModal soft-fail. */
  const validatePlugin = (p: api.PluginDto) => {
    if (actionBusy) return;
    const key = pluginRowKey(p);
    const target = pluginValidateTarget(p);

    if (!api.isTauri()) {
      const presentation = buildPluginValidateExceptionPresentation(
        tr("ext.needTauri"),
        { kinds: pluginValidateKindLabels },
      );
      // Force host_only if message didn't classify (needTauri string varies).
      const forced: PluginValidatePresentation = {
        ...presentation,
        kind: "host_only",
        severity: "warn",
        softFail: true,
        title: pluginValidateKindLabel("host_only", pluginValidateKindLabels),
      };
      setValidateByKey((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          messages: forced.messages,
          reason: "host_only",
        },
      }));
      setValidatePresByKey((prev) => ({ ...prev, [key]: forced }));
      openPluginValidatePresentation(forced, p.name);
      return;
    }

    if (cliMissing) {
      const presentation = presentValidateResult({
        ok: false,
        reason: "cli_missing",
        messages: [tr("ext.plugins.validate.kind.cliMissing")],
      });
      setValidateByKey((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          reason: "cli_missing",
          messages: presentation.messages,
        },
      }));
      setValidatePresByKey((prev) => ({ ...prev, [key]: presentation }));
      openPluginValidatePresentation(presentation, p.name);
      return;
    }

    setActionBusy(`validate:${key}`);
    setActionError(null);
    setActionErrorSource(null);
    void (async () => {
      try {
        const res = applyValidateResult(await api.pluginValidate(target));
        const presentation = presentValidateResult(res);
        setValidateByKey((prev) => ({ ...prev, [key]: res }));
        setValidatePresByKey((prev) => ({ ...prev, [key]: presentation }));
        openPluginValidatePresentation(presentation, p.name);
        // Soft-fail (cli too old / missing): modal + row only — not hard action error.
        if (!res.ok && !presentation.softFail) {
          setActionError(
            formatPluginValidateMessages(
              res.messages,
              tr("ext.plugins.validateFailed"),
            ),
          );
          setActionErrorSource("plugin");
        }
      } catch (e) {
        const presentation = buildPluginValidateExceptionPresentation(e, {
          kinds: pluginValidateKindLabels,
        });
        const envelope: PluginValidateResult = {
          ok: false,
          messages: presentation.messages,
          reason: presentation.reason,
        };
        setValidateByKey((prev) => ({ ...prev, [key]: envelope }));
        setValidatePresByKey((prev) => ({ ...prev, [key]: presentation }));
        openPluginValidatePresentation(presentation, p.name);
        if (!presentation.softFail) {
          setActionError(presentation.summary || String(e));
          setActionErrorSource("plugin");
        }
      } finally {
        setActionBusy(null);
      }
    })();
  };

  /** Pre-install validate for a local path in the advanced install field. */
  const validateInstallSource = () => {
    if (actionBusy) return;
    const source = normalizePluginInstallSource(installSource);
    const preflight = buildPluginValidatePreflightError(source, {
      isTauri: api.isTauri(),
      emptyMessage: tr("ext.plugins.installEmpty"),
      pathOnlyMessage: tr("ext.plugins.validatePathOnly"),
      hostOnlyMessage: tr("ext.needTauri"),
      labels: { kinds: pluginValidateKindLabels },
    });
    if (preflight) {
      const envelope: PluginValidateResult = {
        ok: false,
        messages: preflight.messages,
        reason: preflight.reason,
      };
      setInstallValidate(envelope);
      setInstallValidatePres(preflight);
      openPluginValidatePresentation(preflight, null);
      return;
    }
    if (cliMissing) {
      const presentation = presentValidateResult({
        ok: false,
        reason: "cli_missing",
        messages: [tr("ext.plugins.validate.kind.cliMissing")],
      });
      setInstallValidate({
        ok: false,
        reason: "cli_missing",
        messages: presentation.messages,
      });
      setInstallValidatePres(presentation);
      openPluginValidatePresentation(presentation, null);
      return;
    }
    setActionBusy("validate:install");
    setActionError(null);
    setActionErrorSource(null);
    void (async () => {
      try {
        const res = applyValidateResult(await api.pluginValidate(source));
        const presentation = presentValidateResult(res);
        setInstallValidate(res);
        setInstallValidatePres(presentation);
        openPluginValidatePresentation(presentation, null);
        if (!res.ok && !presentation.softFail) {
          setActionError(
            formatPluginValidateMessages(
              res.messages,
              tr("ext.plugins.validateFailed"),
            ),
          );
          setActionErrorSource("plugin");
        }
      } catch (e) {
        const presentation = buildPluginValidateExceptionPresentation(e, {
          kinds: pluginValidateKindLabels,
        });
        setInstallValidate({
          ok: false,
          messages: presentation.messages,
          reason: presentation.reason,
        });
        setInstallValidatePres(presentation);
        openPluginValidatePresentation(presentation, null);
        if (!presentation.softFail) {
          setActionError(presentation.summary || String(e));
          setActionErrorSource("plugin");
        }
      } finally {
        setActionBusy(null);
      }
    })();
  };

  const showDetails = async (p: api.PluginDto) => {
    setDetailsTitle(p.name);
    setDetailsBody("");
    setDetailsModel(
      installedPluginDetailModel({
        name: p.name,
        version: p.version,
        marketplace: p.marketplace,
        status: p.status || "installed",
        provides: p.provides
          ? {
              skills: p.provides.skills,
              agents: p.provides.agents,
              hooks: p.provides.hooks,
              mcpServers: p.provides.mcpServers,
            }
          : null,
      }),
    );
    setDetailsOpen(true);
    setDetailsLoading(true);
    setActionError(null);
    try {
      const res = await api.pluginDetails(p.name);
      setDetailsBody(res.details?.trim() || tr("ext.plugins.detailsEmpty"));
    } catch (e) {
      setDetailsBody(String(e));
    } finally {
      setDetailsLoading(false);
    }
  };

  const badgeLabel = useCallback(
    (kind: PluginComponentBadgeKind, count?: number | null) => {
      if (kind === "skills" && typeof count === "number" && count > 0) {
        return tr("ext.market.badge.skillsCount", { n: String(count) });
      }
      const key =
        kind === "skills"
          ? "ext.market.badge.skills"
          : kind === "hooks"
            ? "ext.market.badge.hooks"
            : kind === "agents"
              ? "ext.market.badge.agents"
              : "ext.market.badge.mcp";
      return tr(key);
    },
    [tr],
  );

  const resetAddForm = () => {
    setAddName("");
    setAddCommand("");
    setAddArgs("");
    setAddEnv("");
  };

  const openAdd = () => {
    resetAddForm();
    setActionError(null);
    setAddOpen(true);
  };

  const submitAdd = async () => {
    if (!api.isTauri() || actionBusy) return;
    const name = addName.trim();
    const command = addCommand.trim();
    if (!name || !command) return;
    const args = splitArgs(addArgs);
    const env = parseEnvLines(addEnv);
    setActionBusy("mcp:add");
    setActionError(null);
    setActionErrorSource(null);
    try {
      await api.mcpAdd({
        name,
        command,
        args,
        env: Object.keys(env).length ? env : undefined,
      });
      setAddOpen(false);
      resetAddForm();
      await refresh();
    } catch (e) {
      setActionError(String(e));
      setActionErrorSource("mcp");
    } finally {
      setActionBusy(null);
    }
  };

  const confirmRemoveMcp = async () => {
    const target = removeTarget;
    if (!target || !api.isTauri()) return;
    setRemoveTarget(null);
    setActionBusy(`mcp:rm:${target.name}`);
    setActionError(null);
    setActionErrorSource(null);
    try {
      await api.mcpRemove(target.name);
      await refresh();
    } catch (e) {
      setActionError(String(e));
      setActionErrorSource("mcp");
    } finally {
      setActionBusy(null);
    }
  };

  const runDoctor = useCallback(
    async (
      focusName?: string | null,
    ): Promise<{ report: unknown; error: string | null }> => {
      if (!api.isTauri()) {
        return { report: null, error: tr("ext.needTauri") };
      }
      setDoctorOpen(true);
      setDoctorLoading(true);
      setDoctorError(null);
      setDoctorFocus(focusName?.trim() || null);
      try {
        const report = await api.mcpDoctor(focusName?.trim() || null);
        setDoctorReport(report);
        setDoctorLastAt(Date.now());
        const next = indexDoctorServerStatuses(report);
        setDoctorStatusIndex((prev) => {
          // Full doctor (no focus): replace. Focused: merge into previous.
          if (!focusName?.trim()) return next;
          const merged = new Map(prev);
          for (const [k, v] of next) merged.set(k, v);
          return merged;
        });
        return { report, error: null };
      } catch (e) {
        const error = String(e);
        setDoctorReport(null);
        setDoctorError(error);
        return { report: null, error };
      } finally {
        setDoctorLoading(false);
      }
    },
    [tr],
  );

  const openOauthWizard = useCallback(
    (action: McpOauthAction | null, status: McpServerStatus) => {
      if (action) {
        setOauthWizardTarget({ action, status });
        return;
      }
      // No OAuth classifier hit — still open wizard with a synthetic action
      // so the user gets TUI / re-add instructions (soft-fail path).
      const isRetry = status.tone === "auth_expired";
      setOauthWizardTarget({
        action: {
          kind: isRetry ? "retry" : "authorize",
          authUrls: [],
          preferredUrl: null,
          server: status.name,
          isRetry,
        },
        status,
      });
    },
    [],
  );

  /** Live index for the open doctor modal (may be a focused subset). */
  const doctorReportStatusIndex = useMemo(
    () => indexDoctorServerStatuses(doctorReport),
    [doctorReport],
  );

  const doctorLastLabel = useMemo(() => {
    if (!doctorLastAt) return null;
    try {
      return new Date(doctorLastAt).toLocaleString();
    } catch {
      return null;
    }
  }, [doctorLastAt]);

  const visiblePlugins = useMemo(
    () => filterPluginsByLoadState(plugins, pluginFilter),
    [plugins, pluginFilter],
  );

  const tab = activeTab;

  return (
    <div className="ext-panel" data-testid="extensions-panel">
      <p className="settings-page__lead">{tr("ext.lead")}</p>

      {onTabChange ? (
        <div
          className="settings-account-tabs settings-page__tabs"
          role="tablist"
          aria-label={tr("settings.nav.extensions")}
        >
          <div
            className="settings-seg settings-seg--lg settings-page__tabs-seg"
            role="presentation"
          >
            {(
              [
                ["plugins", "ext.plugins.title"],
                ["skills", "ext.skills.title"],
                ["mcp", "ext.mcp.title"],
                ["agents", "ext.agents.title"],
                ["hooks", "ext.hooks.title"],
                ["market", "ext.market.title"],
              ] as const
            ).map(([id, key]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={"settings-seg__btn" + (tab === id ? " is-on" : "")}
                aria-selected={tab === id}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onTabChange(id);
                }}
              >
                {tr(key)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="ext-toolbar">
        <div className="ext-toolbar__scope">
          <span className="ext-badge ext-badge--scope">{scopeLabel}</span>
          {scopePath ? (
            <button
              type="button"
              className="ext-path-btn"
              title={scopePath}
              onClick={() => void reveal(scopePath)}
            >
              <IconFolder size={14} />
              <span>{shortPathLabel(scopePath, 48)}</span>
            </button>
          ) : (
            <span className="ext-toolbar__hint">{tr("ext.scope.globalHint")}</span>
          )}
        </div>
        <div className="ext-toolbar__actions">
          {(agentHome || configPath) && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void reveal(configPath || agentHome)}
              title={configPath || agentHome || undefined}
            >
              <IconExternalLink size={14} />
              <span>{tr("ext.openAgentHome")}</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void refresh()}
            disabled={loading || !!actionBusy || !!busyKey}
          >
            <IconRefresh size={14} />
            <span>{loading ? tr("ext.refreshing") : tr("ext.refresh")}</span>
          </button>
        </div>
      </div>

      {pathHint && (
        <p className="ext-alert ext-alert--warn" role="status">
          {pathHint}
        </p>
      )}

      {actionError && (
        <div className="ext-alert ext-alert--error" role="alert">
          <div className="ext-alert__title">
            {actionErrorSource === "mcp"
              ? tr("ext.mcp.actionError")
              : tr("ext.plugins.actionError")}
          </div>
          <p className="ext-alert__body">{actionError}</p>
          <button
            type="button"
            className="btn btn--ghost ext-alert__cta"
            onClick={() => {
              setActionError(null);
              setActionErrorSource(null);
            }}
          >
            {tr("common.close")}
          </button>
        </div>
      )}

      {bannerError && (
        <div
          className={
            "ext-alert" + (cliMissing ? " ext-alert--error" : " ext-alert--warn")
          }
          role="alert"
        >
          <div className="ext-alert__title">
            {cliMissing ? tr("ext.error.cliTitle") : tr("ext.error.title")}
          </div>
          <p className="ext-alert__body">
            {cliMissing ? tr("ext.error.cliBody") : bannerError}
          </p>
          {cliMissing && onOpenRuntime ? (
            <button
              type="button"
              className="btn btn--solid ext-alert__cta"
              onClick={onOpenRuntime}
            >
              {tr("ext.error.openRuntime")}
            </button>
          ) : null}
          {cliMissing && bannerError && !isCliMissingError(bannerError) ? (
            <p className="ext-alert__detail">{bannerError}</p>
          ) : null}
          {cliMissing && isCliMissingError(bannerError) ? (
            <p className="ext-alert__detail">{bannerError}</p>
          ) : null}
        </div>
      )}

      {/* Plugins — same inventory as Grok Build `plugin list` / Plugins tab */}
      {tab === "plugins" && (
      <>
      <h2 className="settings-page__h2" id="settings-anchor-ext-plugins">
        <IconPuzzle size={15} />
        {tr("ext.plugins.title")}
        {!loading ? (
          <span className="ext-count">{plugins.length}</span>
        ) : null}
        {!loading && plugins.length > 0 ? (
          <button
            type="button"
            className="btn btn--ghost ext-bulk-btn"
            disabled={!!actionBusy || !!busyKey || cliMissing}
            onClick={() => updateAllPlugins()}
          >
            {actionBusy === "update:all"
              ? tr("ext.plugins.updating")
              : tr("ext.plugins.updateAll")}
          </button>
        ) : null}
      </h2>
      <div className="settings-card ext-card">
        {!loading && plugins.length > 0 ? (
          <div
            className="ext-plugin-filters"
            role="tablist"
            aria-label={tr("ext.plugins.filterLabel")}
          >
            {(
              [
                ["all", "ext.plugins.filter.all"],
                ["enabled", "ext.plugins.filter.enabled"],
                ["disabled", "ext.plugins.filter.disabled"],
              ] as const
            ).map(([id, key]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={pluginFilter === id}
                className={
                  "ext-plugin-filter" + (pluginFilter === id ? " is-active" : "")
                }
                onClick={() => setPluginFilter(id)}
              >
                {tr(key)}
              </button>
            ))}
          </div>
        ) : null}
        {loading && <p className="ext-empty">{tr("ext.plugins.loading")}</p>}
        {!loading && plugins.length === 0 && (
          <div className="ext-empty-cta">
            <p className="ext-empty-cta__text">
              {cliMissing ? tr("ext.plugins.emptyCli") : tr("ext.plugins.empty")}
            </p>
            {!cliMissing && onTabChange ? (
              <button
                type="button"
                className="btn btn--solid btn--sm"
                onClick={() => onTabChange("market")}
              >
                <IconPuzzle size={14} />
                <span>{tr("ext.plugins.browseOfficial")}</span>
              </button>
            ) : null}
          </div>
        )}
        {!loading && plugins.length > 0 && visiblePlugins.length === 0 && (
          <p className="ext-empty">{tr("ext.plugins.filterEmpty")}</p>
        )}
        {!loading && visiblePlugins.length > 0 && (
          <ul className="ext-list">
            {visiblePlugins.map((p) => {
              const key = pluginRowKey(p);
              const rowBusy = actionBusy === key;
              const updating = actionBusy === `update:${key}`;
              const validating = actionBusy === `validate:${key}`;
              const busy = rowBusy || updating || validating;
              const tone = pluginStatusTone(p.status, p.enabled);
              const meta = pluginMetaLine(p);
              const provides = pluginProvidesLine(p);
              const vResult = validateByKey[key] ?? null;
              const vPres =
                validatePresByKey[key] ??
                (vResult
                  ? presentValidateResult(vResult)
                  : null);
              const vTone = vPres
                ? pluginValidateRowTone(vPres.severity)
                : vResult
                  ? vResult.ok
                    ? "ok"
                    : "err"
                  : null;
              return (
                <li
                  key={key}
                  className={
                    "ext-item" + (p.enabled ? "" : " ext-item--disabled")
                  }
                >
                  <div className="ext-item__head">
                    <strong className="ext-item__name">{p.name}</strong>
                    <span className={`ext-badge ext-badge--plugin-${tone}`}>
                      {p.enabled
                        ? tr("ext.plugins.status.enabled")
                        : tr("ext.plugins.status.disabled")}
                    </span>
                    {p.scope ? (
                      <span className="ext-badge ext-badge--muted">{p.scope}</span>
                    ) : null}
                    {p.version ? (
                      <span className="ext-badge ext-badge--muted">
                        v{String(p.version).replace(/^v/i, "")}
                      </span>
                    ) : null}
                  </div>
                  {meta ? <p className="ext-item__desc">{meta}</p> : null}
                  {provides ? (
                    <p className="ext-item__desc ext-item__provides">{provides}</p>
                  ) : null}
                  <div className="ext-item__meta">
                    {p.marketplace ? (
                      <span>
                        {tr("ext.plugins.marketplace")}: {p.marketplace}
                      </span>
                    ) : null}
                    {p.path ? (
                      <button
                        type="button"
                        className="ext-path-btn"
                        title={p.path}
                        onClick={() => void reveal(p.path)}
                      >
                        <IconFolder size={13} />
                        <span>{shortPathLabel(p.path, 42)}</span>
                      </button>
                    ) : null}
                  </div>
                  <div className="ext-item__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy || !!actionBusy}
                      onClick={() => togglePlugin(p)}
                    >
                      {rowBusy
                        ? tr("ext.plugins.working")
                        : p.enabled
                          ? tr("ext.plugins.disable")
                          : tr("ext.plugins.enable")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy || !!actionBusy || cliMissing}
                      onClick={() => updatePlugin(p)}
                    >
                      {updating
                        ? tr("ext.plugins.updating")
                        : tr("ext.plugins.update")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy || !!actionBusy}
                      onClick={() => validatePlugin(p)}
                    >
                      {validating
                        ? tr("ext.plugins.validating")
                        : tr("ext.plugins.validate")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy || !!actionBusy}
                      onClick={() => void showDetails(p)}
                    >
                      {tr("ext.plugins.details")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm ext-item__danger"
                      disabled={busy || !!actionBusy}
                      onClick={() => setUninstallTarget(p)}
                    >
                      <IconTrash size={13} />
                      <span>{tr("ext.plugins.uninstall")}</span>
                    </button>
                  </div>
                  {vResult && vPres ? (
                    <div
                      className={
                        "ext-item__validate" +
                        (vTone ? ` ext-item__validate--${vTone}` : "")
                      }
                      role={vPres.ok || vPres.softFail ? "status" : "alert"}
                    >
                      <div className="ext-item__validate-head">
                        <span
                          className={
                            "ext-badge ext-badge--" +
                            pluginValidateBadgeTone(vPres.severity)
                          }
                        >
                          {pluginValidateKindLabel(
                            vPres.kind,
                            pluginValidateKindLabels,
                          )}
                        </span>
                        <div className="ext-item__validate-title">
                          {vPres.ok
                            ? tr("ext.plugins.validateOk")
                            : vPres.softFail
                              ? pluginValidateKindLabel(
                                  vPres.kind,
                                  pluginValidateKindLabels,
                                )
                              : tr("ext.plugins.validateFailed")}
                        </div>
                      </div>
                      {vResult.messages.length > 0 ? (
                        <pre className="ext-item__validate-body">
                          {formatPluginValidateMessages(vResult.messages)}
                        </pre>
                      ) : null}
                      <div className="ext-item__validate-actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            openPluginValidatePresentation(vPres, p.name)
                          }
                        >
                          {tr("ext.plugins.validate.viewResult")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => {
                            setValidateByKey((prev) => {
                              const next = { ...prev };
                              delete next[key];
                              return next;
                            });
                            setValidatePresByKey((prev) => {
                              const next = { ...prev };
                              delete next[key];
                              return next;
                            });
                          }}
                        >
                          {tr("common.close")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {!cliMissing ? (
          <details className="ext-market-sources">
            <summary className="ext-market-sources__summary">
              {tr("ext.plugins.advancedInstall")}
            </summary>
            <div className="ext-plugin-install">
              <label
                className="ext-plugin-install__label"
                htmlFor="ext-plugin-source"
              >
                {tr("ext.plugins.installLabel")}
              </label>
              <div className="ext-plugin-install__row">
                <input
                  id="ext-plugin-source"
                  type="text"
                  className="settings-input ext-plugin-install__input"
                  value={installSource}
                  placeholder={tr("ext.plugins.installPlaceholder")}
                  disabled={!!actionBusy || cliMissing}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setInstallSource(e.target.value);
                    if (installValidate) setInstallValidate(null);
                    if (installValidatePres) setInstallValidatePres(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void installPlugin();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!!actionBusy}
                  title={tr("ext.plugins.validateHint")}
                  onClick={() => validateInstallSource()}
                >
                  {actionBusy === "validate:install"
                    ? tr("ext.plugins.validating")
                    : tr("ext.plugins.validate")}
                </button>
                <button
                  type="button"
                  className="btn btn--solid btn--sm"
                  disabled={
                    !!actionBusy ||
                    cliMissing ||
                    !normalizePluginInstallSource(installSource)
                  }
                  onClick={() => void installPlugin()}
                >
                  {actionBusy === "install"
                    ? tr("ext.plugins.installing")
                    : tr("ext.plugins.install")}
                </button>
              </div>
              <p className="ext-plugin-install__hint">
                {tr("ext.plugins.installHint")}
              </p>
              {installValidate ? (
                (() => {
                  const iPres =
                    installValidatePres ??
                    presentValidateResult(installValidate);
                  const iTone = pluginValidateRowTone(iPres.severity);
                  return (
                    <div
                      className={
                        "ext-item__validate" +
                        ` ext-item__validate--${iTone}`
                      }
                      role={iPres.ok || iPres.softFail ? "status" : "alert"}
                    >
                      <div className="ext-item__validate-head">
                        <span
                          className={
                            "ext-badge ext-badge--" +
                            pluginValidateBadgeTone(iPres.severity)
                          }
                        >
                          {pluginValidateKindLabel(
                            iPres.kind,
                            pluginValidateKindLabels,
                          )}
                        </span>
                        <div className="ext-item__validate-title">
                          {iPres.ok
                            ? tr("ext.plugins.validateOk")
                            : iPres.softFail
                              ? pluginValidateKindLabel(
                                  iPres.kind,
                                  pluginValidateKindLabels,
                                )
                              : tr("ext.plugins.validateFailed")}
                        </div>
                      </div>
                      {installValidate.messages.length > 0 ? (
                        <pre className="ext-item__validate-body">
                          {formatPluginValidateMessages(
                            installValidate.messages,
                          )}
                        </pre>
                      ) : null}
                      <div className="ext-item__validate-actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            openPluginValidatePresentation(iPres, null)
                          }
                        >
                          {tr("ext.plugins.validate.viewResult")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => {
                            setInstallValidate(null);
                            setInstallValidatePres(null);
                          }}
                        >
                          {tr("common.close")}
                        </button>
                      </div>
                    </div>
                  );
                })()
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
      </>
      )}

      {/* Skills */}
      {tab === "skills" && (
      <>
      <h2 className="settings-page__h2" id="settings-anchor-ext-skills">
        <IconSkills size={15} />
        {tr("ext.skills.title")}
        {!loading ? (
          <span className="ext-count">{skills.length}</span>
        ) : null}
        <span className="ext-h2-actions">
          <button
            type="button"
            className="btn btn--ghost ext-bulk-btn"
            disabled={!!actionBusy || !!busyKey || !api.isTauri() || !!skillEditor}
            onClick={openSkillNew}
          >
            <IconPlus size={14} />
            <span>{tr("ext.skills.new")}</span>
          </button>
          {!loading && skills.length > 0 && skillsOffCount > 0 ? (
            <button
              type="button"
              className="btn btn--ghost ext-bulk-btn"
              disabled={!!busyKey}
              onClick={() => void enableAllSkills()}
            >
              {tr("ext.enableAll")}
            </button>
          ) : null}
        </span>
      </h2>
      <div className="settings-card ext-card">
        {loading && (
          <p className="ext-empty">{tr("ext.skills.loading")}</p>
        )}
        {!loading && skills.length === 0 && (
          <p className="ext-empty">
            {cliMissing ? tr("ext.skills.emptyCli") : tr("ext.skills.empty")}
          </p>
        )}
        {!loading && skills.length > 0 && (
          <ul className="ext-list">
            {skills.map((s) => {
              const tone = skillSourceTone(s.source);
              const on = isExtensionEnabled(s.enabled);
              const editable = isSkillEditable(s, skillRoots);
              return (
                <li
                  key={`${s.source}:${s.name}:${s.path ?? ""}`}
                  className={"ext-item" + (on ? "" : " ext-item--off")}
                >
                  <div className="ext-item__head">
                    <strong className="ext-item__name">{s.name}</strong>
                    <span className={`ext-badge ext-badge--${tone}`}>
                      {normalizeSourceLabel(s.source)}
                    </span>
                    {s.userInvocable ? (
                      <span className="ext-badge ext-badge--invocable">
                        {tr("ext.skills.invocable")}
                      </span>
                    ) : null}
                    <ExtensionToggle
                      checked={on}
                      disabled={!!busyKey}
                      label={on ? tr("ext.enabled") : tr("ext.disabled")}
                      onChange={(next) => void toggleSkill(s.name, next)}
                    />
                  </div>
                  {s.description ? (
                    <p className="ext-item__desc">{s.description}</p>
                  ) : null}
                  <div className="ext-item__meta">
                    <span>{skillMetaLine(s)}</span>
                    {s.path ? (
                      <button
                        type="button"
                        className="ext-path-btn"
                        title={s.path}
                        onClick={() => void reveal(s.path)}
                      >
                        <IconFolder size={13} />
                        <span>{shortPathLabel(s.path, 42)}</span>
                      </button>
                    ) : null}
                  </div>
                  {editable ? (
                    <div className="ext-item__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={!!busyKey || !!skillEditor}
                        onClick={() => void openSkillEditor(s)}
                      >
                        <IconEdit size={13} />
                        <span>{tr("ext.skills.edit")}</span>
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </>
      )}

      {/* MCP */}
      {tab === "mcp" && (
      <>
      <h2 className="settings-page__h2" id="settings-anchor-ext-mcp">
        <IconPlug size={15} />
        {tr("ext.mcp.title")}
        {!loading ? (
          <span className="ext-count">{servers.length}</span>
        ) : null}
        <span className="ext-h2-actions">
          <button
            type="button"
            className="btn btn--ghost ext-bulk-btn"
            disabled={!!actionBusy || !!busyKey || cliMissing}
            onClick={() => void runDoctor(null)}
          >
            <IconDoctor size={14} />
            <span>{tr("ext.mcp.doctor")}</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost ext-bulk-btn"
            disabled={!!actionBusy || !!busyKey || !api.isTauri()}
            onClick={openAdd}
          >
            <IconPlus size={14} />
            <span>{tr("ext.mcp.add")}</span>
          </button>
          {!loading && servers.length > 0 && mcpOffCount > 0 ? (
            <button
              type="button"
              className="btn btn--ghost ext-bulk-btn"
              disabled={!!busyKey || !!actionBusy}
              onClick={() => void enableAllMcp()}
            >
              {tr("ext.enableAll")}
            </button>
          ) : null}
        </span>
      </h2>
      <div className="settings-card ext-card">
        {doctorLastLabel ? (
          <p className="ext-mcp-last-doctor" role="status">
            {tr("ext.mcp.doctorLastAt", { time: doctorLastLabel })}
          </p>
        ) : null}
        {loading && <p className="ext-empty">{tr("ext.mcp.loading")}</p>}
        {!loading && servers.length === 0 && (
          <p className="ext-empty">
            {cliMissing ? tr("ext.mcp.emptyCli") : tr("ext.mcp.empty")}
          </p>
        )}
        {!loading && servers.length > 0 && (
          <ul className="ext-list">
            {servers.map((s) => {
              const meta = mcpMetaLine(s);
              const on = isExtensionEnabled(s.enabled);
              const rmBusy = actionBusy === `mcp:rm:${s.name}`;
              const st = lookupServerStatus(doctorStatusIndex, s.name);
              const badgeMod = st ? mcpStatusBadgeMod(st.tone) : null;
              const guidanceKey = st ? mcpAuthGuidanceKey(st.tone) : null;
              const oauthAction = st
                ? classifyMcpOauthFromStatus(st)
                : null;
              return (
                <li
                  key={s.name}
                  className={"ext-item" + (on ? "" : " ext-item--off")}
                >
                  <div className="ext-item__head">
                    <strong className="ext-item__name">{s.name}</strong>
                    {st && badgeMod ? (
                      <span
                        className={
                          "ext-mcp-status ext-mcp-status--" + badgeMod
                        }
                        title={st.reason ?? undefined}
                      >
                        <span
                          className="ext-mcp-status__lamp"
                          aria-hidden
                        />
                        <span
                          className={"ext-badge ext-badge--" + badgeMod}
                        >
                          {tr(mcpStatusLabelKey(st.tone) as MessageKey)}
                        </span>
                      </span>
                    ) : null}
                    {s.transport ? (
                      <span className="ext-badge ext-badge--muted">
                        {s.transport}
                      </span>
                    ) : null}
                    {s.compatibilityStatus ? (
                      <span className="ext-badge ext-badge--compat">
                        {s.compatibilityStatus}
                      </span>
                    ) : null}
                    <ExtensionToggle
                      checked={on}
                      disabled={!!busyKey || !!actionBusy}
                      label={on ? tr("ext.enabled") : tr("ext.disabled")}
                      onChange={(next) => void toggleMcp(s.name, next)}
                    />
                  </div>
                  {meta ? <p className="ext-item__desc">{meta}</p> : null}
                  {st?.reason && st.tone !== "ok" ? (
                    <p className="ext-item__desc ext-mcp-status-reason">
                      {redactMcpText(st.reason)}
                    </p>
                  ) : null}
                  {st?.needsAuthRefresh && guidanceKey ? (
                    <div className="ext-mcp-auth-row">
                      <p className="ext-mcp-auth-hint">
                        {tr(guidanceKey as MessageKey)}
                      </p>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => openOauthWizard(oauthAction, st)}
                      >
                        {tr(
                          (oauthAction
                            ? mcpOauthActionLabelKey(oauthAction.kind)
                            : "ext.mcp.auth.howToRefresh") as MessageKey,
                        )}
                      </button>
                    </div>
                  ) : null}
                  {s.target ? (
                    <div className="ext-item__meta">
                      <em className="ext-item__target" title={s.target}>
                        {shortPathLabel(s.target, 64) || s.target}
                      </em>
                      {looksLikePath(s.target) ? (
                        <button
                          type="button"
                          className="ext-path-btn"
                          title={s.target}
                          onClick={() => void reveal(s.target)}
                        >
                          <IconFolder size={13} />
                          <span>{tr("ext.reveal")}</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {s.vendor ? (
                    <div className="ext-item__meta">
                      <span>
                        {tr("ext.mcp.vendor")}: {s.vendor}
                      </span>
                    </div>
                  ) : null}
                  <div className="ext-item__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={!!actionBusy || doctorLoading || cliMissing}
                      onClick={() => void runDoctor(s.name)}
                    >
                      <IconDoctor size={13} />
                      <span>{tr("ext.mcp.doctor")}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm ext-item__danger"
                      disabled={rmBusy || !!actionBusy}
                      onClick={() => setRemoveTarget(s)}
                    >
                      <IconTrash size={13} />
                      <span>
                        {rmBusy
                          ? tr("ext.plugins.working")
                          : tr("ext.mcp.remove")}
                      </span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </>
      )}

      {tab === "hooks" && (
        <ExtensionsHooksPanel
          locale={locale}
          projectPath={projectPath}
          cliFound={cliFound && !cliMissing}
        />
      )}
      {(tab === "market" || tab === "agents") && (
        <ExtensionsBuildExtras
          locale={locale}
          projectPath={projectPath}
          cliFound={cliFound && !cliMissing}
          mode={tab === "agents" ? "agents" : "market"}
          installedPlugins={plugins.map((p) => ({
            name: p.name,
            marketplace: p.marketplace,
          }))}
          onOpenRuntime={onOpenRuntime}
          onPluginsChanged={() => {
            void refresh();
          }}
        />
      )}

      <GlassModal
        open={!!uninstallTarget}
        onClose={() => {
          if (!actionBusy) setUninstallTarget(null);
        }}
        title={tr("ext.plugins.uninstallTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!!actionBusy}
              onClick={() => setUninstallTarget(null)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={!!actionBusy}
              onClick={() => void confirmUninstall()}
            >
              {tr("ext.plugins.uninstall")}
            </button>
          </>
        }
      >
        <p className="app-dialog__msg">
          {tr("ext.plugins.uninstallConfirm", {
            name: uninstallTarget?.name ?? "",
          })}
        </p>
      </GlassModal>

      <GlassModal
        open={validateModal.open && !!validateModal.presentation}
        onClose={() =>
          setValidateModal((prev) => ({ ...prev, open: false }))
        }
        title={
          validateModal.pluginName
            ? tr("ext.plugins.validate.resultTitleNamed", {
                name: validateModal.pluginName,
              })
            : tr("ext.plugins.validate.resultTitle")
        }
        size="lg"
        closeLabel={tr("common.close")}
        wrapBody
        bodyClassName="ext-plugin-result-modal"
        footer={
          <button
            type="button"
            className="btn btn--solid"
            onClick={() =>
              setValidateModal((prev) => ({ ...prev, open: false }))
            }
          >
            {tr("common.close")}
          </button>
        }
      >
        {validateModal.presentation ? (
          <div className="ext-plugin-result">
            <div className="ext-plugin-result__meta">
              <span
                className={
                  "ext-badge ext-badge--" +
                  pluginValidateBadgeTone(validateModal.presentation.severity)
                }
              >
                {pluginValidateKindLabel(
                  validateModal.presentation.kind,
                  pluginValidateKindLabels,
                )}
              </span>
              {validateModal.presentation.softFail ? (
                <span className="ext-badge ext-badge--muted">
                  {tr("ext.plugins.validate.softFail")}
                </span>
              ) : null}
              {validateModal.presentation.ok ? (
                <span className="ext-badge ext-badge--ok">
                  {tr("ext.plugins.validateOk")}
                </span>
              ) : null}
            </div>
            <p
              className={
                "ext-plugin-result__summary" +
                (validateModal.presentation.severity === "ok"
                  ? " ext-plugin-result__summary--ok"
                  : validateModal.presentation.severity === "err"
                    ? " ext-plugin-result__summary--err"
                    : " ext-plugin-result__summary--warn")
              }
            >
              {validateModal.presentation.summary}
            </p>
            {pluginValidateHint(
              validateModal.presentation.kind,
              pluginValidateKindHints,
            ) ? (
              <p className="ext-plugin-result__hint">
                {pluginValidateHint(
                  validateModal.presentation.kind,
                  pluginValidateKindHints,
                )}
              </p>
            ) : null}
            {validateModal.presentation.detail &&
            validateModal.presentation.detail !==
              validateModal.presentation.summary ? (
              <pre className="ext-plugin-result__detail">
                {validateModal.presentation.detail}
              </pre>
            ) : validateModal.presentation.messages.length > 1 ? (
              <pre className="ext-plugin-result__detail">
                {formatPluginValidateMessages(
                  validateModal.presentation.messages,
                )}
              </pre>
            ) : null}
            {validateModal.presentation.reason ? (
              <p className="ext-plugin-result__reason">
                <span className="ext-plugin-result__label">
                  {tr("ext.plugins.validate.reason")}
                </span>
                <code>{validateModal.presentation.reason}</code>
              </p>
            ) : null}
            {validateModal.presentation.path ? (
              <p
                className="ext-plugin-result__path"
                title={validateModal.presentation.path}
              >
                <span className="ext-plugin-result__label">
                  {tr("ext.plugins.validate.path")}
                </span>
                <code>{validateModal.presentation.path}</code>
              </p>
            ) : null}
          </div>
        ) : null}
      </GlassModal>

      <GlassModal
        open={detailsOpen}
        onClose={() => {
          setDetailsOpen(false);
          setDetailsModel(null);
        }}
        title={tr("ext.plugins.detailsTitle", { name: detailsTitle })}
        size="lg"
        closeLabel={tr("common.close")}
        wrapBody
        footer={
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setDetailsOpen(false);
              setDetailsModel(null);
            }}
          >
            {tr("common.close")}
          </button>
        }
      >
        {detailsModel ? (
          <div className="ext-market-detail">
            <dl className="ext-market-detail__meta">
              <div className="ext-market-detail__row">
                <dt>{tr("ext.market.field.marketplace")}</dt>
                <dd>
                  {detailsModel.marketplace?.trim() ||
                    tr("ext.market.field.unknown")}
                </dd>
              </div>
              <div className="ext-market-detail__row">
                <dt>{tr("ext.market.field.version")}</dt>
                <dd>
                  {detailsModel.versionLabel
                    ? `v${detailsModel.versionLabel}`
                    : tr("ext.market.field.unknown")}
                </dd>
              </div>
            </dl>
            {detailsModel.badges.length > 0 ? (
              <div
                className="ext-component-badges ext-component-badges--detail"
                aria-label={tr("ext.market.componentsLabel")}
              >
                {detailsModel.badges.map((b) => (
                  <span
                    key={b.kind}
                    className={
                      "ext-badge ext-badge--component ext-badge--component-" +
                      b.kind
                    }
                  >
                    {badgeLabel(b.kind, b.count)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {detailsLoading ? (
          <p className="ext-empty">{tr("ext.plugins.detailsLoading")}</p>
        ) : (
          <pre className="ext-details-pre">{detailsBody}</pre>
        )}
      </GlassModal>

      <GlassModal
        open={addOpen}
        onClose={() => {
          if (actionBusy !== "mcp:add") setAddOpen(false);
        }}
        title={tr("ext.mcp.addTitle")}
        size="md"
        closeLabel={tr("common.close")}
        wrapBody
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={actionBusy === "mcp:add"}
              onClick={() => setAddOpen(false)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              disabled={
                actionBusy === "mcp:add" ||
                !addName.trim() ||
                !addCommand.trim()
              }
              onClick={() => void submitAdd()}
            >
              {actionBusy === "mcp:add"
                ? tr("ext.mcp.addWorking")
                : tr("ext.mcp.addSubmit")}
            </button>
          </>
        }
      >
        <form
          className="app-dialog__form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitAdd();
          }}
        >
          <label className="field">
            <span>{tr("ext.mcp.name")}</span>
            <input
              className="app-dialog__input"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder={tr("ext.mcp.namePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={actionBusy === "mcp:add"}
            />
          </label>
          <label className="field">
            <span>{tr("ext.mcp.command")}</span>
            <input
              className="app-dialog__input"
              value={addCommand}
              onChange={(e) => setAddCommand(e.target.value)}
              placeholder={tr("ext.mcp.commandPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={actionBusy === "mcp:add"}
            />
          </label>
          <label className="field">
            <span>{tr("ext.mcp.args")}</span>
            <input
              className="app-dialog__input"
              value={addArgs}
              onChange={(e) => setAddArgs(e.target.value)}
              placeholder={tr("ext.mcp.argsPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={actionBusy === "mcp:add"}
            />
            <span className="ext-field-hint">{tr("ext.mcp.argsHint")}</span>
          </label>
          <label className="field">
            <span>{tr("ext.mcp.env")}</span>
            <textarea
              className="app-dialog__input ext-env-textarea"
              value={addEnv}
              onChange={(e) => setAddEnv(e.target.value)}
              placeholder={tr("ext.mcp.envPlaceholder")}
              rows={3}
              spellCheck={false}
              disabled={actionBusy === "mcp:add"}
            />
            <span className="ext-field-hint">{tr("ext.mcp.envHint")}</span>
          </label>
        </form>
      </GlassModal>

      <GlassModal
        open={!!removeTarget}
        onClose={() => {
          if (!actionBusy) setRemoveTarget(null);
        }}
        title={tr("ext.mcp.removeTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!!actionBusy}
              onClick={() => setRemoveTarget(null)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={!!actionBusy}
              onClick={() => void confirmRemoveMcp()}
            >
              {tr("ext.mcp.remove")}
            </button>
          </>
        }
      >
        <p className="app-dialog__msg">
          {tr("ext.mcp.removeConfirm", {
            name: removeTarget?.name ?? "",
          })}
        </p>
      </GlassModal>

      <GlassModal
        open={doctorOpen}
        onClose={() => {
          if (!doctorLoading) setDoctorOpen(false);
        }}
        title={
          doctorFocus
            ? `${tr("ext.mcp.doctorTitle")} · ${doctorFocus}`
            : tr("ext.mcp.doctorTitle")
        }
        size="lg"
        closeLabel={tr("common.close")}
        wrapBody
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={doctorLoading}
              onClick={() => void runDoctor(doctorFocus)}
            >
              <IconRefresh size={14} />
              <span>{tr("ext.mcp.doctorRerun")}</span>
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={doctorLoading}
              onClick={() => setDoctorOpen(false)}
            >
              {tr("common.close")}
            </button>
          </>
        }
      >
        {doctorLoading && (
          <p className="ext-empty">{tr("ext.mcp.doctorRunning")}</p>
        )}
        {!doctorLoading && doctorError && (
          <div className="ext-alert ext-alert--error" role="alert">
            <p className="ext-alert__body">{doctorError}</p>
          </div>
        )}
        {!doctorLoading && doctorReport && (
          <div className="ext-doctor">
            <p className="ext-doctor__summary">
              {tr("ext.mcp.doctorSummary", {
                healthy: doctorReport.summary.healthy,
                unhealthy: doctorReport.summary.unhealthy,
                total: doctorReport.summary.total,
              })}
            </p>
            {(doctorReport.sources?.length ?? 0) > 0 ? (
              <div className="ext-doctor__sources">
                <div className="ext-doctor__section-title">
                  {tr("ext.mcp.doctorSources")}
                </div>
                <ul className="ext-doctor__source-list">
                  {doctorReport.sources.map((src: any) => (
                    <li key={src.path}>
                      <code>{src.path}</code>
                      <span className="ext-badge ext-badge--muted">
                        {src.status}
                        {src.serverCount != null
                          ? ` · ${src.serverCount}`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(doctorReport.servers?.length ?? 0) === 0 ? (
              <p className="ext-empty">
                {redactMcpText(doctorReport.rawText)?.trim() ||
                  tr("ext.mcp.doctorEmpty")}
              </p>
            ) : (
              <ul className="ext-list ext-doctor__servers">
                {doctorReport.servers.map((s: any) => {
                  const st =
                    lookupServerStatus(doctorReportStatusIndex, s.name) ??
                    lookupServerStatus(doctorStatusIndex, s.name);
                  const badgeMod = st
                    ? mcpStatusBadgeMod(st.tone)
                    : s.healthy
                      ? "ok"
                      : "fail";
                  const label = st
                    ? tr(mcpStatusLabelKey(st.tone) as MessageKey)
                    : s.healthy
                      ? tr("ext.mcp.doctorHealthy")
                      : tr("ext.mcp.doctorUnhealthy");
                  const guidanceKey = st
                    ? mcpAuthGuidanceKey(st.tone)
                    : null;
                  const oauthAction = st
                    ? classifyMcpOauthFromStatus(st)
                    : null;
                  return (
                    <li
                      key={s.name}
                      className={
                        "ext-item" + (s.healthy ? "" : " ext-item--off")
                      }
                    >
                      <div className="ext-item__head">
                        <strong className="ext-item__name">{s.name}</strong>
                        <span
                          className={
                            "ext-mcp-status ext-mcp-status--" + badgeMod
                          }
                        >
                          <span
                            className="ext-mcp-status__lamp"
                            aria-hidden
                          />
                          <span
                            className={"ext-badge ext-badge--" + badgeMod}
                          >
                            {label}
                          </span>
                        </span>
                        {s.transport ? (
                          <span className="ext-badge ext-badge--muted">
                            {s.transport}
                          </span>
                        ) : null}
                      </div>
                      {s.target ? (
                        <p className="ext-item__desc" title={s.target}>
                          {shortPathLabel(s.target, 72) || s.target}
                        </p>
                      ) : null}
                      {st?.needsAuthRefresh && guidanceKey ? (
                        <div className="ext-mcp-auth-row">
                          <p className="ext-mcp-auth-hint">
                            {tr(guidanceKey as MessageKey)}
                          </p>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => openOauthWizard(oauthAction, st)}
                          >
                            {tr(
                              (oauthAction
                                ? mcpOauthActionLabelKey(oauthAction.kind)
                                : "ext.mcp.auth.howToRefresh") as MessageKey,
                            )}
                          </button>
                        </div>
                      ) : null}
                      {Array.isArray(s.checks) && s.checks.length > 0 ? (
                        <ul className="ext-doctor__checks">
                          {s.checks.map((c: any, i: any) => (
                            <li
                              key={`${s.name}:${c.label}:${i}`}
                              className={
                                "ext-doctor__check" +
                                (c.passed ? " is-pass" : " is-fail")
                              }
                            >
                              <span className="ext-doctor__check-label">
                                {c.passed ? "✓" : "✗"} {c.label}
                              </span>
                              {c.detail ? (
                                <span className="ext-doctor__check-detail">
                                  {redactMcpText(c.detail)}
                                </span>
                              ) : null}
                              {c.hint ? (
                                <span className="ext-doctor__check-hint">
                                  {tr("ext.mcp.doctorHint", {
                                    hint: redactMcpText(c.hint),
                                  })}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {doctorReport.rawText ? (
              <pre className="ext-details-pre">
                {redactMcpText(doctorReport.rawText)}
              </pre>
            ) : null}
          </div>
        )}
      </GlassModal>

      <McpOauthWizard
        open={!!oauthWizardTarget}
        locale={locale}
        action={oauthWizardTarget?.action ?? null}
        statusReason={oauthWizardTarget?.status.reason ?? null}
        onClose={() => setOauthWizardTarget(null)}
        onRefreshDoctor={async (serverName) => {
          // Keep doctor modal closed when refreshing from wizard; still update index.
          if (!api.isTauri()) {
            return { report: null, error: tr("ext.needTauri") };
          }
          setDoctorLoading(true);
          setDoctorError(null);
          setDoctorFocus(serverName?.trim() || null);
          try {
            const report = await api.mcpDoctor(serverName?.trim() || null);
            setDoctorReport(report);
            setDoctorLastAt(Date.now());
            const next = indexDoctorServerStatuses(report);
            setDoctorStatusIndex((prev) => {
              if (!serverName?.trim()) return next;
              const merged = new Map(prev);
              for (const [k, v] of next) merged.set(k, v);
              return merged;
            });
            return { report, error: null };
          } catch (e) {
            const error = String(e);
            setDoctorError(error);
            return { report: null, error };
          } finally {
            setDoctorLoading(false);
          }
        }}
      />

      <GlassModal
        open={skillNewOpen}
        onClose={() => {
          if (actionBusy !== "skill:create") setSkillNewOpen(false);
        }}
        title={tr("ext.skills.newTitle")}
        size="md"
        closeLabel={tr("common.close")}
        wrapBody
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={actionBusy === "skill:create"}
              onClick={() => setSkillNewOpen(false)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              disabled={
                actionBusy === "skill:create" || !skillNewSanitized
              }
              onClick={() => void submitSkillNew()}
            >
              {actionBusy === "skill:create"
                ? tr("ext.skills.newWorking")
                : tr("ext.skills.newSubmit")}
            </button>
          </>
        }
      >
        <form
          className="app-dialog__form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitSkillNew();
          }}
        >
          <label className="field">
            <span>{tr("ext.skills.newName")}</span>
            <input
              className="app-dialog__input"
              value={skillNewName}
              onChange={(e) => {
                setSkillNewName(e.target.value);
                setSkillNewError(null);
              }}
              placeholder={tr("ext.skills.newNamePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={actionBusy === "skill:create"}
              autoFocus
            />
            <span className="ext-field-hint">
              {skillNewSanitized
                ? tr("ext.skills.newNameHintOk", { name: skillNewSanitized })
                : tr("ext.skills.newNameHint")}
            </span>
          </label>
          <label className="field">
            <span>{tr("ext.skills.newDescription")}</span>
            <textarea
              className="app-dialog__input ext-env-textarea"
              value={skillNewDesc}
              onChange={(e) => {
                setSkillNewDesc(e.target.value);
                setSkillNewError(null);
              }}
              placeholder={tr("ext.skills.newDescriptionPlaceholder")}
              rows={3}
              spellCheck
              disabled={actionBusy === "skill:create"}
            />
            <span className="ext-field-hint">
              {tr("ext.skills.newDescriptionHint")}
            </span>
          </label>
          <fieldset className="field" disabled={actionBusy === "skill:create"}>
            <legend>{tr("ext.skills.newScope")}</legend>
            <label className="ext-radio-row">
              <input
                type="radio"
                name="skill-new-scope"
                checked={skillNewScope === "user"}
                onChange={() => setSkillNewScope("user")}
              />
              <span>{tr("ext.skills.newScopeUser")}</span>
            </label>
            <label className="ext-radio-row">
              <input
                type="radio"
                name="skill-new-scope"
                checked={skillNewScope === "project"}
                onChange={() => setSkillNewScope("project")}
                disabled={!projectPath?.trim()}
              />
              <span>
                {projectPath?.trim()
                  ? tr("ext.skills.newScopeProject")
                  : tr("ext.skills.newScopeProjectDisabled")}
              </span>
            </label>
            <span className="ext-field-hint">{tr("ext.skills.newScopeHint")}</span>
          </fieldset>
          {skillNewError ? (
            <p className="ext-alert" role="alert">
              <span className="ext-alert__body">{skillNewError}</span>
            </p>
          ) : null}
        </form>
      </GlassModal>

      <GlassModal
        open={!!skillEditor}
        onClose={requestCloseSkillEditor}
        title={
          skillEditor
            ? tr("ext.skills.editTitle", { name: skillEditor.skill.name })
            : tr("ext.skills.edit")
        }
        size="lg"
        closeLabel={tr("common.close")}
        closeOnOverlay={!skillEditor?.saving}
        wrapBody
        bodyClassName="ext-skill-editor"
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!!skillEditor?.saving}
              onClick={requestCloseSkillEditor}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={
                !skillEditor || skillEditor.loading || skillEditor.saving
              }
              onClick={validateSkillEditor}
            >
              {tr("ext.skills.editValidate")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              disabled={
                !skillEditor ||
                skillEditor.loading ||
                skillEditor.saving ||
                !!skillEditor.error ||
                !skillEditorDirty
              }
              onClick={() => void saveSkillEditor()}
            >
              {skillEditor?.saving
                ? tr("ext.skills.editSaving")
                : tr("common.save")}
            </button>
          </>
        }
      >
        {skillEditor ? (
          <>
            {!isExtensionEnabled(skillEditor.skill.enabled) ? (
              <p className="ext-skill-editor__note" role="status">
                {tr("ext.skills.editDisabledNote")}
              </p>
            ) : null}
            {skillEditor.path ? (
              <p className="ext-skill-editor__path" title={skillEditor.path}>
                {shortPathLabel(skillEditor.path, 72) || skillEditor.path}
              </p>
            ) : null}
            {skillEditor.loading ? (
              <p className="ext-empty">{tr("ext.skills.editLoading")}</p>
            ) : skillEditor.error && !skillEditor.baselineText ? (
              <p className="ext-alert ext-alert--error" role="alert">
                <span className="ext-alert__body">{skillEditor.error}</span>
              </p>
            ) : (
              <textarea
                className="ext-skill-editor__textarea"
                value={skillEditor.draftText}
                onChange={(e) =>
                  setSkillEditor((s) =>
                    s
                      ? {
                          ...s,
                          draftText: e.target.value,
                          savedHint: null,
                          error: null,
                        }
                      : s,
                  )
                }
                spellCheck={false}
                disabled={skillEditor.saving}
                aria-label={tr("ext.skills.editAria", {
                  name: skillEditor.skill.name,
                })}
                rows={18}
              />
            )}
            {skillEditor.error && skillEditor.baselineText ? (
              <p className="ext-skill-editor__error" role="alert">
                {skillEditor.error}
                {skillFeedback ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm ext-skill-editor__details-btn"
                      onClick={() => setSkillFeedbackOpen(true)}
                    >
                      {tr("ext.skills.feedback.viewDetails")}
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            {skillEditor.savedHint ? (
              <p
                className={
                  "ext-skill-editor__saved" +
                  (skillFeedback && !skillFeedback.blocking
                    ? skillFeedback.severity === "warn"
                      ? " ext-skill-editor__status--warn"
                      : skillFeedback.severity === "ok"
                        ? " ext-skill-editor__status--ok"
                        : ""
                    : " ext-skill-editor__status--ok")
                }
                role="status"
              >
                {skillEditor.savedHint}
                {skillFeedback && !skillFeedback.blocking ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm ext-skill-editor__details-btn"
                      onClick={() => setSkillFeedbackOpen(true)}
                    >
                      {tr("ext.skills.feedback.viewDetails")}
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}
      </GlassModal>

      <GlassModal
        open={skillFeedbackOpen && !!skillFeedback}
        onClose={() => setSkillFeedbackOpen(false)}
        title={
          skillFeedback?.phase === "validate"
            ? tr("ext.skills.feedback.resultValidateTitle")
            : skillFeedback?.phase === "load"
              ? tr("ext.skills.feedback.resultLoadTitle")
              : skillFeedback?.phase === "create"
                ? tr("ext.skills.feedback.resultCreateTitle")
                : tr("ext.skills.feedback.resultSaveTitle")
        }
        size="md"
        closeLabel={tr("common.close")}
        wrapBody
        bodyClassName="ext-skill-feedback"
        footer={
          <>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => setSkillFeedbackOpen(false)}
            >
              {tr("common.close")}
            </button>
          </>
        }
      >
        {skillFeedback ? (
          <div className="ext-skill-feedback__body">
            <div className="ext-skill-feedback__meta">
              <span
                className={
                  "ext-badge ext-badge--" +
                  skillEditBadgeTone(skillFeedback.severity)
                }
              >
                {skillEditKindLabel(skillFeedback.kind, skillKindLabels)}
              </span>
              {skillFeedback.name ? (
                <span className="ext-badge ext-badge--muted">
                  /{skillFeedback.name}
                </span>
              ) : null}
              {skillFeedback.sizeBytes != null ? (
                <span className="ext-badge ext-badge--muted">
                  {tr("ext.skills.feedback.sizeBytes", {
                    n: String(skillFeedback.sizeBytes),
                  })}
                </span>
              ) : null}
            </div>
            <p
              className={
                "ext-skill-feedback__summary" +
                (skillFeedback.severity === "ok"
                  ? " ext-skill-feedback__summary--ok"
                  : skillFeedback.severity === "err"
                    ? " ext-skill-feedback__summary--err"
                    : skillFeedback.severity === "warn"
                      ? " ext-skill-feedback__summary--warn"
                      : "")
              }
            >
              {skillFeedback.summary}
            </p>
            {skillEditHint(skillFeedback.kind, skillKindHints) ? (
              <p className="ext-skill-feedback__hint">
                {skillEditHint(skillFeedback.kind, skillKindHints)}
              </p>
            ) : null}
            {skillFeedback.detail &&
            skillFeedback.detail !== skillFeedback.summary ? (
              <p className="ext-skill-feedback__detail">
                {skillFeedback.detail}
              </p>
            ) : null}
            {skillFeedback.issues.length > 1 ? (
              <ul className="ext-skill-feedback__issues">
                {skillFeedback.issues.map((issue, idx) => (
                  <li key={`${issue.kind}-${idx}`}>
                    <span
                      className={
                        "ext-badge ext-badge--" +
                        skillEditBadgeTone(issue.severity)
                      }
                    >
                      {skillEditKindLabel(issue.kind, skillKindLabels)}
                    </span>
                    {issue.detail ? (
                      <span className="ext-skill-feedback__issue-detail">
                        {issue.detail}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {skillFeedback.reason ? (
              <p className="ext-skill-feedback__reason">
                <span className="ext-skill-feedback__label">
                  {tr("ext.skills.feedback.reason")}
                </span>
                <code>{skillFeedback.reason}</code>
              </p>
            ) : null}
            {skillFeedback.path ? (
              <p className="ext-skill-feedback__path" title={skillFeedback.path}>
                <span className="ext-skill-feedback__label">
                  {tr("ext.skills.feedback.path")}
                </span>
                <code>
                  {shortPathLabel(skillFeedback.path, 64) || skillFeedback.path}
                </code>
              </p>
            ) : null}
          </div>
        ) : null}
      </GlassModal>

      <GlassModal
        open={skillDiscardOpen}
        onClose={() => setSkillDiscardOpen(false)}
        title={tr("ext.skills.editDiscardTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setSkillDiscardOpen(false)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setSkillDiscardOpen(false);
                closeSkillEditor();
              }}
            >
              {tr("ext.skills.editDiscard")}
            </button>
          </>
        }
      >
        <p className="app-dialog__msg">{tr("ext.skills.editDiscardBody")}</p>
      </GlassModal>

      <GlassModal
        open={skillConflictOpen}
        onClose={() => setSkillConflictOpen(false)}
        title={tr("ext.skills.editConflictTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setSkillConflictOpen(false);
                if (skillEditor) void openSkillEditor(skillEditor.skill);
              }}
            >
              {tr("ext.skills.editConflictReload")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => {
                setSkillConflictOpen(false);
                void saveSkillEditor({ force: true });
              }}
            >
              {tr("ext.skills.editConflictOverwrite")}
            </button>
          </>
        }
      >
        <p className="app-dialog__msg">{tr("ext.skills.editConflictBody")}</p>
      </GlassModal>
    </div>
  );
}

/** Space-separated args; keeps simple tokens (no shell quoting). */
function splitArgs(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse KEY=value lines into a map. Skips blanks and `#` comments. */
function parseEnvLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function ExtensionToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={"ext-switch" + (checked ? " is-on" : "")}
      onClick={() => onChange(!checked)}
    >
      <span className="ext-switch__thumb" aria-hidden />
    </button>
  );
}

function normalizeSourceLabel(source: string): string {
  const s = (source ?? "").trim();
  return s || "unknown";
}

function looksLikePath(target: string): boolean {
  const t = target.trim();
  if (!t) return false;
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.startsWith("~")) return true;
  if (/\s/.test(t) || t.startsWith("http://") || t.startsWith("https://")) {
    return false;
  }
  return t.includes("/") || t.includes("\\");
}
