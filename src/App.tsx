import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, canContribute, STATUSES, type Me, type Monitor, type Project, type PublicStatus as PublicData, type ServerInfo, type Status } from "./lib/api";
import { AppContext, matches, type AppContextValue, type Editing, type SettingsPage } from "./lib/app";
import { MOBILE_QUERY, invalidate, useApi, useMediaQuery } from "./lib/hooks";
import { useRouter } from "./lib/router";
import { SettingsProvider, useSettings } from "./lib/settings";
import { ToastProvider, useToast } from "./components/common";
import { Sidebar } from "./components/Sidebar";
import { SignIn } from "./components/SignIn";
import { SettingsDialog } from "./components/SettingsDialog";
import { SearchDialog } from "./components/SearchDialog";
import { Toolbar } from "./components/Toolbar";
import { Overview } from "./components/Overview";
import { MonitorPage } from "./components/MonitorPage";
import { IncidentsPage } from "./components/IncidentsPage";
import { NotificationsPage } from "./components/NotificationsPage";
import { PublicStatus } from "./components/PublicStatus";
import { PageEditor, StatusPagesPage } from "./components/StatusPagesPage";
import { SidePanel } from "./components/SidePanel";
import { statusKey } from "./components/status";

export default function App() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </SettingsProvider>
  );
}

function Root() {
  const router = useRouter();
  const { t } = useSettings();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);
  // Signed out at /: the default status page when there is one, else the sign-in card.
  const [hasPublic, setHasPublic] = useState<boolean | undefined>(undefined);
  // Set by the server when single sign-on fails (it redirects back with ?signin_error=…).
  const [signinError] = useState(() => new URLSearchParams(location.search).get("signin_error"));

  const loadMe = useCallback(() => {
    api<Me>("/auth/me").then(setMe, (e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setMe(null)));
  }, []);

  useEffect(() => loadMe(), [loadMe]);

  useEffect(() => {
    if (signinError) router.setQuery({ signin_error: undefined }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (me !== null || hasPublic !== undefined) return;
    api<PublicData>("/public/status").then(
      () => setHasPublic(true),
      () => setHasPublic(false),
    );
  }, [me, hasPublic]);

  // Any API call answering 401 means the session ended (expired, signed out elsewhere).
  useEffect(() => {
    const onSignedOut = () => setMe(null);
    window.addEventListener("status:signed-out", onSignedOut);
    return () => window.removeEventListener("status:signed-out", onSignedOut);
  }, []);

  const r = router.route;
  if (r.name === "status") {
    return <PublicStatus slug={r.slug} action={me ? { label: t("openDashboard"), run: () => router.navigate({ name: "overview" }, {}) } : { label: t("signIn"), run: () => router.navigate({ name: "overview" }, {}) }} />;
  }
  if (me === undefined) return <div className="splash" />;
  if (me === null) {
    if (r.name === "overview" && !signinError && !signingIn) {
      if (hasPublic === undefined) return <div className="splash" />;
      if (hasPublic) return <PublicStatus action={{ label: t("signIn"), run: () => setSigningIn(true) }} />;
    }
    return <SignIn error={signinError} onSignedIn={loadMe} />;
  }
  return <Shell me={me} setMe={setMe} router={router} onSignedOut={() => setMe(null)} />;
}

