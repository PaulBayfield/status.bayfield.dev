// Address-bar routing: / is the overview, /m/<id> a monitor, /incidents, /notifications,
// /pages the status pages (and /pages/<id> one's editor), /status and /status/<slug> the public pages. The query string holds the filters (?project=2&status=down).

import { useCallback, useEffect, useState } from "react";

export type Route = { name: "overview" } | { name: "monitor"; id: number } | { name: "incidents" } | { name: "notifications" } | { name: "pages" } | { name: "page"; id: number } | { name: "status"; slug?: string };

export function parseRoute(path: string): Route {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/").map(decodeURIComponent);
  if (parts[0] === "m" && parts[1] && /^\d+$/.test(parts[1])) return { name: "monitor", id: Number(parts[1]) };
  if (parts[0] === "incidents") return { name: "incidents" };
  if (parts[0] === "notifications") return { name: "notifications" };
  if (parts[0] === "pages" && parts[1] && /^\d+$/.test(parts[1])) return { name: "page", id: Number(parts[1]) };
  if (parts[0] === "pages") return { name: "pages" };
  if (parts[0] === "status") return parts[1] ? { name: "status", slug: parts[1].toLowerCase() } : { name: "status" };
  return { name: "overview" };
}

export function routePath(r: Route): string {
  if (r.name === "monitor") return `/m/${r.id}`;
  if (r.name === "overview") return "/";
  if (r.name === "page") return `/pages/${r.id}`;
  if (r.name === "status") return r.slug ? `/status/${encodeURIComponent(r.slug)}` : "/status";
  return `/${r.name}`;
}

const readQuery = () => Object.fromEntries(new URLSearchParams(location.search));

export function useRouter() {
  const [state, setState] = useState(() => ({ route: parseRoute(location.pathname), query: readQuery() }));

  useEffect(() => {
    const onPop = () => setState({ route: parseRoute(location.pathname), query: readQuery() });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** Goes to a page; the filters carry over unless `query` says otherwise. */
  const navigate = useCallback((route: Route, query?: Record<string, string>, replace = false) => {
    setState((s) => {
      const q = query ?? s.query;
      const search = new URLSearchParams(q).toString();
      history[replace ? "replaceState" : "pushState"](null, "", routePath(route) + (search ? `?${search}` : ""));
      return { route, query: q };
    });
  }, []);

  /** Changes the query string of the current page (filters). */
  const setQuery = useCallback((patch: Record<string, string | undefined>, replace = false) => {
    setState((s) => {
      const q = { ...s.query };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete q[k];
        else q[k] = v;
      }
      const search = new URLSearchParams(q).toString();
      history[replace ? "replaceState" : "pushState"](null, "", location.pathname + (search ? `?${search}` : ""));
      return { ...s, query: q };
    });
  }, []);

  return { route: state.route, query: state.query, navigate, setQuery };
}
