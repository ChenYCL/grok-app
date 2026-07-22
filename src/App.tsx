import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useFloatingMenu } from "@/lib/floatingMenu";
import {
  applyThemeToDocument,
  loadTheme,
  saveTheme,
  toggleTheme,
  type Theme,
} from "@/lib/theme";
import {
  DEFAULT_LAYOUT,
  clampAsideWidth,
  loadLayout,
  saveLayout,
} from "@/lib/layout";
import {
  applyStreamChunk,
  canSend,
  canStop,
  canType,
  presentErrorBanner,
  IDLE_SNAPSHOT,
  type ChatMessage,
  type PermissionPayload,
  type SessionSnapshot,
  type StreamPayload,
} from "@/lib/session";
import * as api from "@/lib/api";
import { createT, resolveLocale, type Locale } from "@/i18n";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL_ID,
  isValidEffort,
  isValidModelId,
  isValidPolicy,
  type PermissionPolicyId,
} from "@/lib/grokCatalog";
import { redact } from "@/lib/redact";
import { mapPermissionButtons } from "@/lib/permissionOptions";
import {
  buildAgentPrompt,
  isImagePath,
  mergeAttachments,
  parseAttachmentsFromContent,
  type Attachment,
} from "@/lib/attachments";
import { AttachmentCard } from "@/components/AttachmentCard";
import { ImageViewerProvider } from "@/components/ImageViewer";
import { OverlayScroll } from "@/components/OverlayScroll";
import { GrokLogo } from "@/components/GrokLogo";
import {
  IconChevronDown,
  IconChevronRight,
  IconMore,
  IconPlus,
  IconSearch,
  IconAttach,
  IconSend,
  IconStop,
  IconFolder,
  IconFolderPlus,
  IconClose,
  IconNewChat as IconSquarePen,
  IconCollapse,
  IconImagine,
  IconSkills,
  IconAutomations,
  IconMic,
  IconPanel,
  IconFiles,
  IconArchive,
  IconMinimize,
  IconMaximize,
  IconPin,
} from "@/components/icons";
import {
  ComposerAccessMenu,
  ComposerModelMenu,
} from "@/components/ComposerModelMenu";
import { ResourceViewer } from "@/components/ResourceViewer";
import { ConversationThread } from "@/components/chat/ConversationThread";
import { UserMenu, remainingPercent } from "@/components/UserMenu";
import {
  SettingsPage,
  type SettingsSectionId,
} from "@/components/SettingsPage";
import {
  accountDisplayName,
  accountInitials,
  isAccountConnected,
} from "@/lib/accountUi";

interface Project {
  id: string;
  name: string;
  path: string;
  trusted: boolean;
  pathOk: boolean;
  pinned?: boolean;
}

interface SessionRow {
  id: string;
  title: string;
  projectId: string | null;
  updatedAt: string;
  archived?: boolean;
}

type ContextMenuState =
  | { kind: "project"; id: string; x: number; y: number }
  | { kind: "session"; id: string; x: number; y: number }
  | null;

