// What every part of the signed-in app can reach: the user, the monitors, navigation, the panel.

import { createContext, useContext } from "react";
import type { Me, Monitor, Project, ServerInfo, Status, StatusPage, Webhook } from "./api";
import type { Route } from "./router";

export type SettingsPage = "profile" | "preferences" | "security" | "data" | "shortcuts" | "users" | "about";

/** What the side panel is editing, if anything. */
export type Editing =
  | { kind: "monitor"; monitor?: Monitor; projectId?: number | null }
  | { kind: "webhook"; webhook?: Webhook }
  | { kind: "project"; project?: Project }
  | { kind: "page"; page?: StatusPage };

export interface AppContextValue {
  me: Me;
  setMe: (me: Me) => void;
  server: ServerInfo | undefined;
  route: Route;
  query: Record<string, string>;
  navigate: (route: Route, query?: Record<string, string>, replace?: boolean) => void;
  setQuery: (patch: Record<string, string | undefined>, replace?: boolean) => void;
  monitors: Monitor[] | undefined;
  projects: Project[] | undefined;
  /** The monitors the sidebar's filters leave. */
  visible: Monitor[];
  /** Sidebar filters: a project (0: no project) and a status. */
  project: number | null;
  status: Status | null;
  reload: () => void;
  editing: Editing | null;
  edit: (e: Editing | null) => void;
  openSettings: (page?: SettingsPage) => void;
  signOut: () => void;
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  panelVisible: boolean;
  togglePanel: () => void;
  openSearch: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside the app");
  return v;
}

export function matches(m: Monitor, project: number | null, status: Status | null): boolean {
  if (project !== null && (m.projectId ?? 0) !== project) return false;
  if (status && m.status !== status) return false;
  return true;
}

/** The worst status among monitors: what the banner says. */
export function overall(monitors: { status: Status }[]): "up" | "degraded" | "down" | "none" {
  const active = monitors.filter((m) => m.status !== "paused" && m.status !== "pending");
  if (!active.length) return "none";
  if (active.some((m) => m.status === "down")) return "down";
  if (active.some((m) => m.status === "degraded")) return "degraded";
  return "up";
}
