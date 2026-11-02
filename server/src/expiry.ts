// SSL certificate and domain expiry, watched for HTTP monitors that ask for it.
//
// Certificates: Workers' fetch() doesn't show the certificate, so this opens a TCP socket, sends a
// TLS 1.2 ClientHello and reads the server's Certificate message (still in clear text in TLS 1.2),
// then parses the leaf's dates, issuer and names. Sockets can't reach hosts behind Cloudflare's
// proxy, and TLS 1.3-only servers answer differently: then the Certificate Transparency logs
// (crt.sh) say which certificate was issued last.
//
// Domains: RDAP, the registries' JSON successor to WHOIS, found through IANA's bootstrap file.

import { connect } from "cloudflare:sockets";
import { all, first, run } from "./db.ts";
import type { Monitor } from "./checks.ts";

export type ExpiryKind = "certificate" | "domain";

export interface Expiry {
  monitorId: number;
  kind: ExpiryKind;
  /** The host or domain checked. */
  name: string;
  expiresAt: number | null;
  issuedAt: number | null;
  /** The certificate's issuer, or the domain's registrar. */
  issuer: string;
  /** tls: read from the server; ct: from Certificate Transparency logs; rdap. */
  source: string;
  /** Why it couldn't be checked, or what's wrong (a certificate for another name). */
  error: string;
  checkedAt: number;
  /** The last warning sent: warn, urgent or expired (empty: none). */
  stage: string;
}

const DAY = 24 * 60 * 60_000;
const TIMEOUT = 10_000;
const UA = "Mozilla/5.0 (compatible; status.bayfield.dev uptime monitor)";

// --- Bytes ---

const enc = new TextEncoder();
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const withLen16 = (b: number[]) => [...u16(b.length), ...b];

function clientHello(host: string): Uint8Array {
  const random = [...crypto.getRandomValues(new Uint8Array(32))];
  // TLS 1.2 suites only, and no supported_versions extension: the server has to answer in 1.2.
  const suites = [0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc009, 0xc013, 0xc00a, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035].flatMap(u16);
  const name = [...enc.encode(host)];
  const ext = (type: number, body: number[]) => [...u16(type), ...withLen16(body)];
  const extensions = [
    ...ext(0x0000, withLen16([0, ...withLen16(name)])), // server_name
    ...ext(0x000a, withLen16([0x001d, 0x0017, 0x0018].flatMap(u16))), // supported_groups
    ...ext(0x000b, [1, 0]), // ec_point_formats: uncompressed
    ...ext(0x000d, withLen16([0x0403, 0x0503, 0x0603, 0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601, 0x0201, 0x0203].flatMap(u16))), // signature_algorithms
    ...ext(0xff01, [0]), // renegotiation_info
  ];
  const body = [0x03, 0x03, ...random, 0, ...withLen16(suites), 1, 0, ...withLen16(extensions)];
  const handshake = [0x01, ...u24(body.length), ...body];
  return new Uint8Array([0x16, 0x03, 0x01, ...u16(handshake.length), ...handshake]);
}