function Shell({ me, setMe, router, onSignedOut }: { me: Me; setMe: (me: Me) => void; router: ReturnType<typeof useRouter>; onSignedOut: () => void }) {
  const { settings, update, t } = useSettings();
  const toast = useToast();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [drawer, setDrawer] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(() => {
    const p = new URLSearchParams(location.search).get("settings");
    return p ? (p as SettingsPage) : null;
  });
  const server = useApi<ServerInfo>("/app/server").data;
  const monitorsReq = useApi<Monitor[]>("/app/monitors", true);
  const projectsReq = useApi<Project[]>("/app/projects", true);

  useEffect(() => {
    if (new URLSearchParams(location.search).has("settings")) router.setQuery({ settings: undefined }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const r = router.route;
  const project = router.query.project !== undefined && /^\d+$/.test(router.query.project) ? Number(router.query.project) : null;
  const status = STATUSES.find((s) => s === router.query.status) ?? null;
  const visible = useMemo(() => (monitorsReq.data ?? []).filter((m) => matches(m, project, status)), [monitorsReq.data, project, status]);

  // A tab left open: tell when something goes down or comes back.
  const [seen, setSeen] = useState<Map<number, Status> | null>(null);
  useEffect(() => {
    const list = monitorsReq.data;
    if (!list) return;
    if (seen) {
      for (const m of list) {
        const before = seen.get(m.id);
        if (before && before !== m.status && (m.status === "down" || before === "down")) {
          toast(`${m.name}: ${t(statusKey(m.status))}`, m.status === "down" ? "error" : "info");
        }
      }
    }
    setSeen(new Map(list.map((m) => [m.id, m.status])));
    const down = list.filter((m) => m.status === "down").length;
    document.title = down ? `(${down}) ${t("appName")}` : t("appName");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorsReq.data]);

  // Close the drawer when navigating on phones.
  useEffect(() => setDrawer(false), [r]);

  const sidebarVisible = mobile ? drawer : settings.sidebar;
  const panelVisible = !!editing || (mobile ? mobilePanel : settings.panel);
  const toggleSidebar = () => (mobile ? setDrawer((d) => !d) : update({ sidebar: !settings.sidebar }));
  const togglePanel = () => {
    if (editing) return setEditing(null);
    if (mobile) setMobilePanel((p) => !p);
    else update({ panel: !settings.panel });
  };
  const reload = () => {
    invalidate("/app/monitors");
    invalidate("/app/projects");
    monitorsReq.reload();
    projectsReq.reload();
  };
  const edit = (e: Editing | null) => {
    if (e && !canContribute(me)) return;
    setEditing(e);
    if (e && mobile) setDrawer(false);
  };

  const value: AppContextValue = {
    me,
    setMe,
    server,
    route: r,
    query: router.query,
    navigate: router.navigate,
    setQuery: router.setQuery,
    monitors: monitorsReq.data,
    projects: projectsReq.data,
    visible,
    project,
    status,
    reload,
    editing,
    edit,
    openSettings: (page) => setSettingsPage(page ?? "profile"),
    signOut: () => {
      void api("/auth/logout", { method: "POST" }).finally(() => {
        invalidate();
        onSignedOut();
      });
    },
    sidebarVisible,
    toggleSidebar,
    panelVisible,
    togglePanel,
    openSearch: () => setSearchOpen(true),
  };

  // The same keys as Calendar, Notes and Llip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = !!target.closest?.("input, textarea, select, [contenteditable]");
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (ctrl && !e.altKey && !e.shiftKey && (k === "b" || k === "\\")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (ctrl && !e.altKey && k === "k") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (ctrl && !e.altKey && e.key === ",") {
        e.preventDefault();
        setSettingsPage((p) => p ?? "profile");
        return;
      }
      if (ctrl && !e.altKey && k === ".") {
        e.preventDefault();
        togglePanel();
        return;
      }
      if (k === "escape" && !settingsPage && !searchOpen && !document.querySelector(".dialog-backdrop, .picker")) {
        if (editing) setEditing(null);
        else if (mobile && (drawer || mobilePanel)) {
          setDrawer(false);
          setMobilePanel(false);
        } else if (r.name === "monitor" && !inField) router.navigate({ name: "overview" });
        return;
      }

      // Single keys: not while typing, in a dialog, or with modifiers.
      if (ctrl || e.altKey || inField || settingsPage || searchOpen) return;
      if (document.querySelector(".dialog-backdrop, .picker")) return;
      const open = r.name === "monitor" ? monitorsReq.data?.find((m) => m.id === r.id) : undefined;
      if (k === "\\") toggleSidebar();
      else if (k === "/") setSearchOpen(true);
      else if (k === ".") togglePanel();
      else if (k === "n" && !editing) edit({ kind: "monitor", projectId: project });
      else if (k === "e" && open) edit({ kind: "monitor", monitor: open });
      else if (k === "r" && open && open.type !== "heartbeat") (document.querySelector(".monitor-actions button") as HTMLButtonElement | null)?.click();
      else if (k === "g") router.navigate({ name: "overview" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const projectName = project === 0 ? t("noProject") : projectsReq.data?.find((p) => p.id === project)?.name;
  const title =
    r.name === "monitor"
      ? (monitorsReq.data?.find((m) => m.id === r.id)?.name ?? t("monitor"))
      : r.name === "incidents"
        ? t("incidents")
        : r.name === "notifications"
          ? t("notifications")
          : r.name === "pages" || r.name === "page"
            ? t("statusPages")
            : (projectName ?? (status ? t(statusKey(status)) : t("overview")));

  return (
    <AppContext.Provider value={value}>
      <div className="app">
        {sidebarVisible && (
          <>
            {mobile && <div className="sidebar-backdrop" onClick={() => setDrawer(false)} />}
            <Sidebar />
          </>
        )}
        <main className="main">
          <Toolbar title={title} loading={monitorsReq.loading && !monitorsReq.data} />
          <div className="content">
            {r.name === "overview" && <Overview />}
            {r.name === "monitor" && <MonitorPage key={r.id} id={r.id} />}
            {r.name === "incidents" && <IncidentsPage />}
            {r.name === "notifications" && <NotificationsPage />}
            {r.name === "pages" && <StatusPagesPage />}
            {r.name === "page" && <PageEditor key={r.id} id={r.id} />}
          </div>
        </main>
        {panelVisible && (
          <>
            {mobile && <div className="sidebar-backdrop" onClick={togglePanel} />}
            <SidePanel />
          </>
        )}
      </div>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      {settingsPage && <SettingsDialog page={settingsPage} onClose={() => setSettingsPage(null)} />}
    </AppContext.Provider>
  );
}