interface PlanState {
  title: string;
  body: string;
  entries: unknown[];
  waiting: boolean;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme(localStorage));
  const [layout, setLayout] = useState(() => loadLayout(localStorage));
  const [session, setSession] = useState<SessionSnapshot>(IDLE_SNAPSHOT);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showComposerPlus, setShowComposerPlus] = useState(false);
  const composerPlusTriggerRef = useRef<HTMLButtonElement>(null);
  const composerPlusPanelRef = useRef<HTMLDivElement>(null);
  const { pos: composerPlusPos, style: composerPlusStyle } = useFloatingMenu({
    open: showComposerPlus,
    triggerRef: composerPlusTriggerRef,
    panelRef: composerPlusPanelRef,
    onClose: () => setShowComposerPlus(false),
    placement: "up",
    width: 320,
    estHeight: 280,
    gap: 8,
  });
  const [sessionDataMode, setSessionDataMode] = useState("independent");
  const [defaultOpenTarget, setDefaultOpenTarget] = useState("finder");
  const [showUserMenu, setShowUserMenu] = useState(false);
  /** Hash route: workbench | settings/:section */
  const [appView, setAppView] = useState<"workbench" | "settings">("workbench");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("general");

  useEffect(() => {
    if (!ctxMenu) return;
    // Ignore presses inside the menu (portal) so item clicks are not cancelled.
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".ctx-menu")) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    // Defer attach so the same click that opened the menu does not immediately close it.
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc, true);
    }, 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  useEffect(() => {
    if (!showSearch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSearch(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showSearch]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showDoctor, setShowDoctor] = useState(false);
  const [doctor, setDoctor] = useState<Record<string, unknown> | null>(null);
  const [perm, setPerm] = useState<PermissionPayload | null>(null);
  const [plan, setPlan] = useState<PlanState & { visible: boolean }>({
    title: "Plan ready for review",
    body: "",
    entries: [],
    waiting: true,
    // Only show when Agent sends a plan event (or user opens Plan mode later)
    visible: false,
  });
  const [locale, setLocale] = useState<Locale>("zh");
  const tr = useMemo(() => createT(locale), [locale]);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [effort, setEffort] = useState(DEFAULT_EFFORT);
  const [mode, setMode] = useState("agent");
  const [policy, setPolicy] = useState("ask");
  /** Files/folders attached for next send (@path to agent). */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Live drag-drop target for zone overlays (null = not dragging). */
  const [dragZone, setDragZone] = useState<"sidebar" | "main" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dragPathsRef = useRef<string[]>([]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [, setSetup] = useState({ cli: false, auth: false, project: false });
  const [localError, setLocalError] = useState<string | null>(null);
  /** Expand technical dump under the compact error banner. */
  const [errorDetailOpen, setErrorDetailOpen] = useState(false);
  const [pingMsg, setPingMsg] = useState<string | null>(null);
  const [cliInfo, setCliInfo] = useState<{
    found: boolean;
    path: string | null;
    version: string | null;
    source: string;
    cliAuthPresent: boolean;
  }>({ found: false, path: null, version: null, source: "", cliAuthPresent: false });
  const [manualCliPath, setManualCliPath] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [resizingAside, setResizingAside] = useState(false);
  const [account, setAccount] = useState<api.AccountStatus | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const platform = useMemo(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "mac" as const;
    if (ua.includes("win")) return "win" as const;
    return "other" as const;
  }, []);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.classList.remove("platform-mac", "platform-win");
    if (platform === "mac") document.documentElement.classList.add("platform-mac");
    if (platform === "win") document.documentElement.classList.add("platform-win");
  }, [platform]);

  const refreshLists = useCallback(async () => {
    if (!api.isTauri()) return;
    try {
      const [p, s, settings, cli] = await Promise.all([
        api.projectsList(),
        api.sessionsList(),
        api.settingsGet(),
        api.probeCli(),
      ]);
      setProjects(
        (p as Project[]).map((x) => ({
          ...x,
          pinned: !!(x as Project).pinned,
        })),
      );
      setSessions(
        (
          s as Array<SessionRow & { archived?: boolean }>
        ).map((x) => ({
          id: x.id,
          title: x.title,
          projectId: x.projectId,
          updatedAt: x.updatedAt,
          archived: !!x.archived,
        })),
      );
      if (!settings.onboardingDone && !settings.setupSkipped) {
        setShowOnboarding(true);
      }
      setLocale(resolveLocale(settings.locale));
      setPolicy(
        isValidPolicy(settings.permissionPolicy || "")
          ? settings.permissionPolicy
          : "ask",
      );
      setEffort(
        isValidEffort(settings.effort || "")
          ? (settings.effort as typeof effort)
          : DEFAULT_EFFORT,
      );
      setMode(settings.mode || "agent");
      if (settings.modelId && isValidModelId(settings.modelId)) {
        setModelId(settings.modelId);
      }
      setSessionDataMode(settings.sessionDataMode || "independent");
      setDefaultOpenTarget(
        (settings as { defaultOpenTarget?: string }).defaultOpenTarget ||
          "finder",
      );
      setManualCliPath(settings.manualCliPath || cli.path || "");
      setCliInfo({
        found: cli.found,
        path: cli.path,
        version: cli.version,
        source: cli.source || "",
        cliAuthPresent: !!cli.cliAuthPresent,
      });
      const masked = await api.secretsGetMasked();
      const authOk =
        !!cli.cliAuthPresent ||
        masked.hasOfficialKey ||
        masked.hasRelayKey;
      setSetup({
        cli: cli.found,
        auth: authOk,
        project: p.some((x) => (x as Project).trusted) || p.length > 0,
      });
      // Prefer first trusted project; keep selection if still present
      setActiveProject((prev) => {
        if (prev && (p as Project[]).some((x) => x.id === prev.id)) {
          return (p as Project[]).find((x) => x.id === prev.id) || prev;
        }
        return (
          (p as Project[]).find((x) => x.trusted) ||
          (p as Project[])[0] ||
          null
        );
      });
      setExpandedProjects((prev) => {
        const next = { ...prev };
        for (const proj of p as Project[]) {
          if (next[proj.id] === undefined) next[proj.id] = true;
        }
        return next;
      });
    } catch (e) {
      setLocalError(String(e));
    }
  }, []);

  // Bootstrap lists once
  useEffect(() => {
    void refreshLists();
  }, [refreshLists]);

  // Event listeners: StrictMode-safe (cleanup cancels pending + live unsubs)
  useEffect(() => {
    if (!api.isTauri()) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const track = async (p: Promise<() => void>) => {
      const un = await p;
      if (cancelled) {
        un();
      } else {
        cleanups.push(un);
      }
    };

    void (async () => {
      try {
        const snap = await api.sessionGetState();
        if (!cancelled) setSession(snap);

        await track(
          api.listen<SessionSnapshot>("session://state", (s) => {
            if (!cancelled) setSession(s);
          }),
        );
        await track(
          api.listen<StreamPayload>("session://stream", (chunk) => {
            if (cancelled) return;
            // Ignore empty terminal ticks that only flip done
            if (!chunk.text && !chunk.done) return;
            setMessages((prev) => applyStreamChunk(prev, chunk));
          }),
        );
        await track(
          api.listen<PermissionPayload>("session://permission", (p) => {
            if (!cancelled) setPerm(p);
          }),
        );
        await track(
          api.listen<{ entries: unknown[] }>("session://plan", (p) => {
            if (cancelled) return;
            setPlan({
              title: "Plan ready for review",
              body: "Agent plan",
              entries: p.entries || [],
              waiting: false,
              visible: true,
            });
          }),
        );
        await track(
          api.listen<{ sessionId?: string; title?: string }>(
            "session://title",
            (p) => {
              if (cancelled || !p.sessionId || !p.title) return;
              setSessions((list) =>
                list.map((s) =>
                  s.id === p.sessionId ? { ...s, title: p.title! } : s,
                ),
              );
              setSession((prev) =>
                prev.sessionId === p.sessionId
                  ? { ...prev, title: p.title! }
                  : prev,
              );
            },
          ),
        );
      } catch (e) {
        if (!cancelled) setLocalError(String(e));
      }
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((u) => u());
    };
  }, []);

  const toggleThemeBtn = () => {
    setTheme((t) => {
      const n = toggleTheme(t);
      saveTheme(localStorage, n);
      applyThemeToDocument(n);
      return n;
    });
  };

  const applyThemeChoice = (next: Theme) => {
    saveTheme(localStorage, next);
    applyThemeToDocument(next);
    setTheme(next);
  };

  const navigateWorkbench = useCallback(() => {
    setAppView("workbench");
    if (typeof window !== "undefined" && window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  const navigateSettings = useCallback((section: SettingsSectionId = "general") => {
    setSettingsSection(section);
    setAppView("settings");
    setShowUserMenu(false);
    if (typeof window !== "undefined") {
      window.location.hash = `#/settings/${section}`;
    }
  }, []);

  // Hash route: #/settings[/section]
  useEffect(() => {
    const syncFromHash = () => {
      const raw = (window.location.hash || "").replace(/^#\/?/, "");
      if (raw.startsWith("settings")) {
        const part = raw.split("/")[1] as SettingsSectionId | undefined;
        const allowed: SettingsSectionId[] = [
          "general",
          "appearance",
          "account",
          "runtime",
          "about",
        ];
        setSettingsSection(
          part && allowed.includes(part) ? part : "general",
        );
        setAppView("settings");
      } else if (raw === "" || raw === "workbench" || raw === "home") {
        setAppView("workbench");
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  /** Open local session placeholder — CLI connects on first send. */
  const openSession = async (s: SessionRow, project?: Project | null) => {
    const proj =
      project ||
      projects.find((p) => p.id === s.projectId) ||
      activeProject;
    try {
      const stored = await api.sessionMessages(s.id);
      const mapped = stored.map((m) => {
        const parsed = parseAttachmentsFromContent(m.content);
        return {
          id: m.id,
          role: m.role as "user" | "assistant" | "tool",
          content: parsed.text || (parsed.attachments.length ? "" : m.content),
          thought: m.thought ?? undefined,
          attachments: parsed.attachments.length
            ? parsed.attachments
            : undefined,
        };
      });
      setMessages(mapped);
      // Refine isDir via classify when possible
      const allPaths = mapped.flatMap((m) => m.attachments?.map((a) => a.path) ?? []);
      if (allPaths.length && api.isTauri()) {
        void api.pathsClassify(allPaths).then((list) => {
          const byPath = new Map(list.map((c) => [c.path, c]));
          setMessages((prev) =>
            prev.map((msg) => {
              if (!msg.attachments?.length) return msg;
              return {
                ...msg,
                attachments: msg.attachments.map((a) => {
                  const c = byPath.get(a.path);
                  return c
                    ? { path: c.path, name: c.name, isDir: c.isDir }
                    : a;
                }),
              };
            }),
          );
        });
      }
    } catch {
      setMessages([]);
    }
    if (proj) setActiveProject(proj);
    setAttachments([]);
    setSession({
      ...IDLE_SNAPSHOT,
      sessionId: s.id,
      title: s.title || "Untitled",
      state: "idle",
      backend: "grok_agent_stdio",
    });
    setLocalError(null);
  };

  /**
   * Draft new chat (Codex-style): clear UI only.
   * No store row / CLI until first successful send via ensureConnected.
   */
  const newChat = async (project?: Project | null) => {
    const proj = project || activeProject;
    if (!proj) {
      setLocalError(tr("project.addSelectFirst"));
      return;
    }
    if (!proj.trusted) {
      setLocalError(tr("project.trustFirst", { name: proj.name }));
      return;
    }
    setActiveProject(proj);
    setExpandedProjects((e) => ({ ...e, [proj.id]: true }));
    setMessages([]);
    setDraft("");
    setAttachments([]);
    setPlan({
      title: "Plan ready for review",
      body: "",
      entries: [],
      waiting: true,
      visible: false,
    });
    setPerm(null);
    setSession({
      ...IDLE_SNAPSHOT,
      sessionId: null,
      title: tr("session.new"),
      state: "idle",
      backend: "grok_agent_stdio",
    });
    setLocalError(null);
    // Disconnect any live agent for previous session (best-effort).
    if (api.isTauri()) {
      try {
        await api.sessionDisconnect();
      } catch {
        /* ignore */
      }
    }
  };

  const selectProject = async (proj: Project) => {
    setActiveProject(proj);
    setExpandedProjects((e) => ({ ...e, [proj.id]: true }));
    setLocalError(null);
    // No eager CLI connect — wait until first send (silent).
  };

  const sessionsForProject = (projectId: string) =>
    sessions.filter((s) => s.projectId === projectId && !s.archived);

  const orphanSessions = sessions.filter(
    (s) =>
      (!s.projectId || !projects.some((p) => p.id === s.projectId)) &&
      !s.archived,
  );

  const refreshSessions = async () => {
    try {
      const list = await api.sessionsList();
      setSessions(
        list.map((s) => ({
          id: s.id,
          title: s.title,
          projectId: s.projectId,
          updatedAt: s.updatedAt,
          archived: !!s.archived,
        })),
      );
    } catch {
      /* ignore */
    }
  };

  const refreshProjects = async () => {
    try {
      const list = await api.projectsList();
      setProjects(
        list.map((p) => ({
          ...p,
          pinned: !!p.pinned,
        })),
      );
    } catch {
      /* ignore */
    }
  };

  const renameProject = async (proj: Project) => {
    setCtxMenu(null);
    const name = window.prompt(
      tr("project.rename"),
      proj.name,
    );
    if (!name?.trim()) return;
    try {
      await api.projectRename(proj.id, name.trim());
      await refreshProjects();
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const removeProjectFromApp = async (proj: Project) => {
    // Confirm before closing menu so Tauri focus / portal unmount does not swallow the click.
    const ok = window.confirm(
      tr("project.removeConfirm", { name: proj.name }),
    );
    setCtxMenu(null);
    if (!ok) return;
    try {
      if (!api.isTauri()) {
        setLocalError(tr("error.needTauri"));
        return;
      }
      await api.projectRemove(proj.id);
      if (activeProject?.id === proj.id) {
        setActiveProject(null);
        setSession(IDLE_SNAPSHOT);
        setMessages([]);
      }
      await refreshProjects();
      await refreshSessions();
      setLocalError(null);
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const renameSession = async (s: SessionRow) => {
    setCtxMenu(null);
    const title = window.prompt(
      tr("session.renamePrompt"),
      s.title || "Untitled",
    );
    if (!title?.trim()) return;
    try {
      await api.sessionRename(s.id, title.trim());
      await refreshSessions();
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const archiveSession = async (s: SessionRow, archived = true) => {
    setCtxMenu(null);
    try {
      await api.sessionSetArchived(s.id, archived);
      await refreshSessions();
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const copySessionId = async (s: SessionRow) => {
    setCtxMenu(null);
    try {
      await navigator.clipboard.writeText(s.id);
    } catch {
      setLocalError(s.id);
    }
  };

  const openSessionMenu = (e: ReactMouseEvent, s: SessionRow) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: "session", id: s.id, x: e.clientX, y: e.clientY });
  };

  const openProjectMenu = (e: ReactMouseEvent, proj: Project) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: "project", id: proj.id, x: e.clientX, y: e.clientY });
  };

  const searchHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const sess = sessions.filter((s) => !s.archived);
    const matchedSessions = !q
      ? sess.slice(0, 12)
      : sess
          .filter(
            (s) =>
              s.title.toLowerCase().includes(q) ||
              s.id.toLowerCase().includes(q),
          )
          .slice(0, 20);
    const matchedProjects = !q
      ? projects.slice(0, 6)
      : projects
          .filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.path.toLowerCase().includes(q),
          )
          .slice(0, 10);
    return { matchedSessions, matchedProjects };
  }, [searchQuery, sessions, projects]);

  const isPlaceholderTitle = useCallback(
    (title: string | undefined | null) => {
      const t = (title || "").trim();
      if (!t) return true;
      const placeholders = [
        tr("session.new"),
        tr("session.placeholderTitle"),
        tr("session.untitled"),
        "New chat",
        "新会话",
        "Untitled",
        "未命名",
      ];
      return placeholders.some((p) => p.toLowerCase() === t.toLowerCase());
    },
    [tr],
  );

  /**
   * Ensure app session row + silent CLI connect.
   * Creates store session only on first send (draft → real).
   * Reconnects when disconnected / crashed. Pass force to tear down a "ready"
   * session that may be wedged (e.g. after a timeout).
   * Returns the live session id when ready, else null.
   */
  const ensureConnected = async (force = false): Promise<string | null> => {
    if (!activeProject) {
      setLocalError(tr("project.selectFirst"));
      return null;
    }
    if (!activeProject.trusted) {
      setLocalError(tr("project.trustFirst", { name: activeProject.name }));
      return null;
    }
    if (!force && session.state === "ready" && !session.lastError && session.sessionId) {
      return session.sessionId;
    }
    if (connecting) return null;
    setConnecting(true);
    try {
      let sessionId = session.sessionId;
      // First send: materialize draft into a real session under the project.
      if (!sessionId && api.isTauri()) {
        const meta = (await api.sessionCreate(
          activeProject.id,
          tr("session.new"),
        )) as { id: string; title?: string };
        sessionId = meta.id;
        setSession((prev) => ({
          ...prev,
          sessionId: meta.id,
          title: meta.title || tr("session.new"),
        }));
        setExpandedProjects((e) => ({ ...e, [activeProject.id]: true }));
        await refreshSessions();
      }
      const snap = await api.sessionConnect({
        projectPath: activeProject.path,
        sessionId: sessionId ?? undefined,
        mode,
      });
      setSession(snap);
      if (snap.lastError || snap.state !== "ready") {
        const code = snap.lastError?.code ?? "AGENT_CRASHED";
        const msg = snap.lastError?.message ?? "connect failed";
        setLocalError(`${code}: ${msg}`);
        return null;
      }
      setLocalError(null);
      return snap.sessionId || sessionId || null;
    } catch (e) {
      setLocalError(String(e));
      return null;
    } finally {
      setConnecting(false);
    }
  };

  const applySessionTitle = useCallback(
    (sessionId: string, title: string) => {
      setSessions((list) =>
        list.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
      setSession((prev) =>
        prev.sessionId === sessionId ? { ...prev, title } : prev,
      );
    },
    [],
  );

  const attachLabels = useMemo(
    () => ({
      open: tr("attach.open"),
      reveal: tr("attach.reveal"),
      copyPath: tr("attach.copyPath"),
      copyImage: tr("attach.copyImage"),
      addToComposer: tr("attach.addToComposer"),
      remove: tr("composer.attachRemove"),
      viewImage: tr("image.view"),
    }),
    [tr],
  );

  const send = async () => {
    const text = draft.trim();
    const att = attachments;
    if ((!text && !att.length) || !canSend(session.state) || connecting) return;
    const agentText = buildAgentPrompt(text, att);
    const shouldAutoTitle = isPlaceholderTitle(session.title) || !session.sessionId;
    setDraft("");
    setAttachments([]);
    // Reset textarea height after clear
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(".composer__input");
      if (el) {
        el.style.height = "auto";
      }
    });
    setMessages((m) => [
      ...m,
      {
        id: `u-${Date.now()}`,
        role: "user",
        content: text,
        attachments: att.length ? att : undefined,
      },
    ]);
    try {
      const sessionId = await ensureConnected();
      if (!sessionId) return;
      await api.sessionSend(agentText);
      if (shouldAutoTitle && api.isTauri()) {
        void api
          .sessionAutoTitle(sessionId, text || att.map((a) => a.name).join(", "))
          .then((meta) => {
            if (meta?.title) applySessionTitle(sessionId, meta.title);
          })
          .catch(() => {
            /* heuristic may still land; ignore refine errors */
          });
      }
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const addAttachmentsFromPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) {
        setLocalError(tr("attach.droppedNone"));
        return;
      }
      try {
        if (!api.isTauri()) {
          setAttachments((prev) =>
            mergeAttachments(
              prev,
              paths.map((p) => ({
                path: p,
                name: p.split(/[/\\]/).pop() || p,
                isDir: false,
              })),
            ),
          );
          return;
        }
        const classified = await api.pathsClassify(paths);
        // Accept all formats (images, docs, …). Keep entries even if exists is false
        // so transient sandbox / iCloud paths still show; open may fail later.
        const next = classified.map((c) => ({
          path: c.path,
          name: c.name,
          isDir: c.isDir,
        }));
        if (!next.length) {
          setLocalError(tr("attach.droppedNone"));
          return;
        }
        setAttachments((prev) => mergeAttachments(prev, next));
        setLocalError(null);
      } catch (e) {
        setLocalError(String(e));
      }
    },
    [tr],
  );

  const addProjectsFromPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length || !api.isTauri()) return;
      try {
        const classified = await api.pathsClassify(paths);
        const dirs = classified.filter((c) => c.exists && c.isDir);
        if (!dirs.length) {
          setLocalError(tr("composer.dropProjectFilesOnly"));
          return;
        }
        let last: Project | null = null;
        for (const d of dirs) {
          last = (await api.projectAdd(d.path, false)) as Project;
        }
        const list = (await api.projectsList()) as Project[];
        setProjects(list);
        if (last) {
          setActiveProject(list.find((p) => p.id === last!.id) ?? last);
          setExpandedProjects((e) => ({ ...e, [last!.id]: true }));
          setLocalError(null);
          setToast(tr("composer.projectAdded", { name: last.name }));
          window.setTimeout(() => setToast(null), 2500);
        }
      } catch (e) {
        setLocalError(String(e));
      }
    },
    [tr],
  );

  /** Hit-test drag position → sidebar (project) vs main content (attach). */
  const hitDragZone = useCallback(
    (clientX: number, clientY: number): "sidebar" | "main" | null => {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return null;
      if (
        !layoutRef.current.sidebarCollapsed &&
        el.closest(".sidebar")
      ) {
        return "sidebar";
      }
      if (el.closest(".main") || el.closest(".aside") || el.closest(".shell")) {
        // Prefer main/aside; shell fallback still treats as attach (not project)
        if (el.closest(".sidebar")) return "sidebar";
        return "main";
      }
      return "main";
    },
    [],
  );

  // Tauri OS file drag-drop (full absolute paths)
  useEffect(() => {
    if (!api.isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const webview = getCurrentWebview();
        const win = getCurrentWindow();
        const factor = await win.scaleFactor();

        unlisten = await webview.onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "drop") {
            if ("paths" in payload && payload.paths?.length) {
              dragPathsRef.current = payload.paths;
            }
          }
          if (payload.type === "leave") {
            setDragZone(null);
            dragPathsRef.current = [];
            return;
          }
          if (payload.type === "enter" || payload.type === "over") {
            const x = payload.position.x / factor;
            const y = payload.position.y / factor;
            setDragZone(hitDragZone(x, y));
            return;
          }
          if (payload.type === "drop") {
            const x = payload.position.x / factor;
            const y = payload.position.y / factor;
            const zone = hitDragZone(x, y);
            const paths = payload.paths?.length
              ? payload.paths
              : dragPathsRef.current;
            setDragZone(null);
            dragPathsRef.current = [];
            if (!paths.length) {
              setLocalError(tr("attach.droppedNone"));
              return;
            }
            if (zone === "sidebar") {
              void addProjectsFromPaths(paths);
            } else {
              // All file types (images, pdf, …) attach in main zone
              void addAttachmentsFromPaths(paths);
            }
          }
        });
      } catch {
        /* webview API unavailable */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addAttachmentsFromPaths, addProjectsFromPaths, hitDragZone, tr]);

  // HTML5 fallback: some image drags only expose File list in the webview.
  // Prefer Tauri paths; use File.path when present (Tauri webview).
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      // If Tauri already handled this OS drop, paths may be empty here.
      const files = Array.from(e.dataTransfer.files);
      const paths = files
        .map((f) => {
          const anyF = f as File & { path?: string };
          return anyF.path || "";
        })
        .filter(Boolean);
      if (!paths.length) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = hitDragZone(e.clientX, e.clientY);
      if (zone === "sidebar") void addProjectsFromPaths(paths);
      else void addAttachmentsFromPaths(paths);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [addAttachmentsFromPaths, addProjectsFromPaths, hitDragZone]);

  // Drag-resize right resource pane
  useEffect(() => {
    if (!resizingAside) return;
    const onMove = (e: PointerEvent) => {
      const next = clampAsideWidth(window.innerWidth - e.clientX);
      setLayout((l) => {
        const n = { ...l, asideWidth: next, asideCollapsed: false };
        return n;
      });
    };
    const onUp = () => {
      setResizingAside(false);
      setLayout((l) => {
        saveLayout(localStorage, l);
        return l;
      });
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizingAside]);

  const resizeComposer = (el: HTMLTextAreaElement) => {
    const line = 22; // ~line-height
    const min = line * 1;
    const max = line * 10;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
  };

  const stop = async () => {
    try {
      await api.sessionStop();
      setMessages((m) => m.map((x) => ({ ...x, streaming: false })));
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const addProject = async (autoTrust = false) => {
    setLocalError(null);
    try {
      if (!api.isTauri()) {
        setLocalError(tr("error.needTauri"));
        return;
      }
      // Prefer one-shot dialog that adds + optional trust
      const p = (await api.projectAddDialog(autoTrust)) as Project | null;
      if (!p) return; // cancelled
      const list = (await api.projectsList()) as Project[];
      setProjects(list);
      let current = p;
      if (!p.trusted) {
        const ok = window.confirm(
          tr("project.trustConfirm", { name: p.name, path: p.path }),
        );
        if (ok) {
          current = (await api.projectTrust(p.id)) as Project;
        }
      }
      setActiveProject(current);
      setSetup((s) => ({ ...s, project: true }));
      setProjects((await api.projectsList()) as Project[]);
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const trustProject = async (proj?: Project | null) => {
    const target = proj || activeProject;
    if (!target) return;
    try {
      const p = (await api.projectTrust(target.id)) as Project;
      setActiveProject(p);
      setProjects((await api.projectsList()) as Project[]);
      setLocalError(null);
      // CLI connects on first send only.
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const winChrome = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      if (action === "minimize") await w.minimize();
      if (action === "toggleMaximize") await w.toggleMaximize();
      if (action === "close") await w.close();
    } catch {
      /* ignore */
    }
  };

  const openDoctor = async () => {
    setShowDoctor(true);
    try {
      setDoctor(await api.doctorReport());
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const error = session.lastError;
  const errorBanner = useMemo(
    () => presentErrorBanner(error, localError, locale),
    [error, localError, locale],
  );
  // Collapse technical dump whenever the visible error changes.
  useEffect(() => {
    setErrorDetailOpen(false);
  }, [errorBanner?.code, errorBanner?.summary, errorBanner?.detail]);

  const refreshAccount = useCallback(
    async (opts?: { refreshBilling?: boolean }) => {
      if (!api.isTauri()) return;
      setAccountLoading(true);
      try {
        const st = await api.accountStatus({
          refreshBilling: opts?.refreshBilling ?? true,
          manualCliPath: manualCliPath || null,
        });
        setAccount(st);
        setSetup((s) => ({
          ...s,
          auth: isAccountConnected(st),
          cli: st.cliFound || s.cli,
        }));
      } catch (e) {
        console.warn("account status failed", e);
      } finally {
        setAccountLoading(false);
      }
    },
    [manualCliPath],
  );

  const runAccountLogin = useCallback(
    async (method: "oauth" | "device" = "oauth") => {
      if (!api.isTauri()) {
        setToast(tr("error.needTauri"));
        return;
      }
      setAccountBusy(true);
      try {
        const res = await api.accountLogin(method);
        setToast(res.ok ? tr("account.loginOk") : res.message || tr("account.loginFailed"));
        if (res.deviceUrl) {
          setPingMsg(
            [res.deviceUrl, res.deviceCode ? `code: ${res.deviceCode}` : ""]
              .filter(Boolean)
              .join("\n"),
          );
        }
        await refreshAccount({ refreshBilling: true });
      } catch (e) {
        setToast(String(e));
      } finally {
        setAccountBusy(false);
      }
    },
    [refreshAccount, tr],
  );

  const runAccountLogout = useCallback(async () => {
    if (!api.isTauri()) return;
    setAccountBusy(true);
    try {
      await api.accountLogout();
      await refreshAccount({ refreshBilling: false });
    } catch (e) {
      setToast(String(e));
    } finally {
      setAccountBusy(false);
    }
  }, [refreshAccount]);

  useEffect(() => {
    if (!api.isTauri()) return;
    void refreshAccount({ refreshBilling: true });
  }, [refreshAccount]);

  useEffect(() => {
    if (appView === "settings" && settingsSection === "account") {
      void refreshAccount({ refreshBilling: true });
    }
  }, [appView, settingsSection, refreshAccount]);

  const settingsLabels = useMemo(() => {
    const keys = [
      "settings.backToApp",
      "settings.searchPlaceholder",
      "settings.group.personal",
      "settings.group.system",
      "settings.nav.general",
      "settings.nav.appearance",
      "settings.nav.account",
      "settings.nav.runtime",
      "settings.nav.about",
      "settings.section.permissions",
      "settings.section.general",
      "settings.language",
      "settings.languageDesc",
      "settings.sessionDataMode",
      "settings.sessionDataModeDesc",
      "settings.cliPath",
      "settings.cliPathDesc",
      "settings.cliNotFound",
      "settings.permissionDeep",
      "settings.theme",
      "settings.themeDesc",
      "settings.themeLight",
      "settings.themeDark",
      "settings.doctorDesc",
      "settings.runDoctor",
      "settings.aboutApp",
      "composer.permissionTitle",
      "policy.ask",
      "policy.accept_edits",
      "policy.allow_for_session",
      "policy.dont_ask",
      "policy.always_approve",
      "settings.modeIndependent",
      "settings.modeShared",
      "settings.tabOfficial",
      "settings.tabProviders",
      "settings.tabOfficialHint",
      "settings.tabProvidersHint",
      "settings.openTarget",
      "settings.openTargetDesc",
      "settings.openFinder",
      "settings.sharedConfirm",
      "doctor.title",
      "common.local",
      "common.close",
      "common.cancel",
      "account.section.profile",
      "account.section.runtime",
      "account.signedIn",
      "account.signedOut",
      "account.loginOauth",
      "account.loginDevice",
      "account.loginBusy",
      "account.logout",
      "account.refresh",
      "account.refreshing",
      "account.manageUsage",
      "account.subscribe",
      "account.channel",
      "account.channel.oauth",
      "account.channel.key",
      "account.channel.relay",
      "account.channel.none",
      "account.subscription",
      "account.weeklyTitle",
      "account.quota",
      "account.quotaRemaining",
      "account.quotaUsed",
      "account.quotaUnknown",
      "account.period",
      "account.prepaid",
      "account.onDemand",
      "account.resetsAt",
      "account.fetchedAt",
      "account.products",
      "account.heatmap",
      "account.heatmapHint",
      "account.heatmap.less",
      "account.heatmap.more",
      "account.heatmap.noData",
      "account.heatmap.aria",
      "account.heatmap.requests",
      "account.heatmap.tokens",
      "account.callLogs",
      "account.callLogsEmpty",
      "account.col.session",
      "account.col.model",
      "account.col.turns",
      "account.col.tokens",
      "account.col.duration",
      "account.col.when",
      "account.expired",
      "account.team",
      "account.billingUnavailable",
      "account.cliAuthOk",
      "account.cliAuthMissing",
    ] as const;
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = tr(k);
    return out;
  }, [tr]);

  return (
    <ImageViewerProvider locale={locale}>
    <div className={`app-shell platform-${platform}`} data-testid="app-shell">
      {appView === "settings" ? (
        <SettingsPage
          section={settingsSection}
          onSection={(id) => {
            setSettingsSection(id);
            window.location.hash = `#/settings/${id}`;
          }}
          onBack={navigateWorkbench}
          labels={settingsLabels}
          locale={locale}
          onLocale={(v) => {
            const next = resolveLocale(v);
            setLocale(next);
            void api.settingsGet().then((s) =>
              api.settingsSet({ ...s, locale: next }),
            );
          }}
          theme={theme}
          onTheme={applyThemeChoice}
          sessionDataMode={sessionDataMode}
          onSessionDataMode={(v) => {
            if (v === "shared") {
              const ok = window.confirm(tr("settings.sharedConfirm"));
              if (!ok) return;
            }
            setSessionDataMode(v);
            void api.settingsGet().then((s) =>
              api.settingsSet({ ...s, sessionDataMode: v }),
            );
          }}
          policy={policy}
          onPolicy={(v) => {
            if (!isValidPolicy(v)) return;
            if (v === "always_approve") {
              const ok1 = window.confirm(tr("policy.yoloConfirm"));
              if (!ok1) return;
              const ok2 = window.confirm(tr("policy.yoloConfirm2"));
              if (!ok2) return;
            }
            setPolicy(v);
            void api.sessionSetPolicy(v);
            void api.settingsGet().then((s) =>
              api.settingsSet({ ...s, permissionPolicy: v }),
            );
          }}
          manualCliPath={manualCliPath}
          onManualCliPath={setManualCliPath}
          onCliBlur={(v) => {
            void api.settingsGet().then((s) =>
              api.settingsSet({ ...s, manualCliPath: v || null }),
            );
            void api.probeCli(v || undefined).then((cli) => {
              setCliInfo({
                found: cli.found,
                path: cli.path,
                version: cli.version,
                source: cli.source || "",
                cliAuthPresent: !!cli.cliAuthPresent,
              });
              setSetup((prev) => ({
                ...prev,
                cli: cli.found,
                auth: prev.auth || !!cli.cliAuthPresent,
              }));
            });
          }}
          cliInfo={cliInfo}
          onDoctor={() => void openDoctor()}
          versionFooter={tr("app.versionFooter")}
          account={account}
          accountLoading={accountLoading}
          accountBusy={accountBusy}
          onAccountLoginOauth={() => void runAccountLogin("oauth")}
          onAccountLoginDevice={() => void runAccountLogin("device")}
          onAccountLogout={() => void runAccountLogout()}
          onAccountRefresh={() => void refreshAccount({ refreshBilling: true })}
          onAccountManageUsage={() => void api.accountOpenUsage()}
          onAccountSubscribe={() => void api.accountOpenSubscribe()}
          defaultOpenTarget={defaultOpenTarget}
          onDefaultOpenTarget={(v) => {
            setDefaultOpenTarget(v);
            void api.settingsGet().then((s) =>
              api.settingsSet({ ...s, defaultOpenTarget: v }),
            );
          }}
          onProviderActivated={() => {
            // Hot-reload Grok Build: drop live ACP so next send re-spawns with new GROK_HOME config.
            void (async () => {
              try {
                if (api.isTauri()) {
                  await api.sessionDisconnect();
                  setSession({ ...IDLE_SNAPSHOT });
                }
                setToast(tr("prov.switchedHotReload"));
                window.setTimeout(() => setToast(null), 3200);
              } catch (e) {
                setToast(String(e));
              }
            })();
          }}
        />
      ) : (
      <div className="workbench">
        {platform === "win" && (
          <div className="window-controls">
            <button
              type="button"
              className="window-controls__btn"
              title="Minimize"
              aria-label="Minimize"
              onClick={() => void winChrome("minimize")}
            >
              <IconMinimize size={14} />
            </button>
            <button
              type="button"
              className="window-controls__btn"
              title="Maximize"
              aria-label="Maximize"
              onClick={() => void winChrome("toggleMaximize")}
            >
              <IconMaximize size={14} />
            </button>
            <button
              type="button"
              className="window-controls__btn window-controls__btn--close"
              title="Close"
              aria-label="Close"
              onClick={() => void winChrome("close")}
            >
              <IconClose size={14} />
            </button>
          </div>
        )}
        {/* LEFT — fully hideable (not icon-rail); open via top-bar icon when closed */}
        <aside
          className={
            "sidebar" +
            (layout.sidebarCollapsed ? " sidebar--hidden" : "") +
            (dragZone === "sidebar" ? " is-drop-target" : "") +
            (dragZone === "main" ? " is-drop-idle" : "")
          }
          aria-hidden={layout.sidebarCollapsed}
        >
          {dragZone === "sidebar" && (
            <div className="drop-overlay drop-overlay--project" aria-hidden>
              <div className="drop-overlay__card">
                <span className="drop-overlay__icon">
                  <IconFolderPlus size={22} />
                </span>
                <strong>{tr("composer.dropProjectTitle")}</strong>
                <span>{tr("composer.dropProjectHint")}</span>
              </div>
            </div>
          )}
          {/* Row 1: traffic-light height — only collapse, vertically aligned */}
          <div className="sidebar-chrome" data-tauri-drag-region>
            <button
              type="button"
              className="chrome-btn chrome-btn--traffic"
              title={tr("main.leftPaneHide")}
              onClick={() =>
                setLayout((l) => {
                  const n = { ...l, sidebarCollapsed: true };
                  saveLayout(localStorage, n);
                  return n;
                })
              }
            >
              <IconCollapse size={16} />
            </button>
            <div className="sidebar-chrome__drag" data-tauri-drag-region />
          </div>

          {/* Row 2: brand + search (Codex: title left, search right) */}
          <div className="sidebar-brand-row">
            <div className="sidebar-brand-row__left">
              <GrokLogo size={20} />
              <span>Grok</span>
            </div>
            <button
              type="button"
              className="chrome-btn"
              title={tr("sidebar.search")}
              onClick={() => {
                setShowSearch(true);
                setSearchQuery("");
              }}
            >
              <IconSearch size={16} />
            </button>
          </div>

          <OverlayScroll className="sidebar__scroll" viewportClassName="sidebar__scroll-inner">
            {/* L1 — Projects section */}
            <div className="tree-l1">
              <button
                type="button"
                className="tree-l1__head"
                onClick={() => setProjectsOpen((v) => !v)}
              >
                {projectsOpen ? (
                  <IconChevronDown size={14} />
                ) : (
                  <IconChevronRight size={14} />
                )}
                <span className="tree-l1__label">
                  {tr("sidebar.projects")}
                </span>
              </button>
              <button
                type="button"
                className="tree-l1__action"
                title={tr("sidebar.addProject")}
                onClick={() => void addProject(false)}
              >
                <IconPlus size={15} />
              </button>
            </div>

            {projectsOpen && projects.length === 0 && (
              <div className="sidebar-empty">
                {tr("sidebar.noProjects")}
              </div>
            )}

            {projectsOpen &&
              projects.map((proj) => {
                const open = expandedProjects[proj.id] !== false;
                const projSessions = sessionsForProject(proj.id);
                const isActive = activeProject?.id === proj.id;
                return (
                  <div key={proj.id} className="tree-project">
                    {/* L2 — project folder */}
                    <div
                      className={
                        "tree-l2" + (isActive ? " tree-l2--active" : "")
                      }
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setExpandedProjects((e) => ({
                          ...e,
                          [proj.id]: !open,
                        }));
                        void selectProject(proj);
                      }}
                      onContextMenu={(e) => openProjectMenu(e, proj)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpandedProjects((ex) => ({
                            ...ex,
                            [proj.id]: !open,
                          }));
                          void selectProject(proj);
                        }
                      }}
                    >
                      <span className="tree-l2__icon">
                        <IconFolder size={15} />
                      </span>
                      <span className="tree-l2__name" title={proj.path}>
                        {proj.pinned ? (
                          <IconPin size={12} className="tree-l2__pin" />
                        ) : null}
                        {proj.name}
                      </span>
                      {!proj.trusted && (
                        <span className="project-row__badge">
                          {tr("sidebar.untrusted")}
                        </span>
                      )}
                      <span className="tree-l2__actions">
                        <button
                          type="button"
                          className="tree-icon-btn"
                          title={
                            tr("sidebar.newConversation")
                          }
                          disabled={!proj.trusted}
                          onClick={(e) => {
                            e.stopPropagation();
                            void newChat(proj);
                          }}
                        >
                          <IconSquarePen size={14} />
                        </button>
                        <button
                          type="button"
                          className="tree-icon-btn"
                          title={tr("sidebar.menu")}
                          onClick={(e) => openProjectMenu(e, proj)}
                        >
                          <IconMore size={14} />
                        </button>
                      </span>
                    </div>

                    {open && (
                      <div className="tree-l3-list">
                        {!proj.trusted && (
                          <button
                            type="button"
                            className="tree-l3 tree-l3--hint"
                            onClick={(e) => {
                              e.stopPropagation();
                              void trustProject(proj);
                            }}
                          >
                            {tr("sidebar.trustProject")}
                          </button>
                        )}
                        {projSessions.map((s) => (
                          <div
                            key={s.id}
                            className={
                              "tree-l3" +
                              (session.sessionId === s.id
                                ? " tree-l3--active"
                                : "") +
                              (s.archived ? " tree-l3--archived" : "")
                            }
                            role="button"
                            tabIndex={0}
                            onClick={() => void openSession(s, proj)}
                            onContextMenu={(e) => openSessionMenu(e, s)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void openSession(s, proj);
                            }}
                          >
                            <span className="tree-l3__title">
                              {s.title || "Untitled"}
                            </span>
                            <span className="tree-l3__actions">
                              <button
                                type="button"
                                className="tree-icon-btn"
                                title={
                                  s.archived
                                    ? tr("sidebar.unarchive")
                                    : tr("sidebar.archive")
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void archiveSession(s, !s.archived);
                                }}
                              >
                                <IconArchive size={13} />
                              </button>
                              <button
                                type="button"
                                className="tree-icon-btn"
                                title={tr("sidebar.menu")}
                                onClick={(e) => openSessionMenu(e, s)}
                              >
                                <IconMore size={13} />
                              </button>
                            </span>
                          </div>
                        ))}
                        {projSessions.length === 0 && proj.trusted && (
                          <div className="sidebar-empty" style={{ padding: "4px 10px" }}>
                            {tr("sidebar.noChats")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

            {/* Orphans / history */}
            <div className="tree-l1" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="tree-l1__head"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                {historyOpen ? (
                  <IconChevronDown size={14} />
                ) : (
                  <IconChevronRight size={14} />
                )}
                <span className="tree-l1__label">
                  {tr("sidebar.otherSessions")}
                </span>
              </button>
            </div>
            {historyOpen &&
              orphanSessions.map((s) => (
                <div
                  key={s.id}
                  className={
                    "tree-l3 tree-l3--orphan" +
                    (session.sessionId === s.id ? " tree-l3--active" : "")
                  }
                  role="button"
                  tabIndex={0}
                  onClick={() => void openSession(s)}
                  onContextMenu={(e) => openSessionMenu(e, s)}
                >
                  <span className="tree-l3__title">{s.title || "Untitled"}</span>
                  <span className="tree-l3__actions">
                    <button
                      type="button"
                      className="tree-icon-btn"
                      title={tr("sidebar.archive")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void archiveSession(s, !s.archived);
                      }}
                    >
                      <IconArchive size={13} />
                    </button>
                    <button
                      type="button"
                      className="tree-icon-btn"
                      onClick={(e) => openSessionMenu(e, s)}
                    >
                      <IconMore size={13} />
                    </button>
                  </span>
                </div>
              ))}
          </OverlayScroll>

          <UserMenu
            open={showUserMenu}
            onClose={() => setShowUserMenu(false)}
            theme={theme}
            t={(k) => tr(k as Parameters<typeof tr>[0])}
            account={account}
            accountBusy={accountBusy}
            labels={{
              settings: tr("sidebar.settings"),
              theme: tr("user.theme"),
              themeLight: tr("user.themeLight"),
              themeDark: tr("user.themeDark"),
              local: tr("common.local"),
              signedIn: tr("account.signedIn"),
              signedOut: tr("account.signedOut"),
              login: tr("account.login"),
              logout: tr("account.logout"),
              remaining: tr("account.quotaRemaining"),
            }}
            onSettings={() => navigateSettings("general")}
            onAccountSettings={() => navigateSettings("account")}
            onToggleTheme={toggleThemeBtn}
            onLogin={() => void runAccountLogin("oauth")}
            onLogout={() => void runAccountLogout()}
          >
            <button
              type="button"
              className={
                "sidebar__footer" + (showUserMenu ? " is-open" : "")
              }
              aria-haspopup="menu"
              aria-expanded={showUserMenu}
              title={tr("user.menu")}
              onClick={() => {
                setShowUserMenu((v) => !v);
                if (!showUserMenu) void refreshAccount({ refreshBilling: true });
              }}
            >
              <div className="user-avatar" aria-hidden>
                {account?.profile
                  ? accountInitials(account.profile)
                  : "G"}
              </div>
              <div className="user-meta">
                <span className="user-meta__name">
                  {account?.profile
                    ? accountDisplayName(account.profile, tr("common.local"))
                    : tr("common.local")}
                </span>
                {(() => {
                  const rem = remainingPercent(account);
                  return rem != null ? (
                    <span className="user-meta__quota">{rem.toFixed(0)}%</span>
                  ) : null;
                })()}
              </div>
            </button>
          </UserMenu>
        </aside>

        {/* CENTER — solid pane; top icons fully toggle L/R columns */}
        <main
          className={
            "main" +
            (layout.sidebarCollapsed ? " main--sidebar-hidden" : "") +
            (dragZone === "main" ? " is-drop-target" : "") +
            (dragZone === "sidebar" ? " is-drop-idle" : "")
          }
        >
          {dragZone === "main" && (
            <div className="drop-overlay drop-overlay--attach" aria-hidden>
              <div className="drop-overlay__card">
                <span className="drop-overlay__icon">
                  <IconAttach size={22} />
                </span>
                <strong>{tr("composer.dropAttachTitle")}</strong>
                <span>{tr("composer.dropAttachHint")}</span>
              </div>
            </div>
          )}
          {toast && (
            <div className="app-toast" role="status">
              {toast}
            </div>
          )}
          <div className="main__top" data-tauri-drag-region>
            <div className="main__title-row" data-tauri-drag-region>
              {layout.sidebarCollapsed && (
                <button
                  type="button"
                  className="chrome-btn main__pane-toggle"
                  title={tr("main.leftPaneShow")}
                  onClick={() =>
                    setLayout((l) => {
                      const n = { ...l, sidebarCollapsed: false };
                      saveLayout(localStorage, n);
                      return n;
                    })
                  }
                >
                  <IconPanel size={16} />
                </button>
              )}
              {(() => {
                const cur = sessions.find((s) => s.id === session.sessionId);
                const title =
                  cur?.title ||
                  session.title ||
                  activeProject?.name ||
                  (tr("session.new"));
                return (
                  <>
                    <span className="main__title-icon">
                      <IconFolder size={16} />
                    </span>
                    <h1 className="main__title" data-tauri-drag-region title={title}>
                      {title}
                    </h1>
                    {cur && (
                      <button
                        type="button"
                        className="chrome-btn main__title-menu"
                        title={tr("session.menu")}
                        onClick={(e) => openSessionMenu(e, cur)}
                      >
                        <IconMore size={16} />
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
            <div className="main__top-actions">
              {connecting && (
                <span className="main__sub">{tr("main.connecting")}</span>
              )}
              <button
                type="button"
                className={
                  "chrome-btn main__pane-toggle" +
                  (!layout.sidebarCollapsed ? " is-on" : "")
                }
                title={
                  layout.sidebarCollapsed
                    ? tr("main.leftPaneShow")
                    : tr("main.leftPaneHide")
                }
                onClick={() =>
                  setLayout((l) => {
                    const n = { ...l, sidebarCollapsed: !l.sidebarCollapsed };
                    saveLayout(localStorage, n);
                    return n;
                  })
                }
              >
                <IconPanel size={16} />
              </button>
              <button
                type="button"
                className={
                  "chrome-btn main__pane-toggle" +
                  (!layout.asideCollapsed ? " is-on" : "")
                }
                title={
                  layout.asideCollapsed
                    ? tr("main.rightPaneShow")
                    : tr("main.rightPaneHide")
                }
                onClick={() =>
                  setLayout((l) => {
                    const n = { ...l, asideCollapsed: !l.asideCollapsed };
                    saveLayout(localStorage, n);
                    return n;
                  })
                }
              >
                <IconFiles size={16} />
              </button>
            </div>
          </div>

          {activeProject && !activeProject.trusted && (
            <div className="conn-bar">
              <button
                type="button"
                className="btn btn--primary"
                style={{ height: 24, fontSize: 11 }}
                onClick={() => void trustProject(activeProject)}
              >
                {tr("project.trustToSend", { name: activeProject.name })}
              </button>
            </div>
          )}

          {errorBanner && (
            <div className="error-banner" role="alert">
              {errorBanner.code && (
                <div className="error-banner__code">{errorBanner.code}</div>
              )}
              <div className="error-banner__summary">{errorBanner.summary}</div>
              {(errorBanner.detail ||
                errorBanner.reconnectHint ||
                session.state === "disconnected") && (
                <div className="error-banner__actions">
                  {errorBanner.detail && (
                    <button
                      type="button"
                      className="error-banner__details-btn"
                      aria-expanded={errorDetailOpen}
                      onClick={() => setErrorDetailOpen((v) => !v)}
                    >
                      {errorDetailOpen
                        ? tr("error.hideDetails")
                        : tr("error.details")}
                    </button>
                  )}
                  {(errorBanner.reconnectHint ||
                    session.state === "disconnected") && (
                    <button
                      type="button"
                      className="btn btn--ghost error-banner__reconnect"
                      disabled={connecting}
                      onClick={() => {
                        setLocalError(null);
                        setErrorDetailOpen(false);
                        void ensureConnected(true).then((sid) => {
                          if (sid) setLocalError(null);
                        });
                      }}
                    >
                      {tr("main.reconnect")}
                    </button>
                  )}
                </div>
              )}
              {errorBanner.detail && errorDetailOpen && (
                <pre className="error-banner__detail">{errorBanner.detail}</pre>
              )}
            </div>
          )}

          {perm && (
            <div className="perm-bar" role="dialog" aria-label="Permission">
              <div className="perm-bar__title">
                {perm.title || perm.toolName} · {perm.toolName}
              </div>
              <div className="perm-bar__preview">{perm.preview}</div>
              <div className="perm-bar__actions">
                {mapPermissionButtons(perm.options, {
                  allowOnce: tr("perm.allowOnce"),
                  allowSession: tr("perm.allowSession"),
                  deny: tr("perm.deny"),
                }).map((btn) => (
                  <button
                    key={btn.decision + btn.optionId}
                    type="button"
                    className={
                      btn.decision === "allow_once"
                        ? "btn btn--primary"
                        : btn.decision === "deny"
                          ? "btn btn--danger"
                          : "btn btn--ghost"
                    }
                    onClick={() =>
                      void api
                        .sessionResolvePermission({
                          rpcId: perm.rpcId,
                          decision: btn.decision,
                          optionId: btn.optionId,
                          scopeKey: perm.scopeKey,
                        })
                        .then(() => setPerm(null))
                    }
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ConversationThread
            locale={locale}
            messages={messages}
            sessionState={session.state}
            plan={plan}
            onDismissPlan={() =>
              setPlan((p) => ({
                ...p,
                visible: false,
                waiting: true,
                entries: [],
                body: "",
              }))
            }
            onAddAttachmentToComposer={(att) =>
              setAttachments((prev) => mergeAttachments(prev, [att]))
            }
            attachLabels={attachLabels}
          />

          <div className="composer-wrap">
            <div
              className={
                "composer" +
                (dragZone === "main" ? " composer--drop-ready" : "")
              }
            >
              {attachments.length > 0 && (
                <div
                  className="composer__attachments"
                  aria-label={tr("composer.attachCount", {
                    n: String(attachments.length),
                  })}
                >
                  {attachments.map((a) => (
                    <AttachmentCard
                      key={a.path}
                      attachment={a}
                      variant="chip"
                      labels={attachLabels}
                      galleryPaths={attachments
                        .filter((x) => !x.isDir && isImagePath(x.path))
                        .map((x) => x.path)}
                      onRemove={(att) =>
                        setAttachments((prev) =>
                          prev.filter((x) => x.path !== att.path),
                        )
                      }
                      onAddToComposer={(att) =>
                        setAttachments((prev) => mergeAttachments(prev, [att]))
                      }
                    />
                  ))}
                </div>
              )}
              {showComposerPlus &&
                composerPlusPos &&
                typeof document !== "undefined" &&
                createPortal(
                  <div
                    ref={composerPlusPanelRef}
                    className="composer-plus composer-plus--portal"
                    role="menu"
                    style={composerPlusStyle}
                  >
                    <div className="composer-plus__section">
                      {tr("composer.add")}
                    </div>
                    <button
                      type="button"
                      className="composer-plus__item"
                      onClick={() => {
                        setShowComposerPlus(false);
                        setLocalError(tr("composer.attachLater"));
                      }}
                    >
                      <IconAttach size={16} />
                      <span>
                        <strong>{tr("composer.addFiles")}</strong>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="composer-plus__item"
                      onClick={() => {
                        setShowComposerPlus(false);
                        setMode("plan");
                      }}
                    >
                      <IconImagine size={16} />
                      <span>
                        <strong>{tr("composer.planMode")}</strong>
                        <em>{tr("composer.planModeHint")}</em>
                      </span>
                    </button>
                    <div className="composer-plus__section">
                      {tr("composer.skills")}
                    </div>
                    <button
                      type="button"
                      className="composer-plus__item"
                      disabled
                    >
                      <IconSkills size={16} />
                      <span>
                        <strong>MCP / Skills</strong>
                        <em>{tr("common.comingSoon")}</em>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="composer-plus__item"
                      onClick={() => {
                        setShowComposerPlus(false);
                        setLocalError(tr("automations.menuHint"));
                      }}
                    >
                      <IconAutomations size={16} />
                      <span>
                        <strong>{tr("automations.menu")}</strong>
                        <em>{tr("automations.menuHint")}</em>
                      </span>
                    </button>
                  </div>,
                  document.body,
                )}
              <textarea
                className="composer__input"
                placeholder={tr("composer.placeholder")}
                value={draft}
                disabled={!canType(session.state)}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  resizeComposer(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (
                      canSend(session.state) &&
                      (draft.trim() || attachments.length > 0) &&
                      !connecting
                    ) {
                      void send();
                    }
                  }
                  if (e.key === "Escape") setShowComposerPlus(false);
                }}
              />
              <div className="composer__row">
                <button
                  ref={composerPlusTriggerRef}
                  type="button"
                  className={
                    "icon-btn icon-btn--plus" +
                    (showComposerPlus ? " is-open" : "")
                  }
                  title={tr("composer.add")}
                  onClick={() => setShowComposerPlus((v) => !v)}
                >
                  <IconPlus size={18} />
                </button>
                <span className="chip" title={activeProject?.path}>
                  <IconFolder size={14} />
                  <span className="chip__label">
                    {activeProject?.name ??
                      (tr("composer.noProject"))}
                  </span>
                </span>
                <ComposerModelMenu
                  modelId={modelId}
                  effort={effort}
                  labels={{
                    model: tr("composer.model"),
                    effort: tr("composer.effort"),
                    effortHigh: tr("effort.high"),
                    effortMedium: tr("effort.medium"),
                    effortLow: tr("effort.low"),
                  }}
                  onModel={(v) => {
                    if (!isValidModelId(v)) return;
                    setModelId(v);
                    void api.settingsGet().then((s) =>
                      api.settingsSet({ ...s, modelId: v }),
                    );
                  }}
                  onEffort={(v) => {
                    if (!isValidEffort(v)) return;
                    setEffort(v);
                    void api.settingsGet().then((s) =>
                      api.settingsSet({ ...s, effort: v }),
                    );
                  }}
                />
                <ComposerAccessMenu
                  mode={mode}
                  policy={policy}
                  labels={{
                    access: tr("composer.access"),
                    accessHint: tr("composer.accessHint"),
                    mode: tr("composer.mode"),
                    modeAgent: tr("mode.agent"),
                    modePlan: tr("mode.plan"),
                    modeAsk: tr("mode.ask"),
                    modeAgentDesc: tr("mode.agentDesc"),
                    modePlanDesc: tr("mode.planDesc"),
                    modeAskDesc: tr("mode.askDesc"),
                    permission: tr("composer.permission"),
                    policyAsk: tr("policy.ask"),
                    policyAcceptEdits: tr("policy.accept_edits"),
                    policySession: tr("policy.allow_for_session"),
                    policyDontAsk: tr("policy.dont_ask"),
                    policyYolo: tr("policy.always_approve"),
                    policyAskDesc: tr("policy.askDesc"),
                    policyAcceptEditsDesc: tr("policy.accept_editsDesc"),
                    policySessionDesc: tr("policy.allow_for_sessionDesc"),
                    policyDontAskDesc: tr("policy.dont_askDesc"),
                    policyYoloDesc: tr("policy.always_approveDesc"),
                    policyShortAsk: tr("policy.short.ask"),
                    policyShortAccept: tr("policy.short.accept_edits"),
                    policyShortSession: tr("policy.short.allow_for_session"),
                    policyShortDontAsk: tr("policy.short.dont_ask"),
                    policyShortYolo: tr("policy.short.always_approve"),
                  }}
                  onMode={(v) => {
                    setMode(v);
                    void api.settingsGet().then((s) =>
                      api.settingsSet({ ...s, mode: v }),
                    );
                  }}
                  onPolicy={(v: PermissionPolicyId) => {
                    if (!isValidPolicy(v)) return;
                    if (v === "always_approve") {
                      const ok1 = window.confirm(tr("policy.yoloConfirm"));
                      if (!ok1) return;
                      const ok2 = window.confirm(tr("policy.yoloConfirm2"));
                      if (!ok2) return;
                    }
                    setPolicy(v);
                    void api.sessionSetPolicy(v);
                    void api.settingsGet().then((s) =>
                      api.settingsSet({ ...s, permissionPolicy: v }),
                    );
                  }}
                />
                <span className="composer__spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  title={tr("composer.voiceSoon")}
                  disabled
                >
                  <IconMic size={16} />
                </button>
                {canStop(session.state) ? (
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    onClick={() => void stop()}
                    title="Stop"
                  >
                    <IconStop size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-btn icon-btn--primary"
                    disabled={
                      !canSend(session.state) ||
                      (!draft.trim() && attachments.length === 0) ||
                      connecting
                    }
                    onClick={() => void send()}
                    title={tr("composer.send")}
                  >
                    <IconSend size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* RIGHT — session-linked project resource viewer (fully hideable + resizable) */}
        <aside
          className={
            (layout.asideCollapsed ? "aside aside--hidden" : "aside") +
            (resizingAside ? " is-resizing" : "")
          }
          aria-hidden={layout.asideCollapsed}
          style={
            !layout.asideCollapsed
              ? {
                  width: layout.asideWidth,
                  minWidth: layout.asideWidth,
                  maxWidth: layout.asideWidth,
                }
              : undefined
          }
        >
          {!layout.asideCollapsed && (
            <div
              className="aside-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize files pane"
              onPointerDown={(e) => {
                e.preventDefault();
                setResizingAside(true);
              }}
            />
          )}
          <div className="aside__inner">
            <ResourceViewer
              projectPath={activeProject?.path ?? null}
              projectName={activeProject?.name ?? null}
              locale={locale}
              onClose={() =>
                setLayout((l) => {
                  const n = { ...l, asideCollapsed: true };
                  saveLayout(localStorage, n);
                  return n;
                })
              }
            />
          </div>
        </aside>
      </div>
      )}

      {showOnboarding && (
        <div className="overlay">
          <div className="modal">
            <h2>{tr("onboarding.welcome")}</h2>
            <p>{tr("onboarding.body")}</p>
            <div className="entry-grid">
              <button
                type="button"
                className="entry-card"
                onClick={() => void runAccountLogin("oauth")}
              >
                <div className="entry-card__t">{tr("onboarding.officialOauth")}</div>
                <div className="entry-card__d">{tr("onboarding.officialHint")}</div>
              </button>
              <button
                type="button"
                className="entry-card"
                onClick={() => {
                  const key = window.prompt("Official API Key");
                  if (key) {
                    void api.secretsSet({ officialApiKey: key }).then(() => {
                      setSetup((s) => ({ ...s, auth: true }));
                      setPingMsg("OK");
                      void refreshAccount({ refreshBilling: false });
                    });
                  }
                }}
              >
                <div className="entry-card__t">{tr("onboarding.officialKey")}</div>
                <div className="entry-card__d">{tr("onboarding.officialHint")}</div>
              </button>
              <button
                type="button"
                className="entry-card"
                onClick={() => {
                  const base = window.prompt("Relay base_url");
                  const key = window.prompt("Relay API key");
                  if (base && key) {
                    void api
                      .secretsSet({ relayBaseUrl: base, relayApiKey: key })
                      .then(async () => {
                        setSetup((s) => ({ ...s, auth: true }));
                        const r = await api.providerPing();
                        setPingMsg(`${r.class}: ${r.message}`);
                      });
                  }
                }}
              >
                <div className="entry-card__t">{tr("onboarding.relay")}</div>
                <div className="entry-card__d">{tr("onboarding.relayHint")}</div>
              </button>
              <button
                type="button"
                className="entry-card"
                onClick={() =>
                  void api.importGrokGo().then((r) => setPingMsg(JSON.stringify(r))).catch((e) => setPingMsg(String(e)))
                }
              >
                <div className="entry-card__t">{tr("onboarding.importGo")}</div>
                <div className="entry-card__d">{tr("onboarding.importGoHint")}</div>
              </button>
              <button
                type="button"
                className="entry-card"
                onClick={() =>
                  void api.importGrokCli().then((r) => {
                    setPingMsg(JSON.stringify(r));
                    setSetup((s) => ({ ...s, auth: true }));
                  })
                }
              >
                <div className="entry-card__t">{tr("onboarding.importCli")}</div>
                <div className="entry-card__d">{tr("onboarding.importCliHint")}</div>
              </button>
            </div>
            {pingMsg && <p style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{pingMsg}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  void api.settingsGet().then((s) =>
                    api.settingsSet({ ...s, setupSkipped: true }),
                  );
                  setShowOnboarding(false);
                }}
              >
                {tr("onboarding.skip")}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  void api.settingsGet().then((s) =>
                    api.settingsSet({ ...s, onboardingDone: true }),
                  );
                  setShowOnboarding(false);
                }}
              >
                {tr("onboarding.continue")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDoctor && (
        <div className="overlay" onClick={() => setShowDoctor(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{tr("doctor.title")}</h2>
            <pre
              style={{
                fontSize: 12,
                whiteSpace: "pre-wrap",
                background: "var(--bg-code)",
                padding: 12,
                borderRadius: 8,
                maxHeight: 360,
                overflow: "auto",
              }}
            >
              {redact(JSON.stringify(doctor, null, 2))}
            </pre>
            <button type="button" className="btn btn--ghost" onClick={() => setShowDoctor(false)}>
              {tr("doctor.close")}
            </button>
          </div>
        </div>
      )}

      {/* Search / command palette (Codex-style) */}
      {showSearch && (
        <div
          className="overlay"
          onClick={() => setShowSearch(false)}
        >
          <div
            className="search-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={tr("sidebar.search")}
          >
            <div className="search-panel__head">
              <IconSearch size={16} />
              <input
                autoFocus
                className="search-panel__input"
                placeholder={
                  tr("search.placeholder")
                }
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button
                type="button"
                className="chrome-btn"
                onClick={() => setShowSearch(false)}
              >
                <IconClose size={14} />
              </button>
            </div>
            {searchHits.matchedProjects.length > 0 && (
              <>
                <div className="search-panel__section">
                  {tr("sidebar.projects")}
                </div>
                {searchHits.matchedProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="search-panel__row"
                    onClick={() => {
                      setShowSearch(false);
                      void selectProject(p);
                      setExpandedProjects((e) => ({ ...e, [p.id]: true }));
                    }}
                  >
                    <IconFolder size={15} />
                    <span className="search-panel__title">{p.name}</span>
                    <span className="search-panel__meta">{p.path}</span>
                  </button>
                ))}
              </>
            )}
            <div className="search-panel__section">
              {tr("search.chats")}
            </div>
            {searchHits.matchedSessions.length === 0 && (
              <div className="sidebar-empty" style={{ padding: 12 }}>
                {tr("search.noMatches")}
              </div>
            )}
            {searchHits.matchedSessions.map((s, i) => {
              const proj = projects.find((p) => p.id === s.projectId);
              return (
                <button
                  key={s.id}
                  type="button"
                  className="search-panel__row"
                  onClick={() => {
                    setShowSearch(false);
                    void openSession(s, proj ?? null);
                  }}
                >
                  <IconSquarePen size={15} />
                  <span className="search-panel__title">
                    {s.title || "Untitled"}
                  </span>
                  <span className="search-panel__meta">
                    {proj?.name ?? "—"}
                    {i < 9 ? `  ⌘${i + 1}` : ""}
                  </span>
                </button>
              );
            })}
            <div className="search-panel__foot">
              <button
                type="button"
                className="search-panel__row"
                onClick={() => {
                  setShowSearch(false);
                  void newChat(activeProject);
                }}
              >
                <IconSquarePen size={15} />
                <span className="search-panel__title">
                  {tr("search.newChat")}
                </span>
              </button>
              <button
                type="button"
                className="search-panel__row"
                onClick={() => {
                  setShowSearch(false);
                  void addProject(false);
                }}
              >
                <IconFolder size={15} />
                <span className="search-panel__title">
                  {tr("sidebar.addProject")}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating context menu (project / session) — fixed + portal to body */}
      {ctxMenu &&
        typeof document !== "undefined" &&
        createPortal(
        <ul
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxMenu.kind === "project" &&
            (() => {
              const proj = projects.find((p) => p.id === ctxMenu.id);
              if (!proj) return null;
              return (
                <>
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        setCtxMenu(null);
                        void api
                          .projectSetPinned(proj.id, !proj.pinned)
                          .then(() => refreshProjects());
                      }}
                    >
                      {proj.pinned
                        ? tr("project.unpin")
                        : tr("project.pin")}
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        setCtxMenu(null);
                        void api.projectReveal(proj.id).catch((e) =>
                          setLocalError(String(e)),
                        );
                      }}
                    >
                      {tr("project.reveal")}
                    </button>
                  </li>
                  <li>
                    <button type="button" onClick={() => void renameProject(proj)}>
                      {tr("project.rename")}
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        setCtxMenu(null);
                        void api
                          .projectArchiveSessions(proj.id)
                          .then(() => refreshSessions());
                      }}
                    >
                      {tr("project.archiveChats")}
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void removeProjectFromApp(proj);
                      }}
                    >
                      {tr("project.remove")}
                    </button>
                  </li>
                </>
              );
            })()}
          {ctxMenu.kind === "session" &&
            (() => {
              const s = sessions.find((x) => x.id === ctxMenu.id);
              if (!s) return null;
              return (
                <>
                  <li>
                    <button type="button" onClick={() => void renameSession(s)}>
                      {tr("session.rename")}
                    </button>
                  </li>
                  <li>
                    <button type="button" onClick={() => void copySessionId(s)}>
                      {tr("session.copyId")}
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      onClick={() => void archiveSession(s, !s.archived)}
                    >
                      {s.archived
                        ? tr("sidebar.unarchive")
                        : tr("sidebar.archive")}
                    </button>
                  </li>
                </>
              );
            })()}
        </ul>,
        document.body,
      )}

      <span hidden data-layout-default={JSON.stringify(DEFAULT_LAYOUT)} />
    </div>
    </ImageViewerProvider>
  );
}