/** The server's certificate chain (DER), from a TLS 1.2 handshake. */
async function tlsCertificates(hostname: string, port: number): Promise<Uint8Array[]> {
  const socket = connect({ hostname, port }, { secureTransport: "off", allowHalfOpen: false });
  let handle: ReturnType<typeof setTimeout> | null = null;
  const timer = new Promise<never>((_, reject) => (handle = setTimeout(() => reject(new Error("Timed out")), TIMEOUT)));
  timer.catch(() => {});
  try {
    await Promise.race([socket.opened, timer]);
    const writer = socket.writable.getWriter();
    await writer.write(clientHello(hostname));
    writer.releaseLock();
    const reader = socket.readable.getReader();
    let buf = new Uint8Array(0);
    let hs = new Uint8Array(0);
    const append = (a: Uint8Array, b: Uint8Array) => {
      const out = new Uint8Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    };
    while (true) {
      const { value, done } = await Promise.race([reader.read(), timer]);
      if (done) throw new Error("The server closed the connection");
      buf = append(buf, value);
      // Whole records: type, version, length.
      while (buf.length >= 5) {
        const len = (buf[3] << 8) | buf[4];
        if (buf.length < 5 + len) break;
        const type = buf[0];
        const payload = buf.slice(5, 5 + len);
        buf = buf.slice(5 + len);
        if (type === 0x15) throw new Error("The server refused TLS 1.2");
        if (type !== 0x16) continue;
        hs = append(hs, payload);
      }
      // Whole handshake messages: type, 24-bit length.
      let off = 0;
      while (hs.length - off >= 4) {
        const len = (hs[off + 1] << 16) | (hs[off + 2] << 8) | hs[off + 3];
        if (hs.length - off - 4 < len) break;
        const type = hs[off];
        if (type === 11) {
          const body = hs.subarray(off + 4, off + 4 + len);
          const certs: Uint8Array[] = [];
          let p = 3;
          while (p + 3 <= body.length) {
            const n = (body[p] << 16) | (body[p + 1] << 8) | body[p + 2];
            certs.push(body.slice(p + 3, p + 3 + n));
            p += 3 + n;
          }
          return certs;
        }
        if (type === 14) throw new Error("The server sent no certificate");
        off += 4 + len;
      }
      if (buf.length + hs.length > 256 * 1024) throw new Error("Unexpected answer");
    }
  } finally {
    if (handle !== null) clearTimeout(handle);
    socket.close().catch(() => {});
  }
}

// --- DER (just enough of X.509) ---

interface Node {
  tag: number;
  start: number;
  end: number;
}

function tlv(b: Uint8Array, off: number): Node & { next: number } {
  const tag = b[off];
  let len = b[off + 1];
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new Error("Truncated certificate");
  return { tag, start: p, end: p + len, next: p + len };
}

function children(b: Uint8Array, n: Node): Node[] {
  const out: Node[] = [];
  for (let p = n.start; p < n.end; ) {
    const c = tlv(b, p);
    out.push(c);
    p = c.next;
  }
  return out;
}

const dec = new TextDecoder();
const str = (b: Uint8Array, n: Node) => dec.decode(b.subarray(n.start, n.end));
const oid = (b: Uint8Array, n: Node) => [...b.subarray(n.start, n.end)].map((x) => x.toString(16).padStart(2, "0")).join("");

function time(b: Uint8Array, n: Node): number {
  const s = str(b, n);
  const full = n.tag === 0x17 ? `${Number(s.slice(0, 2)) < 50 ? "20" : "19"}${s}` : s;
  return Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8), +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14));
}

/** CN and O of a Name. */
function name(b: Uint8Array, n: Node): { cn: string; o: string } {
  const out = { cn: "", o: "" };
  for (const set of children(b, n)) {
    for (const atv of children(b, set)) {
      const [type, value] = children(b, atv);
      const id = oid(b, type);
      if (id === "550403") out.cn = str(b, value);
      if (id === "55040a") out.o = str(b, value);
    }
  }
  return out;
}

export interface Certificate {
  notBefore: number;
  notAfter: number;
  issuer: string;
  names: string[];
}

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = tlv(der, 0);
  const tbs = children(der, cert)[0];
  const parts = children(der, tbs);
  let i = parts[0].tag === 0xa0 ? 1 : 0; // optional version
  i += 2; // serial, signature algorithm
  const issuer = name(der, parts[i++]);
  const [nb, na] = children(der, parts[i++]);
  const subject = name(der, parts[i++]);
  const names = new Set<string>();
  if (subject.cn) names.add(subject.cn.toLowerCase());
  const exts = parts.find((p) => p.tag === 0xa3);
  if (exts) {
    for (const ext of children(der, children(der, exts)[0])) {
      const fields = children(der, ext);
      if (oid(der, fields[0]) !== "551d11") continue; // subjectAltName
      const octets = fields[fields.length - 1];
      const seq = tlv(der, octets.start);
      for (const gn of children(der, seq)) if (gn.tag === 0x82) names.add(str(der, gn).toLowerCase());
    }
  }
  return {
    notBefore: time(der, nb),
    notAfter: time(der, na),
    issuer: issuerName(issuer.o, issuer.cn),
    names: [...names],
  };
}

/** Does a certificate name (maybe *.example.com) cover the host? */
export function covers(pattern: string, host: string): boolean {
  host = host.toLowerCase();
  if (pattern === host) return true;
  if (!pattern.startsWith("*.")) return false;
  const rest = pattern.slice(2);
  return host.endsWith(`.${rest}`) && !host.slice(0, -rest.length - 1).includes(".");
}

/** The certificate issued last for the host, among valid ones. */
function latest(host: string, certs: Certificate[]): Certificate {
  const now = Date.now();
  const best = certs.filter((c) => c.notBefore <= now && c.notAfter > now && c.names.some((n) => covers(n, host))).sort((a, b) => b.notBefore - a.notBefore)[0];
  if (!best) throw new Error("No valid certificate in the CT logs");
  return best;
}

/** One attribute of a distinguished name: "C=US, O=Let's Encrypt, CN=R11" → O → "Let's Encrypt". */
const dn = (s: string, key: string) =>
  s
    .split(/,\s*/)
    .map((part) => part.split("="))
    .find(([k]) => k.trim() === key)
    ?.slice(1)
    .join("=")
    .replace(/^"|"$/g, "") ?? "";
const issuerName = (o: string, cn: string) => (o && cn && o !== cn ? `${o} (${cn})` : o || cn);

/** From the Certificate Transparency logs: Cert Spotter (fast, 100 lookups an hour), then crt.sh. */
async function ctCertificate(host: string): Promise<Certificate> {
  try {
    const res = await fetch(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(host)}&expand=dns_names&expand=issuer`, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Cert Spotter answered ${res.status}`);
    const rows = (await res.json()) as { not_before: string; not_after: string; dns_names: string[]; issuer?: { name?: string; friendly_name?: string } }[];
    return latest(
      host,
      rows.map((r) => ({
        notBefore: Date.parse(r.not_before),
        notAfter: Date.parse(r.not_after),
        names: r.dns_names.map((n) => n.toLowerCase()),
        issuer: issuerName(r.issuer?.friendly_name || dn(r.issuer?.name ?? "", "O"), dn(r.issuer?.name ?? "", "CN")),
      })),
    );
  } catch (first) {
    const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(host)}&output=json&exclude=expired`, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res?.ok) throw first;
    const rows = (await res.json()) as { issuer_name: string; name_value: string; not_before: string; not_after: string }[];
    const utc = (s: string) => Date.parse(s.endsWith("Z") ? s : `${s}Z`);
    return latest(
      host,
      rows.map((r) => ({
        notBefore: utc(r.not_before),
        notAfter: utc(r.not_after),
        names: r.name_value.toLowerCase().split("\n"),
        issuer: issuerName(dn(r.issuer_name, "O"), dn(r.issuer_name, "CN")),
      })),
    );
  }
}

export function certificateTarget(m: Pick<Monitor, "type" | "target">): { host: string; port: number } | null {
  if (m.type !== "http") return null;
  try {
    const u = new URL(m.target);
    if (u.protocol !== "https:") return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 443 };
  } catch {
    return null;
  }
}

async function checkCertificate(host: string, port: number): Promise<Omit<Expiry, "monitorId" | "kind" | "checkedAt" | "stage">> {
  let cert: Certificate;
  let source = "tls";
  let note = "";
  try {
    const chain = await tlsCertificates(host, port);
    if (!chain.length) throw new Error("No certificate");
    cert = parseCertificate(chain[0]);
  } catch (e) {
    note = (e as Error).message;
    source = "ct";
    try {
      cert = await ctCertificate(host);
    } catch (e2) {
      return { name: host, expiresAt: null, issuedAt: null, issuer: "", source: "", error: `${note}; ${(e2 as Error).message}`.slice(0, 300) };
    }
  }
  const ok = cert.names.some((n) => covers(n, host));
  return {
    name: host,
    expiresAt: cert.notAfter,
    issuedAt: cert.notBefore,
    issuer: cert.issuer.slice(0, 200),
    source,
    error: ok ? "" : `The certificate is for ${cert.names.slice(0, 3).join(", ")}, not ${host}`,
  };
}

// --- Domains (RDAP) ---

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "ltd", "plc", "me", "gouv", "asso"]);

/** The registered domain of a host: api.example.co.uk → example.co.uk (good enough without the public suffix list). */
export function registeredDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1])) return labels.join(".");
  const sld = labels[labels.length - 2];
  return labels.slice(SECOND_LEVEL.has(sld) && labels[labels.length - 1].length === 2 ? -3 : -2).join(".");
}

export function domainTarget(m: Pick<Monitor, "type" | "target"> & { domainName: string }): string | null {
  if (m.domainName) return m.domainName;
  let host = "";
  if (m.type === "http") {
    try {
      host = new URL(m.target).hostname;
    } catch {
      return null;
    }
  } else if (m.type === "tcp") host = m.target.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!host || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return null;
  return registeredDomain(host);
}

/** IANA's list of each TLD's RDAP server, cached for a week. */
async function rdapBase(tld: string): Promise<string | null> {
  const cached = await first<{ value: string }>("SELECT value FROM kv WHERE key = 'rdap-bootstrap'");
  let data: { at: number; services: [string[], string[]][] } | null = cached ? JSON.parse(cached.value) : null;
  if (!data || Date.now() - data.at > 7 * DAY) {
    const res = await fetch("https://data.iana.org/rdap/dns.json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`IANA answered ${res.status}`);
    data = { at: Date.now(), services: ((await res.json()) as { services: [string[], string[]][] }).services };
    await run("INSERT INTO kv (key, value) VALUES ('rdap-bootstrap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(data));
  }
  const service = data.services.find(([tlds]) => tlds.includes(tld));
  return service?.[1].find((u) => u.startsWith("https://")) ?? service?.[1][0] ?? null;
}

async function checkDomain(domain: string): Promise<Omit<Expiry, "monitorId" | "kind" | "checkedAt" | "stage">> {
  const none = { name: domain, expiresAt: null, issuedAt: null, issuer: "", source: "rdap" };
  try {
    const base = await rdapBase(domain.split(".").pop()!);
    if (!base) return { ...none, error: "This domain's registry has no RDAP service" };
    const res = await fetch(`${base.replace(/\/?$/, "/")}domain/${encodeURIComponent(domain)}`, {
      headers: { "user-agent": UA, accept: "application/rdap+json, application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 404) return { ...none, error: "The registry doesn't know this domain" };
    if (!res.ok) return { ...none, error: `The registry answered ${res.status}` };
    const data = (await res.json()) as {
      events?: { eventAction: string; eventDate: string }[];
      entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[];
    };
    const when = (action: string) => {
      const d = data.events?.find((e) => e.eventAction === action)?.eventDate;
      return d ? Date.parse(d) : null;
    };
    const registrar = data.entities?.find((e) => e.roles?.includes("registrar"))?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3] ?? "";
    const expiresAt = when("expiration");
    return { ...none, expiresAt, issuedAt: when("registration"), issuer: String(registrar).slice(0, 200), error: expiresAt ? "" : "The registry doesn't publish an expiry date" };
  } catch (e) {
    return { ...none, error: (e as Error).message.slice(0, 300) };
  }
}

// --- Watching ---

export type ExpiryMonitor = Monitor;

/** How bad it is: expired, within 3 days, within the warning days, or fine. */
export function stageOf(expiresAt: number | null, warnDays: number, now = Date.now()): string {
  if (expiresAt === null) return "";
  const days = (expiresAt - now) / DAY;
  if (days <= 0) return "expired";
  if (days <= Math.min(3, warnDays)) return "urgent";
  if (days <= warnDays) return "warn";
  return "";
}

const RANK: Record<string, number> = { "": 0, warn: 1, urgent: 2, expired: 3 };

/** A warning to send: the expiry got into a worse stage than the last one sent. */
export interface ExpiryNotice {
  monitor: ExpiryMonitor;
  expiry: Expiry;
}

/** Checks a monitor's certificate and/or domain; returns the warnings to send. */
export async function checkExpiries(m: ExpiryMonitor, kinds: ExpiryKind[] = ["certificate", "domain"]): Promise<ExpiryNotice[]> {
  const out: ExpiryNotice[] = [];
  const now = Date.now();
  for (const kind of kinds) {
    const wanted = kind === "certificate" ? m.certCheck && certificateTarget(m) : m.domainCheck && domainTarget(m);
    if (!wanted) {
      await run("DELETE FROM expiries WHERE monitor_id = ? AND kind = ?", m.id, kind);
      continue;
    }
    const target = kind === "certificate" ? certificateTarget(m)! : null;
    const found = target ? await checkCertificate(target.host, target.port) : await checkDomain(domainTarget(m)!);
    const old = await first<Expiry>("SELECT * FROM expiries WHERE monitor_id = ? AND kind = ?", m.id, kind);
    const stage = stageOf(found.expiresAt, m.expiryWarnDays, now);
    // The stage is kept as it is now (lower after a renewal), and a worse one sends a warning.
    // When the check failed, the last known stage stays.
    // A failed check keeps what was last known, with the error.
    const known = found.expiresAt === null && old?.expiresAt && old.name === found.name ? { ...found, expiresAt: old.expiresAt, issuedAt: old.issuedAt, issuer: old.issuer, source: old.source } : found;
    const row: Expiry = { monitorId: m.id, kind, ...known, checkedAt: now, stage: found.expiresAt === null ? (old?.stage ?? "") : stage };
    await run(
      `INSERT INTO expiries (monitor_id, kind, name, expires_at, issued_at, issuer, source, error, checked_at, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (monitor_id, kind) DO UPDATE SET name = excluded.name, expires_at = excluded.expires_at, issued_at = excluded.issued_at, issuer = excluded.issuer,
         source = excluded.source, error = excluded.error, checked_at = excluded.checked_at, stage = excluded.stage`,
      m.id,
      kind,
      row.name,
      row.expiresAt,
      row.issuedAt,
      row.issuer,
      row.source,
      row.error,
      now,
      row.stage,
    );
    if (found.expiresAt !== null && RANK[stage] > RANK[old?.stage ?? ""]) out.push({ monitor: m, expiry: row });
  }
  return out;
}

/** Certificates every 12 hours, domains every day: a few monitors per run, oldest first. */
export async function dueExpiries(limit: number, now = Date.now()): Promise<{ monitor: ExpiryMonitor; kinds: ExpiryKind[] }[]> {
  const rows = await all<ExpiryMonitor & { certAt: number | null; domainAt: number | null }>(
    `SELECT m.*, c.checked_at AS cert_at, d.checked_at AS domain_at FROM monitors m
     LEFT JOIN expiries c ON c.monitor_id = m.id AND c.kind = 'certificate'
     LEFT JOIN expiries d ON d.monitor_id = m.id AND d.kind = 'domain'
     WHERE m.paused = 0 AND ((m.cert_check = 1 AND (c.checked_at IS NULL OR c.checked_at < ?)) OR (m.domain_check = 1 AND (d.checked_at IS NULL OR d.checked_at < ?)))
     ORDER BY min(coalesce(c.checked_at, 0), coalesce(d.checked_at, 0)) LIMIT ?`,
    now - 12 * 60 * 60_000,
    now - DAY,
    limit,
  );
  return rows.map(({ certAt, domainAt, ...m }) => ({
    monitor: m,
    kinds: [
      ...(m.certCheck && (certAt === null || certAt < now - 12 * 60 * 60_000) ? (["certificate"] as const) : []),
      ...(m.domainCheck && (domainAt === null || domainAt < now - DAY) ? (["domain"] as const) : []),
    ],
  }));
}

export async function expiriesOf(ids: number[]): Promise<Map<number, Expiry[]>> {
  const out = new Map<number, Expiry[]>();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    for (const e of await all<Expiry>(`SELECT * FROM expiries WHERE monitor_id IN (${chunk.map(() => "?").join(",")})`, ...chunk)) {
      out.set(e.monitorId, [...(out.get(e.monitorId) ?? []), e]);
    }
  }
  return out;
}
