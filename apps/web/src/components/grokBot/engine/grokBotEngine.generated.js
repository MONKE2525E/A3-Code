// @ts-nocheck -- generated, minified third-party code
/* eslint-disable -- generated, minified third-party code */
// Extracted from the installed Grok Bot 0.68.1 renderer (Motion Lab engine). Proprietary to its
// authors; kept in this private fork only, never submitted upstream.
import * as k from "react";
import * as M from "react/jsx-runtime";
function Oe(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e);
}
const xt = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule(e, t, n) {
    Pp(e);
    let r = !0;
    const s = globalThis.setTimeout(() => {
      r && ((r = !1), t());
    }, e);
    return (
      n?.keepEventLoopAlive !== !0 && Ep(s) && s.unref(),
      {
        dispose() {
          r && ((r = !1), globalThis.clearTimeout(s));
        },
      }
    );
  },
};
function Ep(e) {
  return typeof e == "object" && e !== null && "unref" in e && typeof e.unref == "function";
}
function Pp(e) {
  if (!Number.isFinite(e) || e < 0)
    throw new RangeError("delayMs must be a finite non-negative number");
}
function PI(e) {
  (rn(e.name), Zt(e.delayMs, "delayMs"));
  const t = e.clock ?? xt,
    n = (r) => {
      const s = eo();
      return Object.assign(
        (...o) => {
          s.current.state !== "disposed" &&
            s.arm(
              t.schedule(e.delayMs, () => {
                (s.fired(), r(...o));
              }),
            );
        },
        {
          dispose() {
            s.dispose();
          },
        },
      );
    };
  return { name: e.name, wrap: n };
}
function eo() {
  let e = { state: "running" };
  return {
    get current() {
      return e;
    },
    arm(t) {
      if (e.state === "disposed") {
        t.dispose();
        return;
      }
      (e.state === "armed" && e.handle.dispose(), (e = { state: "armed", handle: t }));
    },
    fired() {
      e.state === "armed" && (e = { state: "running" });
    },
    dispose() {
      return e.state === "disposed"
        ? !1
        : (e.state === "armed" && e.handle.dispose(), (e = { state: "disposed" }), !0);
    },
  };
}
const Np = /^[a-z0-9]+([-.][a-z0-9]+)*$/;
function rn(e) {
  if (!Np.test(e))
    throw new TypeError(
      `name must be lowercase segments joined by "-" or ".", got ${JSON.stringify(e)}`,
    );
}
function Zt(e, t) {
  if (!Number.isFinite(e) || e < 0)
    throw new RangeError(`${t} must be a finite non-negative number`);
}
const xs = { status: "loading" };
function u2(e, t) {
  const n = new Map(e.map((o) => [o.name, [...o.dependencies].sort()])),
    r = [],
    s = (o) => {
      const i = r.indexOf(o);
      if (i !== -1) return [...r.slice(i), o];
      r.push(o);
      for (const a of n.get(o) ?? []) {
        if (t.has(a)) continue;
        const c = s(a);
        if (c != null) return c;
      }
      return (r.pop(), null);
    };
  for (const o of e) {
    const i = s(o.name);
    if (i != null) return i.join(" \u2192 ");
  }
  return e.map((o) => o.name).join(" \u2192 ");
}
function p2({ size: e = 24, title: t = "Bitbucket", variant: n = "monochrome", ...r }) {
  return (
    (p2.d = 1684959642),
    n === "brand"
      ? M.jsxs("svg", {
          xmlns: "http://www.w3.org/2000/svg",
          viewBox: "0 0 18 18",
          width: e,
          height: e,
          role: "img",
          "aria-label": t,
          ...r,
          children: [
            M.jsx("path", {
              d: "M2.1 3.1C2 2.5 2.5 2 3.1 2h11.8c.6 0 1.1.5 1 1.1L14.2 14c-.1.6-.6 1-1.2 1H5c-.6 0-1.1-.4-1.2-1L2.1 3.1Z",
              fill: "#2684FF",
            }),
            M.jsx("path", { d: "M6.7 10.9h4.6l.7-4.1H6l.7 4.1Z", fill: "white" }),
            M.jsx("path", {
              d: "M7.6 13.1h3.2l.5-2.2H6.7l.9 2.2Z",
              fill: "#172B4D",
              fillOpacity: 0.2,
            }),
          ],
        })
      : M.jsx("svg", {
          xmlns: "http://www.w3.org/2000/svg",
          viewBox: "0 0 16 16",
          width: e,
          height: e,
          role: "img",
          "aria-label": t,
          ...r,
          children: M.jsx("path", {
            d: "M1.91733 2C1.65757 2 1.46275 2.23811 1.50604 2.47623L3.25941 13.2129C3.3027 13.4943 3.54083 13.6892 3.82224 13.6892H12.3077C12.5025 13.6892 12.6757 13.5376 12.719 13.3428L14.4939 2.49787C14.5373 2.23811 14.3424 2.02165 14.0827 2.02165L1.91733 2ZM9.36376 9.74947H6.65792L5.94357 5.91804H10.0348L9.36376 9.74947Z",
            fill: "currentColor",
          }),
        })
  );
}
const to = {
  border: {
    k5JduY: "ui-1s928wv",
    kwXMNM: "ui-1j6awrg",
    k3foIR: "ui-1m1drc7",
    kH8aOt: "ui-1unh1gc",
    k8Iv0R: "ui-1xrz1ek",
    kc1e00: "ui-1iygr5g",
    kDVEDD: "ui-itxdhh",
    kUfP38: "ui-1k48kgn",
    kbMawA: "ui-1o7vem3",
    kloYau: "ui-2q1x1w",
    $$css: !0,
  },
};
const p0 = k.createContext(null);
const y0 = new Set(["\u2303", "\u21E7", "\u2325", "\u2318"]);
function x0(e) {
  const [t, n] = e.split("-");
  switch (t) {
    case "top":
    case "right":
    case "bottom":
    case "left":
      return { side: t, alignment: n === "start" || n === "end" ? n : void 0 };
    default:
      throw new Error(`Unsupported floating placement: ${e}`);
  }
}
const Ps = new WeakMap();
function kt(e, t) {
  if (e === t) return !0;
  if (e == null || t == null) return !1;
  const n = Ps.get(e);
  return n != null && n === Ps.get(t);
}
function tn(e) {
  return Ps.get(e) ?? null;
}
function N0(e) {
  return typeof e == "function" ? e : null;
}
const s5 = ["workspace", "overlay"];
function yn(e, t) {
  return Object.fromEntries(e.map((n) => [n, t(n)]));
}
const $r = yn(s5, () => "single");
function ya(e, t = $r) {
  return Object.hasOwn(t, e);
}
function ot(e) {
  return Object.keys(e).filter((t) => ya(t, e));
}
const i5 = Object.freeze({});
const a5 = new WeakMap();
function F0(e) {
  return a5.get(e) ?? i5;
}
const u1 = Symbol("dune.resource-read.unselected");
function p1(e) {
  return ((typeof e == "object" && e != null) || typeof e == "function") && "default" in e
    ? { found: !0, value: e.default }
    : { found: !1 };
}
function y1(e) {
  const t = new Set(e),
    n = (o) => typeof o == "number" && t.has(o),
    r = (o) => (n(o) ? o : void 0),
    s = (o) => {
      const i = e.findLast((a) => a <= o) ?? 0;
      return n(i) ? i : s(0);
    };
  return { parse: r, to: s };
}
function w1(e, t) {
  return e.load().then((n) => {
    const r = N0(typeof n == "object" && n != null && "default" in n ? n.default : void 0);
    if (r == null) throw new TypeError(t());
    return { default: r };
  });
}
function x1(e, t) {
  return () =>
    w1(
      t,
      () =>
        `Entrypoint "${e.id}" layout module must default-export a component; the entrypoint error boundary owns this failure`,
    );
}
const S1 = 50;
const Ta = Object.freeze([]);
function Ea(e) {
  return `history-${e}`;
}
function Y7(e) {
  return Array.isArray(e);
}
function Pe(e) {
  return Y7(e) ? e : e == null ? [] : [e];
}
function Cs(e, t) {
  if (e[t] !== "stack")
    throw new TypeError(
      `Slot "${t}" is a single slot; push and pop need a stack slot declared with declareSurfaces`,
    );
}
function M1(e, t) {
  const n = Pe(e),
    r = Pe(t);
  return n.length === r.length && n.every((s, o) => s === r[o]);
}
function _s(e, t) {
  const n = Pe(e),
    r = Pe(t);
  return n.length === r.length && n.every((s, o) => kt(s, r[o] ?? null));
}
function Z7(e, t) {
  return e === "stack" ? { committed: Pe(t), pending: null } : { committed: t, pending: null };
}
function br(e, t, n) {
  return { ...e, [t]: n };
}
function Pa(e, t) {
  return yn(ot(t), (n) => e[n].committed);
}
function T1(e, t, n) {
  return ot(n).every((r) => _s(e[r], t[r]));
}
function Q7(e, t) {
  return e.length === t.length && e.every((n, r) => n === t[r]);
}
function J7({ shown: e, next: t, recent: n, retain: r }) {
  if (r === 0) return Ta;
  const s = new Set();
  for (const i of t) {
    const a = tn(i);
    a != null && s.add(a);
  }
  const o = [];
  for (const i of [...e].reverse().concat(n)) {
    if (o.length === r) break;
    const a = tn(i);
    a == null || s.has(a) || (s.add(a), o.push(i));
  }
  return Q7(o, n) ? n : o;
}
function E1(e, t) {
  const n = F0(e.kinds),
    r = new Map();
  for (const s of ot(e.kinds)) {
    const o = e.surfaces[s].committed,
      i = t[s].committed;
    if (o === i) continue;
    const a = J7({ shown: Pe(o), next: Pe(i), recent: e.recent[s], retain: n[s] ?? 0 });
    a !== e.recent[s] && r.set(s, a);
  }
  return r.size === 0 ? e.recent : { ...e.recent, ...Object.fromEntries(r) };
}
function ey(e, t, n) {
  const r = e.entries[e.index];
  if (r == null || ot(n).every((i) => r[i] === t[i])) return e;
  const o = [...e.entries];
  return ((o[e.index] = { key: r.key, ...t }), { entries: o, index: e.index });
}
function ty(e, t, n) {
  const { history: r, nextHistoryKey: s, kinds: o } = e,
    i = r.entries[r.index];
  if (n === "replace" || (i != null && T1(i, t, o)))
    return { history: ey(r, t, o), nextHistoryKey: s };
  const a = { key: Ea(s), ...t },
    c = [...r.entries.slice(0, r.index + 1), a].slice(-S1);
  return { history: { entries: c, index: c.length - 1 }, nextHistoryKey: s + 1 };
}
function Wr(e, t, n, r, s = e) {
  const o = br(e.surfaces, t, { committed: n, pending: null }),
    i = s === e ? e : { ...e, surfaces: br(e.surfaces, t, s.surfaces[t]), history: s.history };
  return { ...e, surfaces: o, recent: E1(i, o), ...ty(i, Pa(o, e.kinds), r) };
}
function ny(e, { count: t, index: n }) {
  const r = e.index + 1,
    s = Math.max(0, S1 - r),
    o = Math.max(0, Math.min(t - s, n));
  return { start: o, end: Math.min(t, o + s), target: r + n - o };
}
function ry(e, t, n) {
  const { history: r, nextHistoryKey: s } = e,
    o = r.entries.slice(0, r.index + 1),
    { start: i, end: a, target: c } = ny(r, { count: t.length, index: n }),
    u = t.slice(i, a).map((d, h) => ({ ...d, key: Ea(s + h) }));
  if (u.length === 0) return { history: r, nextHistoryKey: s };
  const l = [...o, ...u];
  return {
    history: { entries: l, index: Math.min(c, l.length - 1) },
    nextHistoryKey: s + u.length,
  };
}
function sy(e, t, n) {
  let r = e;
  for (const s of ot(n)) {
    const o = e[s];
    (o.committed === t[s] && o.pending == null) ||
      (r = br(r, s, { committed: t[s], pending: null }));
  }
  return r;
}
function Rs(e, t) {
  const { surfaces: n, history: r, kinds: s } = e;
  switch (t.kind) {
    case "open-pending": {
      const o = t.link.surface;
      return {
        ...e,
        surfaces: br(n, o, {
          committed: n[o].committed,
          pending: { link: t.link, ticket: t.ticket },
        }),
      };
    }
    case "cancel-pending": {
      const o = n[t.surface];
      return o.pending == null
        ? e
        : { ...e, surfaces: br(n, t.surface, { committed: o.committed, pending: null }) };
    }
    case "open": {
      const o = t.link.surface,
        i = n[o],
        a = s[o] === "stack" ? [t.link] : t.link;
      return M1(i.committed, a) && i.pending == null ? e : Wr(e, o, a, t.history);
    }
    case "push": {
      const o = t.link.surface;
      Cs(s, o);
      const i = Pe(n[o].committed);
      return Wr(e, o, [...i, t.link], t.history);
    }
    case "pop": {
      const o = t.link.surface;
      Cs(s, o);
      const i = t.from ?? e,
        a = n[o],
        c = Pe(i.surfaces[o].committed);
      if (c.at(-1) !== t.link) return e;
      const u = e.idle[o];
      if (_s(a.committed, u) && a.pending == null) return e;
      const l = c.length > 1 ? c.slice(0, -1) : u;
      return Wr(e, o, l, t.history, i);
    }
    case "close": {
      const o = n[t.surface],
        i = e.idle[t.surface];
      return _s(o.committed, i) && o.pending == null ? e : Wr(e, t.surface, i, t.history, t.from);
    }
    case "present": {
      const o = t.history.entries[t.history.index];
      if (o == null) return e;
      const i = t.from ?? e,
        a = sy(i.surfaces, o, s);
      return a === n && t.history === r
        ? e
        : { ...e, surfaces: a, recent: E1(i, a), history: t.history };
    }
    case "prune-history":
      return t.history === r ? e : { ...e, history: t.history };
    case "install-history":
      return t.entries.length === 0 ? e : { ...e, ...ry(e, t.entries, t.index) };
    case "forget-recent": {
      const o = ot(s);
      return o.every((i) => e.recent[i].length === 0) ? e : { ...e, recent: yn(o, () => Ta) };
    }
    default: {
      const o = t;
      throw new TypeError(`Unknown navigation command ${String(o)}`);
    }
  }
}
function P1(e, t) {
  return yn(ot(t), (n) => e[n].pending != null);
}
function Oi(e, t = null) {
  const { surfaces: n, kinds: r, recent: s, history: o } = e,
    i = ot(r),
    a = P1(n, r),
    c = t != null && i.every((u) => t.pending[u] === a[u]) ? t.pending : a;
  return t != null &&
    t.pending === c &&
    t.recent === s &&
    t.history === o &&
    i.every((u) => t[u] === n[u].committed)
    ? t
    : {
        ...Pa(n, r),
        recent: s,
        pending: c,
        history: o,
        canGoBack: o.index > 0,
        canGoForward: o.index < o.entries.length - 1,
      };
}
function oy(e, t) {
  switch (t.kind) {
    case "open":
      return t.history === "replace" ? ["dune:replace"] : ["dune:open"];
    case "push":
      return t.history === "replace" ? ["dune:replace"] : ["dune:open"];
    case "pop":
      return ["dune:close"];
    case "present":
      return t.history.index < e.history.index
        ? ["dune:back"]
        : t.history.index > e.history.index
          ? ["dune:forward"]
          : [];
    case "close":
      return ["dune:close"];
    case "open-pending":
    case "cancel-pending":
    case "prune-history":
    case "install-history":
    case "forget-recent":
      return [];
    default: {
      const n = t;
      throw new TypeError(`Unknown navigation command ${String(n)}`);
    }
  }
}
function iy(e, t, n) {
  const r = (a) => !_s(e.surfaces[a].committed, n.surfaces[a].committed),
    s = r("workspace"),
    o = r("overlay");
  if (!s && !o) return [];
  const i = oy(e, t);
  return s && o ? i : [...i, s ? "dune:workspace-only" : "dune:overlay-only"];
}
function ay(e, t = $r) {
  const n = ot(t),
    r = yn(n, (c) => Z7(t[c], e?.[c] ?? null)),
    s = Pa(r, t);
  let o = {
      surfaces: r,
      recent: yn(n, () => Ta),
      history: { entries: [{ key: Ea(0), ...s }], index: 0 },
      nextHistoryKey: 1,
      idle: s,
      kinds: t,
    },
    i = Oi(o);
  const a = new Set();
  return {
    getState: () => i,
    getCanonicalSnapshot: () => o,
    dispatch(c, u = "default") {
      const l = Rs(o, c);
      if (l === o) return;
      const d =
        u === "transition"
          ? { kind: "transition", types: iy(o, c, l) }
          : { kind: "default", command: c };
      ((o = l), (i = Oi(o, i)));
      for (const h of [...a]) h(d);
    },
    subscribe(c) {
      return (
        a.add(c),
        () => {
          a.delete(c);
        }
      );
    },
  };
}
const cy = Object.create(null);
function dy(e) {
  const t = e.params;
  if (!Oe(t)) return null;
  const { tilesetId: n } = t;
  return typeof n == "string" ? n : null;
}
function py(e, t, n) {
  let r = null,
    s = null,
    o = !1,
    i = null;
  const a = () => (
      r == null &&
        ((r = t()),
        r.then(
          (l) => {
            s = l;
          },
          () => {
            o = !0;
          },
        )),
      r
    ),
    c = k.lazy(a),
    u = () => {
      try {
        return a().then(
          () => {},
          () => {},
        );
      } catch {
        return Promise.resolve();
      }
    };
  return {
    attemptKey: e.attemptKey,
    get Component() {
      return ((i ??= s == null ? c : s.default), i);
    },
    settled() {
      const l = s != null || o,
        d = n.now();
      return u().then(() => {
        n.record({
          startMs: d,
          durationMs: n.now() - d,
          detail: { kind: "settle", entrypointId: e.entrypointId, chunk: e.chunk, cached: l },
        });
      });
    },
    loadFailed: () => o,
  };
}
function by(e, t) {
  const n = e.entrypoints.find((r) => r.surface === t && r.index === !0);
  return n == null ? null : n.handle.link(void 0);
}
const Y1 = {
  black: { light: "#000000", dark: "#FFFFFF" },
  brown: { light: "#A27952", dark: "#855C36" },
  red: { light: "#FF3E51", dark: "#E02135" },
  orange: { light: "#FF781C", dark: "#FF6700" },
  yellow: { light: "#FFAF38", dark: "#FF9800" },
  green: { light: "#00C972", dark: "#009957" },
  cyan: { light: "#1CC3B0", dark: "#00A592" },
  blue: { light: "#2A92FE", dark: "#0E74E0" },
  violet: { light: "#A97EFE", dark: "#804EE0" },
  magenta: { light: "#FF5EB1", dark: "#E02A88" },
  gray: { light: "#959595", dark: "#777777" },
};
function N_(e) {
  const t = Y1[e];
  return `light-dark(${t.light}, ${t.dark})`;
}
function F_(e, t) {
  return Y1[e][t];
}
const hs = (e) => ({ x: e, v: 0, t: e });
const fs = (e, t, n, r) => {
  ((e.v += (-2 * n * t * e.v - t * t * (e.x - e.t)) * r),
    (e.x += e.v * r),
    (!Number.isFinite(e.x) || !Number.isFinite(e.v)) && ((e.x = e.t), (e.v = 0)));
};
const nk = 1 / 120;
const Z1 = (e) => Math.max(1, Math.ceil(e / nk));
const de = (e, t, n) => Math.min(n, Math.max(t, e));
const Fs = (e) => (e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2);
const Ge = (e) => 1 - Math.pow(1 - e, 3);
const io = (e) => 1 + 2.70158 * Math.pow(e - 1, 3) + 1.70158 * Math.pow(e - 1, 2);
const rk = (e) => e * e * (3 - 2 * e);
const Gn = [0.42, 0, 0.58, 1];
const sk = [0.4, 0.06, 0.18, 1];
const ok = 0.28;
const Li = 0.35;
const Ni = 0.26;
const ik = 4.25 / 60;
const ak = 2 / 60;
const Bo = 1.06;
function Pu(e, t, n) {
  const r = 1 - e;
  return 3 * r * r * e * t + 3 * r * e * e * n + e * e * e;
}
function ck(e, t, n) {
  const r = 1 - e;
  return 3 * r * r * t + 6 * r * e * (n - t) + 3 * e * e * (1 - n);
}
function Ca(e, t) {
  const [n, r, s, o] = t;
  let i = e;
  for (let a = 0; a < 8; a++) {
    const c = Pu(i, n, s) - e,
      u = ck(i, n, s);
    if (Math.abs(c) < 1e-6 || Math.abs(u) < 1e-6) break;
    i = Math.min(1, Math.max(0, i - c / u));
  }
  return Pu(i, r, o);
}
function js(e) {
  const t = Math.min(1, Math.max(0, e));
  return t * t * (3 - 2 * t);
}
function Ho(e, t) {
  const r = Math.min(0.28, (e ? ak : ik) / Math.max(t, 0.05)),
    s = (1 - r) * 0.42;
  return { u1: s, u2: s + r };
}
function uk(e) {
  const t = Math.min(1, Math.max(0, e));
  if (t < 0.7) {
    const n = t / 0.7;
    return (1 - (1 - n) * (1 - n)) * Bo;
  }
  return Bo + (1 - Bo) * js((t - 0.7) / 0.3);
}
function lk(e, { u1: t, u2: n }) {
  return e < t ? js(e / t) : e <= n ? 1 : 1 - js((e - n) / Math.max(1e-6, 1 - n));
}
const hn = Math.PI / 180;
function Fi(e, t) {
  return [
    e[0] * t[0] - e[1] * t[1] - e[2] * t[2] - e[3] * t[3],
    e[0] * t[1] + e[1] * t[0] + e[2] * t[3] - e[3] * t[2],
    e[0] * t[2] - e[1] * t[3] + e[2] * t[0] + e[3] * t[1],
    e[0] * t[3] + e[1] * t[2] - e[2] * t[1] + e[3] * t[0],
  ];
}
function ps(e, t) {
  const n = Math.sin(t / 2);
  return [Math.cos(t / 2), e[0] * n, e[1] * n, e[2] * n];
}
function dk(e) {
  const t = Math.hypot(e[0], e[1], e[2], e[3]) || 1;
  return [e[0] / t, e[1] / t, e[2] / t, e[3] / t];
}
function hk(e, t) {
  const n = 1 + (e[0] * t[0] + e[1] * t[1] + e[2] * t[2]);
  return dk([n, e[1] * t[2] - e[2] * t[1], e[2] * t[0] - e[0] * t[2], e[0] * t[1] - e[1] * t[0]]);
}
function Xn(e) {
  const [t, n, r, s] = e;
  return [
    1 - 2 * (r * r + s * s),
    2 * (n * r - t * s),
    2 * (n * s + t * r),
    2 * (n * r + t * s),
    1 - 2 * (n * n + s * s),
    2 * (r * s - t * n),
    2 * (n * s - t * r),
    2 * (r * s + t * n),
    1 - 2 * (n * n + r * r),
  ];
}
function fk(e, t, n) {
  return Fi(ps([0, 0, 1], n), Fi(ps([0, 1, 0], t), ps([1, 0, 0], e)));
}
function Q1(e) {
  const t = e[0],
    n = e[3],
    r = e[5],
    s = e[4],
    o = e[6],
    i = e[7],
    a = e[8],
    c = Math.max(-1, Math.min(1, -o)),
    u = Math.asin(c);
  return Math.abs(c) > 0.999999
    ? [Math.atan2(-r, s), u, 0]
    : [Math.atan2(i, a), u, Math.atan2(n, t)];
}
function pk(e) {
  return Q1(Xn(e));
}
function wt(e, t) {
  return [
    e[0] * t[0] + e[1] * t[1] + e[2] * t[2],
    e[3] * t[0] + e[4] * t[1] + e[5] * t[2],
    e[6] * t[0] + e[7] * t[1] + e[8] * t[2],
  ];
}
const Iu = 0.1305;
const _a = [
  { A: [0.01722, 0.45638, 0.88962], B: [0.186, 0.20949, 0.95996], N: [0.82924, 0.4906, -0.26773] },
  {
    A: [0.48863, 0.67924, 0.54762],
    B: [0.65674, 0.43195, 0.61815],
    N: [0.60389, 0.18972, -0.77416],
  },
];
function zs(e) {
  const t = Math.hypot(e[0], e[1], e[2]) || 1;
  return [e[0] / t, e[1] / t, e[2] / t];
}
const mk = (() => {
  let e = [0, 0, 0];
  for (const { A: t, B: n } of _a) {
    const r = zs([t[0] + n[0], t[1] + n[1], t[2] + n[2]]);
    e = [e[0] + r[0], e[1] + r[1], e[2] + r[2]];
  }
  return zs(e);
})();
const cr = (() => {
  const e = hk(mk, [0, 0, 1]),
    t = Xn(e);
  let n = 0,
    r = 0;
  for (const { A: i, B: a } of _a) {
    const c = wt(t, [a[0] - i[0], a[1] - i[1], a[2] - i[2]]);
    ((n += c[0]), (r += c[1]));
  }
  const s = Math.atan2(r, n),
    o = ((((Math.PI / 2 - s + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2;
  return Fi(ps([0, 0, 1], o), e);
})();
const gk = (() => {
  const e = Xn(cr);
  return _a.map(({ A: t, B: n, N: r }) => ({ A: wt(e, t), B: wt(e, n), N: wt(e, r) }));
})();
const yk = [cr[0], -cr[1], -cr[2], -cr[3]];
const J1 = (() => {
  const e = ({ A: r, B: s }) => {
      const o = zs([r[0] + s[0], r[1] + s[1], r[2] + s[2]]),
        i = s[0] * o[0] + s[1] * o[1] + s[2] * o[2];
      let a = zs([s[0] - i * o[0], s[1] - i * o[1], s[2] - i * o[2]]);
      a[1] < 0 && (a = [-a[0], -a[1], -a[2]]);
      let c = [o[1] * a[2] - o[2] * a[1], o[2] * a[0] - o[0] * a[2], o[0] * a[1] - o[1] * a[0]];
      return (c[0] * o[0] < 0 && (c = [-c[0], -c[1], -c[2]]), { M: o, T: a, C: c });
    },
    [t, n] = gk;
  if (t == null || n == null) throw new Error("Motion Lab defines exactly two eye capsules");
  return [e(t), e(n)];
})();
const kk = [
  "sphere",
  "cloud",
  "square",
  "sparkle",
  "clover",
  "heartChubby",
  "starFlower",
  "teardrop",
  "tablet",
  "wedge",
  "house",
  "star6",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "shield",
  "dome",
  "arch",
  "leaf",
];
const wk = [
  "neutral",
  "happy",
  "surprised",
  "sad",
  "sleepy",
  "squinted",
  "calm",
  "inspecting",
  "confused",
];
const ur = 0.26;
const bk = 21;
const xk = 18;
const vk = new Map([
  ["thinking", "sad"],
  ["strange", "inspecting"],
  ["angry", "neutral"],
  ["inspect", "inspecting"],
  ["squint", "squinted"],
  ["idle", "neutral"],
  ["smile", "happy"],
  ["sleep", "sleepy"],
]);
const Sk = new Set(["sad", "happy", "confused", "squinted", "sleepy"]);
function Ur(e, t) {
  return [e[t * 6], e[t * 6 + 1]];
}
function Kr(e, t, n) {
  const r = n ? 4 : 2;
  return [e[t * 6] + e[t * 6 + r], e[t * 6 + 1] + e[t * 6 + r + 1]];
}
function eh(e) {
  const t = (bk + 1) >> 1,
    n = [],
    r = (s, o, i, a, c) => {
      for (let u = c; u < t; u++) {
        const l = u / (t - 1),
          d = 1 - l,
          h = d * d * d,
          f = 3 * d * d * l,
          p = 3 * d * l * l,
          m = l * l * l;
        n.push([
          h * s[0] + f * o[0] + p * i[0] + m * a[0],
          h * s[1] + f * o[1] + p * i[1] + m * a[1],
        ]);
      }
    };
  return (
    r(Ur(e, 0), Kr(e, 0, !0), Kr(e, 1, !1), Ur(e, 1), 0),
    r(Ur(e, 1), Kr(e, 1, !0), Kr(e, 2, !1), Ur(e, 2), 1),
    n
  );
}
function Mk({ p0: e, p1: t, p2: n, isArc: r }) {
  const [s, o] = e,
    [i, a] = t,
    [c, u] = n,
    l = new Array(xk).fill(0),
    d = (y, w) => {
      ((l[y * 6] = w[0]), (l[y * 6 + 1] = w[1]));
    },
    h = (y, w) => {
      ((l[y * 6 + 2] = w[0] - l[y * 6]), (l[y * 6 + 3] = w[1] - l[y * 6 + 1]));
    },
    f = (y, w) => {
      ((l[y * 6 + 4] = w[0] - l[y * 6]), (l[y * 6 + 5] = w[1] - l[y * 6 + 1]));
    };
  if (r) {
    const y = 2 * (s * (a - u) + i * (u - o) + c * (o - a));
    if (Math.abs(y) > 1e-9) {
      const S = s * s + o * o,
        v = i * i + a * a,
        x = c * c + u * u,
        E = (S * (a - u) + v * (u - o) + x * (o - a)) / y,
        A = (S * (c - i) + v * (s - c) + x * (i - s)) / y,
        j = Math.hypot(s - E, o - A),
        F = Math.atan2(o - A, s - E),
        O = Math.atan2(u - A, c - E),
        L = Math.atan2(a - A, i - E),
        T = Math.PI * 2,
        I = (O - F + T) % T,
        R = (L - F + T) % T <= I ? I : I - T,
        U = (K) => [E + j * Math.cos(K), A + j * Math.sin(K)],
        W = (K) => [-Math.sin(K), Math.cos(K)],
        G = R / 2,
        J = (4 / 3) * Math.tan(G / 4) * j,
        ye = [F, F + G, F + R];
      for (let K = 0; K < 3; K++) {
        const ae = U(ye[K]),
          ee = W(ye[K]);
        (d(K, ae),
          K > 0 && h(K, [ae[0] - J * ee[0], ae[1] - J * ee[1]]),
          K < 2 && f(K, [ae[0] + J * ee[0], ae[1] + J * ee[1]]));
      }
      return l;
    }
    const w = [(s + c) / 2, (o + u) / 2];
    return (
      d(0, [s, o]),
      d(1, w),
      d(2, [c, u]),
      f(0, [s + (w[0] - s) / 3, o + (w[1] - o) / 3]),
      h(1, [w[0] - (w[0] - s) / 3, w[1] - (w[1] - o) / 3]),
      f(1, [w[0] + (c - w[0]) / 3, w[1] + (u - w[1]) / 3]),
      h(2, [c - (c - w[0]) / 3, u - (u - w[1]) / 3]),
      l
    );
  }
  const p = [(s + i) / 2, (o + a) / 2],
    m = [(i + c) / 2, (a + u) / 2],
    g = [(p[0] + m[0]) / 2, (p[1] + m[1]) / 2];
  return (
    d(0, [s, o]),
    d(1, g),
    d(2, [c, u]),
    f(0, [s + (2 / 3) * (p[0] - s), o + (2 / 3) * (p[1] - o)]),
    h(1, [g[0] + (2 / 3) * (p[0] - g[0]), g[1] + (2 / 3) * (p[1] - g[1])]),
    f(1, [g[0] + (2 / 3) * (m[0] - g[0]), g[1] + (2 / 3) * (m[1] - g[1])]),
    h(2, [c + (2 / 3) * (m[0] - c), u + (2 / 3) * (m[1] - u)]),
    l
  );
}
function pr(e, t, n, r, s) {
  const o = Mk(r);
  return {
    off: e,
    tilt: t,
    wid: n,
    lidY: 1,
    oval: s,
    ovalMix: 0,
    pts: eh(o),
    path: o,
    fillRing: null,
  };
}
function Ra(e, t, n, r, s) {
  const o = Math.max(0, (t - e) / 2),
    i = (n * Math.PI) / 180,
    a = Math.sin(i) * o,
    c = Math.cos(i) * o;
  return pr(r, s, e / 2, { p0: [-a, -c], p1: [0, 0], p2: [a, c], isArc: !1 }, [0, 0]);
}
function En(e, t, n, r) {
  return Ra(e, t, n, [r, 0], 0);
}
function Tk(e, t, n) {
  const r = { p0: [-e, 0], p1: [0, 0], p2: [e, 0], isArc: !1 };
  return pr([n, 0], 0, t, r, [e, t]);
}
function zt(e) {
  return [e, e];
}
const ln = {
  neutral: zt(En(ur, 0.57, 0, 0)),
  happy: zt(
    pr(
      [0.03, 0.03],
      0,
      Iu,
      { p0: [0.16, -0.04], p1: [0, 0.12], p2: [-0.16, -0.04], isArc: !0 },
      [0, 0],
    ),
  ),
  surprised: zt(En(0.42, 0.86, 0, 0.03)),
  inspecting: [En(0.54, 0.54, 0, 0.04), En(0.27, 0.27, 0, 0.04)],
  sad: zt(En(ur, 0.5, -28, -0.05)),
  sleepy: zt(
    pr(
      [0.01, 0],
      0,
      ur / 2,
      { p0: [-0.11, 0.025], p1: [0, -0.05], p2: [0.11, 0.025], isArc: !1 },
      [0, 0],
    ),
  ),
  squinted: zt(En(ur, 0.5, 90, 0.01)),
  calm: zt(Tk(0.296, 0.247, 0.05)),
  confused: zt(
    pr(
      [-0.1, 0],
      0,
      Iu,
      { p0: [0.01, 0.16], p1: [-0.17, 0], p2: [0.01, -0.16], isArc: !1 },
      [0, 0],
    ),
  ),
};
function Ek(e) {
  return wk.some((t) => t === e);
}
function Pk(e) {
  const t = e.trim().toLowerCase(),
    n = vk.get(t) ?? t;
  return Ek(n) ? n : "neutral";
}
function vr(e) {
  return Sk.has(e);
}
function Ik(e) {
  return !vr(e) && !ln[e].some($t);
}
function Qe(e, t) {
  return [t(e[0], 0), t(e[1], 1)];
}
function ft(e) {
  return { ...e, ovalMix: 0 };
}
function $t(e) {
  return e.oval[0] > 1e-4 && e.oval[1] > 1e-4;
}
function Ds(e) {
  if ($t(e) || e.pts.length < 3) return !1;
  const t = e.pts[0],
    n = e.pts[e.pts.length - 1],
    r = n[0] - t[0],
    s = n[1] - t[1],
    o = r * r + s * s;
  if (o < 1e-8) return !1;
  let i = 0;
  for (const a of e.pts) {
    const c = ((a[0] - t[0]) * r + (a[1] - t[1]) * s) / o,
      u = t[0] + c * r,
      l = t[1] + c * s,
      d = Math.hypot(a[0] - u, a[1] - l);
    d > i && (i = d);
  }
  return i > Math.max(0.012, e.wid * 0.2);
}
const Ak = 0.03;
const $k = 0.6;
const Ck = 0.42;
const _k = 20;
function zn(e, t, n) {
  return e + (t - e) * n;
}
function ms(e, t, n) {
  return [zn(e[0], t[0], n), zn(e[1], t[1], n)];
}
function Au(e, t, n) {
  if (e.length === 0) return [0, 0];
  if (e.length === 1 || n <= 1) return e[0];
  const r = (t / (n - 1)) * (e.length - 1),
    s = Math.min(Math.floor(r), e.length - 2);
  return ms(e[s], e[s + 1], r - s);
}
function Rk(e, t, n) {
  const r = {
    off: ms(e.off, t.off, n),
    tilt: zn(e.tilt, t.tilt, n),
    wid: zn(e.wid, t.wid, n),
    lidY: zn(e.lidY, t.lidY, n),
    oval: ms(e.oval, t.oval, n),
    ovalMix: 0,
    fillRing: null,
  };
  if (e.path && t.path && e.path.length === t.path.length) {
    const i = t.path,
      a = e.path.map((c, u) => zn(c, i[u], n));
    return { ...r, path: a, pts: eh(a) };
  }
  const s = Math.max(e.pts.length, t.pts.length, 2),
    o = [];
  for (let i = 0; i < s; i++) o.push(ms(Au(e.pts, i, s), Au(t.pts, i, s), n));
  return { ...r, path: null, pts: o };
}
function qs(e) {
  if ($t(e)) {
    const [s, o] = e.oval;
    return {
      cx: e.off[0],
      cy: e.off[1],
      ang: s >= o ? Math.PI / 2 : 0,
      halfLen: Math.max(s, o),
      halfW: Math.min(s, o),
    };
  }
  const t = e.wid;
  if (e.pts.length < 2) return { cx: e.off[0], cy: e.off[1], ang: e.tilt, halfLen: t, halfW: t };
  const n = e.pts[0],
    r = e.pts[e.pts.length - 1];
  return {
    cx: e.off[0] + (n[0] + r[0]) / 2,
    cy: e.off[1] + (n[1] + r[1]) / 2,
    ang: Math.atan2(r[0] - n[0], r[1] - n[1]) + e.tilt,
    halfLen: Math.hypot(r[0] - n[0], r[1] - n[1]) / 2 + t,
    halfW: t,
  };
}
function th(e, t) {
  let n = t.ang - e.ang;
  for (; n > Math.PI / 2;) n -= Math.PI;
  for (; n < -Math.PI / 2;) n += Math.PI;
  return n;
}
function Ok(e, t, n) {
  const s = Math.max(0, e - t),
    o = Math.max(0, Math.min(1, n)),
    i = [];
  for (let a = 0; a < 48; a++) {
    const c = (a / 48) * Math.PI * 2,
      u = Math.cos(c),
      l = Math.sin(c),
      d = t * u,
      h = e * l,
      f = t / Math.max(Math.abs(u), 1e-6);
    let p;
    if (f * Math.abs(l) <= s + 1e-6 && Number.isFinite(f)) p = f;
    else {
      const w = (l >= 0 ? 1 : -1) * s * l,
        S = Math.max(0, w * w - s * s + t * t);
      p = w + Math.sqrt(S);
    }
    const m = p * u,
      g = p * l;
    i.push([m + (d - m) * o, g + (h - g) * o]);
  }
  return i;
}
function ji(e, t, n, r) {
  return Ra(Math.max(e, 1e-4), Math.max(t, e), 0, r, n);
}
function Lk(e, t, n) {
  if (n <= 1e-4) return ft(e);
  if (n >= 0.995) return ft(t);
  const r = qs(e),
    s = qs(t),
    o = th(r, s),
    i = $t(t),
    a = i ? 1 - (1 - n) ** 3 : n * n * n,
    c = r.ang + o * n,
    u = Math.max(r.halfLen + (s.halfLen - r.halfLen) * n, 1e-4),
    l = Math.max(r.halfW + (s.halfW - r.halfW) * n, 1e-4),
    d = $t(e) ? 1 : 0,
    h = d + ((i ? 1 : 0) - d) * a,
    f = ji(2 * l, 2 * u, c, [r.cx + (s.cx - r.cx) * n, r.cy + (s.cy - r.cy) * n]),
    p = h > 1e-4;
  return { ...f, oval: p ? [l, u] : f.oval, ovalMix: p ? h : 0, fillRing: Ok(u, l, h) };
}
function Nk(e, t, n) {
  if (n >= 1 - 1e-4) return ft(t);
  const r = qs(e),
    s = qs(t),
    o = r.ang + th(r, s) * n,
    i = Math.max(1e-4, r.halfW + (s.halfW - r.halfW) * n),
    a = Math.max(0, r.halfLen - r.halfW) * (1 - n) + Math.max(0, s.halfLen - s.halfW) * n,
    c = [r.cx + (s.cx - r.cx) * n, r.cy + (s.cy - r.cy) * n];
  return Ra(2 * i, 2 * (a + i), (o * 180) / Math.PI, c, 0);
}
function Fk(e) {
  const t = $t(e);
  if (!(e.wid > 0) && !t) return null;
  const n = e.lidY,
    r = e.tilt * (180 / Math.PI);
  if (t)
    return { width: 2 * e.oval[0], height: 2 * e.oval[1] * n, tilt: r, cx: e.off[0], cy: e.off[1] };
  if (e.pts.length < 2) return null;
  const s = e.pts[0],
    o = e.pts[e.pts.length - 1],
    i = o[0] - s[0],
    a = o[1] - s[1],
    c = Math.hypot(i, a),
    u = 2 * e.wid;
  return {
    width: u,
    height: (c + u) * n,
    tilt: Math.atan2(i, a) * (180 / Math.PI) + r,
    cx: e.off[0] + (s[0] + o[0]) / 2,
    cy: e.off[1] + ((s[1] + o[1]) / 2) * n,
  };
}
function jk(e) {
  const t = Fk(e);
  if (t == null) return { w: ur, h: 0.57, cx: e.off[0], cy: e.off[1] };
  const n = (t.tilt * Math.PI) / 180,
    r = Math.abs(Math.cos(n)),
    s = Math.abs(Math.sin(n));
  return { w: t.width * r + t.height * s, h: t.width * s + t.height * r, cx: t.cx, cy: t.cy };
}
function zk(e, t, n, r) {
  return t >= e ? ji(e, t, 0, [n, r]) : ji(t, e, Math.PI / 2, [n, r]);
}
function $u(e, t) {
  if (t <= 0) return e;
  const n = Math.min(1, t),
    r = jk(e),
    s = Math.max(r.w, 1e-4),
    o = Math.max(r.h, s),
    i = s * Ck;
  return zk(s, o + (i - o) * n, r.cx, r.cy);
}
function Dk(e) {
  return { ...e, wid: 0, oval: [0, 0] };
}
function qk(e) {
  let t, n;
  if ($t(e)) ((t = -e.oval[1]), (n = e.oval[1]));
  else {
    let r = 1e9,
      s = -1e9;
    for (const o of e.pts) (o[1] < r && (r = o[1]), o[1] > s && (s = o[1]));
    ((t = r - e.wid), (n = s + e.wid));
  }
  return t + (1 - $k) * (n - t);
}
function Bk(e) {
  if (e.pts.length < 2) return e;
  const t = e.pts[0],
    n = e.pts[e.pts.length - 1],
    r = n[0] - t[0],
    s = n[1] - t[1];
  if (Math.abs(s) < Math.abs(r)) return e;
  const o = Math.atan2(r, s);
  if (Math.abs(o) < 1e-5) return e;
  const i = Math.cos(o),
    a = Math.sin(o);
  return {
    ...e,
    tilt: e.tilt + o,
    pts: e.pts.map((c) => [c[0] * i - c[1] * a, c[0] * a + c[1] * i]),
  };
}
function Cu(e, t) {
  if (t === 0) return e;
  const n = Bk(e),
    r = Math.max(Ak, 1 - t),
    s = qk(n) * (1 - r),
    o = Math.cos(-n.tilt),
    i = Math.sin(-n.tilt);
  return { ...n, off: [n.off[0] - i * s, n.off[1] + o * s], lidY: n.lidY * r };
}
function Hk(e, t, n, r) {
  if (t < 0.001) return e;
  const s = n.isFollowingTurn ? Math.min(1, Math.max(-1, r / _k)) : n.bias,
    [o, i] = ln.inspecting,
    a = Math.max(1e-4, o.wid),
    c = Math.max(1e-4, i.wid),
    u = (1 + s) / 2,
    l = (d, h) => {
      const f = 1 + (h - 1) * t;
      return { ...ft(d), wid: d.wid * f, pts: d.pts.map((p) => [p[0] * f, p[1] * f]) };
    };
  return [l(e[0], Math.pow(c / a, u)), l(e[1], Math.pow(a / c, u))];
}
function _u(e) {
  return e === "inspecting" ? 1 : 0;
}
function Vk(e, t, n) {
  return !(e.some(Ds) || t.some(Ds)) && (e.some($t) || t.some($t))
    ? "oval"
    : n
      ? "spine"
      : "stadium";
}
function Ru(e) {
  return Ca(Math.min(Math.max(e.t / e.dur, 0), 1), sk);
}
function Gk() {
  let e = "neutral",
    t = Qe(ln.neutral, ft),
    n = 0,
    r = null;
  const s = () => {
      if (r == null) return t;
      if (r.kind === "blink") return r.from;
      if (r.kind === "morph") {
        const g = Math.max(0, Math.min(1, Ru(r))),
          { from: y, to: w, path: S } = r;
        return S === "oval"
          ? Qe(y, (v, x) => Lk(v, w[x], g))
          : S === "spine"
            ? Qe(y, (v, x) => Rk(v, w[x], g))
            : Qe(y, (v, x) => Nk(v, w[x], g));
      }
      const h = Math.min(r.t / r.dur, 1),
        { u1: f, u2: p } = Ho(!1, r.dur);
      if (h < f) return Qe(r.from, (g) => Cu(g, js(h / f)));
      if (h <= p) return Qe(r.to, Dk);
      const m = uk((h - p) / Math.max(1e-6, 1 - p));
      return Qe(r.to, (g) => Cu(g, 1 - m));
    },
    o = () => {
      if (r == null) return n;
      if (r.kind === "blink") return r.fromInspect;
      const h = r.fromInspect,
        f = _u(r.toName);
      if (r.kind === "morph") return h + (f - h) * Ru(r);
      const p = Math.min(r.t / r.dur, 1),
        { u1: m, u2: g } = Ho(!1, r.dur);
      return p <= m ? h : p < g ? 0 : f;
    },
    i = (h) => {
      const f = Qe(s(), ft),
        p = ln[h],
        m = f.some(Ds) || p.some(Ds) || e === "sleepy" || h === "sleepy";
      ((r = {
        kind: "morph",
        path: Vk(f, p, m),
        fromInspect: o(),
        toName: h,
        from: f,
        to: p,
        t: 0,
        dur: ok,
        isHeld: !1,
      }),
        (e = h));
    },
    a = (h) => {
      ((r = {
        kind: "lidMorph",
        fromInspect: o(),
        toName: h,
        from: Qe(s(), ft),
        to: ln[h],
        t: 0,
        dur: Li,
        isHeld: !1,
      }),
        (e = h));
    },
    c = () => {
      (r != null && !r.isHeld) ||
        (r = {
          kind: "blink",
          fromInspect: n,
          toName: e,
          from: Qe(t, ft),
          to: ln[e],
          t: 0,
          dur: Ni,
          isHeld: !1,
        });
    },
    u = (h) => {
      (h.name === e && (r == null || r.toName === h.name)) ||
        (h.isThroughBlink && !vr(h.name) && !vr(e) ? a(h.name) : i(h.name));
    },
    l = (h, f) => {
      f >= h.dur
        ? ((t = Qe(h.to, ft)), (n = _u(h.toName)), (r = null))
        : (r = f < 0 ? null : { ...h, t: f });
    },
    d = (h) => {
      r != null && (r = { ...r, isHeld: h });
    };
  return {
    get name() {
      return e;
    },
    get isMorphing() {
      return r != null && r.kind !== "blink" && !r.isHeld;
    },
    eyes: s,
    inspectWeight: o,
    blinkAmount() {
      if (r?.kind !== "blink" || r.isHeld) return null;
      const h = Math.min(r.t / r.dur, 1);
      return Math.min(1, Math.max(0, lk(h, Ho(!0, r.dur))));
    },
    morph: i,
    lidMorph: a,
    blink: c,
    play: u,
    step(h) {
      r != null && !r.isHeld && l(r, r.t + h);
    },
    release() {
      d(!1);
    },
    seek(h, f) {
      ((e = "neutral"), (t = Qe(ln.neutral, ft)), (n = 0), (r = null));
      let p = 0;
      const m = (g) => {
        r != null && l(r, g - p);
      };
      for (const g of h) {
        if (g.t > f + 1e-9) break;
        (m(g.t), u(g), (p = g.t));
      }
      (m(f), d(!0));
    },
  };
}
const Wk = 0.9;
const Uk = 0.4;
const Kk = 0.62;
const Xk = 0.3;
const Yk = 0.5;
const Zk = 16;
function nh({ poke: e, turns: t }) {
  switch (e) {
    case "spin":
      return Wk + Uk * (t - 1);
    case "bounce":
      return Kk;
    case "nod":
      return Yk;
  }
}
function Qk(e) {
  let t = 0,
    n = 0,
    r = 0,
    s = 1,
    o = 1;
  for (const i of e) {
    const a = Math.min(1, i.t / nh(i));
    switch (i.poke) {
      case "spin":
        n += 180 * i.turns * (1 - Math.cos(Math.PI * a));
        break;
      case "nod":
        t += Zk * Xr(a, 0, 1);
        break;
      case "bounce": {
        const c = Xr(a, 0, 0.18) + Xr(a, 0.82, 1),
          u = Xr(a, 0.18, 0.82);
        ((r += Xk * Math.sin(Math.PI * de((a - 0.14) / 0.72, 0, 1))),
          (s *= 1 + 0.08 * c - 0.04 * u),
          (o *= 1 - 0.1 * c + 0.06 * u));
        break;
      }
    }
  }
  return { pitch: t, yaw: n, lift: r, squash: [s, o] };
}
function Xr(e, t, n) {
  return e <= t || e >= n ? 0 : Math.sin((Math.PI * (e - t)) / (n - t)) ** 2;
}
const Jk = 0.14;
const ew = 0.55;
const tw = { heartChubby: 0.6, wedge: 0.55 };
const nw = 2;
function Ou(e, t, n) {
  const r = e !== "sphere",
    s = tw[e] ?? 1;
  return {
    rx: -(r ? 19 : 14) * s * n,
    ry: (r ? 26 : 18) * s * t,
    px: (r ? 0.07 : 0.03) * t,
    py: (r ? 0.055 : 0.024) * n,
  };
}
function rw(e, t, n = nw) {
  const r = Math.max(e.width, 1) * n,
    s = (o) => Math.max(-1, Math.min(1, o));
  return [s((t.x - (e.left + e.width / 2)) / r), s(-(t.y - (e.top + e.height / 2)) / r)];
}
const sw = {
  thinking: "dots",
  orbit: "orbit",
  radar: "radar",
  progress: "progress",
  spawning: "gather",
  dictating: "wave",
  sending: "send",
  receiving: "receive",
  uploading: "dock",
  bouncing: "ball",
  writing: "pencil",
  alerting: "bang",
  "powering-down": "standby",
};
const ow = Math.PI;
const iw = 0.1;
const aw = 2654435769;
const cw = new Set(["progress", "spawning"]);
const uw = { progress: 2.5, spawning: 2 };
const lw = 1.5;
function Oa(e) {
  let t = e | 0;
  return () => {
    t = (t + 1831565813) | 0;
    let n = Math.imul(t ^ (t >>> 15), t | 1);
    return ((n ^= n + Math.imul(n ^ (n >>> 7), n | 61)), ((n ^ (n >>> 14)) >>> 0) / 4294967296);
  };
}
function La(e) {
  return uw[e] ?? 2.5;
}
function dw(e = {}) {
  const t = e.isReducedMotion ?? !1,
    n = Oa(e.seed ?? aw),
    r = hs(0),
    s = hs(1),
    o = hs(0);
  let i = null,
    a = null,
    c = null,
    u = null,
    l = !1,
    d = 0,
    h = 0,
    f = 1,
    p = !1,
    m = 0,
    g = 0,
    y = 0,
    w = 0,
    S = 0;
  const v = () => {
    const x = i == null ? null : sw[i],
      E = y;
    i !== a && ((a = i), i != null && ((y = m), (l = !1)));
    let A = x != null;
    (i != null &&
      cw.has(i) &&
      (!l && m - y > La(i) ? ((l = !0), (d = m)) : l && m - d > lw && ((l = !1), (y = m)),
      (A = !l)),
      (r.t = A ? 1 : 0),
      x != null &&
        x !== c &&
        (c != null && r.x > 0.02
          ? ((u = c), (w = g), (S = E), (s.x = t ? 1 : 0))
          : ((u = null), (s.x = 1)),
        (s.v = 0),
        (s.t = 1),
        (c = x),
        (g = m)),
      x == null && r.x < 0.004 && ((c = null), (u = null)),
      s.x > 0.996 && (u = null),
      A !== p && (A && !t && (f = n() < 0.5 ? 1 : -1), t || ((h += ow * f), (o.t = h)), (p = A)));
  };
  return {
    get target() {
      return i;
    },
    set(x) {
      i = x;
    },
    advance(x) {
      const E = x > 0 ? Math.min(x, iw) : 0;
      ((m += E), v());
      const A = Z1(E),
        j = E / A;
      for (let F = 0; F < A; F++) (fs(r, 14, 1, j), fs(s, 11, 1, j), fs(o, 14, 1, j));
      t && ((s.x = 1), (o.x = o.t), (r.x = r.t));
    },
    settle() {
      v();
      for (const x of [r, s, o]) ((x.x = x.t), (x.v = 0));
      v();
    },
    snapshot() {
      return {
        amount: de(r.x, 0, 1),
        spin: o.x,
        kind: c,
        outgoing: u,
        swap: de(s.x, 0, 1),
        clock: { stateTime: m - g, shotTime: m - y },
        outgoingClock: { stateTime: m - w, shotTime: m - S },
        isReducedMotion: t,
        isSettled: Math.abs(r.x - r.t) < 0.001 && Math.abs(o.t - o.x) < 0.01 && s.x > 0.996,
      };
    },
  };
}
const hw = new Map([
  ["position", "position"],
  ["rotation", "rotation"],
  ["squash", "squash"],
  ["scale", "zoom"],
  ["lids", "lids"],
  ["expression", "expression"],
  ["pos", "position"],
  ["rot", "rotation"],
  ["scl", "squash"],
  ["zoom", "zoom"],
  ["expr", "expression"],
]);
const fw = new Map([
  ["blob", "sphere"],
  ["sphereWide", "sphere"],
  ["arch", "horseshoe"],
  ["spark", "sparkle"],
  ["star", "star6"],
  ["heart", "heartChubby"],
  ["hexagon", "hex"],
]);
const pw = [0.4, 0, 0.2, 1];
const vn = 0.6;
const rh = (() => {
  const [e, t, n] = pk(yk);
  return [e / hn, t / hn, n / hn];
})();
const sh = {
  duration: 10,
  body: null,
  squashAnchor: 0,
  restTime: 0,
  inspect: {},
  position: [],
  rotation: [],
  squash: [],
  zoom: [],
  lids: [],
  expression: [],
};
const Lu = { ...sh, rotation: [{ t: 0, v: rh, ease: Gn }] };
function mw(e) {
  return kk.some((t) => t === e);
}
function gw(e) {
  const t = fw.get(e) ?? e;
  return mw(t) ? t : "sphere";
}
function yw(e) {
  return e != null && e.length === 4;
}
function kw({ t: e, v: t, ease: n }) {
  return { t: e, v: typeof t == "string" ? [] : t, ease: yw(n) ? n : Gn };
}
function ww(e) {
  return [
    { t: e, v: [0], ease: Gn },
    { t: e + Ni * 0.45, v: [1], ease: Gn },
    { t: e + Ni, v: [0], ease: Gn },
  ];
}
function bw({ inspect: e }) {
  const t = e?.bias;
  return {
    bias: t !== void 0 && Number.isFinite(t) ? Math.min(1, Math.max(-1, t)) : void 0,
    isFollowingTurn: e?.follow,
  };
}
function xw(e) {
  const t = new Map();
  for (const [i, a] of Object.entries(e.tracks)) {
    const c = hw.get(i);
    c !== void 0 && t.set(c, a);
  }
  const n = (i) => (t.get(i) ?? []).map(kw),
    r = n("lids"),
    s = [];
  let o = !1;
  for (const i of t.get("expression") ?? []) {
    if (i.v === "blink") {
      ((o = !0), r.push(...ww(i.t)));
      continue;
    }
    s.push({
      t: i.t,
      name: typeof i.v == "string" ? Pk(i.v) : "neutral",
      isThroughBlink: i.cut === !1,
    });
  }
  return (
    o && r.sort((i, a) => i.t - a.t),
    {
      duration: e.duration,
      body: gw(e.body ?? "sphere"),
      squashAnchor: e.squashAnchor ?? 0,
      restTime: e.workArea ? e.workArea.start : 0,
      inspect: bw(e),
      position: n("position"),
      rotation: n("rotation"),
      squash: n("squash"),
      zoom: n("zoom"),
      lids: r,
      expression: s,
    }
  );
}
function mt(e, t) {
  if (e.length === 0) return null;
  if (t <= e[0].t) return e[0].v;
  const n = e[e.length - 1];
  if (t >= n.t) return n.v;
  let r = 0;
  for (; r < e.length - 2 && e[r + 1].t <= t;) r++;
  const s = e[r],
    o = e[r + 1],
    i = (t - s.t) / Math.max(o.t - s.t, 1e-9),
    a = Ca(i, s.ease);
  return s.v.map((c, u) => c + (o.v[u] - c) * a);
}
function Nu(e) {
  const t = e.restTime,
    n = mt(e.rotation, t),
    r = mt(e.position, t),
    s = mt(e.squash, t),
    o = mt(e.zoom, t),
    i = mt(e.lids, t);
  let a = "neutral",
    c = !1;
  for (const u of e.expression) (c || ((a = u.name), (c = !0)), u.t <= t + 1e-9 && (a = u.name));
  return {
    rot: n ? [n[0], n[1], n[2]] : [0, 0, 0],
    pos: r ? [r[0], r[1]] : [0, 0],
    scl: s ? [s[0], s[1]] : [1, 1],
    zoom: o ? o[0] : vn,
    lids: i ? Math.min(1, Math.max(0, i[0])) : 0,
    expr: a,
    squashAnchor: e.squashAnchor,
  };
}
function Vo(e, t) {
  return e + 360 * Math.round((t - e) / 360);
}
function Go(e, t) {
  return Math.abs(((((e - t) % 360) + 540) % 360) - 180);
}
function vw(e, t) {
  return (
    Go(e.rot[0], t.rot[0]) < 4 &&
    Go(e.rot[1], t.rot[1]) < 4 &&
    Go(e.rot[2], t.rot[2]) < 4 &&
    Math.abs(e.pos[0] - t.pos[0]) < 0.015 &&
    Math.abs(e.pos[1] - t.pos[1]) < 0.015 &&
    Math.abs(e.scl[0] - t.scl[0]) < 0.02 &&
    Math.abs(e.scl[1] - t.scl[1]) < 0.02 &&
    Math.abs(e.zoom - t.zoom) < 0.02 &&
    Math.abs(e.lids - t.lids) < 0.05
  );
}
function Sw(e, t) {
  const n = (s, o) => [
      { t: 0, v: s, ease: pw },
      { t: Li, v: o, ease: Gn },
    ],
    r = [Vo(t.rot[0], e.rot[0]), Vo(t.rot[1], e.rot[1]), Vo(t.rot[2], e.rot[2])];
  return {
    ...sh,
    duration: Li,
    squashAnchor: e.squashAnchor,
    position: n(e.pos, t.pos),
    rotation: n(e.rot, r),
    squash: n(e.scl, t.scl),
    zoom: n([e.zoom], [t.zoom]),
    lids: e.lids === 0 && t.lids === 0 ? [] : n([e.lids], [t.lids]),
  };
}
const Mw = {
  left: { rot: [0, -20, 0], pos: [-0.1, 0] },
  right: { rot: [0, 20, 0], pos: [0.1, 0] },
  up: { rot: [-20, 0, 0], pos: [0, 0.1] },
  down: { rot: [20, 0, 0], pos: [0, -0.1] },
  center: { rot: [0, 0, 0], pos: [0, 0] },
};
const Tw = [0.42, 0, 0.58, 1];
const Ew = 0.5;
const Pw = 0.1;
const Iw = 10;
const Aw = 1e-4;
const $w = 0.5;
const Cw = 0.001;
const Fu = "rest";
function Wo(e) {
  return 360 * Math.round(e / 360);
}
function ju(e, t) {
  let n = "neutral";
  for (const r of e) {
    if (r.t > t + 1e-9) break;
    n = r.name;
  }
  return n;
}
function oh(e = {}) {
  const t = Math.min(3, Math.max(0.2, e.zoomMul || 1)),
    n = Gk();
  let r = e.body ?? "sphere",
    s = e.body !== void 0,
    o = [];
  const i = hs(1),
    a = dw();
  let c = null,
    u = rh,
    l = [0, 0],
    d = [1, 1],
    h = 0,
    f = vn * t,
    p = { bias: -1, isFollowingTurn: !0 },
    m = null,
    g = { isHeld: !1, isAlways: e.isGazeAlways ?? !1, x: 0, y: 0, cx: 0, cy: 0, hold: 0 },
    y = Lu,
    w = 0,
    S = !1,
    v = !0,
    x = !1,
    E = null,
    A = null,
    j = null,
    F = 0,
    O = 0,
    L = null,
    T = null,
    I = !1,
    $ = [];
  const R = () => {
      const _ = mt(y.position, w);
      l = _ ? [_[0], _[1]] : [0, 0];
      const q = mt(y.rotation, w);
      u = q ? [q[0], q[1], q[2]] : [0, 0, 0];
      const B = mt(y.squash, w);
      d = B ? [B[0], B[1]] : [1, 1];
      const P = mt(y.zoom, w);
      P && (f = Math.min(2.5, Math.max(0.25, P[0])) * t);
    },
    U = (_) => {
      if ((n.blinkAmount() ?? ye()) > 0) {
        T = _;
        return;
      }
      (_(), K());
    },
    W = (_, q) => {
      if (L == null) for (const B of y.expression) B.t <= _ || B.t > q || U(() => n.play(B));
    },
    G = (_) => {
      ((w = _),
        (m = null),
        (T = null),
        R(),
        n.seek(y.expression, _),
        L != null && n.seek([{ t: 0, name: L, isThroughBlink: !1 }], 0));
    },
    J = () => {
      const _ = mt(y.lids, w);
      return _ ? Math.min(1, Math.max(0, _[0])) : 0;
    },
    ye = () => (I ? 0 : J()),
    K = () => {
      !Ik(n.name) || n.isMorphing ? (I = !0) : I && J() === 0 && (I = !1);
    },
    ae = () => ({ rot: u, pos: l, scl: d, zoom: f / t, lids: ye(), expr: n.name, squashAnchor: h }),
    ee = (_) => {
      ((S = !1),
        (y = _),
        (w = 0),
        (h = _.squashAnchor),
        _.body != null && !s && (r = _.body),
        (p = {
          bias: _.inspect.bias ?? p.bias,
          isFollowingTurn: _.inspect.isFollowingTurn ?? p.isFollowingTurn,
        }));
    },
    te = (_) => {
      if (((A = null), ee(_.clip), (E = { clip: _.clip, name: _.name }), (v = !0), !_.isPlaying)) {
        (G(0), _.isRest && (g = { ...g, hold: 0 }));
        return;
      }
      ((S = !0),
        _.phase > 0 && G(_.phase * _.clip.duration),
        n.release(),
        _.phase <= 0 && W(-1e-9, 0));
    },
    he = (_) => {
      const q = ae(),
        B = Nu(_.clip);
      ((A = _),
        ee(Sw(q, B)),
        (v = !1),
        (S = !0),
        L == null && q.expr !== B.expr && U(() => n.morph(B.expr)));
    },
    D = () =>
      A != null || E == null || vw(ae(), Nu(E.clip))
        ? !1
        : (he({ ...E, isPlaying: !0, phase: 0, isRest: !1 }), !0),
    V = (_) => {
      const q = w;
      let B = q + _;
      if (B >= y.duration)
        if ((W(q, y.duration), v)) {
          if (((O += 1), D())) return;
          ((B = B - y.duration), B >= y.duration && (B = 0), W(-1e-9, B), (w = B));
        } else ((w = y.duration), (S = !1), A != null && te(A));
      else (W(q, B), (w = B));
      ((m = null), R());
    },
    Y = (_, q) => {
      const B = _ + (q - _) * Jk;
      return Math.abs(q - B) < Cw ? q : B;
    },
    Z = () => {
      if (
        x ||
        (!g.isHeld && g.hold === 0) ||
        ((g = { ...g, cx: Y(g.cx, g.x), cy: Y(g.cy, g.y), hold: Y(g.hold, g.isHeld ? 1 : 0) }), S)
      )
        return;
      R();
      const _ = Ou(r, g.cx, g.cy),
        { hold: q } = g;
      ((u = [u[0] + (_.rx - u[0]) * q, u[1] + (_.ry - u[1]) * q, u[2] * (1 - q)]),
        (l = [l[0] + (_.px - l[0]) * q, l[1] + (_.py - l[1]) * q]));
    },
    Q = (_) => {
      if (m == null) return;
      const q = m.t + _,
        B = Math.min(q / Ew, 1),
        P = Ca(B, Tw),
        { fromRot: C, toRot: N, fromPos: H, toPos: z } = m;
      ((u = [C[0] + (N[0] - C[0]) * P, C[1] + (N[1] - C[1]) * P, C[2] + (N[2] - C[2]) * P]),
        (l = [H[0] + (z[0] - H[0]) * P, H[1] + (z[1] - H[1]) * P]),
        B >= 1 ? ((u = N), (l = z), (m = null)) : (m = { ...m, t: q }));
    },
    ie = () => {
      if (o.length === 0) return [{ body: r, weight: 1 }];
      const _ = Fs(de(i.x, 0, 1)),
        q = new Map();
      for (const C of o) q.set(C.body, (q.get(C.body) ?? 0) + C.weight * (1 - _));
      q.set(r, (q.get(r) ?? 0) + _);
      const B = [...q].filter(([, C]) => C > Aw),
        P = B.reduce((C, [, N]) => C + N, 0);
      return B.map(([C, N]) => ({ body: C, weight: N / P }));
    },
    re = (_) => {
      _ !== r && ((o = ie()), (r = _), (i.x = 0), (i.v = 0), (i.t = 1));
    },
    ke = (_) => {
      if (o.length === 0) return;
      const q = Z1(_);
      for (let B = 0; B < q; B++) fs(i, Iw, 1, _ / q);
      Math.abs(i.x - 1) < 0.001 && Math.abs(i.v) < 0.01 && ((i.x = 1), (i.v = 0), (o = []));
    },
    we = () => n.blinkAmount() ?? ye(),
    Ee = (_, q) => {
      const B = Hk(n.eyes(), q, p, _),
        P = we();
      return P <= 1e-4 ? B : [$u(B[0], P), $u(B[1], P)];
    };
  return {
    get isPlaying() {
      return S;
    },
    get time() {
      return w;
    },
    get duration() {
      return y.duration;
    },
    get loopCount() {
      return O;
    },
    get face() {
      return n.name;
    },
    get isSettled() {
      const _ =
        x || (g.hold === (g.isHeld ? 1 : 0) && (!g.isHeld || (g.cx === g.x && g.cy === g.y)));
      return (
        !S &&
        $.length === 0 &&
        o.length === 0 &&
        m == null &&
        T == null &&
        !n.isMorphing &&
        n.blinkAmount() == null &&
        a.snapshot().isSettled &&
        _
      );
    },
    load(_, { isPlaying: q = !0, transition: B = "bridge", phase: P = 0 } = {}) {
      const C = _.name || E?.name || "recipe",
        N = { clip: xw(_), name: C, isPlaying: q, phase: de(P, 0, 1) % 1, isRest: !1 };
      B === "bridge" && E != null && (A != null || E.name !== C) ? he(N) : te(N);
    },
    play() {
      ((x = !1), (S = !0));
    },
    pause() {
      ((x = !0), (S = !1));
    },
    stop() {
      ((S = !1), G(0));
    },
    rest() {
      x = !1;
      const _ = { clip: Lu, name: Fu, isPlaying: !1, phase: 0, isRest: !0 };
      if (A == null && (E == null || E.name === Fu)) {
        E == null && te(_);
        return;
      }
      he(_);
    },
    seek: G,
    setBody(_, { isInstant: q = !1 } = {}) {
      if (((s = !0), !q)) {
        re(_);
        return;
      }
      ((r = _), (o = []), (i.x = 1), (i.v = 0));
    },
    setMorph(_, { isInstant: q = !1 } = {}) {
      (a.set(_), q && a.settle());
    },
    setExpression(_, { isThroughBlink: q = !1 } = {}) {
      U(() => {
        q && !vr(_) && !vr(n.name) ? n.lidMorph(_) : n.morph(_);
      });
    },
    holdFace(_) {
      _ !== L &&
        ((L = _),
        U(() => {
          const q = L ?? (A == null ? ju(y.expression, w) : ju(A.clip.expression, 0));
          q !== n.name && n.morph(q);
        }));
    },
    poke(_, { turns: q = 1 } = {}) {
      $ = [...$, { poke: _, t: 0, turns: Math.max(1, Math.round(q)) }];
    },
    blink() {
      n.blink();
    },
    setInspect({ bias: _, isFollowingTurn: q }) {
      p = {
        bias: _ === void 0 ? p.bias : Math.min(1, Math.max(-1, _)),
        isFollowingTurn: q ?? p.isFollowingTurn,
      };
    },
    setGaze(_) {
      if (_ == null) {
        g = { ...g, isHeld: !1 };
        return;
      }
      const q = de(_[0] || 0, -1, 1),
        B = de(_[1] || 0, -1, 1);
      g =
        g.hold === 0
          ? { ...g, isHeld: !0, x: q, y: B, cx: q, cy: B }
          : { ...g, isHeld: !0, x: q, y: B };
    },
    setGazeAlways(_) {
      g = { ...g, isAlways: _ };
    },
    look(_) {
      const q = Mw[_];
      m = { t: 0, fromRot: u, toRot: q.rot, fromPos: l, toPos: q.pos };
    },
    setGlow(_) {
      j = _;
    },
    advance(_) {
      Z();
      const q = Math.min(_, Pw),
        B = 1 - a.snapshot().amount;
      if ((S && V(q * B), Q(q), n.step(q), T != null && (n.blinkAmount() ?? ye()) === 0)) {
        const C = T;
        ((T = null), C());
      }
      (K(),
        ke(q),
        ($ = $.map((C) => ({ ...C, t: C.t + q })).filter((C) => C.t < nh(C))),
        a.advance(q));
      const P = a.snapshot();
      (P.amount > 0 || !P.isSettled ? (c ??= [Wo(u[0]), Wo(u[1]), Wo(u[2])]) : (c = null),
        (F += _));
    },
    frame() {
      const _ = g.isAlways && S && !x ? Ou(r, g.cx, g.cy) : null,
        q = ew * g.hold,
        B = Qk($),
        P = [u[0] + (_ ? _.rx * q : 0) + B.pitch, u[1] + (_ ? _.ry * q : 0) + B.yaw, u[2]],
        C = [l[0] + (_ ? _.px * q : 0), l[1] + (_ ? _.py * q : 0) + B.lift],
        N = [d[0] * B.squash[0], d[1] * B.squash[1]],
        H = n.inspectWeight(),
        z = a.snapshot(),
        X = 1 - z.amount,
        ce = (z.spin % (2 * Math.PI)) / hn,
        ne = c ?? [0, 0, 0],
        se = (ue) => ne[ue] + (P[ue] - ne[ue]) * X,
        pe = se(1);
      return {
        body: r,
        quat: fk(se(0) * hn, (pe + ce) * hn, se(2) * hn),
        zoom: f,
        offset: X === 1 ? C : [C[0] * X, C[1] * X],
        squash: X === 1 ? N : [1 + (N[0] - 1) * X, 1 + (N[1] - 1) * X],
        squashAnchor: h,
        eyes: z.amount >= $w ? null : Ee(pe, H),
        glow: j && { ...j, midT: 0.5 + 0.5 * Math.sin((F * 1e3) / 860) },
        inspectWeight: H,
        bodies: ie(),
        morph: z.kind === null && z.isSettled ? null : z,
      };
    },
  };
}
const ao = 0.92;
function _r(e) {
  return e / vn;
}
function Sr(e) {
  const t = (n) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${t(e[0])}${t(e[1])}${t(e[2])}`;
}
function Na(e) {
  return e.inkPaint ?? Sr(e.ink);
}
function Fa(e) {
  return e.spotPaint ?? Sr(e.spot);
}
function ja(e, t, n = e) {
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${t}" width="${n}" height="${n}" viewBox="0 0 ${e} ${e}">`;
}
const _w = [
  {
    name: "Blocked_A",
    duration: 2.12,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 2.1 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 0,
          v: [0, 0],
          ease: [0.7968976121829217, 0.023358873568246466, 0.25805236576790014, 0.9399472349279558],
        },
        {
          t: 0.38639855209383034,
          v: [0.020362603567309623, 0.0321716960933944],
          ease: [0.7968976121829217, 0.023358873568246466, 0.25805236576790014, 0.9399472349279558],
        },
        {
          t: 0.7460619029579755,
          v: [-0.13200621755876568, 0.04928491306786316],
          ease: [0.16206624605678288, 0.6573718201333453, 0.4776581771164943, 0.9890940068909632],
        },
        {
          t: 0.8660990266653926,
          v: [-0.0027221809712659807, 0.05083886406795958],
          ease: [0.34720720728860055, -0.008777460320222181, 0.2695010548130348, 1.02521711915982],
        },
        {
          t: 1.0493565888199954,
          v: [-0.12038936798795193, 0.04235181137057312],
          ease: [0.2773807176656155, 0.29281356631792965, 0.35341088328075676, 1.0737667821535892],
        },
        {
          t: 1.2986659810851888,
          v: [-0.0027221809712659807, 0.05083886406795958],
          ease: [0.34720720728860055, -0.008777460320222181, 0.2695010548130348, 1.02521711915982],
        },
        { t: 1.7569209127327317, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        {
          t: 0,
          v: [0, 0, 0],
          ease: [0.8199958981940145, -0.1753438779653778, 0.35490544014951186, 0.958837837092147],
        },
        {
          t: 0.38639855209383034,
          v: [6.596421550520286, 26.266588805679774, 6.122577979110701],
          ease: [0.8199958981940145, -0.1753438779653778, 0.35490544014951186, 0.958837837092147],
        },
        {
          t: 0.7460619029579755,
          v: [4.03072349953808, -14.070821783965659, -8.088521350792867],
          ease: [0.16206624605678288, 0.6573718201333453, 0.4776581771164943, 0.9890940068909632],
        },
        {
          t: 0.8660990266653926,
          v: [10.306252195330941, 13.969026095064219, 7.524804229298955],
          ease: [0.34720720728860055, -0.008777460320222181, 0.2695010548130348, 1.02521711915982],
        },
        {
          t: 1.0493565888199954,
          v: [8.006914468651756, -9.270764174998455, -8.505309845875193],
          ease: [0.2773807176656155, 0.29281356631792965, 0.35341088328075676, 1.0737667821535892],
        },
        {
          t: 1.2986659810851888,
          v: [10.306252195330941, 13.969026095064219, 7.524804229298955],
          ease: [0.34720720728860055, -0.008777460320222181, 0.2695010548130348, 1.02521711915982],
        },
        { t: 1.7569209127327317, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      scale: [
        { t: 0, v: [0.6], ease: [0.42, 0, 0.06944264684998447, 0.9679740678629829] },
        {
          t: 0.38639855209383034,
          v: [0.6],
          ease: [0.42, 0, 0.06944264684998447, 0.9679740678629829],
        },
        {
          t: 1.1494959879909783,
          v: [0.5],
          ease: [0.7910272291113791, -0.026550296201944556, 0.19732842008291107, 1],
        },
        {
          t: 1.900275655021834,
          v: [0.6],
          ease: [0.42, 0, 0.06944264684998447, 0.9679740678629829],
        },
      ],
      expression: [
        { t: 0.46926065284592233, v: "confused", ease: [0.42, 0, 0.58, 1] },
        { t: 1.606008694397346, v: "neutral", ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
  {
    name: "Blocked_B",
    duration: 3,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 3 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 1.2593574149757256,
          v: [0.004259404064870088, -0.22320548763819217],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      rotation: [
        {
          t: 1.2593574149757256,
          v: [22.38040777312499, -0.11374925549943268, -1.3254543924838493],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [
        {
          t: 0,
          v: "sad",
          ease: [0.8458217358299596, 0.40487753378378377, 0.13769926619433198, 0.9154349662162162],
        },
      ],
    },
  },
  {
    name: "Blocked_C",
    duration: 1.4,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 1.3929879324776784 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        { t: 0, v: [-0.10159994888361161, 0.0005766171900318479], ease: [0.42, 0, 0.58, 1] },
        {
          t: 0.6816231863839288,
          v: [0.06829453998737205, 0.0005766171900318479],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 1.3929879324776784,
          v: [-0.10159994888361161, 0.0005766171900318479],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      rotation: [
        {
          t: 0,
          v: [22.100629997955743, -15.657630964434397, -4.681428255949899],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 0.6816231863839288,
          v: [21.919069173693785, 11.388653232575262, 0.7382242020910257],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 1.3929879324776784,
          v: [22.100629997955743, -15.657630964434397, -4.681428255949899],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [
        {
          t: 0,
          v: "sleepy",
          ease: [0.8458217358299596, 0.40487753378378377, 0.13769926619433198, 0.9154349662162162],
        },
      ],
    },
  },
  {
    name: "Bodymoves_A",
    duration: 5,
    body: "clover",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        { t: 0, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 0.3316869300911854, v: [-0.1, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 0.6673157294832825, v: [-0.1, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 1, v: [0.1, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 1.3356762917933132, v: [0.1, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 1.654302811550152, v: [0, 0.1], ease: [0.42, 0, 0.58, 1] },
        { t: 2, v: [0, 0.1], ease: [0.42, 0, 0.58, 1] },
        { t: 2.329549772036474, v: [0, -0.1], ease: [0.42, 0, 0.58, 1] },
        { t: 2.667601683029453, v: [0, -0.1], ease: [0.42, 0, 0.58, 1] },
        { t: 2.9985974754558207, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        { t: 0, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 0.3316869300911854, v: [0, -20, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 0.6673157294832825, v: [0, -20, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 1, v: [0, 20, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 1.3356762917933132, v: [0, 20, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 1.654302811550152, v: [-20, 0, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 2, v: [-20, 0, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 2.329549772036474, v: [20, 0, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 2.667601683029453, v: [20, 0, 0], ease: [0.42, 0, 0.58, 1] },
        {
          t: 2.9985974754558207,
          v: [0, 0, 0],
          ease: [0.7340521114106021, 0, 0.024581648697214575, 1],
        },
        { t: 4.546161721267454, v: [0, 360, 0], ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
  {
    name: "Done_A",
    duration: 3.7,
    body: "sphere",
    squashAnchor: -1,
    workArea: { start: 0.07228455190755256, end: 2.4415076840284984 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      expression: [
        {
          t: 0.5404427256792492,
          v: "happy",
          ease: [
            0.9601942054655871, -0.052470439189189255, 0.20804339574898786, 0.9135346283783784,
          ],
        },
        {
          t: 1.1009640885188103,
          v: "neutral",
          ease: [
            0.9601942054655871, -0.052470439189189255, 0.20804339574898786, 0.9135346283783784,
          ],
        },
      ],
      squash: [
        { t: 0.026170163234005256, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        { t: 0.1712334301051709, v: [1.095, 0.95], ease: [0.42, 0, 0.58, 1] },
        { t: 0.2519479897020158, v: [1, 1.1], ease: [0.42, 0, 0.58, 1] },
        { t: 0.5890803023663453, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        { t: 0.7128174264881666, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        { t: 0.7669564766634516, v: [1.095, 0.95], ease: [0.42, 0, 0.58, 1] },
        {
          t: 0.9897759640666083,
          v: [1, 1.05],
          ease: [0.42, 0, 0.8951431517668547, 0.3407570422535186],
        },
        {
          t: 1.2017846598233752,
          v: [1, 1],
          ease: [0.31159929257512675, 0.38869681601739836, 0.58, 1],
        },
        { t: 1.2442602578454727, v: [1.02, 0.95], ease: [0.42, 0, 0, 0.9636255030181098] },
        { t: 1.3707862721816209, v: [1, 1.05], ease: [0.42, -0.06206202263065829, 0.58, 1] },
        { t: 1.5659785175305556, v: [1, 1.05], ease: [0.42, -0.06206202263065829, 0.58, 1] },
        { t: 1.7225242861726335, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        { t: 0.07894117002629274, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
        {
          t: 0.5890803023663453,
          v: [-30.114678799869385, -0.3481515921755908, 14.22102163595976],
          ease: [0.7300325174456456, -0.12405425024558042, 0.3365835061031919, 0.8017889379937657],
        },
        {
          t: 1.1421861305872043,
          v: [-22.577941336944804, 6.412920843838687, -21.655639323327193],
          ease: [0.583298559499341, -0.33760664743211344, 0.32045494511798944, 1.0963542960860653],
        },
        {
          t: 1.9672542725679227,
          v: [-2.0781042925060573, 2.7701174100260233, -1.1097245079483975],
          ease: [0.42, 0, 0.58, 1],
        },
        { t: 2.265132022348826, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      position: [
        {
          t: 0.21523060911481157,
          v: [0, 0],
          ease: [0.26223486988161915, 0.6947245975855132, 0.19480556164846297, 0.9038661358145291],
        },
        {
          t: 0.4114390589896057,
          v: [4251034064187152e-20, 0.2658889947011273],
          ease: [0.6174717437059508, -0.1285535110701914, 0.9558063166458642, 1.4558335539794296],
        },
        {
          t: 0.7733546480351897,
          v: [0, 0.0027633019963448496],
          ease: [0.09538195235865887, 0.5878716966122386, 0.07993556895591414, 0.9424688534678969],
        },
        {
          t: 0.9897759640666083,
          v: [4251034064187152e-20, 0.2724621969461928],
          ease: [0.8363729761758775, -0.06230462217533443, 0.9982539187302559, 1.5],
        },
        {
          t: 1.2463303718735304,
          v: [0, 0.004098894994698572],
          ease: [0.0027852407545025976, 0.747585125427439, 0.2902850468489716, 1.075893533235889],
        },
        {
          t: 1.4277545322137832,
          v: [4251034064187152e-20, 0.20927514060819213],
          ease: [0.6418193857854623, 0.06919682671194852, 0.999114846102708, 1.0051682084254565],
        },
        {
          t: 1.6154571730378309,
          v: [0, -0.0012722231452485869],
          ease: [0.1439324608778934, 0.5569463954729904, 0.40675790714828725, 0.8986649812795062],
        },
        {
          t: 1.6919913573024103,
          v: [4251034064187152e-20, 0.12826705419287673],
          ease: [0.7357127354801332, -0.23608339420075217, 0.998983119560359, 1.0241908800770656],
        },
        {
          t: 1.838861098534871,
          v: [0, -0.00406003797139351],
          ease: [0.16778668894268609, 0.5982980173372091, 0.2604597520439014, 0.8844972998628613],
        },
        {
          t: 1.8667112801287638,
          v: [4251034064187152e-20, 0.07903432452816228],
          ease: [0.4685028760838894, -0.42953625372100485, 0.9202731953835559, 0.8525061773543536],
        },
        {
          t: 1.9472873681398353,
          v: [0, -0.006228275916527491],
          ease: [0.0027852407545025976, 1.5, 0.48865476645304945, 0.9551260679225434],
        },
      ],
    },
  },
  {
    name: "Done_B",
    duration: 1.8,
    body: "sphere",
    squashAnchor: -1,
    workArea: null,
    inspect: { bias: -1, follow: !1 },
    tracks: {
      expression: [{ t: 0.1, v: "happy", ease: [0.4, 0.22, 0.28, 1.34] }],
      squash: [
        { t: 0, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        { t: 0.24, v: [1.12, 0.88], ease: [0.42, 0, 0.58, 1] },
        { t: 0.46, v: [0.93, 1.09], ease: [0.42, 0, 0.58, 1] },
        { t: 0.68, v: [1.04, 0.97], ease: [0.42, 0, 0.58, 1] },
        { t: 0.92, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
  {
    name: "Done_C",
    duration: 2,
    body: "sphere",
    squashAnchor: -1,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      expression: [
        {
          t: 0,
          v: "happy",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 1.1902334624750293,
          v: "neutral",
          ease: [0.8458217358299596, 0.40487753378378377, 0.13769926619433198, 0.9154349662162162],
        },
      ],
      position: [
        { t: 0, v: [0, 0], ease: [0.42, 0, 0.4073342890672376, 1.018190339792799] },
        {
          t: 0.3798103165938864,
          v: [-0.1054748164006256, 0.1247799599228919],
          ease: [0.6446428602987402, 0.013555142906648983, 0.26273657853993304, 1.0464437149441994],
        },
        {
          t: 0.9426716022659842,
          v: [0.10617803719053583, 0.1550632852223643],
          ease: [0.8992655949641883, 0.06226468791954258, 0.6897429932929974, 1.0606800225733635],
        },
        {
          t: 1.3822867688368345,
          v: [0.011140244111415301, -0.17250079856992764],
          ease: [0.5369766709678977, 0.09639530999237222, 0.4242841447981972, 0.8655803895199093],
        },
        {
          t: 1.5768176200981194,
          v: [0.009657934584899294, 0.02418870866616249],
          ease: [0.10285717371228631, 0.44298137016142797, 0.58, 1],
        },
        {
          t: 1.7545755610844578,
          v: [0.005569779366063913, -0.08650009457623184],
          ease: [0.11393164333435832, 0.20842906107559217, 0.58, 1],
        },
        { t: 1.9557554786340765, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        {
          t: 0,
          v: [0, 0, 0],
          ease: [0.7521899922111783, 0, 0.29680419697434735, 1.2284132127170915],
        },
        {
          t: 0.3798103165938864,
          v: [-31.25365067481446, -5.533499139447874, 13.746823539571478],
          ease: [0.6650959278914218, 0.08187947429053509, 0.027403916739799694, 1.175374728587553],
        },
        {
          t: 0.9426716022659842,
          v: [-30.6162399609899, 14.144576441037861, -12.73974221895198],
          ease: [0.8992655949641883, 0.06226468791954258, 0.6897429932929974, 1.0606800225733635],
        },
        {
          t: 1.3972576410224693,
          v: [19.356472882732792, 0.12303000388944017, -1.6697872707546177],
          ease: [0.5369766709678977, 0.09639530999237222, 0.4242841447981972, 0.8655803895199093],
        },
        {
          t: 1.5873362914457065,
          v: [-4.965245810760847, -1.410803032494741, -0.08557034006007683],
          ease: [0.10285717371228631, 0.44298137016142797, 0.58, 1],
        },
        {
          t: 1.7574889536920633,
          v: [12.945220298267941, -0.9549298574076148, -1.3541756721371099],
          ease: [0.11393164333435832, 0.20842906107559217, 0.58, 1],
        },
        {
          t: 1.9557554786340765,
          v: [0, 0, 0],
          ease: [0.7521899922111783, 0, 0.29680419697434735, 1.2284132127170915],
        },
      ],
    },
  },
  {
    name: "Idle_A",
    duration: 6,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 0.4874467656537753,
          v: [0, 0],
          ease: [0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1],
        },
        {
          t: 1.3832000000000173,
          v: [-0.14647919001828796, 0.027266090496135924],
          ease: [0.5825263567433967, 0.31017058172003364, 0.04617913732408452, 1.3610608114532912],
        },
        {
          t: 1.77965296961326,
          v: [-0.14647919001828796, 0.027266090496135924],
          ease: [0.22005965712189499, 0.31017058172003364, 0.04617913732408452, 0.9652306378531971],
        },
        {
          t: 2.75,
          v: [-0.0745899946905787, -0.16596550351011732],
          ease: [0.7924378812353865, 0.08203268815009183, 0.20257664629337524, 0.5708768022766131],
        },
        {
          t: 2.9261481353591154,
          v: [-0.0745899946905787, -0.16596550351011732],
          ease: [0.9024115240536277, 0.09528443113772456, 0.31187154968454267, 0.9286115269461079],
        },
        {
          t: 4.0795674814720835,
          v: [0, 0],
          ease: [0.8772841365461845, 0.09396460316883949, 0, 0.9378491736838274],
        },
        { t: 5.754212106241882, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        {
          t: 0.4874467656537753,
          v: [0, 0, 0],
          ease: [0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1],
        },
        {
          t: 1.3832000000000173,
          v: [-16.083597442672094, -32.69316873461356, -11.038560548848148],
          ease: [0.5825263567433967, 0.31017058172003364, 0.04617913732408452, 1.3610608114532912],
        },
        {
          t: 1.77965296961326,
          v: [-13.471262391203387, -31.664036845872012, -11.622988481798327],
          ease: [0.22005965712189499, 0.31017058172003364, 0.04617913732408452, 0.9652306378531971],
        },
        {
          t: 2.75,
          v: [10.37381753258554, 13.583422586232203, 10.666197221172675],
          ease: [0.7924378812353865, 0.08203268815009183, 0.20257664629337524, 0.5708768022766131],
        },
        {
          t: 2.9261481353591154,
          v: [22.819835891847944, 5.292311893891789, 5.163005094237094],
          ease: [1, -0.5, 0.4051656151419559, 0.8872272583365959],
        },
        {
          t: 4.0795674814720835,
          v: [-24.875244874578584, 31.812786832669843, 15.07444269105954],
          ease: [0.8772841365461845, 0.09396460316883949, 0, 0.9378491736838274],
        },
        {
          t: 5.754212106241882,
          v: [0, 360, 0],
          ease: [0.9122920380277829, 0.038550560528246756, 0.4251612081579069, 0.8172019143128422],
        },
      ],
      expression: [
        { t: 1.1628970994475138, v: "blink", ease: [0.42, 0, 0.58, 1] },
        { t: 4.00439785911593, v: "blink", ease: [0.42, 0, 0.58, 1] },
        { t: 5.643314779005485, v: "neutral", ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
  {
    name: "Idle_B",
    duration: 4,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [{ t: 1.6054821209465213, v: [0, 0], ease: [0.42, 0, 0.58, 1] }],
      rotation: [
        {
          t: 0.9010370289220491,
          v: [0, 0, 0],
          ease: [0.42, 0, 0.28927730966925536, 0.9624241226685105],
        },
        {
          t: 1.6163686240140267,
          v: [0.12032076750937498, -8.658512604326788, -2.5426418939710658],
          ease: [0.8747812559101849, -0.03625853912624016, 0.25467036702156304, 0.8980229024542974],
        },
        {
          t: 2.4902049517966525,
          v: [0.9659548057072269, 5.658900089349377, 1.7129240357574211],
          ease: [0.6027205111294465, -0.23084976154500042, 0.2902495275740431, 0.9815467952425966],
        },
        { t: 3.45704978089402, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      scale: [
        {
          t: 0,
          v: [0.6],
          ease: [0.6180446538332104, 0.0012432525890504465, 0.1839130507609582, 0.9358696746423821],
        },
        {
          t: 1.6054821209465213,
          v: [0.64],
          ease: [0.8658706538170823, -0.07995460153625837, 0.29979142380351903, 1.0195121615474219],
        },
        {
          t: 3.841942375109553,
          v: [0.6],
          ease: [0.6180446538332104, 0.0012432525890504465, 0.1839130507609582, 0.9405530305724485],
        },
      ],
      expression: [
        { t: 1.4811034202342213, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
        { t: 3.45704978089402, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
      ],
    },
  },
  {
    name: "Idle_D",
    duration: 6,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.6511065418455951, 0, 0.3268385117846959, 1],
        },
        {
          t: 0.5867355510752692,
          v: [-34.32339609164593, 16.86196736106905, 15.137354734738835],
          ease: [0.5996715199956071, 0, 0.24671113951908907, 1],
        },
        {
          t: 1.0783308131720428,
          v: [-34.32339609164593, 16.86196736106905, 15.137354734738835],
          ease: [0.5996715199956071, 0, 0.10657397408207336, 1],
        },
        {
          t: 1.962638608870968,
          v: [-6.1682538522357975, 3.098853229789992, 14.349419848128031],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 2.671748991935484,
          v: [-6.1682538522357975, 3.098853229789992, 14.349419848128031],
          ease: [0.42, 0, 0.2029056425485961, 1],
        },
        {
          t: 3.914377520161291,
          v: [7.572938650100637, 40.386943374478015, 25.47389006919084],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 4.785706485215049,
          v: [7.572938650100637, 40.386943374478015, 25.47389006919084],
          ease: [0.6315554130669547, 0, 0.21641299946004333, 1],
        },
        {
          t: 5.632732694892469,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.6511065418455951, 0, 0.3268385117846959, 1],
        },
      ],
      expression: [
        { t: 0.5929099462365591, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
        { t: 2.0691383064517033, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
        { t: 2.3722908266129035, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
        { t: 4.247479838709677, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
      ],
    },
  },
  {
    name: "Logo_A",
    duration: 4,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 2.0002578769692425 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.940308570092613, 0, 0.8322175812019608, 0.42841310531523513],
        },
        {
          t: 0.9325431465191484,
          v: [-15.896271043294888, 290.3612956381275, 25.38480127460161],
          ease: [0.08370250411471428, 0.7821860109261747, 0.1762354651162792, 1],
        },
        {
          t: 1.9567938859714928,
          v: [-15.896271043294888, 393.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
    },
  },
  {
    name: "Logo_B",
    duration: 4,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 3.1220695798949736 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.77323790487339, 0, 0.19818347223390587, 0.9476806070764106],
        },
        {
          t: 0.7185100111661579,
          v: [-11.287778634690255, -33.00231519019303, -21.062449423926747],
          ease: [0.2717748154604947, -0.2636988609351958, 0.6005198984279181, 0.023491972600300434],
        },
        {
          t: 1.141527569392348,
          v: [-11.399396607755296, -31.39663474186699, -19.937494120163255],
          ease: [0.9137669521901326, 0.04016940837145343, 0.8322175812019608, 0.42841310531523513],
        },
        {
          t: 2.074070715911496,
          v: [-15.896271043294888, 290.3612956381275, 25.38480127460161],
          ease: [0.08370250411471428, 0.7821860109261747, 0.1762354651162792, 1],
        },
        {
          t: 3.0983214553638407,
          v: [-15.896271043294888, 393.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
    },
  },
  {
    name: "Marketing_A",
    duration: 4,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        { t: 0.6167064755838638, v: [0, 0], ease: [0.5771393784786643, 0, 0.41654104823747684, 1] },
        { t: 1.4190773177636233, v: [-0.16387514369529332, 0], ease: [0.42, 0, 0.58, 1] },
        {
          t: 2.2684226822363764,
          v: [-0.16387514369529332, 0.05904395257747427],
          ease: [0.580719503710575, 0, 0, 1],
        },
        { t: 3.1610281808035716, v: [0, 0], ease: [0.5771393784786643, 0, 0.41654104823747684, 1] },
      ],
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 0.6167064755838638,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.8625910776088882, -0.041613616273912, 0.25952275632662025, 1.049784301761229],
        },
        {
          t: 1.4190773177636233,
          v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
          ease: [0.7818125791576046, 0.15346315752484826, 0.32687664998404986, 1.1173618829561318],
        },
        {
          t: 2.2684226822363764,
          v: [-31.58476211869586, -3.710798107118315, 24.071416454447956],
          ease: [0.36229770668640776, -0.17418027527991467, 0.2875659277885649, 1.2452842602722636],
        },
        {
          t: 2.7962446921443735,
          v: [-27.874087487241205, 0.739249290532289, 5.007074162025872],
          ease: [0.42, 0.044881803684311196, 0.58, 1],
        },
        {
          t: 3.2725893489030398,
          v: [-19.255583925594408, -17.414119894980235, -7.023063437300964],
          ease: [0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1],
        },
        {
          t: 3.8435756138392856,
          v: [-19.353875077555468, 20.03044512007725, 19.013275491556097],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 3.9805733816964284,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [
        {
          t: 0.05960518973214285,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 2.2434315286624202,
          v: "surprised",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Marketing_B",
    duration: 4,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 0.6167064755838638,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.8625910776088882, -0.041613616273912, 0.25952275632662025, 1.049784301761229],
        },
        {
          t: 1.4190773177636233,
          v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
          ease: [0.7818125791576046, 0.15346315752484826, 0.32687664998404986, 1.1173618829561318],
        },
        {
          t: 2.2684226822363764,
          v: [20.16565207199379, -20.644446669166673, 22.47273384376682],
          ease: [0.36229770668640776, -0.17418027527991467, 0.2875659277885649, 1.2452842602722636],
        },
        {
          t: 3.2725893489030398,
          v: [-20.98869306129836, -21.248460672675545, -6.20573622722674],
          ease: [0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1],
        },
        {
          t: 4,
          v: [-23.757982259034762, 24.83627384870201, 18.82083960330674],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [
        {
          t: 0,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 1.4471868365180467,
          v: "calm",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Marketing_C",
    duration: 4,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 0.6167064755838638,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.8625910776088882, -0.041613616273912, 0.25952275632662025, 1.049784301761229],
        },
        {
          t: 1.4190773177636233,
          v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
          ease: [0.7818125791576046, 0.15346315752484826, 0.32687664998404986, 1.1173618829561318],
        },
        {
          t: 2.2684226822363764,
          v: [20.16565207199379, -20.644446669166673, 22.47273384376682],
          ease: [0.36229770668640776, -0.17418027527991467, 0.2875659277885649, 1.2452842602722636],
        },
        {
          t: 3.2725893489030398,
          v: [-20.98869306129836, -21.248460672675545, -6.20573622722674],
          ease: [0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1],
        },
        {
          t: 4,
          v: [-23.757982259034762, 24.83627384870201, 18.82083960330674],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [
        {
          t: 0,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 1.4471868365180467,
          v: "calm",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Marketing_D",
    duration: 4,
    body: "sphere",
    squashAnchor: -1,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      expression: [
        {
          t: 0.05498053786270347,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 0.7522248761500355,
          v: "happy",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 3.188380537862626,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
      squash: [
        { t: 0.6800000000000002, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        { t: 0.9199999999999999, v: [1.12, 0.88], ease: [0.42, 0, 0.58, 1] },
        { t: 1.1400000000000001, v: [0.93, 1.09], ease: [0.42, 0, 0.58, 1] },
        { t: 1.3600000000000003, v: [1.04, 0.97], ease: [0.42, 0, 0.58, 1] },
        { t: 1.6, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        {
          t: 0,
          v: [-6.345525006325851, 19.726304895345887, 7.225894380877916],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 0.68,
          v: [-6.345525006325851, 19.726304895345887, 7.225894380877916],
          ease: [0.6287715517241379, 0, 0.1652870297805643, 1],
        },
        {
          t: 1.80886178343963,
          v: [7.946317173704124, -27.372379409841862, -13.611633161590936],
          ease: [0.5888217507250163, 0, 0, 1],
        },
        { t: 3.406449044585987, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
        {
          t: 3.887429228591649,
          v: [-6.345525006325851, 19.726304895345887, 7.225894380877916],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
    },
  },
  {
    name: "Rotation_A",
    duration: 6,
    body: "cloud",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [2.3120950657104795, -34.698071961330996, 6.287220573778937],
          ease: [0.001, 0.001, 0.999, 0.999],
        },
        {
          t: 3.0420576880625374,
          v: [-15.896271043294888, 393.29315635042974, 25.38480127460161],
          ease: [0.001, 0.001, 0.999, 0.999],
        },
        { t: 5.685518927730484, v: [-26.2, 719.4, 25.38480127460161], ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
  {
    name: "Rotation_B",
    duration: 10,
    body: "cloud",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [-5.86170199829258, -66.48579621643268, 11.013855401509232],
          ease: [0.001, 0.001, 0.999, 0.999],
        },
        {
          t: 10,
          v: [-5.86170199829258, 293.5142037835673, 11.013855401509232],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
    },
  },
  {
    name: "Rotation_C",
    duration: 4,
    body: "cloud",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [{ t: 0, v: [0, 0], ease: [0.42, 0, 0.58, 1] }],
      rotation: [
        { t: 0, v: [-35, -28.5, 8.9], ease: [0.001, 0.001, 0.999, 0.999] },
        {
          t: 3.954889112903226,
          v: [30.3, -25.03032384031022, 25.838583124958074],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [{ t: 2.02137936827957, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] }],
    },
  },
  {
    name: "Streaming_A",
    duration: 2.6,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 2.593141413751879 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      rotation: [
        {
          t: 0,
          v: [-17.330877831673277, 2.263279637703984, 15.443629275983977],
          ease: [0.7300325174456456, -0.12405425024558042, 0.40585908939755444, 1.0050376870076922],
        },
        {
          t: 0.3458182816671912,
          v: [9.638628832336948, 2.025895269795649, -1.2527648183630171],
          ease: [0.4224707625763918, 0.0022972310598335997, 0.58, 0.9927354054381194],
        },
        {
          t: 0.5813687143348092,
          v: [-15.366003917619995, -2.619836674995623, -2.16549892253304],
          ease: [0.7322498965237162, -0.011667049678267111, 0, 0.9141484219009502],
        },
        {
          t: 0.8343818658890081,
          v: [4.338039365692767, 0.49348825557993187, -3.7087410402723067],
          ease: [0.1580317356155577, -0.07611268668891613, 0.32045494511798944, 1.0963542960860653],
        },
        {
          t: 1.2183655201918815,
          v: [-0.2793440526930908, 0, 0],
          ease: [0.7202644919359068, 0, 0.414580660247694, 0.9498001208025284],
        },
        {
          t: 1.6185917357603328,
          v: [-5.399115822872089, 14.530502605079048, 3.1285787766973128],
          ease: [0.603730806420981, -0.0304892240026259, 0.2700959962528573, 0.9305186654092706],
        },
        {
          t: 2.0602042690217752,
          v: [-2.088336039091766, -10.814208972017363, -20.009405175503947],
          ease: [0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1],
        },
        {
          t: 2.593141413751879,
          v: [-17.330877831673277, 2.263279637703984, 15.443629275983977],
          ease: [0.7300325174456456, -0.12405425024558042, 0.40585908939755444, 1.0050376870076922],
        },
      ],
      position: [
        { t: 0.008051106963364502, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 0.34800758255567965, v: [0, -0.09893530004977505], ease: [0.42, 0, 0.58, 1] },
        { t: 0.5873549334090005, v: [0, 0.04654750224419043], ease: [0.42, 0, 0.58, 1] },
        { t: 0.8343818658890081, v: [0, 0.004683687521738383], ease: [0.42, 0, 0.58, 1] },
        {
          t: 1.2183655201918815,
          v: [0, 0],
          ease: [0.42, 0, 0.27743996350027533, 0.9367983894536062],
        },
        {
          t: 1.6185917357603328,
          v: [0.12655004394233813, 0],
          ease: [0.603730806420981, -0.0304892240026259, 0.2700959962528573, 0.9282552090918559],
        },
        {
          t: 2.0602042690217752,
          v: [-0.1362091399555723, 0],
          ease: [0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1],
        },
        { t: 2.593141413751879, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
  {
    name: "Streaming_B",
    duration: 2.6,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 2.593141413751879 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      expression: [
        {
          t: 0.8343818658890081,
          v: "surprised",
          ease: [0.8458217358299596, 0.40487753378378377, 0.13769926619433198, 0.9154349662162162],
          cut: !0,
        },
        {
          t: 2.1679160926807017,
          v: "neutral",
          ease: [0.8458217358299596, 0.40487753378378377, 0.13769926619433198, 0.9154349662162162],
          cut: !0,
        },
      ],
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.7300325174456456, -0.12405425024558042, 0.40585908939755444, 1.0050376870076922],
        },
        {
          t: 0.3458182816671912,
          v: [9.638628832336948, 2.025895269795649, -1.2527648183630171],
          ease: [0.4224707625763918, 0.0022972310598335997, 0.58, 0.9927354054381194],
        },
        {
          t: 0.8343818658890081,
          v: [-13.158704916519811, -16.90797681471658, -2.914418472822627],
          ease: [0.1580317356155577, -0.07611268668891613, 0.32045494511798944, 1.0963542960860653],
        },
        {
          t: 1.2183655201918815,
          v: [3.3337098816649693, 21.543227556484112, 4.461698658684633],
          ease: [0.7202644919359068, 0, 0.414580660247694, 0.9498001208025284],
        },
        {
          t: 1.6185917357603328,
          v: [-5.399115822872089, 14.530502605079048, 3.1285787766973128],
          ease: [0.603730806420981, -0.0304892240026259, 0.2700959962528573, 0.9305186654092706],
        },
        {
          t: 2.0602042690217752,
          v: [-2.088336039091766, -10.814208972017363, -20.009405175503947],
          ease: [0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1],
        },
        {
          t: 2.593141413751879,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.7300325174456456, -0.12405425024558042, 0.40585908939755444, 1.0050376870076922],
        },
      ],
      position: [
        { t: 0.008051106963364502, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        { t: 0.34800758255567965, v: [0, -0.09893530004977505], ease: [0.42, 0, 0.58, 1] },
        { t: 0.8343818658890081, v: [0, 0.004683687521738383], ease: [0.42, 0, 0.58, 1] },
        {
          t: 1.36568364300849,
          v: [0.12655004394233813, 0],
          ease: [0.603730806420981, -0.0304892240026259, 0.2700959962528573, 0.9282552090918559],
        },
        {
          t: 2.0602042690217752,
          v: [-0.1362091399555723, 0],
          ease: [0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1],
        },
        { t: 2.593141413751879, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
  {
    name: "Streaming_C",
    duration: 2.4,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      expression: [
        {
          t: 0.0930430477108114,
          v: "squinted",
          ease: [
            0.9601942054655871, -0.052470439189189255, 0.20804339574898786, 0.9135346283783784,
          ],
        },
      ],
      rotation: [
        {
          t: 0.007536501544973762,
          v: [-30.114678799869385, -0.3481515921755908, 10.657733527966457],
          ease: [0.8069695446331039, 0.06068366162676136, 0.22176992691461772, 1.0529567094556063],
        },
        {
          t: 0.6967011702649526,
          v: [-25.983934007381276, 7.767555485689494, -17.97884031792412],
          ease: [0.6337438554404256, 0.03915919163464518, 0.24060607252134747, 0.9552013782917067],
        },
        {
          t: 1.3,
          v: [-27.316297934452344, -1.3907007432867593, 11.301625700367927],
          ease: [0.8069695446331039, 0.06068366162676136, 0.05967881944444445, 0.9976179673321233],
        },
        {
          t: 2.3830582002457,
          v: [-30.114678799869385, 359.6518484078244, 10.657733527966457],
          ease: [0.545887017284529, -0.16488185903681707, 0.58, 1],
        },
      ],
      position: [
        {
          t: 0.007536501544973762,
          v: [0, 0],
          ease: [0.8069695446331039, 0.06068366162676136, 0.22176992691461772, 1.0529567094556063],
        },
        {
          t: 0.6967011702649526,
          v: [0.16304040871678732, 0.1060830475460072],
          ease: [0.6337438554404256, 0.03915919163464518, 0.24060607252134747, 0.9552013782917067],
        },
        {
          t: 1.3,
          v: [-0.16109273893088566, 0.1112767252235085],
          ease: [0.8069695446331039, 0.06068366162676136, 0.05967881944444445, 0.9976179673321233],
        },
        {
          t: 2.3830582002457,
          v: [0, 0],
          ease: [0.7622975213794354, -0.39274360300976613, 0.22176992691461772, 1.0529567094556063],
        },
      ],
    },
  },
  {
    name: "Working_A",
    duration: 8,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 0.4874467656537753,
          v: [0, 0],
          ease: [0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1],
        },
        {
          t: 1.3832000000000173,
          v: [-0.14647919001828796, 0.027266090496135924],
          ease: [0.5825263567433967, 0.31017058172003364, 0.04617913732408452, 1.3610608114532912],
        },
        {
          t: 1.77965296961326,
          v: [-0.14647919001828796, 0.027266090496135924],
          ease: [0.22005965712189499, 0.31017058172003364, 0.04617913732408452, 0.9652306378531971],
        },
        {
          t: 2.5961328343722427,
          v: [0.06209379465135341, 0.0363636826260471],
          ease: [0.6823010997778416, 0.03975119923438924, 0.58, 0.7462988396745895],
        },
        {
          t: 3.066377943544433,
          v: [-0.016487420591570615, 0.0804209848791122],
          ease: [0.8034080182827295, -0.08276325518488785, 0.6510110561346553, 0.8128258749805829],
        },
        {
          t: 3.426085780646072,
          v: [-0.008916270094194876, -0.2135819760518346],
          ease: [0.1744021985074266, -0.5, 0.8865519014643501, -0.2214168917492133],
        },
        {
          t: 4.00439785911593,
          v: [-0.0052248049102180776, -0.12515593913381462],
          ease: [0.023812816055625345, 0.31341394515796384, 0.0448947139696587, 1.0658309377957906],
        },
        { t: 5.005029942257856, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        {
          t: 6.298778790534628,
          v: [0.03813914798218992, -0.019258402700427682],
          ease: [0.576933472628317, 0.007827540903749368, 0.12610215878412523, 0.9598864308897559],
        },
        {
          t: 6.952426906222622,
          v: [-0.25, -0.004137934943726919],
          ease: [0.8326089284460128, -0.06392110845094923, 0.3654460022570882, 1.0352901568389925],
        },
        {
          t: 7.900964066608238,
          v: [0, 0],
          ease: [0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1],
        },
      ],
      rotation: [
        {
          t: 0.4874467656537753,
          v: [0, 0, 0],
          ease: [0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1],
        },
        {
          t: 1.3832000000000173,
          v: [-11.013174031248813, -20.059833580125414, -12.896783267756348],
          ease: [0.5825263567433967, 0.31017058172003364, 0.04617913732408452, 1.3610608114532912],
        },
        {
          t: 1.77965296961326,
          v: [-17.48975478197329, -18.703976724880516, -12.678205332257816],
          ease: [0.22005965712189499, 0.31017058172003364, 0.04617913732408452, 0.9652306378531971],
        },
        {
          t: 2.5961328343722427,
          v: [-14.554913391638532, 17.164836260093473, 9.376528927180779],
          ease: [0.6823010997778416, 0.03975119923438924, 0.58, 0.9240336563778733],
        },
        {
          t: 3.1796016343940767,
          v: [-24.586251970533304, 0.14133926125606477, -0.7477216271856462],
          ease: [0.8034080182827295, -0.08276325518488785, 0.9143306014396848, 0.4851034680582119],
        },
        {
          t: 3.4679142027965795,
          v: [-1.0943281912285556, -1.1346215368163393, -0.7116952620126241],
          ease: [
            0.12040927423864656, -0.18872517040581954, 0.9481776569383256, -0.20917925086224787,
          ],
        },
        {
          t: 4.001861402631413,
          v: [-147.11069531984157, -0.6757806869448113, -0.4238857605398247],
          ease: [0.03131913716814155, 0.8644907690193963, 0.0448947139696587, 1.0658309377957906],
        },
        {
          t: 5.005029942257856,
          v: [-360, 0, 0],
          ease: [0.7970933306500759, -0.5, 0.24118105710043447, 0.7361553789450831],
        },
        {
          t: 6.298778790534628,
          v: [-364.89323527138873, 18.626179650675688, -0.2598233988596897],
          ease: [0.576933472628317, 0.007827540903749368, 0.12610215878412523, 0.9742744867440337],
        },
        {
          t: 6.952426906222622,
          v: [-366.80423922162356, -23.365336474310464, -3.339162411443921],
          ease: [0.8326089284460128, -0.06392110845094923, 0.3654460022570882, 1.0352901568389925],
        },
        { t: 7.900964066608238, v: [-360, 0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      expression: [
        { t: 1.1672000000000002, v: "blink", ease: [0.42, 0, 0.58, 1] },
        {
          t: 1.77965296961326,
          v: "surprised",
          ease: [0.7394673582995951, 0.10409628378378377, 0.6676682692307693, 1.5],
        },
        { t: 5.643314779005485, v: "neutral", ease: [0.42, 0, 0.58, 1] },
        {
          t: 6.298778790534628,
          v: "strange",
          ease: [
            0.9601942054655871, -0.052470439189189255, 0.20804339574898786, 0.9135346283783784,
          ],
        },
        {
          t: 7.3115338882283,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Working_B",
    duration: 4.8,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 4.8 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 0.17746730083234244,
          v: [0, 0],
          ease: [0.807066718478605, 0.026672824415491948, 0.05397305674842967, 1.0519668384455731],
        },
        {
          t: 1.4141067024830507,
          v: [-0.1, -14911040730998862e-21],
          ease: [0.7054694160272805, 0.15290809768637542, 0, 0.9011176996605331],
        },
        {
          t: 2.75,
          v: [0.1, -0.0019533463357608513],
          ease: [0.8240202817829232, -0.24792725943516045, 0.2993925437700369, 1],
        },
        {
          t: 4.7824019024970275,
          v: [0, 0],
          ease: [0.42, 0, 0.07071724310528026, 1.3032158407916754],
        },
      ],
      rotation: [
        {
          t: 0.17746730083234244,
          v: [0, 0, 0],
          ease: [0.807066718478605, 0.026672824415491948, 0.05397305674842967, 1.0519668384455731],
        },
        {
          t: 1.4141067024830507,
          v: [1.431495026310406, -16.140319998213133, -36.05175434586088],
          ease: [0.7054694160272805, 0.15290809768637542, 0, 0.9507801322055007],
        },
        {
          t: 2.75,
          v: [-3.793664340840882, 16.145026960161896, 23.111555762366347],
          ease: [0.8145184258410576, 0.05868417745499387, 0.7187386211123404, 0.8220737938312388],
        },
        {
          t: 3.300369915174868,
          v: [-0.658471135071176, 32.094524718170625, 23.00284198348812],
          ease: [0.9529378729987852, -0.03412152368009878, 0.7143170242443122, 0.5254015949332431],
        },
        {
          t: 3.896330300821882,
          v: [-0.03018222484427137, -273.02901001946327, 5.757592653481982],
          ease: [0.11270319506726437, 0.6690303636987784, 0.23166630377840014, 0.9738369897382892],
        },
        { t: 4.7824019024970275, v: [-0.02727988727869867, -360, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      scale: [
        {
          t: 0.17779177760649373,
          v: [0.6],
          ease: [0.807066718478605, 0.026672824415491948, 0.05397305674842967, 0.9010023979880923],
        },
        {
          t: 1.4141067024830507,
          v: [0.4215844279727266],
          ease: [0.758517646256336, -0.08984960385218788, 0.3074500979615823, 0.9070651813931356],
        },
        {
          t: 2.25,
          v: [0.5281520264776418],
          ease: [1, 0.12529134929810246, 0.3851632150743237, 0.8426351606267645],
        },
        {
          t: 2.9883359098579825,
          v: [0.6153393854797824],
          ease: [0.6185932743021068, -0.26875053521000764, 0.341686978852472, 1],
        },
        {
          t: 4.608223713420763,
          v: [0.6],
          ease: [0.807066718478605, 0.026672824415491948, 0.05397305674842967, 1.0519668384455731],
        },
      ],
      expression: [
        {
          t: 0.7466486120839366,
          v: "inspect",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 2.556108799048751,
          v: "surprised",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 3.7592152199762188,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Working_C",
    duration: 5,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 0.17491812227074233,
          v: [-0.06835221071089878, -14911040730998862e-21],
          ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
        },
        {
          t: 1.5108114197876916,
          v: [0.032133292775302545, -0.0019533463357608513],
          ease: [0.001, 0.24090214653366723, 0.58, 1],
        },
        {
          t: 1.7971520856616507,
          v: [-0.06835221071089878, -14911040730998862e-21],
          ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
        },
        {
          t: 3.1330453831785996,
          v: [0.032133292775302545, -0.0019533463357608513],
          ease: [0.001, 0.24090214653366723, 0.58, 1],
        },
        {
          t: 3.4083292556973226,
          v: [-0.06835221071089878, -14911040730998862e-21],
          ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
        },
        {
          t: 4.777367618612606,
          v: [0.032133292775302545, -0.0019533463357608513],
          ease: [0.001, 0.24090214653366723, 0.58, 1],
        },
        {
          t: 5,
          v: [-0.06835221071089878, -14911040730998862e-21],
          ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
        },
      ],
      rotation: [
        {
          t: 0.17491812227074233,
          v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
          ease: [0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5],
        },
        {
          t: 1.5108114197876916,
          v: [25.82236401380847, 8.163455755358939, 36.34926880424543],
          ease: [0, 0.24090214653366723, 0.58, 1],
        },
        {
          t: 1.7971520856616507,
          v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
          ease: [0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5],
        },
        {
          t: 3.1330453831785996,
          v: [25.82236401380847, 8.163455755358939, 36.34926880424543],
          ease: [0, 0.24090214653366723, 0.58, 1],
        },
        {
          t: 3.4083292556973226,
          v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
          ease: [0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5],
        },
        {
          t: 4.777367618612606,
          v: [25.82236401380847, 8.163455755358939, 36.34926880424543],
          ease: [0, 0.24090214653366723, 0.58, 1],
        },
        {
          t: 5,
          v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
          ease: [0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5],
        },
      ],
      expression: [
        {
          t: 0,
          v: "surprised",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Working_D",
    duration: 5,
    body: "sphere",
    squashAnchor: 0,
    workArea: { start: 0, end: 5 },
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 1.5264103096017296,
          v: [0, 0],
          ease: [0.8183794558884002, 0, 0.42063048773799955, 0.8916191063669083],
        },
        {
          t: 2.2538209606986896,
          v: [0.13302558581350077, 0.08599672420051416],
          ease: [0.7164816671975539, -0.07059803322016199, 0.15856161687281733, 1],
        },
        { t: 2.636972068926158, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        {
          t: 0,
          v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
          ease: [0.7818125791576046, 0.15346315752484826, 0.32687664998404986, 1.1173618829561318],
        },
        {
          t: 0.003820960698689868,
          v: [2.4615600363954893, -24.921015876700608, 2.790543200988768],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 0.5222436429350663,
          v: [20.16565207199379, -20.644446669166673, 22.47273384376682],
          ease: [0.36229770668640776, -0.17418027527991467, 0.2875659277885649, 1.2452842602722636],
        },
        {
          t: 1.5264103096017296,
          v: [-20.98869306129836, -21.248460672675545, -6.20573622722674],
          ease: [0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1],
        },
        {
          t: 2.2538209606986896,
          v: [-23.757982259034762, 24.83627384870201, 18.82083960330674],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 2.636972068926158,
          v: [8.316132781421524, -27.390741199393897, -9.531735566337252],
          ease: [
            0.12247552635300568, -0.002557518043474879, 0.7043012111749869, 0.5773041000961353,
          ],
        },
        {
          t: 3.494456667932666,
          v: [6.3335276735657375, -0.1762970079864843, 0.6565665872756274],
          ease: [0.42, 0.5038392468370619, 0.58, 1],
        },
        {
          t: 4.25382096069869,
          v: [8.1703683326745, 24.729657859977713, 10.395084291173474],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 4.971120960698738,
          v: [2.4615600363954893, -24.921015876700608, 2.790543200988768],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [
        {
          t: 0.003820960698689868,
          v: "calm",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Working_E",
    duration: 4,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        { t: 0.6167064755838638, v: [0, 0], ease: [0.5771393784786643, 0, 0.41654104823747684, 1] },
        { t: 1.4190773177636233, v: [-0.16387514369529332, 0], ease: [0.42, 0, 0.58, 1] },
        {
          t: 2.2684226822363764,
          v: [-0.16387514369529332, 0.05904395257747427],
          ease: [0.580719503710575, 0, 0, 1],
        },
        { t: 3.1610281808035716, v: [0, 0], ease: [0.5771393784786643, 0, 0.41654104823747684, 1] },
      ],
      rotation: [
        {
          t: 0,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 0.6167064755838638,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.8625910776088882, -0.041613616273912, 0.25952275632662025, 1.049784301761229],
        },
        {
          t: 1.4190773177636233,
          v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
          ease: [0.7818125791576046, 0.15346315752484826, 0.32687664998404986, 1.1173618829561318],
        },
        {
          t: 2.2684226822363764,
          v: [-31.58476211869586, -3.710798107118315, 24.071416454447956],
          ease: [0.36229770668640776, -0.17418027527991467, 0.2875659277885649, 1.2452842602722636],
        },
        {
          t: 2.7962446921443735,
          v: [-27.874087487241205, 0.739249290532289, 5.007074162025872],
          ease: [0.42, 0.044881803684311196, 0.58, 1],
        },
        {
          t: 3.2725893489030398,
          v: [-19.255583925594408, -17.414119894980235, -7.023063437300964],
          ease: [0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1],
        },
        {
          t: 3.8435756138392856,
          v: [-10.064416055441825, 12.982763466855692, 19.192265328801522],
          ease: [0.42, 0, 0.58, 1],
        },
        {
          t: 3.9805733816964284,
          v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
          ease: [0.42, 0, 0.58, 1],
        },
      ],
      expression: [
        {
          t: 0.05960518973214285,
          v: "neutral",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
        {
          t: 2.2434315286624202,
          v: "surprised",
          ease: [0.7416814271255061, 0.03220016891891886, 0.26459703947368424, 1.0216427364864864],
        },
      ],
    },
  },
  {
    name: "Working_F",
    duration: 5,
    body: "sphere",
    squashAnchor: 0,
    workArea: null,
    inspect: { bias: -1, follow: !0 },
    tracks: {
      position: [
        {
          t: 0.4874467656537753,
          v: [0, 0],
          ease: [0.6778358120868745, -0.22439715100065685, 0.15951040179591214, 1],
        },
        {
          t: 1.3832000000000173,
          v: [-0.14647919001828796, 0.027266090496135924],
          ease: [0.5825263567433967, 0.31017058172003364, 0.04617913732408452, 1.3610608114532912],
        },
        {
          t: 1.77965296961326,
          v: [-0.14647919001828796, 0.027266090496135924],
          ease: [0.22005965712189499, 0.31017058172003364, 0.04617913732408452, 0.9652306378531971],
        },
        {
          t: 2.5961328343722427,
          v: [0.06209379465135341, 0.0363636826260471],
          ease: [0.6823010997778416, 0.03975119923438924, 0.58, 0.7462988396745895],
        },
        {
          t: 3.066377943544433,
          v: [-0.016487420591570615, 0.0804209848791122],
          ease: [0.8034080182827295, -0.08276325518488785, 0.6510110561346553, 0.8128258749805829],
        },
        {
          t: 3.426085780646072,
          v: [-0.008916270094194876, -0.2135819760518346],
          ease: [0.1744021985074266, -0.5, 0.8865519014643501, -0.2214168917492133],
        },
        {
          t: 4.00439785911593,
          v: [-0.0052248049102180776, -0.12515593913381462],
          ease: [0.023812816055625345, 0.31341394515796384, 0.0448947139696587, 1.0658309377957906],
        },
        { t: 4.893926749555462, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
      ],
      rotation: [
        {
          t: 0.4874467656537753,
          v: [0, 0, 0],
          ease: [0.6778358120868745, -0.22439715100065685, 0.15951040179591214, 1],
        },
        {
          t: 1.3832000000000173,
          v: [-11.013174031248813, -20.059833580125414, -12.896783267756348],
          ease: [0.5825263567433967, 0.31017058172003364, 0.04617913732408452, 1.3610608114532912],
        },
        {
          t: 1.77965296961326,
          v: [-17.48975478197329, -18.703976724880516, -12.678205332257816],
          ease: [0.22005965712189499, 0.31017058172003364, 0.04617913732408452, 0.9652306378531971],
        },
        {
          t: 2.5961328343722427,
          v: [-14.554913391638532, 17.164836260093473, 9.376528927180779],
          ease: [0.6823010997778416, 0.03975119923438924, 0.58, 0.9240336563778733],
        },
        {
          t: 3.1796016343940767,
          v: [-24.586251970533304, 0.14133926125606477, -0.7477216271856462],
          ease: [0.8034080182827295, -0.08276325518488785, 0.9143306014396848, 0.4851034680582119],
        },
        {
          t: 3.4679142027965795,
          v: [-1.0943281912285556, -1.1346215368163393, -0.7116952620126241],
          ease: [
            0.12040927423864656, -0.18872517040581954, 0.9481776569383256, -0.20917925086224787,
          ],
        },
        {
          t: 4.001861402631413,
          v: [-147.11069531984157, -0.6757806869448113, -0.4238857605398247],
          ease: [0.03131913716814155, 0.8644907690193963, 0.0448947139696587, 1.0658309377957906],
        },
        {
          t: 4.893926749555462,
          v: [-360, 0, 0],
          ease: [0.7970933306500759, -0.5, 0.24118105710043447, 0.7361553789450831],
        },
      ],
      expression: [
        {
          t: 1.8508295659644571,
          v: "surprised",
          ease: [0.7394673582995951, 0.10409628378378377, 0.6676682692307693, 1.5],
        },
        {
          t: 4.893926749555462,
          v: "neutral",
          ease: [0.8458217358299596, 0.40487753378378377, 0.13769926619433198, 0.9154349662162162],
          cut: !0,
        },
      ],
      lids: [
        { t: 1.1672000000000002, v: [0], ease: [0.42, 0, 0.58, 1] },
        { t: 1.2797000000000003, v: [1], ease: [0.42, 0, 0.58, 1] },
        { t: 1.4172000000000002, v: [0], ease: [0.42, 0, 0.58, 1] },
      ],
    },
  },
];
const Ow = 120;
const Pn = {
  clips: ["Working_A", "Working_B", "Working_C", "Working_D", "Working_E", "Working_F"],
};
const zu = {
  idle: { clips: ["Idle_B", "Idle_B", "Idle_D", "Idle_B", "Idle_A"], compactClips: ["Idle_B"] },
  listening: { clips: ["Idle_D"], face: "calm" },
  thinking: { clips: ["Idle_B"], morph: "thinking" },
  streaming: { clips: ["Streaming_A", "Streaming_B", "Streaming_C"] },
  searching: { clips: ["Idle_B"], morph: "radar" },
  reading: Pn,
  working: Pn,
  coding: Pn,
  running: Pn,
  computing: Pn,
  controlling: Pn,
  waiting: { clips: ["Idle_B"], morph: "orbit" },
  blocked: { clips: ["Blocked_A"], next: "drowsy", holdSeconds: Ow },
  finished: { clips: ["Done_B", "Done_A"], face: "happy", next: "idle" },
  failed: { clips: ["Blocked_B"], next: "idle" },
  sleeping: { clips: ["Idle_B"], face: "sleepy" },
  waking: { clips: ["Idle_B"], face: "surprised", next: "idle", holdSeconds: 1.6 },
  happy: { clips: ["Done_A"] },
  excited: { clips: ["Done_C"] },
  laughing: { clips: ["Done_B"] },
  proud: { clips: ["Marketing_B"] },
  curious: { clips: ["Working_B"], face: "inspecting" },
  playful: { clips: ["Bodymoves_A"] },
  shy: { clips: ["Idle_D"], face: "calm" },
  surprised: { clips: ["Idle_B"], face: "surprised" },
  suspicious: { clips: ["Idle_D"], face: "squinted" },
  angry: { clips: ["Blocked_A"], face: "squinted" },
  confused: { clips: ["Blocked_A"] },
  sad: { clips: ["Blocked_B"] },
  drowsy: { clips: ["Blocked_C"] },
  bored: { clips: ["Idle_B"], face: "sleepy" },
  scared: { clips: ["Idle_D"], face: "surprised" },
  celebrate: { clips: ["Rotation_A"], face: "happy" },
  approving: { clips: ["Rotation_C"], next: "idle" },
  orbit: { clips: ["Idle_B"], morph: "orbit" },
  radar: { clips: ["Idle_B"], morph: "radar" },
  progress: { clips: ["Idle_B"], morph: "progress" },
  spawning: { clips: ["Idle_B"], morph: "spawning" },
  loading: { clips: ["Idle_B"], morph: "progress" },
  dictating: { clips: ["Idle_B"], morph: "dictating" },
  sending: { clips: ["Idle_B"], morph: "sending" },
  receiving: { clips: ["Idle_B"], morph: "receiving" },
  uploading: { clips: ["Idle_B"], morph: "uploading" },
  writing: { clips: ["Idle_B"], morph: "writing" },
  alerting: { clips: ["Idle_B"], morph: "alerting" },
  bouncing: { clips: ["Idle_B"], morph: "bouncing" },
  "powering-down": { clips: ["Idle_B"], morph: "powering-down" },
  humming: { clips: ["Idle_B"], face: "calm" },
  notifying: { clips: ["Done_B"], face: "surprised" },
  dragging: { clips: ["Idle_B"], face: "surprised" },
  logo: { clips: ["Logo_A", "Logo_B"] },
  showcase: { clips: ["Marketing_A", "Marketing_B", "Marketing_C", "Marketing_D"] },
  turntable: { clips: ["Rotation_B"] },
};
const Lw = new Map(_w.map((e) => [e.name, e]));
function Nw(e) {
  const t = Lw.get(e);
  if (t == null) throw new Error(`No motion recipe named ${e}`);
  return t;
}
const Fw = "surprised";
function jw(e, t, n) {
  const r = [...e];
  for (let o = r.length - 1; o > 0; o -= 1) Du(r, o, Math.floor(t() * (o + 1)));
  const s = r.findIndex((o) => o !== n);
  return (s > 0 && Du(r, 0, s), r);
}
function Du(e, t, n) {
  const r = e[t],
    s = e[n];
  r === void 0 || s === void 0 || ((e[t] = s), (e[n] = r));
}
function zw(e, t, n = {}) {
  const r = Oa(n.seed ?? 1),
    s = new Map();
  let o = n.isCompact ?? !1,
    i = n.isResting ?? !1,
    a = !1,
    c = i,
    u = t,
    l = zu[t],
    d = 0,
    h = 0,
    f = e.loopCount,
    p = null;
  const m = () => (o && l.compactClips != null ? l.compactClips : l.clips),
    g = () => l.next != null && l.holdSeconds == null,
    y = () => {
      const x = m(),
        E = s.get(x) ?? [];
      return (E.length === 0 && E.push(...jw(x, r, p)), s.set(x, E), E.shift());
    },
    w = () => {
      const x = g() ? m()[h] : y();
      if (((f = e.loopCount), x === void 0 || x === p)) return;
      const E = c || g();
      (e.load(Nw(x), { phase: E ? 0 : (n.firstPhase ?? r()) }),
        (c = !0),
        (p = x),
        (f = e.loopCount));
    },
    S = () => {
      e.holdFace(l.face ?? (a ? Fw : null));
    },
    v = (x) => {
      ((u = x), (l = zu[x]), (d = 0), (h = 0), e.setMorph(l.morph ?? null), S(), i || w());
    };
  return (
    i && e.rest(),
    v(t),
    {
      get state() {
        return u;
      },
      get clip() {
        return p;
      },
      setState(x) {
        x !== u && v(x);
      },
      setCompact(x) {
        o = x;
      },
      setEmphasis(x) {
        x !== a && ((a = x), S());
      },
      setResting(x) {
        if (x !== i) {
          if (((i = x), !i)) {
            w();
            return;
          }
          (e.rest(), (p = null));
        }
      },
      advance(x) {
        if (i) return;
        d += x;
        const E = l.next;
        if (E != null && l.holdSeconds != null && d >= l.holdSeconds) {
          v(E);
          return;
        }
        if (e.loopCount !== f) {
          if (E != null && l.holdSeconds == null && ((h += 1), h >= m().length)) {
            v(E);
            return;
          }
          w();
        }
      },
    }
  );
}
const Dw = 0.26;
const qw = 0.57;
const mn = 0.64;
const qu = 11;
const Bw = 18;
const Bs = 48;
const Bu = 10;
const Hu = 64;
const Vu = { on: !1, oval: !1, width: 0, height: 0, tilt: 0, cx: 0, cy: 0 };
const Hw = {
  cloud: {
    width: 0.21294,
    height: 0.4668299999999999,
    gap: 0.47001600000000004,
    shiftY: 0.06999999999999999,
  },
  square: { width: 0.2553258426966292, height: 0.559752808988764, gap: 0.529408, shiftY: 0.12 },
  sparkle: {
    width: 0.18381999999999998,
    height: 0.40298999999999996,
    gap: 0.41215999999999997,
    shiftY: 0,
  },
  clover: { width: 0.23296, height: 0.51072, gap: 0.559104, shiftY: -0.020000000000000018 },
  heartChubby: {
    width: 0.18657600000000002,
    height: 0.409032,
    gap: 0.44620799999999994,
    shiftY: 0.051999999999999935,
  },
  starFlower: { width: 0.19292, height: 0.42294, gap: 0.38297600000000004, shiftY: 0.12 },
  teardrop: {
    width: 0.20779200000000003,
    height: 0.455544,
    gap: 0.45260800000000007,
    shiftY: 0.18,
  },
  tablet: { width: 0.2132, height: 0.4673999999999999, gap: 0.587776, shiftY: 0.01999999999999999 },
  wedge: { width: 0.2132, height: 0.4673999999999999, gap: 0.46771199999999996, shiftY: 0.18 },
  house: {
    width: 0.2295124,
    height: 0.5031617999999999,
    gap: 0.5125120000000001,
    shiftY: 0.18499534000463813,
  },
  star6: { width: 0.184782, height: 0.44965988999999995, gap: 0.41913343999999997, shiftY: 0.12 },
  pebble: { width: 0.23920000000000002, height: 0.5244, gap: 0.546304, shiftY: 0.12 },
  bean: { width: 0.2028, height: 0.4446, gap: 0.4608, shiftY: 0.12 },
  egg: { width: 0.23920000000000002, height: 0.5244, gap: 0.433664, shiftY: 0.11299906800092761 },
  squircle: { width: 0.23920000000000002, height: 0.5244, gap: 0.5632, shiftY: 0.12 },
  capsule: { width: 0.2106, height: 0.4617, gap: 0.36044800000000005, shiftY: 0.12 },
  cylinder: { width: 0.23920000000000002, height: 0.5244, gap: 0.47872000000000003, shiftY: 0.12 },
  hex: { width: 0.26, height: 0.57, gap: 0.64, shiftY: 0.12 },
  gem: { width: 0.23920000000000002, height: 0.5244, gap: 0.501248, shiftY: 0.12 },
  crystal: { width: 0.1612, height: 0.3534, gap: 0.3712, shiftY: 0.12 },
  shield: {
    width: 0.26790400000000003,
    height: 0.5873280000000001,
    gap: 0.44492800000000005,
    shiftY: 0.12,
  },
  dome: {
    width: 0.2132,
    height: 0.4673999999999999,
    gap: 0.47872000000000003,
    shiftY: 0.10599813600185524,
  },
  arch: {
    width: 0.19240000000000002,
    height: 0.42179999999999995,
    gap: 0.44799999999999995,
    shiftY: 0.16,
  },
  leaf: {
    width: 0.1872,
    height: 0.41039999999999993,
    gap: 0.44799999999999995,
    shiftY: 0.039999999999999994,
  },
};
function Vw(e, t, n, r) {
  const s = Hw[e],
    o = s.width / Dw,
    i = s.height / qw,
    a = s.gap / mn;
  if (t.every((h) => za(h) && !(h.fillRing != null && h.fillRing.length > 0)))
    return Gw(Uu(t[0]), Uu(t[1]), s, o, i, a, n, r);
  let u = Ww(t, o, a, i, s.shiftY),
    l = 1;
  if (r >= 0.001) {
    const [h, f] = ih(Math.max(0, Ce(mn * a, mn)), n, r);
    ((l *= h), u.length >= 2 && (u = [Wu(u[0], h), Wu(u[1], f)]));
  }
  const d = Math.max(0.08, Math.min(1.25, l));
  return { loops: u.map((h) => h.map((f) => ({ x: f.x * d, y: f.y * d }))), shiftY: 0 };
}
function Gw(e, t, n, r, s, o, i, a) {
  const c = Ce(e.width * r),
    u = Ce(e.height * r),
    l = Ce(t.width * r),
    d = Ce(t.height * r);
  let h = Math.max(0, Ce(Math.min(c, u))),
    f = Math.max(0, Ce(Math.max(c, u))),
    p = Math.max(0, Ce(Math.min(l, d))),
    m = Math.max(0, Ce(Math.max(l, d)));
  const g = Math.max(0, Ce((mn + (e.on ? Ce(e.cx) : 0) + (t.on ? Ce(t.cx) : 0)) * o, mn * o));
  if (a >= 0.001) {
    const [w, S] = ih(g, i, a);
    ((h *= w), (f *= w), (p *= S), (m *= S));
  }
  const y = Math.max(0.05, Math.min(1.8, g));
  return {
    loops: [
      Gu(-1, h, f, -Ce(Ce(e.tilt) + (c >= u ? 0 : 90)), y),
      Gu(1, p, m, Ce(Ce(t.tilt) + (l >= d ? 0 : 90)), y),
    ],
    shiftY: Ce(n.shiftY + ((Ce(e.cy) + Ce(t.cy)) / 2) * s, n.shiftY),
  };
}
function Gu(e, t, n, r, s) {
  const o = Math.max(0.01, Math.min(1, t)) / 2,
    i = Math.max(0.02, Math.min(1.8, Math.max(n, t))) / 2,
    a = (-r * Math.PI) / 180,
    c = Math.cos(a),
    u = Math.sin(a);
  return Array.from({ length: Hu }, (l, d) => {
    const h = (2 * Math.PI * d) / Hu,
      f = e * i * Math.cos(h),
      p = o * Math.sin(h);
    return { x: f * c - p * u + (e * s) / 2, y: f * u + p * c };
  });
}
function ih(e, t, n) {
  const r = Math.max(0.05, (e || mn) / 2),
    s = (t * Math.PI) / 180,
    o = Math.cos(r) || 1;
  return [
    1 + (Math.max(0.18, Math.cos(-r - s)) / o - 1) * n,
    1 + (Math.max(0.18, Math.cos(r - s)) / o - 1) * n,
  ];
}
function Wu(e, t) {
  if (e.length === 0 || Math.abs(t - 1) < 1e-4) return e;
  let n = 0,
    r = 0;
  for (const s of e) ((n += s.x), (r += s.y));
  return (
    (n /= e.length), (r /= e.length), e.map((s) => ({ x: n + (s.x - n) * t, y: r + (s.y - r) * t }))
  );
}
function Uu(e) {
  const t = za(e);
  if (!(e.wid > 0) && !t) return Vu;
  const n = e.lidY || 1,
    r = (e.tilt || 0) * (180 / Math.PI);
  if (t)
    return {
      on: !0,
      oval: !0,
      width: 2 * e.oval[0],
      height: 2 * e.oval[1] * n,
      tilt: r,
      cx: e.off[0],
      cy: e.off[1],
    };
  const s = e.pts;
  if (s.length < 2) return { ...Vu, cx: e.off[0], cy: e.off[1] };
  const o = s[0],
    i = s[s.length - 1],
    a = i[0] - o[0],
    c = i[1] - o[1],
    u = Math.hypot(a, c),
    l = 2 * e.wid;
  return {
    on: !0,
    oval: !1,
    width: l,
    height: (u + l) * n,
    tilt: Math.atan2(a, c) * (180 / Math.PI) + r,
    cx: e.off[0] + (o[0] + i[0]) / 2,
    cy: e.off[1] + ((o[1] + i[1]) / 2) * n,
  };
}
function Ww(e, t, n, r, s) {
  const o = [],
    i = -Math.sin(s);
  return (
    e.forEach((a, c) => {
      const u = za(a);
      if ((!(a.wid > 0) && !u) || (!u && a.pts.length < 2)) return;
      const l = c === 0 ? -1 : 1,
        d = a.lidY || 1,
        h = Math.cos(a.tilt || 0),
        f = Math.sin(a.tilt || 0),
        p = l * ((mn / 2 + Ce(a.off[0])) * n),
        m = i + Ce(a.off[1]) * r,
        g = (S, v) => {
          const x = S * h - v * f,
            E = S * f + v * h;
          return { x: p + l * x * t, y: m + E * t * d };
        };
      if (a.fillRing != null && a.fillRing.length >= 3) {
        const S = Ce(a.off[0]),
          v = Ce(a.off[1]);
        o.push(a.fillRing.map(([x, E]) => g(x - S, (E - v) * d)));
        return;
      }
      if (u) {
        const S = [];
        for (let v = 0; v < Bs; v++) {
          const x = (2 * Math.PI * v) / Bs;
          S.push(g(a.oval[0] * Math.cos(x), a.oval[1] * d * Math.sin(x)));
        }
        o.push(S);
        return;
      }
      const y = a.wid * t,
        w =
          a.path != null && a.path.length === Bw
            ? Kw(a.path, g, y)
            : Uw(
                a.pts.map((S) => g(S[0], S[1])),
                y,
              );
      w.length > 0 && o.push(w);
    }),
    o
  );
}
function Uw(e, t) {
  const n = [];
  for (const u of e) {
    const l = n.at(-1);
    (l == null || Math.hypot(u.x - l.x, u.y - l.y) > 1e-6) && n.push(u);
  }
  if (n.length === 0 || t <= 0) return [];
  const r = ch(n, t);
  if (r != null) return r;
  const s = n.length;
  if (s < 2) return [];
  const o = [],
    i = [];
  for (let u = 0; u < s; u++) {
    const l = n[Math.max(0, u - 1)],
      d = n[Math.min(s - 1, u + 1)],
      h = Math.hypot(d.x - l.x, d.y - l.y) || 1;
    let f = -(d.y - l.y) / h,
      p = (d.x - l.x) / h;
    (u > 0 && f * o[u - 1] + p * i[u - 1] < 0 && ((f = -f), (p = -p)), o.push(f), i.push(p));
  }
  const a = Zu(n[1].x - n[0].x, n[1].y - n[0].y),
    c = Zu(n[s - 1].x - n[s - 2].x, n[s - 1].y - n[s - 2].y);
  return ah(n, o, i, t, a, c);
}
function Kw(e, t, n) {
  if (n <= 0) return [];
  const r = [];
  for (let h = 0; h < 2; h++) {
    const f = Xu(e, h),
      p = Yu(e, h, 4),
      m = Yu(e, h + 1, 2),
      g = Xu(e, h + 1);
    for (let y = h === 0 ? 0 : 1; y < qu; y++) {
      const w = y / (qu - 1),
        S = Xw(f, p, m, g, w),
        v = Yw(f, p, m, g, w),
        x = t(S[0], S[1]),
        E = t(S[0] + v[0], S[1] + v[1]);
      r.push({ x: x.x, y: x.y, tx: E.x - x.x, ty: E.y - x.y });
    }
  }
  const s = ch(r, n);
  if (s != null) return s;
  const o = r.length,
    i = [],
    a = [];
  for (let h = 0; h < o; h++) {
    const f = Math.hypot(r[h].tx, r[h].ty) || 1;
    let p = -r[h].ty / f,
      m = r[h].tx / f;
    (h > 0 && p * i[h - 1] + m * a[h - 1] < 0 && ((p = -p), (m = -m)), i.push(p), a.push(m));
  }
  const c = r[0],
    u = r[o - 1],
    l = Math.hypot(c.tx, c.ty) || 1,
    d = Math.hypot(u.tx, u.ty) || 1;
  return ah(r, i, a, n, { x: c.tx / l, y: c.ty / l }, { x: u.tx / d, y: u.ty / d });
}
function ah(e, t, n, r, s, o) {
  const i = e.length,
    a = e.map((d, h) => ({ x: d.x + t[h] * r, y: d.y + n[h] * r })),
    c = e.map((d, h) => ({ x: d.x - t[h] * r, y: d.y - n[h] * r })),
    u = { x: e[0].x - s.x * r, y: e[0].y - s.y * r },
    l = { x: e[i - 1].x + o.x * r, y: e[i - 1].y + o.y * r };
  return [...a, ...Ku(e[i - 1], a[i - 1], l, r), ...[...c].reverse(), ...Ku(e[0], c[0], u, r)];
}
function Ku(e, t, n, r) {
  const s = [],
    o = Math.atan2(t.y - e.y, t.x - e.x);
  let a = Math.atan2(n.y - e.y, n.x - e.x) - o;
  for (; a > Math.PI;) a -= 2 * Math.PI;
  for (; a < -Math.PI;) a += 2 * Math.PI;
  const c = a >= 0 ? 1 : -1;
  for (let u = 1; u < Bu; u++) {
    const l = o + c * (u / Bu) * Math.PI;
    s.push({ x: e.x + r * Math.cos(l), y: e.y + r * Math.sin(l) });
  }
  return s;
}
function ch(e, t) {
  let n = 0,
    r = 0;
  for (const i of e) ((n += i.x), (r += i.y));
  ((n /= e.length), (r /= e.length));
  let s = 0;
  for (const i of e) s = Math.max(s, Math.hypot(i.x - n, i.y - r));
  if (t <= s * 1.05) return null;
  const o = [];
  for (let i = 0; i < Bs; i++) {
    const a = (2 * Math.PI * i) / Bs,
      c = Math.cos(a),
      u = Math.sin(a);
    let l = -1 / 0,
      d = 0,
      h = 0;
    for (const f of e) {
      const p = f.x * c + f.y * u;
      p > l && ((l = p), (d = f.x), (h = f.y));
    }
    o.push({ x: d + c * t, y: h + u * t });
  }
  return o;
}
function Xu(e, t) {
  return [e[t * 6], e[t * 6 + 1]];
}
function Yu(e, t, n) {
  return [e[t * 6] + e[t * 6 + n], e[t * 6 + 1] + e[t * 6 + n + 1]];
}
function Xw(e, t, n, r, s) {
  const o = 1 - s;
  return [
    o * o * o * e[0] + 3 * o * o * s * t[0] + 3 * o * s * s * n[0] + s * s * s * r[0],
    o * o * o * e[1] + 3 * o * o * s * t[1] + 3 * o * s * s * n[1] + s * s * s * r[1],
  ];
}
function Yw(e, t, n, r, s) {
  const o = 1 - s;
  return [
    3 * o * o * (t[0] - e[0]) + 6 * o * s * (n[0] - t[0]) + 3 * s * s * (r[0] - n[0]),
    3 * o * o * (t[1] - e[1]) + 6 * o * s * (n[1] - t[1]) + 3 * s * s * (r[1] - n[1]),
  ];
}
function Zu(e, t) {
  const n = Math.hypot(e, t) || 1;
  return { x: e / n, y: t / n };
}
function za(e) {
  return e.oval[0] > 1e-4 && e.oval[1] > 1e-4;
}
function Ce(e, t = 0) {
  return Number.isFinite(e) ? e : t;
}
const b = 114.2705;
const Zw = (e, t, n) => e.map(([r, s], o) => [r + (t[o][0] - r) * n, s + (t[o][1] - s) * n]);
const uh = 1e-10;
const Qw = 2 ** 26;
function Jw(e) {
  const t = eb(e);
  if (t == null) return [];
  const n = tb(t.map((c) => e[c])),
    [r, s, o, i] = t;
  let a = [
    [r, s, o],
    [r, s, i],
    [r, o, i],
    [s, o, i],
  ].map(([c, u, l]) => {
    const d = Uo(e, [c, u, l]);
    return Qu(d, n) > 0 ? Uo(e, [c, l, u]) : d;
  });
  return (
    e.forEach((c, u) => {
      if (t.includes(u)) return;
      const l = a.map((f) => Qu(f, c) > uh);
      if (!l.includes(!0)) return;
      const d = new Set();
      a.forEach((f, p) => {
        if (!l[p]) for (let m = 0; m < 3; m++) d.add(Ju(f.corners[m], f.corners[(m + 1) % 3]));
      });
      const h = [];
      (a.forEach((f, p) => {
        if (!l[p]) {
          h.push(f);
          return;
        }
        for (let m = 0; m < 3; m++) {
          const g = f.corners[m],
            y = f.corners[(m + 1) % 3];
          d.has(Ju(y, g)) && h.push(Uo(e, [g, y, u]));
        }
      }),
        (a = h));
    }),
    a.map((c) => c.corners)
  );
}
function eb(e) {
  if (e.length < 4) return null;
  let t = 0;
  e.forEach((i, a) => {
    i[0] < e[t][0] && (t = a);
  });
  const n = Ko(e, (i) => Di(Mt(i, e[t]))),
    r = Ko(e, (i) => Di(zi(Mt(e[n], e[t]), Mt(i, e[t])))),
    s = zi(Mt(e[n], e[t]), Mt(e[r], e[t])),
    o = Ko(e, (i) => Math.abs(Hs(s, Mt(i, e[t]))));
  return Math.abs(Hs(s, Mt(e[o], e[t]))) < uh ? null : [t, n, r, o];
}
function Uo(e, t) {
  const n = e[t[0]],
    r = zi(Mt(e[t[1]], n), Mt(e[t[2]], n)),
    s = Di(r) || 1,
    o = [r[0] / s, r[1] / s, r[2] / s];
  return { corners: t, normal: o, offset: Hs(o, n) };
}
function Qu(e, t) {
  return Hs(e.normal, t) - e.offset;
}
function Ju(e, t) {
  return e * Qw + t;
}
function Ko(e, t) {
  let n = 0,
    r = -1 / 0;
  return (
    e.forEach((s, o) => {
      const i = t(s);
      i > r && ((r = i), (n = o));
    }),
    n
  );
}
function tb(e) {
  const t = e.length;
  return [
    e.reduce((n, r) => n + r[0], 0) / t,
    e.reduce((n, r) => n + r[1], 0) / t,
    e.reduce((n, r) => n + r[2], 0) / t,
  ];
}
function Mt(e, t) {
  return [e[0] - t[0], e[1] - t[1], e[2] - t[2]];
}
function zi(e, t) {
  return [e[1] * t[2] - e[2] * t[1], e[2] * t[0] - e[0] * t[2], e[0] * t[1] - e[1] * t[0]];
}
function Hs(e, t) {
  return e[0] * t[0] + e[1] * t[1] + e[2] * t[2];
}
function Di(e) {
  return Math.hypot(e[0], e[1], e[2]);
}
const nb = [
  { x: 0.934475052698969, y: 0.004363180216799212 },
  { x: 0.948891570423846, y: 0.039714756021395174 },
  { x: 0.9608728659762679, y: 0.07607039935952659 },
  { x: 0.9703302557200477, y: 0.11326502451357987 },
  { x: 0.977189539605176, y: 0.15112675873557632 },
  { x: 0.9813908922405818, y: 0.18947802927479046 },
  { x: 0.9828887074578869, y: 0.2281365499571005 },
  { x: 0.9816519990958227, y: 0.2669163757988432 },
  { x: 0.9776625497902636, y: 0.30562830330137525 },
  { x: 0.9709166586711733, y: 0.3440810419322467 },
  { x: 0.9614266573440594, y: 0.3820827122339433 },
  { x: 0.949221424670692, y: 0.41944230284893746 },
  { x: 0.9343467338379507, y: 0.45597122804302315 },
  { x: 0.9168643128164508, y: 0.49148439126889626 },
  { x: 0.8968538338085426, y: 0.5258027955519334 },
  { x: 0.8744135590875667, y: 0.5587560766363049 },
  { x: 0.8496605481016927, y: 0.5901852347689388 },
  { x: 0.8227287687893752, y: 0.6199442885313702 },
  { x: 0.7937617531488526, y: 0.6478973166280976 },
  { x: 0.762905919754175, y: 0.6739136951531549 },
  { x: 0.7303134746505421, y: 0.6978700569784003 },
  { x: 0.6961411032024281, y: 0.7196491755310737 },
  { x: 0.6605596057818293, y: 0.7391502303914683 },
  { x: 0.6237513457393834, y: 0.7562897143525837 },
  { x: 0.5859073404691287, y: 0.7710015652906158 },
  { x: 0.5472248974285161, y: 0.7832374824769789 },
  { x: 0.507904865265839, y: 0.7929662862613107 },
  { x: 0.4681494646643414, y: 0.8001734773422571 },
  { x: 0.4281602030115182, y: 0.8048604074486263 },
  { x: 0.38813613170852307, y: 0.8070434681543606 },
  { x: 0.34827256966973696, y: 0.8067537475134688 },
  { x: 0.3087597745583025, y: 0.8040363403785654 },
  { x: 0.26978201344672026, y: 0.7989504065912386 },
  { x: 0.23151662960878241, y: 0.7915694823366872 },
  { x: 0.19413194481287305, y: 0.7819778247879767 },
  { x: 0.1577852845947917, y: 0.7702630818507747 },
  { x: 0.12262733079593371, y: 0.7565354795442158 },
  { x: 0.08880015313138229, y: 0.7409422361214794 },
  { x: 0.05642586889159421, y: 0.7236017950683938 },
  { x: 0.02561647598492663, y: 0.704659966051552 },
  { x: -0.0036037810305528913, y: 0.6895105233164277 },
  { x: -0.03317542334906984, y: 0.7095400285365243 },
  { x: -0.06438496917371282, y: 0.7280864309789705 },
  { x: -0.0971349646590295, y: 0.7450166000084965 },
  { x: -0.13130575647382275, y: 0.7601465770772312 },
  { x: -0.16677330012669841, y: 0.7733777436363767 },
  { x: -0.20339569964825052, y: 0.7845796245158417 },
  { x: -0.24101725346433553, y: 0.7936313321637897 },
  { x: -0.27947704857143557, y: 0.8004456020397803 },
  { x: -0.3186049196302664, y: 0.8049436403918587 },
  { x: -0.35822225014656567, y: 0.8070572252942809 },
  { x: -0.398143514039767, y: 0.8067313311007664 },
  { x: -0.438177182680152, y: 0.8039242993502419 },
  { x: -0.478126841210925, y: 0.7986084072202804 },
  { x: -0.5177925726656645, y: 0.7907706714017452 },
  { x: -0.5569723963185897, y: 0.7804134068929688 },
  { x: -0.5954640748960385, y: 0.7675550146764192 },
  { x: -0.6330671972405764, y: 0.7522306880298593 },
  { x: -0.6695855487964426, y: 0.734492987733704 },
  { x: -0.7048299443180804, y: 0.714412410733904 },
  { x: -0.7386209319309059, y: 0.6920772477931056 },
  { x: -0.7707921245520308, y: 0.6675935661866239 },
  { x: -0.8011924150225685, y: 0.641083697347949 },
  { x: -0.8296683466506882, y: 0.612669941116809 },
  { x: -0.8560711521836232, y: 0.5824818706921402 },
  { x: -0.8802586099360401, y: 0.550657644865542 },
  { x: -0.9021016261853626, y: 0.5173474030319016 },
  { x: -0.921488351217944, y: 0.48271361643050537 },
  { x: -0.9383250626073236, y: 0.44692900756649523 },
  { x: -0.9525363976829352, y: 0.4101742582574272 },
  { x: -0.9640652637601566, y: 0.37263580242597466 },
  { x: -0.9728702117174652, y: 0.3345029815392968 },
  { x: -0.9789264673905609, y: 0.2959671170672982 },
  { x: -0.9822255348467005, y: 0.25722000690078245 },
  { x: -0.982774894246464, y: 0.21845258628445002 },
  { x: -0.9805967489497907, y: 0.17985349925722946 },
  { x: -0.9757258679433654, y: 0.1416078138454962 },
  { x: -0.9682107746348935, y: 0.1038965717106635 },
  { x: -0.9581143826889033, y: 0.06689596974801386 },
  { x: -0.9455146116784895, y: 0.03077634172969411 },
  { x: -0.9305051553319804, y: -0.004299067407576291 },
  { x: -0.9131952327192244, y: -0.038175545674491246 },
  { x: -0.8937019647378253, y: -0.07070785611844921 },
  { x: -0.8721591451869681, y: -0.10176130887451734 },
  { x: -0.8487362913086253, y: -0.1312168064224554 },
  { x: -0.8236207468105732, y: -0.15897343836917888 },
  { x: -0.7970979502287641, y: -0.18497038865757742 },
  { x: -0.7710541733734617, y: -0.2096139557882936 },
  { x: -0.7461193861529073, y: -0.23320814197562353 },
  { x: -0.7221519248227056, y: -0.2558870618710858 },
  { x: -0.6990265515010246, y: -0.27776911859221876 },
  { x: -0.6766318459161248, y: -0.29895980890191903 },
  { x: -0.6548676461286994, y: -0.31955389248594185 },
  { x: -0.6336431338424889, y: -0.3396372581810514 },
  { x: -0.6128753135059731, y: -0.359288557412959 },
  { x: -0.5924873537443393, y: -0.3785803988633805 },
  { x: -0.5724075923763201, y: -0.3975806113171165 },
  { x: -0.5525683653066091, y: -0.4163531831687479 },
  { x: -0.5329051623123328, y: -0.43495923867716463 },
  { x: -0.5133556323648999, y: -0.45345775659418885 },
  { x: -0.49385881021048816, y: -0.47190633957419137 },
  { x: -0.4743544952965227, y: -0.4903620705111528 },
  { x: -0.4547822689301765, y: -0.5088820023697915 },
  { x: -0.43508096787875605, y: -0.5275240823754965 },
  { x: -0.41518776564532156, y: -0.5463477370262614 },
  { x: -0.39503744073179237, y: -0.565414738403984 },
  { x: -0.37456138068841166, y: -0.584789881188713 },
  { x: -0.3536868090571391, y: -0.6045421927475639 },
  { x: -0.33233545822868515, y: -0.6247456276706727 },
  { x: -0.31042247776931897, y: -0.6454805113116225 },
  { x: -0.28785488995869934, y: -0.6668347728530055 },
  { x: -0.26452992996104363, y: -0.6889057008744045 },
  { x: -0.24032737271767535, y: -0.7117848186103969 },
  { x: -0.21465925160321186, y: -0.7340046463187382 },
  { x: -0.18703495679704094, y: -0.7534714425430167 },
  { x: -0.15772553428835867, y: -0.7700652053068575 },
  { x: -0.1270070450444056, y: -0.7836711911119708 },
  { x: -0.0951684130469074, y: -0.7942311382405959 },
  { x: -0.062495032850901626, y: -0.8016579582061256 },
  { x: -0.02928242470209217, y: -0.8059763869703366 },
  { x: 0.00418250025635626, y: -0.8071603933705995 },
  { x: 0.03761179305139532, y: -0.8051997052887491 },
  { x: 0.07071763099568142, y: -0.8001090083866196 },
  { x: 0.10320959245128111, y: -0.7918885098432591 },
  { x: 0.134798677354145, y: -0.7805799374564395 },
  { x: 0.16519657722647352, y: -0.7662371932046725 },
  { x: 0.1941137081486192, y: -0.748919054724023 },
  { x: 0.22126182274327255, y: -0.7287044591356419 },
  { x: 0.24646172395988103, y: -0.705992917688509 },
  { x: 0.27042811605651085, y: -0.6833113574191189 },
  { x: 0.2935522498121435, y: -0.6614269249128338 },
  { x: 0.31594558408750634, y: -0.6402340573221494 },
  { x: 0.33770831010282365, y: -0.6196380408622824 },
  { x: 0.3589311734375708, y: -0.5995528607013482 },
  { x: 0.3796973337781967, y: -0.579900027393222 },
  { x: 0.40008347985475634, y: -0.5606067493570983 },
  { x: 0.4201613352275292, y: -0.5416052696177914 },
  { x: 0.4399985323371352, y: -0.5228315569692281 },
  { x: 0.4596595725296922, y: -0.504224454308306 },
  { x: 0.47920690986264164, y: -0.4857251046289992 },
  { x: 0.4987013585100146, y: -0.46727574968264535 },
  { x: 0.5182031792984406, y: -0.44881937116377135 },
  { x: 0.5377727619439542, y: -0.4302988919363394 },
  { x: 0.5574712942997964, y: -0.41165639717445024 },
  { x: 0.5773615598171413, y: -0.39283243400856016 },
  { x: 0.5975088031531646, y: -0.3737652763272414 },
  { x: 0.6179815681468954, y: -0.3543900575947271 },
  { x: 0.6388526754619042, y: -0.3346378544777047 },
  { x: 0.6602003073706015, y: -0.3144346462096216 },
  { x: 0.6821093031111911, y: -0.2937001458611249 },
  { x: 0.7046726622334125, y: -0.2723464324690267 },
  { x: 0.7279930725720649, y: -0.25027624068777876 },
  { x: 0.752199978996238, y: -0.22738555814564856 },
  { x: 0.7774207173704459, y: -0.20355017023582161 },
  { x: 0.8037647094696927, y: -0.17862206250636986 },
  { x: 0.8300422031017065, y: -0.15219910918500412 },
  { x: 0.8547554784773178, y: -0.1240094996536292 },
  { x: 0.8777124848745345, y: -0.09414272665900433 },
  { x: 0.8987592287763329, y: -0.06270816362882596 },
  { x: 0.9177264967761565, y: -0.029827205842901418 },
];
const bt = Math.PI * 2;
const ve = (e) => Math.round(e * 100) / 100;
const Da = (e, t, n) => (e < t ? t : e > n ? n : e);
class sn {
  d = "";
  move(t, n) {
    return ((this.d += `M${ve(t)} ${ve(n)}`), this);
  }
  line(t, n) {
    return ((this.d += `L${ve(t)} ${ve(n)}`), this);
  }
  curve(t, n, r, s, o, i) {
    return ((this.d += `C${ve(t)} ${ve(n)} ${ve(r)} ${ve(s)} ${ve(o)} ${ve(i)}`), this);
  }
  corner(t, n, r, s) {
    const o = (l, d) => {
        const h = l[0] - d[0],
          f = l[1] - d[1],
          p = Math.hypot(h, f) || 1;
        return [h / p, f / p];
      },
      i = o(t, n),
      a = o(r, n),
      c = [n[0] + i[0] * s, n[1] + i[1] * s],
      u = [n[0] + a[0] * s, n[1] + a[1] * s];
    return (
      this.d ? this.line(c[0], c[1]) : this.move(c[0], c[1]),
      (this.d += `Q${ve(n[0])} ${ve(n[1])} ${ve(u[0])} ${ve(u[1])}`),
      this
    );
  }
  arc(t, n, r, s, o, i) {
    const a = Math.max(1, Math.ceil(Math.abs(i - o) / (Math.PI / 2))),
      c = (i - o) / a,
      u = (4 / 3) * Math.tan(c / 4);
    let l = o;
    for (let d = 0; d < a; d++) {
      const h = l + c,
        f = [t + r * Math.cos(l), n + s * Math.sin(l)],
        p = [t + r * Math.cos(h), n + s * Math.sin(h)];
      (this.curve(
        f[0] - u * r * Math.sin(l),
        f[1] + u * s * Math.cos(l),
        p[0] + u * r * Math.sin(h),
        p[1] - u * s * Math.cos(h),
        p[0],
        p[1],
      ),
        (l = h));
    }
    return this;
  }
  close() {
    return this.d + "Z";
  }
}
const rb = (e) => {
  const t = e.length;
  let n = `M${ve(e[0][0])} ${ve(e[0][1])}`;
  for (let r = 0; r < t; r++) {
    const s = e[(r - 1 + t) % t],
      o = e[r],
      i = e[(r + 1) % t],
      a = e[(r + 2) % t];
    n += `C${ve(o[0] + (i[0] - s[0]) / 6)} ${ve(o[1] + (i[1] - s[1]) / 6)} ${ve(i[0] - (a[0] - o[0]) / 6)} ${ve(i[1] - (a[1] - o[1]) / 6)} ${ve(i[0])} ${ve(i[1])}`;
  }
  return n + "Z";
};
const Yn = (e, t = 128) => {
  const n = [];
  for (let r = 0; r < t; r++) n.push(e((r / t) * bt));
  return rb(n);
};
const qa = (e, t) => {
  const n = new sn(),
    r = e.length;
  for (let s = 0; s < r; s++) {
    const o = typeof t == "number" ? t : t[s % t.length];
    n.corner(e[(s - 1 + r) % r], e[s], e[(s + 1) % r], o);
  }
  return n.close();
};
const lh = (e, t, n, r = 0) =>
  qa(
    Array.from({ length: t }, (s, o) => {
      const i = r + (o / t) * bt;
      return [b + Math.cos(i) * e, b + Math.sin(i) * e];
    }),
    n,
  );
const dh = (e, t = 160) =>
  Yn((n) => {
    const r = Math.cos(n),
      s = Math.sin(n);
    let o = 0;
    for (const [i, a, c] of e) {
      const u = i - b,
        l = a - b,
        d = r * u + s * l,
        h = d * d - (u * u + l * l) + c * c;
      if (h <= 0) continue;
      const f = d + Math.sqrt(h);
      f > o && (o = f);
    }
    return [b + r * o, b + s * o];
  }, t);
const el = (e, t, n) =>
  Yn((r) => {
    const s = Math.cos(r),
      o = Math.sin(r);
    return [
      b + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * e,
      b + Math.sign(o) * Math.pow(Math.abs(o), 2 / n) * t,
    ];
  });
const sb = (e, t) =>
  new sn()
    .move(b - e + t, b - t)
    .line(b + e - t, b - t)
    .arc(b + e - t, b, t, t, -Math.PI / 2, Math.PI / 2)
    .line(b - e + t, b + t)
    .arc(b - e + t, b, t, t, Math.PI / 2, (Math.PI * 3) / 2)
    .close();
const ob = (e, t) =>
  new sn()
    .move(b - e, b + t - e)
    .line(b - e, b - t + e)
    .arc(b, b - t + e, e, e, Math.PI, bt)
    .line(b + e, b + t - e)
    .arc(b, b + t - e, e, e, 0, Math.PI)
    .close();
const ib = (e, t, n) =>
  new sn()
    .move(b - e, b - t + n)
    .arc(b, b - t + n, e, n, Math.PI, bt)
    .line(b + e, b + t - n)
    .arc(b, b + t - n, e, n, 0, Math.PI)
    .close();
const ab = (e, t, n) => {
  const r = b + t;
  return new sn()
    .move(b - e, r - n)
    .arc(b, r - n, e, 2 * t - n, Math.PI, bt)
    .line(b + e, r - n)
    .curve(b + e, r, b + e, r, b + e - n, r)
    .line(b - e + n, r)
    .curve(b - e, r, b - e, r, b - e, r - n)
    .close();
};
const cb = (e, t, n) => {
  const r = b + t,
    s = b - t + e;
  return new sn()
    .move(b - e, s)
    .arc(b, s, e, e, Math.PI, bt)
    .line(b + e, r - n)
    .curve(b + e, r, b + e, r, b + e - n, r)
    .line(b - e + n, r)
    .curve(b - e, r, b - e, r, b - e, r - n)
    .close();
};
const ub = (e, t, n) => {
  const r = b - t,
    s = b + t;
  return new sn()
    .move(b - e, r + n)
    .curve(b - e, r - 2, b - e * 0.5, r - 10, b, r - 10)
    .curve(b + e * 0.5, r - 10, b + e, r - 2, b + e, r + n)
    .curve(b + e, b + t * 0.42, b + e * 0.62, s, b, s)
    .curve(b - e * 0.62, s, b - e, b + t * 0.42, b - e, r + n)
    .close();
};
const lb = (e, t, n) =>
  Yn((r) => {
    const s = Math.cos(r),
      o = Math.sin(r),
      i = (1 - o) / 2;
    return [b + s * e * (1 - n * i * i), b + o * t];
  });
const db = (e, t, n, r) => {
  const s = Da(e / (n - t), -1, 1),
    o = Math.sqrt(1 - s * s),
    i = [b + e * o, n - e * s],
    a = [b - e * o, n - e * s],
    c = Math.atan2(i[1] - n, i[0] - b);
  return new sn()
    .corner(i, [b, t], a, r)
    .line(a[0], a[1])
    .arc(b, n, e, e, Math.PI - c, c)
    .close();
};
const hb = (e, t) =>
  qa(
    [
      [b - e, b - e],
      [b + e, b - e],
      [b + e, b + e],
      [b - e, b + e],
    ],
    t,
  );
const fb = (e, t, n, r) =>
  qa(
    [
      [b - e, b + t],
      [b + e, b + t],
      [b + e, b - t + n],
      [b, b - t],
      [b - e, b - t + n],
    ],
    r,
  );
const pb =
  "M79.4511 11.5693C94.8767 -3.85636 119.887 -3.85622 135.312 11.5693C150.738 26.995 150.738 52.0049 135.312 67.4306L129.302 73.4404L129.303 73.4414L83.7724 118.972C81.8111 120.933 79.4309 122.22 76.9199 122.833C76.463 122.944 76.0018 123.034 75.538 123.101C74.1477 123.301 72.734 123.301 71.3437 123.101C70.8802 123.034 70.4194 122.944 69.9628 122.833C69.8486 122.805 69.7347 122.776 69.621 122.745C69.3938 122.684 69.1679 122.616 68.9433 122.544C67.4837 122.073 66.0831 121.367 64.8017 120.426C64.6047 120.281 64.4108 120.13 64.2197 119.975C63.837 119.662 63.466 119.328 63.1093 118.972L11.5693 67.4306C-3.85643 52.0049 -3.85642 26.995 11.5693 11.5693C26.995 -3.85643 52.0049 -3.85643 67.4306 11.5693L73.4404 17.579L79.4511 11.5693Z";
const mb =
  "M58.9438 9.25323C63.2492 -3.08441 80.6974 -3.08441 85.0027 9.25322L91.7612 28.6207C94.0136 35.0751 100.652 38.9078 107.368 37.6311L127.52 33.8004C140.357 31.3602 149.081 46.4708 140.549 56.3681L127.156 71.9049C122.692 77.0827 122.692 84.748 127.156 89.9258L140.549 105.463C149.081 115.36 140.357 130.471 127.52 128.03L107.368 124.2C100.652 122.923 94.0136 126.756 91.7612 133.21L85.0027 152.577C80.6974 164.915 63.2492 164.915 58.9438 152.577L52.1853 133.21C49.933 126.756 43.2946 122.923 36.5788 124.2L16.4268 128.03C3.58942 130.471 -5.1347 115.36 3.39733 105.463L16.7908 89.9258C21.2543 84.748 21.2543 77.0827 16.7908 71.9049L3.39734 56.3681C-5.13469 46.4708 3.58941 31.3602 16.4268 33.8004L36.5787 37.6311C43.2946 38.9078 49.933 35.0751 52.1853 28.6207L58.9438 9.25323Z";
const gb =
  "M93.9365 0.100586C98.4439 -0.387322 102.691 0.897134 106.341 4.03418C111.502 8.47087 114.842 16.0545 116.636 25.2725C118.36 34.1341 118.716 44.8177 117.701 56.4346L117.707 56.4375L117.706 56.4443C122.25 58.5638 126.519 60.8171 130.449 63.168C130.485 63.1891 130.52 63.2103 130.556 63.2314C131.25 63.6478 131.934 64.067 132.607 64.4893C132.68 64.5349 132.753 64.5813 132.825 64.627C133.074 64.7838 133.322 64.941 133.567 65.0986C133.692 65.1787 133.816 65.2596 133.94 65.3398C134.138 65.4676 134.335 65.5954 134.53 65.7236C134.653 65.8039 134.775 65.8844 134.896 65.9648C135.112 66.1073 135.325 66.2506 135.538 66.3936C135.625 66.4522 135.713 66.5106 135.8 66.5693C138.866 68.645 141.667 70.7792 144.163 72.9502C149.754 77.8126 153.981 83.0002 156.136 88.2578C156.159 88.3133 156.181 88.3693 156.203 88.4248C156.268 88.5868 156.332 88.749 156.393 88.9111C156.435 89.0226 156.475 89.1346 156.516 89.2461C156.541 89.3175 156.566 89.3895 156.591 89.4609C157.443 91.8917 157.839 94.3199 157.696 96.7109C157.522 99.7997 156.469 102.655 154.613 105.192C154.236 105.709 153.826 106.208 153.388 106.692C153.365 106.717 153.343 106.742 153.32 106.767C153.171 106.93 153.019 107.091 152.863 107.25C152.844 107.27 152.824 107.29 152.804 107.311C152.3 107.822 151.762 108.316 151.191 108.79C151.168 108.81 151.144 108.83 151.12 108.85C150.952 108.988 150.781 109.125 150.607 109.261C150.558 109.299 150.509 109.337 150.46 109.375C150.282 109.512 150.101 109.648 149.917 109.781C149.903 109.792 149.888 109.801 149.874 109.812C149.255 110.26 148.605 110.689 147.926 111.1C147.795 111.179 147.662 111.256 147.528 111.334C147.41 111.403 147.292 111.473 147.173 111.541C146.915 111.687 146.653 111.832 146.388 111.974C146.316 112.012 146.243 112.047 146.171 112.085C145.978 112.186 145.783 112.287 145.586 112.386C145.459 112.449 145.331 112.511 145.203 112.573C145.048 112.649 144.891 112.723 144.733 112.797C144.614 112.853 144.494 112.909 144.373 112.964C144.198 113.044 144.021 113.122 143.843 113.2C143.722 113.253 143.6 113.306 143.478 113.358C143.288 113.439 143.096 113.519 142.903 113.598C142.836 113.625 142.769 113.655 142.701 113.683C142.662 113.698 142.622 113.712 142.583 113.728C142.371 113.812 142.156 113.895 141.94 113.978C141.847 114.013 141.753 114.051 141.658 114.086C140.71 114.441 139.731 114.771 138.725 115.078C138.613 115.112 138.502 115.145 138.39 115.179C138.257 115.218 138.123 115.26 137.989 115.299C137.911 115.322 137.831 115.343 137.752 115.365C137.61 115.406 137.467 115.446 137.324 115.485C137.095 115.549 136.863 115.611 136.63 115.672C136.52 115.701 136.41 115.73 136.3 115.759C136.064 115.819 135.827 115.879 135.588 115.938C135.451 115.971 135.314 116.004 135.177 116.037C134.975 116.085 134.772 116.131 134.568 116.178C134.312 116.236 134.054 116.294 133.795 116.35C133.535 116.406 133.274 116.461 133.011 116.515C132.85 116.547 132.688 116.578 132.525 116.61C132.333 116.648 132.14 116.686 131.946 116.723C131.689 116.771 131.43 116.818 131.17 116.864C131.075 116.881 130.979 116.898 130.884 116.914C130.595 116.964 130.304 117.012 130.012 117.06C129.932 117.073 129.851 117.085 129.771 117.098C129.484 117.143 129.196 117.188 128.906 117.23C128.818 117.243 128.729 117.256 128.641 117.269C127.33 117.457 125.983 117.62 124.601 117.755C124.468 117.768 124.336 117.782 124.203 117.794C123.92 117.82 123.636 117.845 123.351 117.869C123.24 117.878 123.13 117.888 123.02 117.897C122.701 117.923 122.381 117.948 122.059 117.971C121.967 117.977 121.874 117.984 121.782 117.99C121.463 118.012 121.143 118.033 120.82 118.053C120.73 118.058 120.639 118.063 120.549 118.068C119.546 118.126 118.527 118.171 117.492 118.202C117.322 118.207 117.151 118.213 116.979 118.218C116.785 118.223 116.59 118.225 116.395 118.229C116.147 118.235 115.899 118.24 115.65 118.244C115.415 118.248 115.178 118.25 114.94 118.252C114.688 118.254 114.435 118.256 114.181 118.257C114.008 118.257 113.835 118.257 113.662 118.257C113.32 118.256 112.976 118.255 112.631 118.252C112.503 118.251 112.375 118.25 112.247 118.248C111.858 118.243 111.466 118.237 111.073 118.229C110.984 118.227 110.894 118.226 110.804 118.224C107.734 118.154 104.558 117.977 101.289 117.69C96.3593 128.261 90.7082 137.338 84.7832 144.151C78.6204 151.238 71.9357 156.137 65.2471 157.399C60.5179 158.292 56.1975 157.281 52.5381 154.604C48.9431 151.975 46.1246 147.845 44.0479 142.691C40.0321 132.725 38.5457 118.333 40.043 101.281C40.0382 101.279 40.0331 101.277 40.0283 101.274C39.6986 101.121 39.3711 100.965 39.0449 100.811C38.8351 100.711 38.6254 100.612 38.417 100.512C38.0794 100.35 37.7438 100.186 37.4102 100.023C37.2392 99.9399 37.0684 99.8563 36.8984 99.7725C36.5886 99.6196 36.2801 99.4663 35.9736 99.3125C35.7564 99.2034 35.5398 99.0939 35.3242 98.9844C34.9817 98.8104 34.6409 98.636 34.3027 98.4609C34.2424 98.4297 34.1823 98.3975 34.1221 98.3662C19.2858 90.6566 8.70839 81.8767 3.56055 73.3232C3.50461 73.2303 3.44926 73.137 3.39453 73.0439C3.37308 73.0075 3.35134 72.971 3.33008 72.9346C3.19352 72.7003 3.06142 72.4652 2.93262 72.2305C2.19429 70.8865 1.58552 69.5375 1.11816 68.1895C1.10444 68.1499 1.09161 68.1099 1.07813 68.0703C1.04009 67.9586 1.00191 67.847 0.96582 67.7354C0.954674 67.7009 0.943578 67.6663 0.932617 67.6318C0.823298 67.2877 0.723275 66.9435 0.632813 66.5996C-0.103732 63.8123 -0.218301 61.0433 0.402344 58.3643C1.34437 54.2986 3.89972 50.7745 7.875 47.9023C7.90661 47.8794 7.93796 47.8559 7.96973 47.833C8.12646 47.7208 8.2852 47.6092 8.44629 47.499C8.57825 47.4084 8.71216 47.3194 8.84668 47.2305C8.87052 47.2148 8.89404 47.1983 8.91797 47.1826C10.608 46.0723 12.497 45.0908 14.5547 44.2324C14.6355 44.1986 14.7165 44.1643 14.7979 44.1309C14.8508 44.1092 14.9038 44.087 14.957 44.0654L15.25 43.9482C15.3501 43.9084 15.4509 43.8694 15.5518 43.8301C15.6093 43.8078 15.6668 43.7848 15.7246 43.7627C23.7646 40.6682 34.1765 39.3165 45.6846 39.4756C45.8574 39.4779 46.0307 39.4814 46.2041 39.4844C46.4305 39.4884 46.6576 39.4909 46.8848 39.4961C47.3568 39.5065 47.8313 39.5207 48.3076 39.5361C48.4142 39.5397 48.5212 39.5441 48.6279 39.5479C51.1795 39.6366 53.791 39.7967 56.4512 40.0293C63.6811 24.5137 72.1655 12.7934 80.627 6.1709C85.0025 2.74635 89.5085 0.57999 93.9365 0.100586Z";
const yb = (e, t) =>
  dh([
    [b - e, b - e, t],
    [b + e, b - e, t],
    [b + e, b + e, t],
    [b - e, b + e, t],
  ]);
const kb = (e, t, n) =>
  Yn((r) => {
    const s = Math.cos(r),
      o = Math.sin(r);
    return [b + s * e * Math.pow(Math.max(1 - o * o, 0), n / 2 - 0.5) * 1, b + o * t];
  });
const wb = (e, t, n, r) =>
  Yn((s) => {
    const o = (a) => {
        const c = Math.abs(((((s - a + Math.PI) % bt) + bt) % bt) - Math.PI);
        return Math.exp(-(c * c) / 0.4232);
      },
      i = 1 - n * o(r) + n * 0.34 * o(r + Math.PI);
    return [b + Math.cos(s) * e * i, b + Math.sin(s) * t * i];
  });
const bb = (e, t, n) =>
  Yn((r) => {
    const s = e * (1 + t * (Math.sin(r * 2 + n) * 0.6 + Math.sin(r * 3 - n) * 0.4));
    return [b + Math.cos(r) * s, b + Math.sin(r) * s * 0.98];
  });
const Vs = (e, t = 4) => {
  const n = e.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [],
    r = [];
  let s = 0,
    o = "",
    i = 0,
    a = 0,
    c = 0,
    u = 0;
  const l = () => parseFloat(n[s++]),
    d = (h, f) => {
      const p = Math.max(2, Math.ceil(f / t));
      for (let m = 1; m <= p; m++) r.push(h(m / p));
    };
  for (; s < n.length;) {
    if ((/[a-z]/i.test(n[s]) && (o = n[s++].toUpperCase()), o === "Z")) {
      (Math.hypot(c - i, u - a) > 0.01 &&
        d((h) => [i + (c - i) * h, a + (u - a) * h], Math.hypot(c - i, u - a)),
        (i = c),
        (a = u));
      continue;
    }
    if (s >= n.length) break;
    if (o === "M") ((i = l()), (a = l()), (c = i), (u = a), r.push([i, a]), (o = "L"));
    else if (o === "L") {
      const h = l(),
        f = l();
      (d((p) => [i + (h - i) * p, a + (f - a) * p], Math.hypot(h - i, f - a)), (i = h), (a = f));
    } else if (o === "Q") {
      const h = l(),
        f = l(),
        p = l(),
        m = l(),
        g = i,
        y = a;
      (d(
        (w) => {
          const S = 1 - w;
          return [S * S * g + 2 * S * w * h + w * w * p, S * S * y + 2 * S * w * f + w * w * m];
        },
        Math.hypot(h - i, f - a) + Math.hypot(p - h, m - f),
      ),
        (i = p),
        (a = m));
    } else {
      const h = l(),
        f = l(),
        p = l(),
        m = l(),
        g = l(),
        y = l(),
        w = i,
        S = a;
      (d(
        (v) => {
          const x = 1 - v;
          return [
            x * x * x * w + 3 * x * x * v * h + 3 * x * v * v * p + v * v * v * g,
            x * x * x * S + 3 * x * x * v * f + 3 * x * v * v * m + v * v * v * y,
          ];
        },
        Math.hypot(h - i, f - a) + Math.hypot(p - h, m - f) + Math.hypot(g - p, y - m),
      ),
        (i = g),
        (a = y));
    }
  }
  return r;
};
const xb = (e, t = 160) => {
  let n = 1 / 0,
    r = -1 / 0;
  for (const d of e) (d[1] < n && (n = d[1]), d[1] > r && (r = d[1]));
  const s = r - n,
    o = (d) => n + (s * (d + 0.5)) / t,
    i = new Float64Array(t),
    a = new Float64Array(t),
    c = new Float64Array(t),
    u = new Float64Array(t);
  for (let d = 0; d < t; d++) {
    const h = o(d);
    let f = -1 / 0,
      p = 1 / 0,
      m = 1 / 0,
      g = -1 / 0;
    for (let y = 0; y < e.length; y++) {
      const w = e[y],
        S = e[(y + 1) % e.length];
      if (w[1] <= h == S[1] <= h) continue;
      const v = w[0] + ((S[0] - w[0]) * (h - w[1])) / (S[1] - w[1]);
      (v <= b ? v > f && (f = v) : v < p && (p = v), v < m && (m = v), v > g && (g = v));
    }
    ((i[d] = Number.isFinite(f) ? f : b),
      (a[d] = Number.isFinite(p) ? p : b),
      (c[d] = Number.isFinite(m) ? m : b),
      (u[d] = Number.isFinite(g) ? g : b));
  }
  const l = (d, h) => (f) => {
    const p = Da(((f - n) / s) * t - 0.5, 0, t - 1),
      m = Math.floor(p),
      g = p - m,
      y = Math.min(m + 1, t - 1);
    return [d[m] + (d[y] - d[m]) * g, h[m] + (h[y] - h[m]) * g];
  };
  return { top: n, bottom: r, spanAt: l(i, a), outerAt: l(c, u) };
};
const tl = 96;
const vb = (e) =>
  Array.from({ length: tl }, (t, n) => {
    const r = (n / tl) * bt,
      s = Math.cos(r),
      o = Math.sin(r);
    let i = 0;
    for (let a = 0; a < e.length; a++) {
      const c = e[a],
        u = e[(a + 1) % e.length],
        l = c[0] - b,
        d = c[1] - b,
        h = u[0] - b,
        f = u[1] - b,
        p = (h - l) * o - (f - d) * s;
      if (Math.abs(p) < 1e-9) continue;
      const m = (l * o - d * s) / -p;
      if (m < 0 || m > 1) continue;
      const g = (l + (h - l) * m) * s + (d + (f - d) * m) * o;
      g > i && (i = g);
    }
    return [b + s * i, b + o * i];
  });
const Sb = (e, t, n, r) => {
  let s = 0;
  return e.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (o) => {
    s ^= 1;
    const i = parseFloat(o) + (s ? n : r);
    return String(ve(b + (i - b) * t));
  });
};
const Mb = 228.44;
const Tb = (e) => {
  let t = 1 / 0,
    n = -1 / 0,
    r = 1 / 0,
    s = -1 / 0;
  for (const c of e)
    (c[0] < t && (t = c[0]),
      c[0] > n && (n = c[0]),
      c[1] < r && (r = c[1]),
      c[1] > s && (s = c[1]));
  const o = b - (t + n) / 2,
    i = b - (r + s) / 2;
  return { k: Da(Mb / Math.max(n - t, s - r), 0.9, 1.35), dx: o, dy: i };
};
const Eb = (e, t) => {
  const { k: n, dx: r, dy: s } = Tb(t);
  return Math.abs(n - 1) < 0.005 && Math.abs(r) < 0.5 && Math.abs(s) < 0.5 ? e : Sb(e, n, r, s);
};
const Ba = (e) => {
  const t = Eb(e, Vs(e)),
    n = Vs(t),
    { top: r, bottom: s, spanAt: o, outerAt: i } = xb(n);
  let a = 0;
  for (let c = r; c <= s; c += 2) {
    const [u, l] = i(c);
    a = Math.max(a, (l - u) / 2);
  }
  return { path: t, ring: vb(n), top: ve(r), bottom: ve(s), spanAt: o, beltRadius: ve(a) };
};
const Pb = {
  pebble: () => bb(108, 0.075, 1.1),
  bean: () => wb(94, 112, 0.34, Math.PI),
  egg: () => lb(98, 113, 0.22),
  squircle: () => el(107, 107, 3.2),
  square: () => hb(107, 28),
  tablet: () => sb(114, 74),
  capsule: () => ob(72, 113),
  cylinder: () => ib(94, 110, 48),
  hex: () => lh(114, 6, 20, Math.PI / 6),
  gem: () => el(112, 113, 1.5),
  shield: () => ub(98, 108, 30),
  dome: () => ab(114, 82, 26),
  arch: () => cb(76, 113, 42),
  cloud: () =>
    dh([
      [b - 62, b + 26, 56],
      [b + 62, b + 26, 54],
      [b, b + 34, 62],
      [b - 24, b - 30, 62],
      [b + 38, b - 26, 54],
    ]),
  leaf: () => kb(88, 113, 1.5),
  clover: () => yb(38, 58),
  house: () => fb(100, 110, 78, 29),
  heart: () => pb,
  sparkle: () => gb,
  star6: () => mb,
};
const nl = new Map();
function Rr(e) {
  const t = nl.get(e);
  if (t != null) return t;
  const n = Ba(Pb[e]());
  return (nl.set(e, n), n);
}
const ut = (e, t = 4) => Vs(Rr(e).path, t);
const rl = (e) => Vs(e);
const hh = (e, t) => Ba(db(e, b - 114, b + 26, t));
const Ib = (e, t) => Ba(lh(130, 3, [t, e, e], -Math.PI / 2));
const Mr = Math.PI * 2;
const Ab = 0.36;
const $b = 0.22;
const mr = 4;
const sl = 96;
const ol = 64;
const il = 33;
const Cb = 40;
const fh = 0.72;
const al = 16;
const cl = 160;
const In = 180;
const Xo = 64;
const Yr = 1e-5;
const _b = {
  pebble: () => An(1.2167999999999999, "pebble"),
  bean: () => {
    const e = jb("bean");
    return {
      size: 1.17,
      silhouette: { kind: "solid", samples: [], balls: e, isLoop: !1 },
      seat: mh("bean", e),
    };
  },
  egg: () => An(1.17, "egg"),
  squircle: () => ({
    size: 1.17,
    silhouette: Dn(Lb("squircle", 0.28, 0.11)),
    seat: { kind: "front", faceZ: 0.28 },
  }),
  tablet: () => {
    const { x0: e, x1: t, y0: n, y1: r } = qi("tablet"),
      s = (t - e) / 2 / b,
      o = (r - n) / 2 / b,
      i = Math.max(0, s - o);
    return {
      size: 1.3922999999999999,
      silhouette: { kind: "solid", samples: [], balls: pl("tablet", "x"), isLoop: !1 },
      seat: {
        kind: "wrapX",
        wrapR: o,
        wrapX0: -s + 0.02,
        wrapX1: s - 0.02,
        radiusAtX: (a) => {
          const c = Math.abs(a) - i;
          return c <= 0 ? o : Math.sqrt(Math.max(0, o * o - c * c));
        },
      },
    };
  },
  capsule: () => {
    const e = pl("capsule", "y"),
      { y0: t, y1: n } = qi("capsule"),
      r = -(n - b) / b,
      s = -(t - b) / b,
      { hx: o, hz: i } = Fb(e);
    return {
      size: 1.17,
      silhouette: { kind: "solid", samples: [], balls: e, isLoop: !1 },
      seat: {
        kind: "wrap",
        wrapR: Math.max(0.35, (o + i) * 0.5),
        wrapY0: r,
        wrapY1: s,
        eyeY: (r + s) * 0.5,
      },
    };
  },
  cylinder: () => dl("cylinder", (e, t) => (t + e) * 0.5),
  hex: () => $n(1.2519, Bt(ut("hex"))),
  gem: () => An(1.17, "gem"),
  crystal: () => ({
    size: 1.3805999999999998,
    silhouette: Dn(Nb()),
    seat: { kind: "front", faceZ: 0.64 * (Math.sqrt(3) / 2) },
  }),
  wedge: () => {
    const e = Ib(60, 80),
      t = rl(e.path),
      [n, r] = e.spanAt(e.top + (e.bottom - e.top) * 0.5),
      s = -(e.top - b) / b,
      o = -(e.bottom - b) / b;
    return {
      size: 1.3590719999999998,
      silhouette: Dn(Bi(t)),
      seat: {
        kind: "wrap",
        wrapR: Math.max(0.2, (r - n) / 2 / b),
        wrapY0: o,
        wrapY1: s,
        eyeY: s + (o - s) * 0.5,
        radiusAt: Hi(t),
      },
    };
  },
  shield: () => An(1.17, "shield"),
  dome: () => An(1.17, "dome"),
  arch: () => dl("arch", (e, t) => e + (t - e) * 0.42),
  cloud: () => hl(1.3455, Bt(ut("cloud", 1)), 0.72),
  teardrop: () => {
    const e = hh(88, 48),
      t = rl(e.path),
      [n, r] = e.spanAt(e.top + (e.bottom - e.top) * 0.62),
      s = -(e.bottom - b) / b,
      o = -(e.top - b) / b;
    return {
      size: 1.318122,
      silhouette: Dn(Bi(t)),
      seat: {
        kind: "wrap",
        wrapR: Math.max(0.2, (r - n) / 2 / b),
        wrapY0: s,
        wrapY1: o,
        eyeY: (s + o) * 0.5,
        radiusAt: Hi(t),
      },
    };
  },
  leaf: () => An(1.17, "leaf"),
  square: () => $n(1.0413, Bt(ut("square"))),
  starFlower: () => $n(1.3922999999999999, Db()),
  sparkle: () => $n(1.521, Bt(ut("sparkle"))),
  clover: () => $n(1.0881, Bt(ut("clover"))),
  heartChubby: () => hl(1.3571999999999997, nb, 0.62),
  house: () => $n(1.17, Bt(ut("house"))),
  star6: () => ph(1.4976, Bt(ut("star6")), 0.3, 0.18),
};
const ul = new Map();
let ll = null;
function co(e) {
  const t = ul.get(e);
  if (t != null) return t;
  const n = _b[e]();
  return (ul.set(e, n), n);
}
function Rb() {
  return (
    (ll ??= {
      size: 1.17,
      silhouette: { kind: "solid", samples: Bt(ut("bean")), balls: [], isLoop: !0 },
      seat: null,
    }),
    ll
  );
}
function Dn(e) {
  return { kind: "solid", samples: e, balls: [], isLoop: !1 };
}
function An(e, t) {
  return { size: e, silhouette: Dn(yh(t)), seat: mh(t, []) };
}
function dl(e, t) {
  const n = Rr(e),
    r = -(n.top - b) / b,
    s = -(n.bottom - b) / b;
  return {
    size: 1.17,
    silhouette: Dn(yh(e)),
    seat: {
      kind: "wrap",
      wrapR: n.beltRadius / b,
      wrapY0: s,
      wrapY1: r,
      eyeY: t(r, s),
      radiusAt: kh(e),
    },
  };
}
function $n(e, t) {
  return ph(e, t, Ab, $b);
}
function ph(e, t, n, r) {
  return {
    size: e,
    silhouette: { kind: "extrusion", rings: zb(t, n, r) },
    seat: { kind: "front", faceZ: n },
  };
}
function hl(e, t, n) {
  const r = qb(t, n);
  return {
    size: e,
    silhouette: { kind: "loft", rings: r.rings },
    seat: { kind: "loft", surfaceZ: Bb(r) },
  };
}
function mh(e, t) {
  const n = Rr(e),
    r = -(n.bottom - b) / b,
    s = -(n.top - b) / b,
    o = kh(e),
    i = Math.min(s - 0.02, Math.max(r + 0.02, 0));
  return {
    kind: "wrap",
    wrapR: o(i),
    wrapY0: r,
    wrapY1: s,
    eyeY: i,
    radiusAt: o,
    puffAt: t.length > 0 ? (a, c) => Ob(t, a, c) : void 0,
  };
}
function Ob(e, t, n) {
  let r = e[0],
    s = -1 / 0,
    o = 1 / 0,
    i = !1;
  for (const a of e) {
    const c = Math.hypot(t - a[0], n - a[1]);
    if (c < a[3]) {
      const u = a[2] + Math.sqrt(a[3] * a[3] - c * c);
      (!i || u > s) && ((i = !0), (s = u), (r = a));
    } else !i && c - a[3] < o && ((o = c - a[3]), (r = a));
  }
  return { x: r[0], y: r[1], z: r[2], r: r[3] };
}
function Bt(e) {
  return e.map(([t, n]) => ({ x: (t - b) / b, y: -(n - b) / b, z: 0 }));
}
function qi(e) {
  let t = 1 / 0,
    n = -1 / 0,
    r = 1 / 0,
    s = -1 / 0;
  for (const [o, i] of Rr(e).ring)
    (o < t && (t = o), o > n && (n = o), i < r && (r = i), i > s && (s = i));
  return { x0: t, x1: n, y0: r, y1: s };
}
function Lb(e, t, n) {
  const r = Rr(e).ring.map(([i, a]) => ({ x: (i - b) / b, y: -(a - b) / b })),
    s = r.length,
    o = [];
  for (let i = 0; i < s; i++) {
    const a = r[i],
      c = r[(i - 1 + s) % s],
      u = r[(i + 1) % s];
    let l = u.y - c.y,
      d = -(u.x - c.x);
    const h = Math.hypot(l, d) || 1;
    ((l /= h), (d /= h), l * a.x + d * a.y < 0 && ((l = -l), (d = -d)));
    for (let f = 0; f <= mr; f++) {
      const p = (f / mr) * (Math.PI / 2),
        m = n * (1 - Math.cos(p)),
        g = t - n + n * Math.sin(p);
      (o.push({ x: a.x - l * m, y: a.y - d * m, z: g }),
        o.push({ x: a.x - l * m, y: a.y - d * m, z: -g }));
    }
  }
  return o;
}
function Nb() {
  const s = 1.1600000000000001,
    o = [
      { x: 0, y: s - 0.12, z: 0 },
      { x: 0, y: -s + 0.12, z: 0 },
    ],
    i = 0.54 - 0.12 * 0.25,
    a = 0.64 - 0.12;
  for (const d of [-1, 1])
    for (let h = 0; h < 6; h++) {
      const f = (h / 6) * Mr;
      o.push({ x: a * Math.cos(f), y: d * i, z: a * Math.sin(f) });
    }
  const c = [],
    u = 8,
    l = 14;
  for (const d of o)
    for (let h = 0; h <= u; h++) {
      const f = (h / u) * Math.PI,
        p = Math.sin(f),
        m = h === 0 || h === u ? 1 : l;
      for (let g = 0; g < m; g++) {
        const y = (g / m) * Mr;
        c.push({
          x: d.x + 0.12 * p * Math.sin(y),
          y: d.y + 0.12 * Math.cos(f),
          z: d.z + 0.12 * p * Math.cos(y),
        });
      }
    }
  return c;
}
function gh(e) {
  const t = e.length;
  let n = 1 / 0,
    r = -1 / 0;
  for (const [, i] of e) (i < n && (n = i), i > r && (r = i));
  ((n -= Yr), (r += Yr));
  const s = (i) => Math.min(Xo - 1, Math.floor(((i - n) / (r - n)) * Xo)),
    o = Array.from({ length: Xo }, () => []);
  for (let i = 0; i < t; i++) {
    const a = e[i][1],
      c = e[(i + 1) % t][1],
      u = s(Math.max(a, c) + Yr);
    for (let l = s(Math.min(a, c) - Yr); l <= u; l++) o[l].push(i);
  }
  return (i) => {
    let a = 1 / 0,
      c = -1 / 0;
    if (!(i >= n && i <= r)) return c - a;
    for (const u of o[s(i)]) {
      const [l, d] = e[u],
        [h, f] = e[(u + 1) % t];
      if (Math.abs(f - d) < 1e-9) {
        Math.abs(d - i) < 1e-6 && ((a = Math.min(a, l, h)), (c = Math.max(c, l, h)));
        continue;
      }
      if ((d <= i && f >= i) || (f <= i && d >= i)) {
        const p = l + ((h - l) * (i - d)) / (f - d);
        (p < a && (a = p), p > c && (c = p));
      }
    }
    return c - a;
  };
}
function yh(e) {
  return Bi(ut(e));
}
function Bi(e) {
  let t = 1 / 0,
    n = -1 / 0;
  for (const [, f] of e) (f < t && (t = f), f > n && (n = f));
  const r = [],
    s = -(t - b) / b,
    o = -(n - b) / b,
    i = gh(e),
    a = (f) => {
      const p = i(f);
      return p < 0 ? 0 : p / 2 / b;
    },
    c = n - t,
    u = (f, p) => {
      if (a(f) >= 0.06) return null;
      const m = a(f);
      let g = c * 0.02;
      for (let y = c / 512; y <= c * 0.05; y += c / 512)
        if (Math.abs(a(f + p * y) - m) > 1e-4) {
          g = y;
          break;
        }
      return { yEdge: f, sign: p, dJoin: g, rJoin: a(f + p * g) };
    },
    l = [u(t, 1), u(n, -1)].filter((f) => f !== null),
    d = (f) => {
      let p = a(f);
      for (const m of l) {
        const g = (f - m.yEdge) * m.sign;
        g >= 0 && g < m.dJoin && (p = Math.min(p, m.rJoin * Math.sqrt(g / m.dJoin)));
      }
      return p;
    },
    h = (f, p) => {
      const m = d(p);
      m < 0.06 ? r.push({ x: 0, y: f, z: 0 }) : r.push(...fl(f, m));
    };
  h(s, t);
  for (let f = 1; f < sl - 1; f++) {
    const p = (1 - Math.cos(Math.PI * (f / (sl - 1)))) / 2,
      m = t + (n - t) * p,
      g = d(m),
      y = -(m - b) / b;
    if (g < 1e-4) {
      r.push({ x: 0, y, z: 0 });
      continue;
    }
    r.push(...fl(y, g));
  }
  return (h(o, n), r);
}
function fl(e, t) {
  const n = [];
  for (let r = 0; r < ol; r++) {
    const s = (r / ol) * Mr;
    n.push({ x: t * Math.sin(s), y: e, z: t * Math.cos(s) });
  }
  return n;
}
function kh(e) {
  return Hi(ut(e));
}
function Hi(e) {
  const t = gh(e);
  let n = 1 / 0,
    r = -1 / 0;
  for (const [, s] of e) (s < n && (n = s), s > r && (r = s));
  return (s) => {
    const o = Math.max(n, Math.min(r, b - s * b));
    return Math.max(0.02, t(o) / 2 / b);
  };
}
function pl(e, t) {
  const { x0: n, x1: r, y0: s, y1: o } = qi(e),
    i = (r - n) / 2 / b,
    a = (o - s) / 2 / b,
    c = t === "x" ? a : i,
    u = Math.max(0, (t === "x" ? i : a) - c),
    l = -u,
    d = [];
  for (let h = 0; h < il; h++) {
    const f = l + (u - l) * (h / (il - 1));
    d.push(t === "x" ? [f, 0, 0, c] : [0, f, 0, c]);
  }
  return d;
}
function Fb(e) {
  let t = 0.55,
    n = 0.35;
  for (const [r, , s, o] of e)
    ((t = Math.max(t, Math.abs(r) + o)), (n = Math.max(n, Math.abs(s) + o)));
  return { hx: t, hz: n };
}
function jb(e) {
  const t = ut(e);
  let n = 1 / 0,
    r = -1 / 0,
    s = 1 / 0,
    o = -1 / 0;
  for (const [l, d] of t)
    ((n = Math.min(n, l)), (r = Math.max(r, l)), (s = Math.min(s, d)), (o = Math.max(o, d)));
  const i = (l, d) => {
      let h = !1;
      const f = t.length;
      for (let p = 0, m = f - 1; p < f; m = p++) {
        const [g, y] = t[p],
          [w, S] = t[m];
        y > d != S > d && l < g + ((w - g) * (d - y)) / (S - y) && (h = !h);
      }
      return h;
    },
    a = Math.max(r - n, o - s) / Cb,
    c = [];
  for (let l = s + a / 2; l < o; l += a)
    for (let d = n + a / 2; d < r; d += a) {
      if (!i(d, l)) continue;
      let h = 1 / 0;
      for (const [p, m] of t) h = Math.min(h, (p - d) ** 2 + (m - l) ** 2);
      const f = Math.sqrt(h);
      f > a && c.push({ x: d, y: l, r: f });
    }
  c.sort((l, d) => d.r - l.r);
  const u = [];
  for (const l of c)
    u.some((d) => Math.hypot(l.x - d.x, l.y - d.y) + l.r <= d.r + a * 0.25) || u.push(l);
  return u.map((l) => [(l.x - b) / b, -(l.y - b) / b, 0, l.r / b]);
}
function zb(e, t, n) {
  let r = 1 / 0,
    s = -1 / 0,
    o = 1 / 0,
    i = -1 / 0;
  for (const h of e)
    ((r = Math.min(r, h.x)),
      (s = Math.max(s, h.x)),
      (o = Math.min(o, h.y)),
      (i = Math.max(i, h.y)));
  const a = (r + s) / 2,
    c = (o + i) / 2,
    u = Math.max(1e-4, Math.min((s - r) / 2, (i - o) / 2)),
    l = (h, f) => {
      const p = (h / mr) * (Math.PI / 2),
        m = t - n + n * Math.sin(p);
      return { z: f < 0 ? -m : m, scale: 1 - (n / u) * (1 - Math.cos(p)) };
    },
    d = [];
  for (let h = mr; h >= 0; h--) d.push(l(h, -1));
  for (let h = 0; h <= mr; h++) d.push(l(h, 1));
  return d.map(({ z: h, scale: f }) =>
    e.map((p) => ({ x: a + (p.x - a) * f, y: c + (p.y - c) * f, z: h })),
  );
}
function Db() {
  const r = [{ x: 0, y: 0, r: 0.36 }];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Mr) / 6;
    r.push({ x: 0.58 * Math.cos(a), y: 0.58 * Math.sin(a), r: 0.33 });
  }
  const s = 240,
    o = [];
  for (let i = 0; i < s; i++) {
    const a = (i / s) * Mr,
      c = Math.cos(a),
      u = Math.sin(a);
    let l = 0,
      d = 0.58 + 0.33;
    for (let h = 0; h < 22; h++) {
      const f = (l + d) / 2,
        p = f * c,
        m = f * u;
      r.some((g) => (p - g.x) * (p - g.x) + (m - g.y) * (m - g.y) <= g.r * g.r) ? (l = f) : (d = f);
    }
    o.push({ x: l * c, y: l * u, z: 0 });
  }
  return o;
}
function qb(e, t) {
  const n = e.length / cl,
    r = n > 1 ? Array.from({ length: cl }, (l, d) => e[Math.floor(d * n)]) : e;
  let s = 1 / 0,
    o = -1 / 0,
    i = 1 / 0,
    a = -1 / 0;
  for (const l of r)
    ((s = Math.min(s, l.x)),
      (o = Math.max(o, l.x)),
      (i = Math.min(i, l.y)),
      (a = Math.max(a, l.y)));
  const c = { x: (s + o) / 2, y: (i + a) / 2 },
    u = [];
  for (let l = 0; l <= al; l++) {
    const d = -Math.PI / 2 + (Math.PI * l) / al,
      h = Math.pow(Math.max(0, Math.cos(d)), fh),
      f = t * Math.sin(d);
    u.push(r.map((p) => ({ x: c.x + (p.x - c.x) * h, y: c.y + (p.y - c.y) * h, z: f })));
  }
  return { rings: u, center: c, depth: t };
}
function Bb({ rings: e, center: t, depth: n }) {
  const r = e[Math.floor(e.length / 2)],
    s = new Float64Array(In);
  for (let i = 0; i < In; i++) {
    const a = ((i + 0.5) / In) * Math.PI * 2,
      c = Math.cos(a),
      u = Math.sin(a);
    let l = 0;
    for (let d = 0; d < r.length; d++) {
      const h = r[d],
        f = r[(d + 1) % r.length],
        p = f.x - h.x,
        m = f.y - h.y,
        g = c * m - u * p;
      if (Math.abs(g) < 1e-9) continue;
      const y = h.x - t.x,
        w = h.y - t.y,
        S = (y * m - w * p) / g,
        v = (y * u - w * c) / g;
      S > l && v >= 0 && v <= 1 && (l = S);
    }
    s[i] = l;
  }
  const o = (i, a) => {
    const c = i - t.x,
      u = a - t.y,
      l = Math.hypot(c, u);
    if (l < 1e-8) return 0;
    const h = (((Math.atan2(u, c) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * In,
      f = Math.floor(h) % In,
      p = h - Math.floor(h),
      m = s[f],
      g = s[(f + 1) % In];
    return Math.min(1, l / Math.max(1e-8, m * (1 - p) + g * p));
  };
  return (i, a) => n * Math.sqrt(Math.max(0, 1 - Math.pow(o(i, a), 2 / fh)));
}
const gr = Math.PI * 2;
const Hb = 0.2;
const Vb = 0.36;
const Gb = 1.18;
const Wb = 160;
const Je = 480;
const Ub = wh(Wb);
const ml = wh(Je);
const Kb = 1.01;
const Xb = 1e-5;
const Yb = 0.01;
const Zb = 8;
function wh(e) {
  return Array.from({ length: e }, (t, n) => {
    const r = (n / e) * gr;
    return { x: Math.cos(r), y: Math.sin(r) };
  });
}
function Ha(e, t) {
  return Math.max(Hb, e.size) * ((Vb * t) / Gb);
}
function bh(e, t, n) {
  return ex(e.silhouette, xh(e, t, n)).flatMap(vh);
}
function Qb(e, t, n, r) {
  return e.seat == null ? [] : sx(e.seat, r, xh(e, t, n)).flatMap(vh);
}
function xh(e, t, n) {
  const r = n / 2,
    s = Ha(e, n),
    o = Jb((t.yaw * Math.PI) / 180, (t.pitch * Math.PI) / 180, (t.roll * Math.PI) / 180);
  return {
    rotate: o,
    project: (i) => {
      const a = o(i);
      return { x: r + s * a.x, y: r - s * a.y };
    },
    origin: { x: r, y: r },
    radius: s,
  };
}
function Jb(e, t, n) {
  const [r, s, o] = Yo(e),
    [i, a, c] = Yo(t),
    [u, l, d] = Yo(n);
  return ({ x: h, y: f, z: p }) => {
    const m = h * r + p * s,
      g = f * r + f * o,
      y = p * r - h * s,
      w = m * i + m * c,
      S = g * i - y * a,
      v = y * i + g * a;
    return { x: w * u - S * l, y: S * u + w * l, z: v * u + v * d };
  };
}
function Yo(e) {
  const t = Math.cos(e);
  return [t, Math.sin(e), 1 - t];
}
function vh(e) {
  const [t] = e;
  if (e.length < 2 || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return [];
  const n = [];
  for (const r of e) Number.isFinite(r.x) && Number.isFinite(r.y) && n.push(r.x, r.y);
  return n.length >= 6 ? [n] : [];
}
function ex(e, t) {
  if (e.kind === "loft") return [rx(e.rings, t)];
  if (e.kind === "solid") return [tx(e, t)];
  const n = e.rings.map((i) => i.map(t.project)),
    r = n[0],
    s = n[n.length - 1],
    o = [s, r];
  for (let i = 1; i < n.length; i++) {
    const a = n[i - 1],
      c = n[i];
    for (let u = 0; u < c.length; u++) {
      const l = (u + 1) % s.length;
      o.push([a[u], a[l], c[l], c[u]]);
    }
  }
  return o;
}
function tx(e, { project: t, origin: n, radius: r }) {
  const s = [];
  for (const c of e.samples) {
    const u = t(c);
    Number.isFinite(u.x) && Number.isFinite(u.y) && s.push(u);
  }
  if (e.isLoop) return s;
  if (e.balls.length === 0) return Zo(s);
  const o = e.balls
    .map(([c, u, l, d]) => ({ ...t({ x: c, y: u, z: l }), r: d * r }))
    .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && c.r > 1e-6);
  let i = n.x,
    a = n.y;
  if (o.length > 0) {
    ((i = 0), (a = 0));
    for (const c of o) ((i += c.x), (a += c.y));
    ((i /= o.length), (a /= o.length));
  }
  for (const { x: c, y: u } of Ub) {
    let l = 0;
    for (const d of o) {
      const h = d.x - i,
        f = d.y - a,
        p = c * h + u * f,
        m = p * p - (h * h + f * f) + d.r * d.r;
      if (m <= 0) continue;
      const g = p + Math.sqrt(m);
      g > l && (l = g);
    }
    l > 0 && s.push({ x: i + c * l, y: a + u * l });
  }
  if (e.samples.length > 0) return Zo(s);
  if (s.length >= 3) return s;
  for (const c of o)
    for (let u = 0; u < 48; u++) {
      const l = (u / 48) * gr;
      s.push({ x: c.x + c.r * Math.cos(l), y: c.y + c.r * Math.sin(l) });
    }
  return s.length >= 3 ? Zo(s) : s;
}
function Zo(e) {
  const t = nx(e.filter((o) => Number.isFinite(o.x) && Number.isFinite(o.y)));
  if (t.length < 3) return t;
  const n = (o, i, a) => (i.x - o.x) * (a.y - o.y) - (i.y - o.y) * (a.x - o.x),
    r = [];
  for (const o of t) {
    for (; r.length >= 2 && n(r[r.length - 2], r[r.length - 1], o) <= 0;) r.pop();
    r.push(o);
  }
  const s = [];
  for (let o = t.length - 1; o >= 0; o--) {
    const i = t[o];
    for (; s.length >= 2 && n(s[s.length - 2], s[s.length - 1], i) <= 0;) s.pop();
    s.push(i);
  }
  return (r.pop(), s.pop(), [...r, ...s]);
}
function nx(e) {
  let t = 1 / 0,
    n = -1 / 0;
  for (const { x: u } of e) (u < t && (t = u), u > n && (n = u));
  const r = Math.ceil(e.length / Zb),
    s = n > t ? r / (n - t) : 0,
    o = (u) => Math.min(r - 1, Math.floor((u - t) * s)),
    i = new Int32Array(r + 1);
  for (const { x: u } of e) i[o(u) + 1]++;
  for (let u = 0; u < r; u++) i[u + 1] += i[u];
  const a = i.slice(0, r),
    c = new Array(e.length);
  for (const u of e) c[a[o(u.x)]++] = u;
  for (let u = 0; u < r; u++)
    for (let l = i[u] + 1; l < i[u + 1]; l++) {
      const d = c[l];
      let h = l - 1;
      for (; h >= i[u] && (c[h].x > d.x || (c[h].x === d.x && c[h].y > d.y)); h--) c[h + 1] = c[h];
      c[h + 1] = d;
    }
  return c;
}
function rx(e, { project: t, origin: n }) {
  const r = e.map((g) => g.map(t)),
    s = (g) => {
      let y = 0,
        w = 0;
      for (const S of g) ((y += S.x), (w += S.y));
      return { x: y / g.length, y: w / g.length };
    },
    o = s(r[0]),
    i = s(r[r.length - 1]);
  if (Math.hypot(i.x - o.x, i.y - o.y) < 1e-4) {
    let g = r[0],
      y = 0;
    for (const w of r) {
      let S = 0;
      for (let v = 0; v < w.length; v++) {
        const x = w[v],
          E = w[(v + 1) % w.length];
        S += x.x * E.y - E.x * x.y;
      }
      Math.abs(S) > y && ((g = w), (y = Math.abs(S)));
    }
    return g;
  }
  const a = r.map((g) => g.map(({ x: y, y: w }) => (y - n.x) * (y - n.x) + (w - n.y) * (w - n.y))),
    c = a.map((g) => Math.max(...g)),
    u = Xb * Math.max(...c) + Yb,
    l = (g, y) => {
      const w = (y - u) / Kb;
      return w > 0 && g < w * w;
    },
    d = r.map((g) =>
      g.map((y) => {
        const w = (Math.atan2(y.y - n.y, y.x - n.x) + gr) % gr;
        return Math.floor((w / gr) * Je) % Je;
      }),
    ),
    h = new Float64Array(Je);
  let f = 0;
  const p = (g, y, w, S, v) => {
      if (l(v, f)) return;
      let x = S - w;
      x > Je / 2 ? (x -= Je) : x < -Je / 2 && (x += Je);
      const E = x < 0 ? -1 : 1,
        A = Math.abs(x);
      let j = 1 / 0;
      for (let I = -1; I <= A + 1; I++) {
        const $ = (w + E * I + Je) % Je;
        h[$] < j && (j = h[$]);
      }
      if (l(v, j)) return;
      const F = y.x - g.x,
        O = y.y - g.y,
        L = g.x - n.x,
        T = g.y - n.y;
      for (let I = -1; I <= A + 1; I++) {
        const $ = (w + E * I + Je) % Je,
          { x: R, y: U } = ml[$],
          W = R * O - U * F;
        if (Math.abs(W) < 1e-9) continue;
        const G = (L * O - T * F) / W,
          J = (L * U - T * R) / W;
        G > h[$] && J >= 0 && J <= 1 && (h[$] = G);
      }
    },
    m = c.map((g, y) => y).sort((g, y) => c[y] - c[g]);
  for (const g of m) {
    const y = r[g];
    for (let w = 0; w < y.length; w++) {
      const S = (w + 1) % y.length;
      p(y[w], y[S], d[g][w], d[g][S], Math.max(a[g][w], a[g][S]));
    }
    f = Math.min(...h);
  }
  for (let g = 0; g < r.length - 1; g++) {
    const y = r[g],
      w = r[g + 1];
    for (let S = 0; S < Math.min(y.length, w.length); S++)
      p(y[S], w[S], d[g][S], d[g + 1][S], Math.max(a[g][S], a[g + 1][S]));
  }
  return ml.flatMap(({ x: g, y }, w) =>
    h[w] > 0 ? [{ x: n.x + g * h[w], y: n.y + y * h[w] }] : [],
  );
}
function sx(e, t, n) {
  switch (e.kind) {
    case "front":
      return ox(e.faceZ, t, n);
    case "loft":
      return ix(e.surfaceZ, t, n);
    case "wrap":
      return ax(e, t, n);
    case "wrapX":
      return cx(e, t, n);
  }
}
function ox(e, { loops: t, shiftY: n }, r) {
  if (!(r.rotate({ x: 0, y: 0, z: 1 }).z > 0.03)) return [];
  const o = Math.sin(n);
  return t
    .filter((i) => i.length >= 3)
    .map((i) => i.map((a) => r.project({ x: a.x, y: a.y - o, z: e })));
}
function ix(e, { loops: t, shiftY: n }, { rotate: r, project: s }) {
  if (!(r({ x: 0, y: 0, z: 1 }).z >= 0.05)) return [];
  const i = Math.sin(n),
    a = [];
  for (const c of t) {
    if (c.length < 3) continue;
    const u = c.map((y) => ({ x: y.x, y: y.y - i }));
    let l = 0,
      d = 0;
    for (const y of u) ((l += y.x), (d += y.y));
    ((l /= u.length), (d /= u.length));
    const h = 0.004,
      f = (e(l + h, d) - e(l - h, d)) / (2 * h),
      p = (e(l, d + h) - e(l, d - h)) / (2 * h),
      m = Math.hypot(f, p, 1);
    if (r({ x: -f / m, y: -p / m, z: 1 / m }).z < 0.12) continue;
    const g = e(l, d);
    a.push(u.map((y) => s({ x: y.x, y: y.y, z: g + (y.x - l) * f + (y.y - d) * p })));
  }
  return a;
}
function ax(e, { loops: t, shiftY: n }, { rotate: r, project: s }) {
  const { wrapR: o, wrapY0: i, wrapY1: a, radiusAt: c, puffAt: u } = e,
    l = c ? 0.02 : 0.06,
    d = Math.min(a - l, Math.max(i + l, e.eyeY - n)),
    h = (v) => Math.min(a, Math.max(i, v)),
    f = (v) => {
      const x = [];
      for (const E of v) {
        const A = h(d + E.y),
          j = c ? c(A) : o,
          F = Math.max(-2.6, Math.min(2.6, E.x / Math.max(0.12, j)));
        let O = 0;
        (c && (O = -(c(Math.min(a, A + 0.012)) - c(Math.max(i, A - 0.012))) / (2 * 0.012)),
          r({ x: Math.sin(F), y: O, z: Math.cos(F) }).z >= 0.05 &&
            x.push(s({ x: j * Math.sin(F), y: A, z: j * Math.cos(F) })));
      }
      return x;
    },
    p = (v) => {
      if (!u || v.length === 0) return [];
      let x = 0,
        E = 0;
      for (const O of v) ((x += O.x), (E += O.y));
      const A = u(x / v.length, h(d + E / v.length)),
        j = r({ x: 0, y: 0, z: 1 }).z,
        F = [];
      for (const O of v) {
        const L = O.x - A.x,
          T = h(d + O.y) - A.y,
          I = Math.hypot(L, T);
        let $ = Math.min(I / A.r, Math.PI - 0.02);
        const R = I > 1e-9 ? L / I : 1,
          U = I > 1e-9 ? T / I : 0,
          W = r({ x: R, y: U, z: 0 }).z,
          G = (K) => W * Math.sin(K) + j * Math.cos(K);
        if (G($) < 0.06 && j > 0.06) {
          let K = 0,
            ae = $;
          for (let ee = 0; ee < 20; ee++) {
            const te = (K + ae) / 2;
            G(te) >= 0.06 ? (K = te) : (ae = te);
          }
          $ = K;
        }
        const J = A.r * Math.sin($),
          ye = { x: R * Math.sin($), y: U * Math.sin($), z: Math.cos($) };
        r(ye).z >= 0.05 &&
          F.push(s({ x: A.x + R * J, y: A.y + U * J, z: A.z + A.r * Math.cos($) }));
      }
      return F;
    };
  let m = 1 / 0,
    g = -1 / 0;
  for (const v of t) for (const x of v) (x.y < m && (m = x.y), x.y > g && (g = x.y));
  let y = 0;
  g - m <= a - i && (d + m < i ? (y = i - (d + m)) : d + g > a && (y = a - (d + g)));
  const w = y === 0 ? t : t.map((v) => v.map((x) => ({ x: x.x, y: x.y + y }))),
    S = u ? p : f;
  return w.map(S).filter((v) => v.length > 2);
}
function cx(e, { loops: t, shiftY: n }, { rotate: r, project: s }) {
  const { wrapR: o, wrapX0: i, wrapX1: a, radiusAtX: c } = e,
    u = Math.max(-2.4, Math.min(2.4, -n / o));
  let l = 1 / 0,
    d = -1 / 0;
  for (const p of t) for (const m of p) (m.x < l && (l = m.x), m.x > d && (d = m.x));
  let h = 0;
  return (
    d - l <= a - i && (l < i ? (h = i - l) : d > a && (h = a - d)),
    (h === 0 ? t : t.map((p) => p.map((m) => ({ x: m.x + h, y: m.y }))))
      .map((p) => {
        const m = [];
        for (const g of p) {
          const y = Math.min(a, Math.max(i, g.x)),
            w = c(y),
            S = u + Math.max(-2.6, Math.min(2.6, g.y / Math.max(0.12, o))),
            v = 0.012,
            x = -(c(Math.min(a, y + v)) - c(Math.max(i, y - v))) / (2 * v);
          r({ x, y: Math.sin(S), z: Math.cos(S) }).z >= 0.05 &&
            m.push(s({ x: y, y: w * Math.sin(S), z: w * Math.cos(S) }));
        }
        return m;
      })
      .filter((p) => p.length > 2)
  );
}
const Cn = { kind: "extrusion", halfDepth: 0.36, bevel: 0.22 };
const ux = {
  cloud: { kind: "loft", depth: 0.72 },
  square: Cn,
  sparkle: Cn,
  clover: Cn,
  heartChubby: { kind: "loft", depth: 0.62 },
  starFlower: Cn,
  teardrop: { kind: "revolve" },
  tablet: { kind: "pill", axis: 0 },
  wedge: { kind: "revolve" },
  house: Cn,
  star6: { kind: "extrusion", halfDepth: 0.3, bevel: 0.18 },
  pebble: { kind: "revolve" },
  bean: { kind: "inscribedBalls" },
  egg: { kind: "revolve" },
  squircle: { kind: "roundedSlab", halfDepth: 0.28, edge: 0.11 },
  capsule: { kind: "pill", axis: 1 },
  cylinder: { kind: "revolve" },
  hex: Cn,
  gem: { kind: "revolve" },
  crystal: { kind: "crystal" },
  shield: { kind: "revolve" },
  dome: { kind: "revolve" },
  arch: { kind: "revolve" },
  leaf: { kind: "revolve" },
};
const Gs = Math.PI * 2;
const Qo = 1024;
const lx = { yaw: 0, pitch: 0, roll: 0 };
const Jo = 4;
const gl = 64;
const yl = 96;
const kl = 4;
const dx = 0.72;
const wl = 16;
const bl = 33;
const hx = 40;
const xl = 1e-9;
const vl = 1e-9;
const fx = 1e-15;
const Sl = new Map();
function px(e) {
  const t = Sl.get(e);
  if (t != null) return t;
  const n = mx(e, ux[e]);
  return (Sl.set(e, n), n);
}
function mx(e, t) {
  if (t.kind === "inscribedBalls") return { kind: "balls", balls: vx(Ml(Rb())[0]) };
  const n = Ml(co(e));
  switch (t.kind) {
    case "extrusion":
      return gx(n, t.halfDepth, t.bevel);
    case "revolve":
      return yx(lr(n[0]));
    case "roundedSlab":
      return kx(Sx(lr(n[0])), t.halfDepth, t.edge);
    case "pill":
      return { kind: "balls", balls: wx(lr(n[0]), t.axis) };
    case "crystal":
      return bx();
    case "loft":
      return xx(lr(n[0]), t.depth);
  }
}
function Ml(e) {
  const t = Ha(e, Qo),
    n = Qo / 2;
  return bh(e, lx, Qo).map((r) => r.map((s, o) => (o % 2 === 0 ? (s - n) / t : (n - s) / t)));
}
function gx(e, t, n) {
  const r = e[0].length / 2,
    s = Array.from({ length: r }, (x, E) => {
      const A = e[2 + Jo * r + E];
      return [A[0], A[1]];
    }),
    o = Eh(s),
    { x0: i, x1: a, y0: c, y1: u } = Va(o),
    l = (i + a) / 2,
    d = (c + u) / 2,
    h = Math.max(1e-4, Math.min((a - i) / 2, (u - c) / 2)),
    f = Math.min(t * 0.8, n),
    p = (x) => {
      const E = (x / Jo) * (Math.PI / 2);
      return { z: t - f + f * Math.sin(E), scale: 1 - (f / h) * (1 - Math.cos(E)) };
    },
    m = Array.from({ length: Jo + 1 }, (x, E) => p(E)),
    y = [...m.map(({ z: x, scale: E }) => ({ z: -x, scale: E })).reverse(), ...m].map(
      ({ z: x, scale: E }) => o.map(([A, j]) => [l + (A - l) * E, d + (j - d) * E, x]),
    ),
    { vertices: w, faces: S } = Sh(y, !0),
    v = S.length - 1;
  return {
    kind: "mesh",
    vertices: w,
    faces: S.map((x, E) => ({ corners: x, isBounding: E === 0 || E === v })),
  };
}
function yx(e) {
  const t = new Map();
  for (const [a, c] of e) a > -xl && t.set(c, Math.max(t.get(c) ?? 0, a));
  const n = [],
    r = (a) => n.push(a) - 1,
    s = [...t]
      .sort((a, c) => c[0] - a[0])
      .map(([a, c]) =>
        c <= xl
          ? [r([0, a, 0])]
          : Array.from({ length: gl }, (u, l) => {
              const d = (l / gl) * Gs;
              return r([c * Math.sin(d), a, c * Math.cos(d)]);
            }),
      ),
    o = [s[0], s[s.length - 1]].filter((a) => a.length > 1),
    i = s.slice(1).flatMap((a, c) => Mx(s[c], a));
  return Tx(n, [...o, ...i]);
}
function kx(e, t, n) {
  const r = e.length,
    s = e.map((i, a) => {
      const c = e[(a - 1 + r) % r],
        u = e[(a + 1) % r];
      let l = u[1] - c[1],
        d = -(u[0] - c[0]);
      const h = Math.hypot(l, d) || 1;
      return ((l /= h), (d /= h), l * i[0] + d * i[1] < 0 ? [-l, -d] : [l, d]);
    }),
    o = [];
  return (
    e.forEach(([i, a], c) => {
      for (let u = 0; u <= kl; u++) {
        const l = (u / kl) * (Math.PI / 2),
          d = n * (1 - Math.cos(l)),
          h = t - n + n * Math.sin(l),
          f = i - s[c][0] * d,
          p = a - s[c][1] * d;
        o.push([f, p, h], [f, p, -h]);
      }
    }),
    Mh(o)
  );
}
function wx(e, t) {
  const n = Math.max(...e.map((s) => Math.abs(s[1 - t]))),
    r = Math.max(...e.map((s) => Math.abs(s[t]))) - n;
  return Array.from({ length: bl }, (s, o) => {
    const i = -r + 2 * r * (o / (bl - 1));
    return { center: t === 0 ? [i, 0, 0] : [0, i, 0], radius: n };
  });
}
function bx() {
  const e = 1.1600000000000001,
    t = 0.12,
    n = [
      [0, e - t, 0],
      [0, -e + t, 0],
    ],
    r = 0.54 - t * 0.25,
    s = 0.64 - t;
  for (const i of [-1, 1])
    for (let a = 0; a < 6; a++) {
      const c = (a / 6) * Gs;
      n.push([s * Math.cos(c), i * r, s * Math.sin(c)]);
    }
  const o = [];
  for (const [i, a, c] of n)
    for (let u = 0; u <= 8; u++) {
      const l = (u / 8) * Math.PI,
        d = Math.sin(l),
        h = u === 0 || u === 8 ? 1 : 14;
      for (let f = 0; f < h; f++) {
        const p = (f / h) * Gs;
        o.push([i + t * d * Math.sin(p), a + t * Math.cos(l), c + t * d * Math.cos(p)]);
      }
    }
  return Mh(o);
}
function xx(e, t) {
  const n = Eh(e),
    { x0: r, x1: s, y0: o, y1: i } = Va(n),
    a = (r + s) / 2,
    c = (o + i) / 2,
    u = Array.from({ length: wl + 1 }, (h, f) => {
      const p = -Math.PI / 2 + (Math.PI * f) / wl,
        m = Math.pow(Math.max(0, Math.cos(p)), dx),
        g = t * Math.sin(p);
      return n.map(([y, w]) => [a + (y - a) * m, c + (w - c) * m, g]);
    }),
    { vertices: l, faces: d } = Sh(u, !1);
  return { kind: "mesh", vertices: l, faces: d.map((h) => ({ corners: h, isBounding: !1 })) };
}
function vx(e) {
  const t = lr(e).map(([l, d]) => [b + b * l, b - b * d]),
    { x0: n, x1: r, y0: s, y1: o } = Va(t),
    i = (l, d) => {
      let h = !1;
      for (let f = 0, p = t.length - 1; f < t.length; p = f++) {
        const [m, g] = t[f],
          [y, w] = t[p];
        g > d != w > d && l < m + ((y - m) * (d - g)) / (w - g) && (h = !h);
      }
      return h;
    },
    a = Math.max(r - n, o - s) / hx,
    c = [];
  for (let l = s + a / 2; l < o; l += a)
    for (let d = n + a / 2; d < r; d += a) {
      if (!i(d, l)) continue;
      let h = 1 / 0;
      for (const [p, m] of t) h = Math.min(h, (p - d) ** 2 + (m - l) ** 2);
      const f = Math.sqrt(h);
      f > a && c.push({ x: d, y: l, r: f });
    }
  c.sort((l, d) => d.r - l.r);
  const u = [];
  for (const l of c)
    u.some((d) => Math.hypot(l.x - d.x, l.y - d.y) + l.r <= d.r + a * 0.25) || u.push(l);
  return u.map((l) => ({ center: [(l.x - b) / b, -(l.y - b) / b, 0], radius: l.r / b }));
}
function Sx(e) {
  return Array.from({ length: yl }, (t, n) => {
    const r = (n / yl) * Gs,
      s = Math.cos(r),
      o = -Math.sin(r);
    let i = 0;
    return (
      e.forEach((a, c) => {
        const u = e[(c + 1) % e.length],
          l = u[0] - a[0],
          d = u[1] - a[1],
          h = s * d - o * l;
        if (Math.abs(h) < fx) return;
        const f = (a[0] * d - a[1] * l) / h,
          p = (a[0] * o - a[1] * s) / h;
        f > i && p >= -vl && p <= 1 + vl && (i = f);
      }),
      [s * i, o * i]
    );
  });
}
function Sh(e, t) {
  const n = e[0].length,
    r = e.flat(),
    s = [],
    o = (i, a) => i * n + (a % n);
  t && s.push(Array.from({ length: n }, (i, a) => o(0, n - 1 - a)));
  for (let i = 1; i < e.length; i++)
    for (let a = 0; a < n; a++) s.push([o(i - 1, a), o(i - 1, a + 1), o(i, a + 1), o(i, a)]);
  return (
    t && s.push(Array.from({ length: n }, (i, a) => o(e.length - 1, a))), { vertices: r, faces: s }
  );
}
function Mh(e) {
  return { kind: "mesh", vertices: e, faces: Jw(e).map((t) => ({ corners: t, isBounding: !0 })) };
}
function Mx(e, t) {
  return e.length === 1 && t.length === 1
    ? []
    : e.length === 1
      ? t.map((n, r) => [e[0], n, t[(r + 1) % t.length]])
      : t.length === 1
        ? e.map((n, r) => [n, t[0], e[(r + 1) % e.length]])
        : e.map((n, r) => [n, t[r], t[(r + 1) % t.length], e[(r + 1) % e.length]]);
}
function Tx(e, t) {
  const n = e.length,
    r = [
      e.reduce((o, i) => o + i[0], 0) / n,
      e.reduce((o, i) => o + i[1], 0) / n,
      e.reduce((o, i) => o + i[2], 0) / n,
    ],
    s = t.map((o) => {
      const [i, a, c] = Th(e, o),
        u = o.reduce((h, f) => [h[0] + e[f][0], h[1] + e[f][1], h[2] + e[f][2]], [0, 0, 0]),
        l = o.length;
      return {
        corners:
          i * (u[0] / l - r[0]) + a * (u[1] / l - r[1]) + c * (u[2] / l - r[2]) < 0
            ? [...o].reverse()
            : o,
        isBounding: !0,
      };
    });
  return { kind: "mesh", vertices: e, faces: s };
}
function Th(e, t) {
  let n = 0,
    r = 0,
    s = 0;
  for (let o = 0; o < t.length; o++) {
    const i = e[t[o]],
      a = e[t[(o + 1) % t.length]];
    ((n += (i[1] - a[1]) * (i[2] + a[2])),
      (r += (i[2] - a[2]) * (i[0] + a[0])),
      (s += (i[0] - a[0]) * (i[1] + a[1])));
  }
  return [n, r, s];
}
function Eh(e) {
  let t = 0;
  return (
    e.forEach((n, r) => {
      const s = e[(r + 1) % e.length];
      t += n[0] * s[1] - s[0] * n[1];
    }),
    t < 0 ? [...e].reverse() : e
  );
}
function Va(e) {
  let t = 1 / 0,
    n = -1 / 0,
    r = 1 / 0,
    s = -1 / 0;
  for (const [o, i] of e)
    ((t = Math.min(t, o)), (n = Math.max(n, o)), (r = Math.min(r, i)), (s = Math.max(s, i)));
  return { x0: t, x1: n, y0: r, y1: s };
}
function lr(e) {
  return Array.from({ length: e.length / 2 }, (t, n) => [e[2 * n], e[2 * n + 1]]);
}
const dr = 1024;
const Tl = 2 ** 23;
const Ex = 2 ** 25;
const Ut = 2 ** 26;
class uo {
  xs = [];
  ys = [];
  #e = new Map();
  id(t, n) {
    const r = (t + Tl) * Ex + (n + Tl);
    let s = this.#e.get(r);
    return (
      s == null && ((s = this.xs.length), this.xs.push(t), this.ys.push(n), this.#e.set(r, s)), s
    );
  }
}
function Ga(e) {
  let t = "";
  for (const n of e) {
    t += `M${Yt(n[0])} ${Yt(n[1])}`;
    for (let r = 2; r < n.length; r += 2) t += ` ${Yt(n[r])} ${Yt(n[r + 1])}`;
    t += "Z";
  }
  return t;
}
function Px(e) {
  const t = Ix(e),
    n = Ax(t);
  return Ox(Rx(_x(t.flatMap((r) => $x(r, n)))));
}
function Ix(e) {
  const t = new uo(),
    n = new Map(),
    r = [],
    s = [],
    o = (c) => {
      const u = Nx(c);
      if (u === 0) return;
      const l = c.length / 2;
      s.length = 0;
      for (let d = 0; d < l; d++) {
        const h = u > 0 ? d : l - 1 - d;
        s.push(t.id(c[2 * h], c[2 * h + 1]));
      }
      for (let d = 0; d < l; d++) {
        const h = s[d],
          f = s[(d + 1) % l];
        if (h === f) continue;
        const p = f * Ut + h,
          m = n.get(p) ?? 0;
        m > 1
          ? n.set(p, m - 1)
          : m === 1
            ? n.delete(p)
            : n.set(h * Ut + f, (n.get(h * Ut + f) ?? 0) + 1);
      }
    };
  for (const c of e) {
    r.length = c.length;
    for (let l = 0; l < c.length; l++) r[l] = Math.round(c[l] * dr);
    const u = r.length === 8 ? Lx(r) : null;
    if (u == null) o(r);
    else for (const l of u) o(l);
  }
  const { xs: i, ys: a } = t;
  return [...n].map(([c, u]) => {
    const l = Math.floor(c / Ut),
      d = c - l * Ut;
    return { ax: i[l], ay: a[l], bx: i[d], by: a[d], count: u };
  });
}
function Ax(e) {
  const t = new uo();
  for (const o of e) (t.id(o.ax, o.ay), t.id(o.bx, o.by));
  const n = e.map((o, i) => i).sort((o, i) => ei(e[o]) - ei(e[i]));
  n.forEach((o, i) => {
    const a = e[o],
      c = Math.max(a.ax, a.bx);
    for (let u = i + 1; u < n.length; u++) {
      const l = e[n[u]];
      if (ei(l) > c) break;
      if (
        Math.min(l.ay, l.by) > Math.max(a.ay, a.by) ||
        Math.max(l.ay, l.by) < Math.min(a.ay, a.by)
      )
        continue;
      const d = Math.sign(lt(a.ax, a.ay, a.bx, a.by, l.ax, l.ay)),
        h = Math.sign(lt(a.ax, a.ay, a.bx, a.by, l.bx, l.by)),
        f = lt(l.ax, l.ay, l.bx, l.by, a.ax, a.ay),
        p = lt(l.ax, l.ay, l.bx, l.by, a.bx, a.by);
      if (d * h >= 0 || Math.sign(f) * Math.sign(p) >= 0) continue;
      const m = f / (f - p);
      t.id(Math.round(a.ax + (a.bx - a.ax) * m), Math.round(a.ay + (a.by - a.ay) * m));
    }
  });
  const { xs: r, ys: s } = t;
  return r.map((o, i) => ({ x: o, y: s[i] })).sort((o, i) => o.x - i.x);
}
function $x(e, t) {
  const n = e.bx - e.ax,
    r = e.by - e.ay,
    s = Math.abs(n) + Math.abs(r),
    o = Math.min(e.ay, e.by) - 0.5,
    i = Math.max(e.ay, e.by) + 0.5,
    a = Math.max(e.ax, e.bx) + 0.5,
    c = [];
  for (let l = Cx(t, Math.min(e.ax, e.bx) - 0.5); l < t.length && t[l].x <= a; l++) {
    const { x: d, y: h } = t[l];
    h < o ||
      h > i ||
      2 * Math.abs(lt(e.ax, e.ay, e.bx, e.by, d, h)) > s ||
      c.push({ t: ((d - e.ax) * n + (h - e.ay) * r) / (n * n + r * r), x: d, y: h });
  }
  c.sort((l, d) => l.t - d.t);
  const u = [];
  for (let l = 1; l < c.length; l++) {
    const d = c[l - 1],
      h = c[l];
    (d.x !== h.x || d.y !== h.y) && u.push({ ax: d.x, ay: d.y, bx: h.x, by: h.y, count: e.count });
  }
  return u;
}
function Cx(e, t) {
  let n = 0,
    r = e.length;
  for (; n < r;) {
    const s = (n + r) >> 1;
    e[s].x < t ? (n = s + 1) : (r = s);
  }
  return n;
}
function _x(e) {
  const t = new uo(),
    n = new Map();
  for (const i of e) {
    const a = t.id(i.ax, i.ay),
      c = t.id(i.bx, i.by),
      u = Math.min(a, c) * Ut + Math.max(a, c);
    n.set(u, (n.get(u) ?? 0) + (a < c ? i.count : -i.count));
  }
  const { xs: r, ys: s } = t,
    o = [];
  for (const [i, a] of n) {
    if (a === 0) continue;
    const c = Math.floor(i / Ut),
      u = i - c * Ut;
    o.push({ ax: r[c], ay: s[c], bx: r[u], by: s[u], count: a });
  }
  return o;
}
function Rx(e) {
  const t = [];
  for (const n of e) {
    const r = n.ax + n.bx,
      s = n.ay + n.by;
    let o = 0;
    for (const u of e) {
      if (u === n) continue;
      const l = 2 * u.ay,
        d = 2 * u.by;
      l <= s
        ? d > s && lt(2 * u.ax, l, 2 * u.bx, d, r, s) > 0 && (o += u.count)
        : d <= s && lt(2 * u.ax, l, 2 * u.bx, d, r, s) < 0 && (o -= u.count);
    }
    const a = n.ay < n.by || (n.ay === n.by && n.ax > n.bx) ? o + n.count : o,
      c = a - n.count;
    (a !== 0) != (c !== 0) &&
      t.push(a !== 0 ? { ...n, count: 1 } : { ax: n.bx, ay: n.by, bx: n.ax, by: n.ay, count: 1 });
  }
  return t;
}
function Ox(e) {
  const t = new uo(),
    n = [];
  for (const i of e) {
    const a = t.id(i.ax, i.ay),
      c = t.id(i.bx, i.by);
    for (; n.length <= Math.max(a, c);) n.push([]);
    for (let u = 0; u < Math.abs(i.count); u++) i.count > 0 ? n[a].push(c) : n[c].push(a);
  }
  const { xs: r, ys: s } = t;
  let o = "";
  return (
    n.forEach((i, a) => {
      for (; i.length > 0;) {
        o += `M${Yt(r[a] / dr)} ${Yt(s[a] / dr)}`;
        let c = i.pop();
        for (; c != null && c !== a;)
          ((o += ` ${Yt(r[c] / dr)} ${Yt(s[c] / dr)}`), (c = n[c].pop()));
        o += "Z";
      }
    }),
    o
  );
}
function Lx(e) {
  const [t, n, r, s, o, i, a, c] = e,
    u = El(t, n, r, s, o, i, a, c);
  if (u != null)
    return [
      [t, n, u[0], u[1], a, c],
      [u[0], u[1], r, s, o, i],
    ];
  const l = El(r, s, o, i, a, c, t, n);
  return l != null
    ? [
        [r, s, l[0], l[1], t, n],
        [l[0], l[1], o, i, a, c],
      ]
    : null;
}
function El(e, t, n, r, s, o, i, a) {
  const c = Math.sign(lt(e, t, n, r, s, o)),
    u = Math.sign(lt(e, t, n, r, i, a)),
    l = lt(s, o, i, a, e, t),
    d = lt(s, o, i, a, n, r);
  if (!(c * u < 0 && Math.sign(l) * Math.sign(d) < 0)) return null;
  const h = l / (l - d);
  return [Math.round(e + (n - e) * h), Math.round(t + (r - t) * h)];
}
function lt(e, t, n, r, s, o) {
  return (n - e) * (o - t) - (r - t) * (s - e);
}
function Nx(e) {
  let t = 0;
  for (let n = 0; n < e.length; n += 2) {
    const r = (n + 2) % e.length;
    t += e[n] * e[r + 1] - e[r] * e[n + 1];
  }
  return t;
}
function ei(e) {
  return Math.min(e.ax, e.bx);
}
function Yt(e) {
  return String(Math.round(e * 100) / 100);
}
const Pl = Math.PI / 6;
const Fx = 1.17;
const ti = -1.24;
const ni = 0.79;
const rr = 3.24;
const sr = 48;
const Zr = 160;
const jx = 0.001;
const Ws = 0.18;
const nt = Wx([-0.5, 0.6, 0.62]);
const zx = [
  ...[0, 1, 2, 3, 4, 5].map((e) => {
    const t = e * Pl;
    return { center: [0, 0, 0], a: [Math.sin(t), 0, Math.cos(t)], b: [0, 1, 0], isEquator: !1 };
  }),
  ...[-2, -1, 0, 1, 2].map((e) => {
    const t = e * Pl,
      n = Math.cos(t);
    return { center: [0, Math.sin(t), 0], a: [0, 0, n], b: [n, 0, 0], isEquator: e === 0 };
  }),
];
let Qr = null;
function Dx(e, t) {
  const n = wt(t, e.center),
    r = wt(t, e.a),
    s = wt(t, e.b),
    o = Math.hypot(r[2], s[2]);
  let i = 0,
    a = 2 * Math.PI;
  if (o > Math.abs(n[2])) {
    const c = Math.atan2(s[2], r[2]),
      u = Math.acos(-n[2] / o);
    ((i = c - u), (a = c + u));
  } else if (n[2] <= 0) return null;
  return { center: [n[0], n[1]], a: [r[0], r[1]], b: [s[0], s[1]], from: i, to: a };
}
function qx(e, t) {
  const n = Math.sqrt(Math.max(0, 1 - e * e - t * t)),
    r = nt[0] * e + nt[1] * t + nt[2] * n;
  return Ws + (1 - Ws) * Math.max(0, r);
}
function Bx() {
  if (Qr !== null) return Qr;
  const e = Math.hypot(nt[0], nt[1]),
    t = [nt[0] / e, nt[1] / e],
    n = {
      origin: [ti * nt[0], ti * nt[1]],
      axisX: [ni * rr * t[0], ni * rr * t[1]],
      axisY: [-rr * t[1], rr * t[0]],
      focus: ((Fx - ti) * e) / (ni * rr),
    };
  return ((Qr = { ...n, stops: Vx(n) }), Qr);
}
function Hx(e, t, n) {
  const r = t - e.origin[0],
    s = n - e.origin[1],
    o = (r * e.axisX[0] + s * e.axisX[1]) / (e.axisX[0] ** 2 + e.axisX[1] ** 2),
    i = (r * e.axisY[0] + s * e.axisY[1]) / (e.axisY[0] ** 2 + e.axisY[1] ** 2),
    a = e.focus,
    c = a * a - 1,
    u = 2 * a * (o - a),
    l = (o - a) ** 2 + i * i;
  return (-u - Math.sqrt(u * u - 4 * c * l)) / (2 * c);
}
function Vx(e) {
  const t = sr + 1,
    n = new Float64Array(t),
    r = new Float64Array(t),
    s = new Float64Array(t);
  let o = 0;
  for (let c = 0; c < Zr; c++)
    for (let u = 0; u < Zr; u++) {
      const l = ((c + 0.5) / Zr) * 2 - 1,
        d = ((u + 0.5) / Zr) * 2 - 1;
      if (l * l + d * d >= 1) continue;
      const h = Math.min(1, Hx(e, l, d)) * sr,
        f = Math.min(sr - 1, Math.floor(h)),
        p = h - f,
        m = qx(l, d);
      ((n[f] += (1 - p) ** 2),
        (n[f + 1] += p * p),
        (r[f] += (1 - p) * p),
        (s[f] += (1 - p) * m),
        (s[f + 1] += p * m),
        o++);
    }
  const i = (jx * o) / t;
  for (let c = 0; c < sr; c++) ((n[c] += i), (n[c + 1] += i), (r[c] -= i));
  const a = Gx(n, r, s);
  return Array.from(a, (c, u) => ({ offset: u / sr, shade: c }));
}
function Gx(e, t, n) {
  const r = e.length,
    s = new Float64Array(r),
    o = new Float64Array(r);
  ((s[0] = t[0] / e[0]), (o[0] = n[0] / e[0]));
  for (let a = 1; a < r; a++) {
    const c = e[a] - t[a - 1] * s[a - 1];
    ((s[a] = t[a] / c), (o[a] = (n[a] - t[a - 1] * o[a - 1]) / c));
  }
  const i = new Float64Array(r);
  i[r - 1] = o[r - 1];
  for (let a = r - 2; a >= 0; a--) i[a] = o[a] - s[a] * i[a + 1];
  return i;
}
function Wx(e) {
  const t = Math.hypot(e[0], e[1], e[2]);
  return [e[0] / t, e[1] / t, e[2] / t];
}
const Ux = 0.4;
const Kx = 1e-9;
const Jr = 6;
const gs = 24;
const Vi = 0.004;
const _n = Math.PI / 180;
function Xx(e, t, n, r) {
  const s = px(e),
    o = Yx(t),
    i = Ha(co(e), n),
    a = n / 2,
    c = r.map((h) => h + (1 - h) * Ux),
    u = (h) => {
      const f = h[0] * nt[0] + h[1] * nt[1] + h[2] * nt[2],
        p = Ws + (1 - Ws) * Math.max(0, f);
      return nv(c.map((m) => m * p));
    },
    l = (h) => [a + i * h[0], a - i * h[1]],
    d = s.kind === "mesh" ? Zx(s, o, l, u) : Qx(s.balls, o, l, i, u);
  return { baseFill: u([0, 0, 1]), faces: d };
}
function Yx(e) {
  const [t, n] = [Math.cos(e.yaw * _n), Math.sin(e.yaw * _n)],
    [r, s] = [Math.cos(e.pitch * _n), Math.sin(e.pitch * _n)],
    [o, i] = [Math.cos(e.roll * _n), Math.sin(e.roll * _n)];
  return ([a, c, u]) => {
    const l = a * t + u * n,
      d = u * t - a * n,
      h = c * r - d * s,
      f = c * s + d * r;
    return [l * o - h * i, l * i + h * o, f];
  };
}
function Zx(e, t, n, r) {
  const s = e.vertices.map(t),
    o = [],
    i = new Map();
  for (const a of e.faces) {
    const [c, u, l] = Th(s, a.corners),
      d = Math.hypot(c, u, l);
    if (d === 0 || l <= Kx * d) continue;
    const h = r([c / d, u / d, l / d]),
      f = a.corners.flatMap((m) => n(s[m]));
    if (a.isBounding) {
      Ph(i, h, f);
      continue;
    }
    const p = a.corners.reduce((m, g) => m + s[g][2], 0) / a.corners.length;
    o.push({ polygon: f, fill: h, depth: p });
  }
  return (o.sort((a, c) => a.depth - c.depth), [...Jx(o), ...[...i].map(([a, c]) => Wa(c, a))]);
}
function Qx(e, t, n, r, s) {
  const o = e.map((c) => ({ center: t(c.center), radius: c.radius })),
    i = o
      .map((c, u) => u)
      .sort((c, u) => o[c].center[2] + o[c].radius - (o[u].center[2] + o[u].radius)),
    a = Vi / r;
  return i.flatMap((c) => {
    const { center: u, radius: l } = o[c],
      d = o.filter((g, y) => y !== c && o[y].radius > a),
      h = (g) => d.some((y) => g.every((w) => tv(w, y.center) < (y.radius - a) ** 2)),
      f = (g, y) => [
        u[0] + l * Math.sin(g) * Math.cos(y),
        u[1] + l * Math.sin(g) * Math.sin(y),
        u[2] + l * Math.cos(g),
      ],
      p = ev(l * r),
      m = new Map();
    for (let g = 0; g < Jr; g++) {
      const y = (g / Jr) * (Math.PI / 2),
        w = ((g + 1) / Jr) * (Math.PI / 2),
        S = g === Jr - 1 ? p : 1;
      for (let v = 0; v < gs; v++) {
        const x = (v / gs) * 2 * Math.PI,
          E = ((v + 1) / gs) * 2 * Math.PI,
          A = [
            ...(g === 0 ? [f(0, 0)] : [f(y, x)]),
            ...Array.from({ length: S + 1 }, (L, T) => f(w, x + ((E - x) * T) / S)),
            ...(g === 0 ? [] : [f(y, E)]),
          ];
        if (h(A)) continue;
        const j = (y + w) / 2,
          F = (x + E) / 2,
          O = s([Math.sin(j) * Math.cos(F), Math.sin(j) * Math.sin(F), Math.cos(j)]);
        Ph(m, O, A.flatMap(n));
      }
    }
    return [...m].map(([g, y]) => Wa(y, g));
  });
}
function Jx(e) {
  const t = [];
  let n = 0;
  for (let r = 1; r <= e.length; r++)
    (r < e.length && e[r].fill === e[n].fill) ||
      (t.push(
        Wa(
          e.slice(n, r).map((s) => s.polygon),
          e[n].fill,
        ),
      ),
      (n = r));
  return t;
}
function Ph(e, t, n) {
  const r = e.get(t);
  r == null ? e.set(t, [n]) : r.push(n);
}
function Wa(e, t) {
  return { d: Ga(e), fill: t };
}
function ev(e) {
  if (e <= Vi) return 1;
  const t = 2 * Math.acos(1 - Vi / e);
  return Math.max(1, Math.ceil((2 * Math.PI) / gs / t));
}
function tv(e, t) {
  return (e[0] - t[0]) ** 2 + (e[1] - t[1]) ** 2 + (e[2] - t[2]) ** 2;
}
function nv(e) {
  const t = (n) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${e.map(t).join("")}`;
}
const Ih = 144;
const Ah = 184 / 256;
const ys = 180 / Math.PI;
const rv = 16e6;
const sv = 0.6;
const Rn = new Map();
let ri = 0;
function ov(e, t, n, r = {}) {
  const s = Math.max(8, Math.round((n * e.zoom) / Ah)),
    o = Math.max(s, Ih),
    i = $h(e.quat, Ch(n, e.zoom)),
    { body: a, eyes: c } = _h(e.body, i, o, e.eyes, e.inspect),
    [u, l, d, h] = Rh(e, n, s, o),
    f = `matrix(${ts(u)} 0 0 ${ts(l)} ${ts(d)} ${ts(h)})`,
    p = r.isProof === !0 ? Xx(e.body, i, o, t.ink) : null;
  if (e.glow != null) {
    const y = lv(e.glow, o);
    return {
      size: n,
      sprite: o,
      transform: f,
      body: a,
      bodyFill: y,
      eyes: [],
      eyeFill: null,
      proof: p,
    };
  }
  const m = t.cutout ? null : Fa(t),
    g = e.eyes == null ? [] : c;
  return {
    size: n,
    sprite: o,
    transform: f,
    body: a,
    bodyFill: Na(t),
    eyes: g,
    eyeFill: m,
    proof: p,
  };
}
function iv(e, t) {
  const n = Math.max(8, Math.round((t * e.zoom) / Ah)),
    r = Math.max(n, Ih),
    s = $h(e.quat, Ch(t, e.zoom)),
    { body: o, eyes: i } = _h(e.body, s, r, e.eyes, e.inspect),
    [a, c, u, l] = Rh(e, t, n, r),
    d = ([h, f]) => [a * h + u, c * f + l];
  return {
    center: [(a * r) / 2 + u, (c * r) / 2 + l],
    radius: (e.zoom * t) / 2,
    body: o.flatMap($l).map((h) => h.map(d)),
    eyes: e.eyes == null ? [] : i.flatMap($l).map((h) => h.map(d)),
  };
}
function av(e, t, n = e.size) {
  const r = e.sprite,
    s = `${t}-body`,
    o = `maskUnits="userSpaceOnUse" x="0" y="0" width="${r}" height="${r}"`,
    i = (h) => e.eyes.map((f) => `<path d="${f}" fill="${h}"/>`).join(""),
    a = e.body.map((h) => `<path d="${h}"/>`).join("");
  let c = `<g id="${s}">${a}</g>`,
    u = "",
    l = "";
  e.eyes.length > 0 && e.eyeFill == null
    ? ((c += `<mask id="${t}-holes" ${o}><rect width="${r}" height="${r}" fill="#fff"/>${i("#000")}</mask>`),
      (u = ` mask="url(#${t}-holes)"`))
    : e.eyes.length > 0 &&
      e.eyeFill != null &&
      ((c += `<mask id="${t}-inside" ${o}><use href="#${s}" fill="#fff"/></mask>`),
      (l = `<g mask="url(#${t}-inside)">${i(e.eyeFill)}</g>`));
  let d = "";
  if (e.proof != null) {
    c += `<clipPath id="${t}-solid">${a}</clipPath>`;
    const h = e.proof.faces.map((f) => `<path d="${f.d}" fill="${f.fill}"/>`).join("");
    d = `<g clip-path="url(#${t}-solid)"${u}><use href="#${s}" fill="${e.proof.baseFill}"/>${h}</g>`;
  } else if (typeof e.bodyFill == "string") d = `<use href="#${s}" fill="${e.bodyFill}"${u}/>`;
  else {
    const { cx: h, cy: f, r: p, stops: m } = e.bodyFill,
      g = m.map((y) => `<stop offset="${y.offset}" stop-color="${y.color}"/>`).join("");
    ((c += `<radialGradient id="${t}-glow" gradientUnits="userSpaceOnUse" cx="${h}" cy="${f}" r="${p}">${g}</radialGradient>`),
      (d = `<use href="#${s}" fill="url(#${t}-glow)"${u}/>`));
  }
  return `${ja(e.size, t, n)}<defs>${c}</defs><g transform="${e.transform}">${d}${l}</g></svg>`;
}
function $h(e, t = 0) {
  const n = Xn(e),
    [r, s, o] = Q1(n[8] >= 0 ? n : [-n[0], n[1], -n[2], -n[3], n[4], -n[5], -n[6], n[7], -n[8]]),
    i = (a) => (t > 0 ? Math.round(a / t) * t : a);
  return { yaw: Il(i(s * ys)), pitch: Il(i(r * ys)), roll: i(o * ys) };
}
function Ch(e, t) {
  const n = (sv / Math.max((e * t) / 2, 1)) * ys;
  return 2 ** Math.floor(Math.log2(n));
}
function Il(e) {
  const t = ((e % 180) + 180) % 180;
  return Math.abs(t - 90) >= 0.5 ? e : e + (t <= 90 ? 89.5 - t : 90.5 - t);
}
function _h(e, t, n, r, s) {
  const o = r == null ? [] : Qb(co(e), t, n, Vw(e, r, t.yaw, s));
  return { body: cv(e, t, n), eyes: o.map((i) => Ga([i])) };
}
function cv(e, t, n) {
  const r = `${e} ${n} ${t.yaw} ${t.pitch} ${t.roll}`,
    s = Rn.get(r);
  if (s != null) return (Rn.delete(r), Rn.set(r, s), s);
  const o = uv(bh(co(e), t, n));
  (Rn.set(r, o), (ri += Al(o)));
  for (const [i, a] of Rn) {
    if (ri <= rv) break;
    (Rn.delete(i), (ri -= Al(a)));
  }
  return o;
}
function Al(e) {
  return e.reduce((t, n) => t + n.length, 0);
}
function uv(e) {
  if (e.length === 1) return [Ga(e)];
  const t = Px(e);
  return t === "" ? [] : [t];
}
function Rh(e, t, n, r) {
  const s = t / 2,
    o = s + e.offset[0] * e.zoom * s,
    i = s - e.offset[1] * e.zoom * s,
    a = i - e.squashAnchor * e.zoom * s,
    [c, u] = e.squash,
    l = n / r;
  return [c * l, u * l, o - (c * n) / 2, a + u * (i - n / 2 - a)];
}
function $l(e) {
  const t = [];
  for (const n of e.split("Z")) {
    const r = n
      .replace("M", " ")
      .trim()
      .split(/\s+/)
      .filter((o) => o !== "")
      .map(Number);
    if (r.length < 6) continue;
    const s = [];
    for (let o = 0; o + 1 < r.length; o += 2) s.push([r[o], r[o + 1]]);
    t.push(s);
  }
  return t;
}
function lv(e, t) {
  const n = t / 2;
  return {
    cx: n,
    cy: n,
    r: n,
    stops: [
      { offset: 0, color: es(e.inner) },
      { offset: 0.42 + e.midT * 0.16, color: es(e.mid) },
      { offset: 0.93, color: es(e.rim) },
      { offset: 1, color: es(e.rim) },
    ],
  };
}
function es(e) {
  return `rgb(${Math.round(e[0] * 255)}, ${Math.round(e[1] * 255)}, ${Math.round(e[2] * 255)})`;
}
function ts(e) {
  return Math.round(e * 1e6) / 1e6;
}
const rt = Math.PI * 2;
const Cl = 1e-9;
const dv = 1e-7;
const hv = 1e-7;
const Vt = 720;
function fv(e) {
  return Array.from({ length: e }, (t, n) => (n / e) * rt);
}
function pv(e, t) {
  return e.flatMap((n) => n.map(([r, s]) => Us(t, r, s)));
}
function mv(e) {
  const t = e.flat().sort((n, r) => n - r);
  return t.filter((n, r) => r === 0 || n - t[r - 1] > dv);
}
function gv(e, t, n) {
  const r = Ev(e, t),
    s = Iv(n.map((o) => Pv(r, t, o)));
  return n.map((o, i) => [t[0] + Math.cos(o) * s[i], t[1] + Math.sin(o) * s[i]]);
}
function yv(e, t, n) {
  const [r, s] = t;
  return Array.from({ length: n }, (o, i) => {
    const a = (i / n) * rt,
      c = Math.cos(a),
      u = Math.sin(a),
      l = r === 0 || s === 0 ? 0 : 1 / Math.hypot(c / r, u / s);
    return [e[0] + c * l, e[1] + u * l];
  });
}
function kv(e, t, n) {
  const r = e
    .map(([s, o]) => ({ angle: Us(t, s, o), reach: Math.hypot(s - t[0], o - t[1]) }))
    .sort((s, o) => s.angle - o.angle);
  return n.map((s) => {
    const o = Av(r, s);
    return [t[0] + Math.cos(s) * o, t[1] + Math.sin(s) * o];
  });
}
function wv(e) {
  const t = Tv(e) < 0 ? [...e].reverse() : e,
    n = $v(t, Lh(t)),
    r = n == null ? t : [n.point, ...t.slice(n.edge + 1), ...t.slice(0, n.edge + 1)],
    s = [0];
  for (let i = 0; i < r.length; i++) {
    const [a, c] = r[i],
      [u, l] = r[(i + 1) % r.length];
    s.push(s[i] + Math.hypot(u - a, l - c));
  }
  const o = s[r.length] ?? 0;
  return { points: r, stations: s.map((i) => (o === 0 ? 0 : i / o)) };
}
function bv({ points: e, stations: t }, n) {
  if (e.length === 0) return [];
  let r = 0;
  return n.map((s) => {
    for (; r < e.length - 1 && t[r + 1] < s;) r++;
    const [o, i] = e[r],
      [a, c] = e[(r + 1) % e.length],
      u = t[r + 1] - t[r],
      l = u === 0 ? 0 : (s - t[r]) / u;
    return [o + (a - o) * l, i + (c - i) * l];
  });
}
function xv(e) {
  return Array.from({ length: e }, (t, n) => n / e);
}
function vv(e) {
  const t = e
    .flat()
    .filter((n) => n < 1)
    .sort((n, r) => n - r);
  return t.filter((n, r) => r === 0 || n - t[r - 1] > hv);
}
function Oh(e) {
  const t = e.reduce((r, s) => r + s.weight, 0),
    [n] = e;
  return n == null || t === 0
    ? []
    : n.outline.map((r, s) => {
        let o = 0,
          i = 0;
        for (const { outline: a, weight: c } of e) ((o += a[s][0] * c), (i += a[s][1] * c));
        return [o / t, i / t];
      });
}
function Sv(e, t, n) {
  return e.map(([r, s], o) => [r + (t[o][0] - r) * n, s + (t[o][1] - s) * n]);
}
function Mv(e, t) {
  return Array.from({ length: t }, () => [e[0], e[1]]);
}
function Lh(e) {
  if (e.length === 0) return [0, 0];
  let t = 0,
    n = 0;
  for (const [r, s] of e) ((t += r), (n += s));
  return [t / e.length, n / e.length];
}
function Gi(e) {
  return e.length === 0 ? "" : `M${e.map(([t, n]) => `${_l(t)} ${_l(n)}`).join("L")}Z`;
}
function Tv(e) {
  let t = 0;
  for (let n = 0; n < e.length; n++) {
    const [r, s] = e[n],
      [o, i] = e[(n + 1) % e.length];
    t += r * i - o * s;
  }
  return t / 2;
}
function Ev(e, t) {
  const n = Array.from({ length: Vt }, () => []);
  for (const r of e)
    for (let s = 0; s < r.length; s++) {
      const o = r[s],
        i = r[(s + 1) % r.length],
        a = Us(t, o[0], o[1]);
      let c = Us(t, i[0], i[1]) - a;
      (c > Math.PI && (c -= rt), c < -Math.PI && (c += rt));
      const u = Math.floor(((c < 0 ? a + c : a) / rt) * Vt) - 1,
        l = Math.floor(((c < 0 ? a : a + c) / rt) * Vt) + 1;
      for (let d = u; d <= l; d++) n[((d % Vt) + Vt) % Vt].push([o, i]);
    }
  return n;
}
function Pv(e, [t, n], r) {
  const s = Math.cos(r),
    o = Math.sin(r);
  let i = Number.NaN;
  for (const [[a, c], [u, l]] of e[Math.floor((r / rt) * Vt) % Vt]) {
    const d = u - a,
      h = l - c,
      f = s * h - o * d;
    if (Math.abs(f) < 1e-12) continue;
    const p = a - t,
      m = c - n,
      g = (p * h - m * d) / f,
      y = (p * o - m * s) / f;
    g >= 0 && y >= -Cl && y <= 1 + Cl && !(g <= i) && (i = g);
  }
  return i;
}
function Us(e, t, n) {
  const r = Math.atan2(n - e[1], t - e[0]);
  return r < 0 ? r + rt : r;
}
function Iv(e) {
  const t = e.length,
    n = e.flatMap((r, s) => (Number.isNaN(r) ? [] : [s]));
  return n.length === 0
    ? e.map(() => 0)
    : e.map((r, s) => {
        if (!Number.isNaN(r)) return r;
        const o = n.find((c) => c > s) ?? n[0] + t,
          i = [...n].reverse().find((c) => c < s) ?? (n.at(-1) ?? 0) - t,
          a = (s - i) / (o - i);
        return e[(i + t) % t] * (1 - a) + e[o % t] * a;
      });
}
function Av(e, t) {
  const n = e.length;
  if (n === 0) return 0;
  let r = e.findIndex((c) => c.angle >= t);
  r < 0 && (r = 0);
  const s = e[r],
    o = e[(r - 1 + n) % n],
    i = (s.angle - o.angle + rt) % rt;
  if (i === 0) return s.reach;
  const a = ((t - o.angle + rt) % rt) / i;
  return o.reach + (s.reach - o.reach) * a;
}
function $v(e, [t, n]) {
  let r = null;
  for (let s = 0; s < e.length; s++) {
    const [o, i] = e[s],
      [a, c] = e[(s + 1) % e.length];
    if (i === c || (i - n) * (c - n) > 0) continue;
    const u = o + ((n - i) / (c - i)) * (a - o);
    u >= t && (r == null || u > r.point[0]) && (r = { edge: s, point: [u, n] });
  }
  return r;
}
function _l(e) {
  return String(Math.round(e * 100) / 100);
}
const Cv = [1, 1];
function _v(e, t) {
  const n = e.length;
  let r = -1;
  for (let a = 0; a < n && r < 0; a++) e[a][2] <= 0 && e[(a + 1) % n][2] > 0 && (r = a);
  if (r < 0)
    return n === 0 || e[0][2] <= 0 ? null : e.map(([a, c]) => ({ kind: "line", to: [a, c] }));
  const s = [];
  let o = [1, 0],
    i = null;
  for (let a = 0; a < n; a++) {
    const c = e[(r + a) % n],
      u = e[(r + a + 1) % n],
      l = c[2] > 0,
      d = u[2] > 0;
    if (l && d) s.push({ kind: "line", to: [u[0], u[1]] });
    else if (l) ((i = Rl(c, u)), s.push({ kind: "line", to: i }));
    else if (d) {
      const h = Rl(c, u);
      (i === null ? (o = h) : s.push(Ol(i, h, t)), s.push({ kind: "line", to: [u[0], u[1]] }));
    }
  }
  return (i !== null && s.push(Ol(i, o, t)), s);
}
function Rv(e, t) {
  const n = Lv(e, t),
    r = n.length;
  if (n.every((c) => c.isInside)) return e;
  let s = -1;
  for (let c = 0; c < r && s < 0; c++) n[c].isInside && !n[(c + r - 1) % r].isInside && (s = c);
  if (s < 0) {
    const c = n.reduce((u, l) => u + l.sweep, 0);
    return Math.abs(c) > Math.PI ? Tr(t, Math.sign(c)) : null;
  }
  const o = [];
  let i = null,
    a = 0;
  for (let c = 0; c < r; c++) {
    const u = n[(s + c) % r];
    u.isInside
      ? (i !== null && o.push({ kind: "arc", to: u.from, radii: t, sweep: a }),
        (i = null),
        o.push(u.segment))
      : (i === null && ((i = u.from), (a = 0)), (a += u.sweep));
  }
  return (i !== null && o.push({ kind: "arc", to: n[s].from, radii: t, sweep: a }), o);
}
function Ov(e, t) {
  const n = (a) => a.kind === "arc" && a.radii[0] === e[0] && a.radii[1] === e[1],
    r = [],
    s = [],
    o = [],
    i = [];
  for (const a of t) {
    const c = a.findIndex(n);
    if (c < 0) {
      r.push(a);
      continue;
    }
    let u = a[c].to,
      l = [],
      d = u;
    for (let h = 1; h <= a.length; h++) {
      const f = a[(c + h) % a.length];
      (n(f)
        ? (o.push({ from: d, sweep: f.sweep }),
          i.push(d, f.to),
          l.length > 0 && s.push(jv(u, l)),
          (l = []),
          (u = f.to))
        : l.push(f),
        (d = f.to));
    }
  }
  return o.length === 0 ? [Tr(e, 1), ...r] : [...qv([...s, ...zv(e, o, i)]), ...r];
}
function Tr(e, t) {
  return [
    { kind: "arc", to: [-e[0], 0], radii: e, sweep: t * Math.PI },
    { kind: "arc", to: [e[0], 0], radii: e, sweep: t * Math.PI },
  ];
}
function Nh(e, t) {
  const n = Math.cos(t),
    r = Math.sin(t),
    s = 1 / Math.sqrt((n * n) / (e[0] * e[0]) + (r * r) / (e[1] * e[1]));
  return [s * n, s * r];
}
function Rl(e, t) {
  const n = e[2] / (e[2] - t[2]),
    r = e[0] + (t[0] - e[0]) * n,
    s = e[1] + (t[1] - e[1]) * n,
    o = Math.sqrt(r * r + s * s);
  return [r / o, s / o];
}
function Ol(e, t, n) {
  const r = Nl(Math.atan2(t[1], t[0]) - n) - Nl(Math.atan2(e[1], e[0]) - n);
  return { kind: "arc", to: t, radii: Cv, sweep: r };
}
function Lv(e, t) {
  const n = 1 / (t[0] * t[0]),
    r = 1 / (t[1] * t[1]),
    s = (a) => n * a[0] * a[0] + r * a[1] * a[1] - 1,
    o = [];
  let i = e[e.length - 1].to;
  for (const a of e) {
    if (a.kind === "line") {
      const c = Nv(i, a.to, n, r);
      let u = i;
      for (let l = 0; l <= c.length; l++) {
        const d = l === 0 ? 0 : c[l - 1],
          h = l === c.length ? 1 : c[l],
          f = l === c.length ? a.to : Ll(i, a.to, h);
        (o.push({
          from: u,
          segment: { kind: "line", to: f },
          sweep: Math.atan2(u[0] * f[1] - u[1] * f[0], u[0] * f[0] + u[1] * f[1]),
          isInside: s(Ll(i, a.to, (d + h) / 2)) < 0,
        }),
          (u = f));
      }
    } else {
      const c = a.radii[0],
        u = Math.atan2(i[1], i[0]),
        l = Fv(c, u, a.sweep, n, r);
      let d = i;
      for (let h = 0; h <= l.length; h++) {
        const f = h === 0 ? 0 : l[h - 1],
          p = h === l.length ? 1 : l[h],
          m = u + a.sweep * p,
          g = h === l.length ? a.to : [c * Math.cos(m), c * Math.sin(m)],
          y = u + (a.sweep * (f + p)) / 2,
          w = a.sweep * (p - f);
        (o.push({
          from: d,
          segment: { kind: "arc", to: g, radii: a.radii, sweep: w },
          sweep: w,
          isInside: s([c * Math.cos(y), c * Math.sin(y)]) < 0,
        }),
          (d = g));
      }
    }
    i = a.to;
  }
  return o;
}
function Nv(e, t, n, r) {
  const s = t[0] - e[0],
    o = t[1] - e[1],
    i = n * s * s + r * o * o,
    a = n * e[0] * s + r * e[1] * o,
    c = n * e[0] * e[0] + r * e[1] * e[1] - 1,
    u = a * a - i * c;
  if (i === 0 || u <= 0) return [];
  const l = Math.sqrt(u),
    d = -(a + (a < 0 ? -l : l));
  return [d / i, c / d].filter((h) => h > 0 && h < 1).sort((h, f) => h - f);
}
function Fv(e, t, n, r, s) {
  if (r === s || n === 0) return [];
  const o = (1 / (e * e) - s) / (r - s);
  if (!(o > 0 && o < 1)) return [];
  const i = Math.acos(Math.sqrt(o)),
    a = [];
  for (const c of [i, -i, Math.PI - i, Math.PI + i]) {
    const l = (n > 0 ? Er(c - t) : Er(t - c)) / Math.abs(n);
    l > 0 && l < 1 && a.push(l);
  }
  return a.sort((c, u) => c - u);
}
function jv(e, t) {
  const n = [e, ...t.map((s) => s.to)],
    r = t
      .map((s, o) =>
        s.kind === "line" ? { kind: "line", to: n[o] } : { ...s, to: n[o], sweep: -s.sweep },
      )
      .reverse();
  return { from: n[n.length - 1], to: e, segments: r };
}
function zv(e, t, n) {
  const r = n
      .map((o) => ({ point: o, angle: Er(Math.atan2(o[1], o[0])) }))
      .sort((o, i) => o.angle - i.angle),
    s = [];
  for (let o = 0; o < r.length; o++) {
    const i = r[o],
      a = r[(o + 1) % r.length],
      c = o + 1 < r.length ? a.angle - i.angle : a.angle + 2 * Math.PI - i.angle;
    if (c <= 0) continue;
    const u = i.angle + c / 2;
    t.reduce((l, d) => l + Dv(d, u), 0) === 0 &&
      s.push({
        from: i.point,
        to: a.point,
        segments: [{ kind: "arc", to: a.point, radii: e, sweep: c }],
      });
  }
  return s;
}
function Dv(e, t) {
  const n = Math.atan2(e.from[1], e.from[0]);
  return (e.sweep > 0 ? Er(t - n) : Er(n - t)) < Math.abs(e.sweep) ? Math.sign(e.sweep) : 0;
}
function qv(e) {
  const t = (o) => `${o[0]} ${o[1]}`,
    n = new Map();
  for (const o of e) {
    const i = n.get(t(o.from));
    i === void 0 ? n.set(t(o.from), [o]) : i.push(o);
  }
  const r = new Set(),
    s = [];
  for (const o of e) {
    const i = [];
    let a = o;
    for (; a !== void 0 && !r.has(a);)
      (r.add(a), i.push(...a.segments), (a = n.get(t(a.to))?.find((c) => !r.has(c))));
    i.length > 0 && s.push(i);
  }
  return s;
}
function Ll(e, t, n) {
  return [e[0] + (t[0] - e[0]) * n, e[1] + (t[1] - e[1]) * n];
}
function Nl(e) {
  return e - 2 * Math.PI * Math.round(e / (2 * Math.PI));
}
function Er(e) {
  const t = e % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}
const Bv = 60;
const Hv = 256;
const Vv = 24;
const Gv = 2e4;
const Wv = 0.2;
function Uv(e, t, n) {
  const r = {
      field: e,
      tolerance: n,
      root: n.deviation * 0.001,
      reach: t.step * Math.hypot(t.nx, t.ny),
    },
    s = [];
  for (const o of Kv(r, t)) {
    const i = Zv(Xv(r, o), n);
    i.length >= 3 && s.push(i);
  }
  return s;
}
function Kv(e, t) {
  const { field: n } = e,
    { x0: r, y0: s, step: o, nx: i, ny: a } = t,
    c = i + 1,
    u = new Float64Array(c * (a + 1));
  for (let v = 0; v <= a; v++) for (let x = 0; x <= i; x++) u[v * c + x] = n(r + x * o, s + v * o);
  const l = 2 * c * (a + 1),
    d = new Int32Array(l).fill(-1),
    h = new Map(),
    f = (v) => {
      const x = h.get(v);
      if (x !== void 0) return x;
      const E = v >> 1,
        A = v & 1 ? E + c : E + 1,
        j = r + (E % c) * o,
        F = s + Math.floor(E / c) * o,
        O = r + (A % c) * o,
        L = s + Math.floor(A / c) * o,
        T = Fh(e, j, F, u[E], O, L, u[A]),
        I = [j + (O - j) * T, F + (L - F) * T];
      return (h.set(v, I), I);
    },
    p = [0, 0, 0, 0],
    m = [0, 0, 0, 0],
    g = [],
    y = [];
  for (let v = 0; v < a; v++)
    for (let x = 0; x < i; x++) {
      const E = v * c + x;
      ((p[0] = E),
        (p[1] = E + 1),
        (p[2] = E + 1 + c),
        (p[3] = E + c),
        (m[0] = 2 * E),
        (m[1] = 2 * (E + 1) + 1),
        (m[2] = 2 * (E + c)),
        (m[3] = 2 * E + 1),
        (g.length = 0),
        (y.length = 0));
      for (let A = 0; A < 4; A++) {
        const j = u[p[A]] < 0,
          F = u[p[(A + 1) & 3]] < 0;
        j !== F && (g.push(m[A]), y.push(j));
      }
      if (g.length === 2) {
        const A = y[0] ? 0 : 1;
        d[g[A]] = g[1 - A];
      } else if (g.length === 4) {
        const A = n(r + (x + 0.5) * o, s + (v + 0.5) * o) < 0;
        for (let j = 0; j < 4; j++) y[j] && (d[g[j]] = g[(j + (A ? 1 : 3)) & 3]);
      }
    }
  const w = [],
    S = new Uint8Array(l);
  for (let v = 0; v < l; v++) {
    if (d[v] < 0 || S[v]) continue;
    const x = [];
    let E = v;
    for (; E >= 0 && !S[E];) ((S[E] = 1), x.push(f(E)), (E = d[E]));
    E === v && w.push(x);
  }
  return w;
}
function Fh(e, t, n, r, s, o, i) {
  let a = 0,
    c = r,
    u = 1,
    l = i,
    d = 0,
    h = 0;
  for (let f = 0; f < Bv; f++) {
    h = (a * l - u * c) / (l - c);
    const p = e.field(t + (s - t) * h, n + (o - n) * h);
    if (Math.abs(p) <= e.root || u - a <= 1e-15) break;
    p < 0 == l < 0
      ? ((u = h), (l = p), d === -1 && (c /= 2), (d = -1))
      : ((a = h), (c = p), d === 1 && (l /= 2), (d = 1));
  }
  return h;
}
function Xv(e, t) {
  const n = [];
  for (let r = 0; r < t.length; r++) {
    const s = t[r],
      o = t[(r + 1) % t.length];
    (s[0] === o[0] && s[1] === o[1]) || (n.push(s), Wi(e, s, o, 0, n));
  }
  return n;
}
function Wi(e, t, n, r, s) {
  const o = n[0] - t[0],
    i = n[1] - t[1],
    a = Math.sqrt(o * o + i * i);
  if (a === 0 || r >= Vv || s.length >= Gv) return;
  const c = (t[0] + n[0]) / 2,
    u = (t[1] + n[1]) / 2,
    l = e.field(c, u);
  if (!Number.isFinite(l)) return;
  const d = l > 0 ? 1 : -1,
    h = (-i / a) * d,
    f = (o / a) * d,
    p = jh(e, c, u, l, h, f);
  if (p === null || (p <= e.tolerance.deviation / 2 && a <= e.tolerance.edge)) return;
  const m = l > 0 ? Yv(e, c, u, l, h, f, p) : [c + h * p, u + f * p];
  (Wi(e, t, m, r + 1, s), s.push(m), Wi(e, m, n, r + 1, s));
}
function Yv(e, t, n, r, s, o, i) {
  const a = [t + s * i, n + o * i],
    c = i * 0.001,
    u = e.field(t + c, n) - e.field(t - c, n),
    l = e.field(t, n + c) - e.field(t, n - c),
    d = Math.sqrt(u * u + l * l);
  if (d === 0) return a;
  const h = u * o - l * s < 0 ? -1 : 1,
    f = (-l / d) * h,
    p = (u / d) * h;
  if (f * s + p * o < Wv) return a;
  const m = jh(e, t, n, r, f, p);
  return m === null || m * (f * s + p * o) <= i ? a : [t + f * m, n + p * m];
}
function jh(e, t, n, r, s, o) {
  if (r === 0) return 0;
  let i = 0,
    a = r;
  for (let c = 0; c < Hv; c++) {
    const u = i + Math.max(Math.abs(a), e.root);
    if (u > e.reach) return null;
    const l = t + s * u,
      d = n + o * u,
      h = e.field(l, d);
    if (h < 0 != r < 0) return i + (u - i) * Fh(e, t + s * i, n + o * i, a, l, d, h);
    ((i = u), (a = h));
  }
  return null;
}
function Zv(e, t) {
  const n = e.length;
  if (n < 4) return e;
  const r = new Uint8Array(n);
  let s = 0,
    o = -1;
  for (let a = 1; a < n; a++) {
    const c = Fl(e[0], e[a]);
    c > o && ((o = c), (s = a));
  }
  ((r[0] = 1), (r[s] = 1));
  const i = (a, c) => {
    if (c - a < 2) return;
    const u = e[a],
      l = e[c % n];
    let d = -1,
      h = a;
    for (let p = a + 1; p < c; p++) {
      const m = Qv(e[p], u, l);
      m > d && ((d = m), (h = p));
    }
    const f = d > t.deviation / 2;
    (!f && Math.sqrt(Fl(u, l)) <= t.edge) ||
      (f || (h = (a + c) >> 1), (r[h] = 1), i(a, h), i(h, c));
  };
  return (i(0, s), i(s, n), e.filter((a, c) => r[c] === 1));
}
function Fl(e, t) {
  const n = t[0] - e[0],
    r = t[1] - e[1];
  return n * n + r * r;
}
function Qv(e, t, n) {
  const r = n[0] - t[0],
    s = n[1] - t[1],
    o = e[0] - t[0],
    i = e[1] - t[1],
    a = r * r + s * s,
    c = a > 0 ? Math.min(1, Math.max(0, (o * r + i * s) / a)) : 0,
    u = o - r * c,
    l = i - s * c;
  return Math.sqrt(u * u + l * l);
}
const Jv = 0.02;
const eS = 16;
const tS = 0.015;
const nS = 400;
const rS = 512;
const Ks = 5;
const cn = new Map();
function sS(e, t) {
  const n = Math.min(eS, Math.max(0, Math.ceil(Math.log2(Math.max(t, 1))))),
    r = `${n}|${e.wid}|${e.oval.join()}|${e.ovalMix}|${e.pts.join()}`,
    s = cn.get(r);
  if (s !== void 0) return (cn.delete(r), cn.set(r, s), s);
  const o = cS(oS(e), Jv / 2 ** n);
  if ((cn.set(r, o), cn.size > rS)) {
    const i = cn.keys().next();
    i.done !== !0 && cn.delete(i.value);
  }
  return o;
}
function oS(e) {
  const [t, n] = e.oval,
    s =
      t > 1e-5 && n > 1e-5
        ? e.ovalMix > 1e-4
          ? Math.min(1, e.ovalMix)
          : uS(0, 0.08, Math.min(t, n))
        : 0,
    o = Math.max(0, e.pts.length - 1),
    i = new Float64Array(o * Ks);
  for (let a = 0; a < o; a++) {
    const [c, u] = e.pts[a],
      l = e.pts[a + 1][0] - c,
      d = e.pts[a + 1][1] - u,
      h = l * l + d * d;
    i.set([c, u, l, d, h > 0 ? 1 / h : 0], a * Ks);
  }
  return { segments: i, halfWidth: e.wid > 0 ? e.wid : -1, rx: t, ry: n, ellipseMix: s };
}
function iS(e, t, n) {
  const r = aS(e.segments, t, n) - e.halfWidth;
  if (e.ellipseMix === 0) return r;
  const s = t / e.rx,
    o = n / e.ry,
    i = (Math.sqrt(s * s + o * o) - 1) * Math.min(e.rx, e.ry);
  return r * (1 - e.ellipseMix) + i * e.ellipseMix;
}
function aS(e, t, n) {
  let r = 1e6;
  for (let s = 0; s < e.length; s += Ks) {
    const o = t - e[s],
      i = n - e[s + 1],
      a = e[s + 2],
      c = e[s + 3],
      u = (o * a + i * c) * e[s + 4],
      l = u < 0 ? 0 : u > 1 ? 1 : u,
      d = o - a * l,
      h = i - c * l,
      f = d * d + h * h;
    f < r && (r = f);
  }
  return Math.sqrt(r);
}
function cS(e, t) {
  let n = 1 / 0,
    r = 1 / 0,
    s = -1 / 0,
    o = -1 / 0,
    i = 1 / 0;
  const { segments: a, halfWidth: c } = e;
  if (c > 0 && e.ellipseMix < 1 && a.length > 0) {
    for (let d = 0; d < a.length; d += Ks)
      for (const [h, f] of [
        [a[d], a[d + 1]],
        [a[d] + a[d + 2], a[d + 1] + a[d + 3]],
      ])
        ((n = Math.min(n, h - c)),
          (r = Math.min(r, f - c)),
          (s = Math.max(s, h + c)),
          (o = Math.max(o, f + c)));
    i = c;
  }
  if (
    (e.ellipseMix > 0 &&
      ((n = Math.min(n, -e.rx)),
      (r = Math.min(r, -e.ry)),
      (s = Math.max(s, e.rx)),
      (o = Math.max(o, e.ry)),
      (i = Math.min(i, e.rx, e.ry))),
    !(s > n && o > r))
  )
    return [];
  const u = Math.max(Math.min(tS, i / 3), Math.max(s - n, o - r) / nS),
    l = {
      x0: n - 2 * u,
      y0: r - 2 * u,
      step: u,
      nx: Math.ceil((s - n) / u) + 4,
      ny: Math.ceil((o - r) / u) + 4,
    };
  return Uv((d, h) => iS(e, d, h), l, { deviation: t, edge: Math.sqrt(4 * t) });
}
function uS(e, t, n) {
  const r = Math.min(1, Math.max(0, (n - e) / (t - e)));
  return r * r * (3 - 2 * r);
}
const jl = 48;
const zl = 11;
const or = 0.055;
const zh = Math.PI * 0.999;
const lS = 0.4;
const dS = 0.0035;
const hS = 0.75;
const fS = 0.45;
const pS = 1.8;
const mS = 0.8;
const gS = J1.map(MS);
const yS = 192;
const kS = Math.PI / 48;
function wS(e, t, n, r = {}) {
  const s = (e.zoom * n) / 2,
    [o, i] = e.squash;
  if (s === 0 || o === 0 || i === 0)
    return { size: n, body: "", eyes: "", glow: null, proof: null };
  const a = [Math.abs(o), Math.abs(i)],
    c = n / 2 + s * e.offset[0],
    u = n / 2 - s * (e.squashAnchor * (1 - i) + e.offset[1]),
    l = (f) => `${Ct(c + f[0] * s)} ${Ct(u - f[1] * s)}`,
    d = (f) => f.map((p) => Ui(p, l, Math.abs(s))).join(""),
    h = Dh(e, Math.abs(s));
  return {
    size: n,
    body: d(t.cutout ? Ov(a, h) : [Tr(a, 1)]),
    eyes: t.cutout ? "" : d(h),
    glow: e.glow === null ? null : TS(e.glow, a, l, Math.abs(s)),
    proof: r.isProof === !0 ? ES(e, t, a, l, s, n) : null,
  };
}
function Dh(e, t) {
  if (e.eyes === null) return [];
  const n = Xn(e.quat),
    r = [Math.abs(e.squash[0]), Math.abs(e.squash[1])],
    s = r[0] < 1 || r[1] < 1,
    o = [];
  return (
    e.eyes.forEach((i, a) => {
      for (const c of SS(i, J1[a], gS[a], n, t)) {
        const u = s ? Rv(c, r) : c;
        u !== null && o.push(u);
      }
    }),
    o
  );
}
function bS(e, t) {
  const n = (e.zoom * t) / 2,
    [r, s] = e.squash,
    o = [t / 2 + n * e.offset[0], t / 2 - n * (e.squashAnchor * (1 - s) + e.offset[1])],
    i = Math.abs(n),
    a = ([c, u]) => [o[0] + c * n, o[1] - u * n];
  return {
    center: o,
    radius: i,
    body: [yv(o, [Math.abs(r) * i, Math.abs(s) * i], yS)],
    eyes: Dh(e, i).map((c) => xS(c).map(a)),
  };
}
function xS(e) {
  const t = [];
  let n = e[e.length - 1]?.to ?? [0, 0];
  for (const r of e) {
    if (r.kind === "arc") {
      const s = Math.atan2(n[1], n[0]),
        o = Math.max(1, Math.ceil(Math.abs(r.sweep) / kS));
      for (let i = 1; i < o; i++) t.push(Nh(r.radii, s + (r.sweep * i) / o));
    }
    (t.push(r.to), (n = r.to));
  }
  return t;
}
function vS(e, t, n = "grok-sphere", r = e.size) {
  const s = [],
    o = [];
  let i = Na(t);
  if (
    (e.glow?.halo != null &&
      (s.push(oi(`${n}-halo`, e.glow.halo.gradient)),
      o.push(`<path d="${e.glow.halo.d}" fill="url(#${n}-halo)" fill-rule="evenodd"/>`)),
    e.proof !== null
      ? ((i = `url(#${n}-light)`),
        s.push(
          oi(`${n}-light`, e.proof.light),
          `<clipPath id="${n}-proof"><path d="${e.body}" clip-rule="evenodd"/></clipPath>`,
        ))
      : e.glow !== null && ((i = `url(#${n}-body)`), s.push(oi(`${n}-body`, e.glow.body))),
    o.push(`<path d="${e.body}" fill="${i}" fill-rule="evenodd"/>`),
    e.eyes !== "" && o.push(`<path d="${e.eyes}" fill="${Fa(t)}"/>`),
    e.proof !== null)
  ) {
    const a = e.proof.lines
      .filter((c) => c.d !== "")
      .map(
        (c) =>
          `<path d="${c.d}" fill="none" stroke="${c.color}" stroke-width="${Ct(c.width)}" stroke-opacity="${c.opacity}"/>`,
      );
    o.push(`<g clip-path="url(#${n}-proof)">${a.join("")}</g>`);
  }
  return `${ja(e.size, n, r)}${s.length > 0 ? `<defs>${s.join("")}</defs>` : ""}${o.join("")}</svg>`;
}
function SS(e, t, n, r, s) {
  const o = sS(e, s * Math.max(1, e.lidY));
  if (o.length === 0) return [];
  const i = wt(r, t.M),
    a = wt(r, t.C),
    c = wt(r, t.T),
    u = Math.atan2(i[1], i[0]),
    l = Math.cos(e.tilt),
    d = Math.sin(e.tilt),
    [h, f] = e.off,
    p = ([g, y]) => {
      const w = y * e.lidY,
        S = h + l * g + d * w,
        v = f - d * g + l * w,
        x = Math.sqrt(S * S + v * v),
        E = x > 1e-12 ? Math.sin(x) / x : 1,
        A = Math.cos(x);
      return [
        A * i[0] + E * (S * a[0] + v * c[0]),
        A * i[1] + E * (S * a[1] + v * c[1]),
        A * i[2] + E * (S * a[2] + v * c[2]),
      ];
    },
    m = [];
  for (const g of o) {
    const y = g.map(p);
    n && y.reverse();
    const w = _v(y, u);
    w !== null && m.push(w);
  }
  return m;
}
function MS({ M: e, T: t, C: n }) {
  const r = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return r[0] * e[0] + r[1] * e[1] + r[2] * e[2] < 0;
}
function Ui(e, t, n) {
  let r = e[e.length - 1].to,
    s = `M${t(r)}`;
  for (const o of e) ((s += o.kind === "line" ? `L${t(o.to)}` : Ki(r, o, t, n)), (r = o.to));
  return `${s}Z`;
}
function Ki(e, t, n, r) {
  if (t.sweep === 0) return "";
  if (Math.abs(t.sweep) > zh) {
    const o = t.sweep / 2,
      i = Nh(t.radii, Math.atan2(e[1], e[0]) + o);
    return Ki(e, { ...t, to: i, sweep: o }, n, r) + Ki(i, { ...t, sweep: o }, n, r);
  }
  return `A${`${Ct(t.radii[0] * r)} ${Ct(t.radii[1] * r)}`} 0 0 ${t.sweep > 0 ? 0 : 1} ${n(t.to)}`;
}
function TS(e, t, n, r) {
  const s = 0.42 + 0.16 * e.midT,
    o = [];
  for (let u = 0; u <= jl; u++) {
    const l = 1 - (1 - u / jl) ** 2;
    o.push({ offset: l, color: Sr(IS(e, s, l)), opacity: 1 });
  }
  const i = { transform: Bl(t, n, r), focus: 0, stops: o };
  if (!(e.halo > 0)) return { body: i, halo: null };
  const a = [];
  for (let u = 0; u <= zl; u++) {
    const l = (or * u) / zl,
      d = Math.min(1, e.halo * (1 - Xi(0, or, l)));
    a.push({ offset: (1 + l) / (1 + or), color: Sr(e.rim), opacity: d });
  }
  const c = [t[0] * (1 + or), t[1] * (1 + or)];
  return {
    body: i,
    halo: {
      d: Ui(Tr(c, 1), n, r) + Ui(Tr(t, 1), n, r),
      gradient: { transform: Bl(c, n, r), focus: 0, stops: a },
    },
  };
}
function ES(e, t, n, r, s, o) {
  const i = Xn(e.quat);
  let a = "",
    c = "";
  for (const f of zx) {
    const p = Dx(f, i);
    p !== null && (f.isEquator ? (c += Dl(p, r, s)) : (a += Dl(p, r, s)));
  }
  const u = ql(t.ink, [1, 1, 1], lS),
    l = Bx(),
    d = 0.2126 * u[0] + 0.7152 * u[1] + 0.0722 * u[2] > 0.6 ? "#000000" : "#ffffff",
    h = Math.max(hS, o * dS);
  return {
    light: {
      transform: PS(l, n, r, s),
      focus: l.focus,
      stops: l.stops.map((f) => ({
        offset: f.offset,
        color: Sr(ql([0, 0, 0], u, f.shade)),
        opacity: 1,
      })),
    },
    lines: [
      { d: a, color: d, width: h, opacity: fS },
      { d: c, color: d, width: h * pS, opacity: mS },
    ],
  };
}
function Dl(e, t, n) {
  const r = (p) => [
      e.center[0] + e.a[0] * Math.cos(p) + e.b[0] * Math.sin(p),
      e.center[1] + e.a[1] * Math.cos(p) + e.b[1] * Math.sin(p),
    ],
    s = 0.5 * Math.atan2(2 * si(e.a, e.b), si(e.a, e.a) - si(e.b, e.b)),
    [o, i] = [Math.cos(s), Math.sin(s)],
    a = [e.a[0] * o + e.b[0] * i, e.a[1] * o + e.b[1] * i],
    c = [e.b[0] * o - e.a[0] * i, e.b[1] * o - e.a[1] * i],
    u = `${Ct(Math.hypot(a[0], a[1]) * Math.abs(n))} ${Ct(Math.hypot(c[0], c[1]) * Math.abs(n))}`,
    l = Math.round(Math.atan2(-a[1] * n, a[0] * n) * (180 / Math.PI) * 1e3) / 1e3,
    d = e.a[0] * e.b[1] - e.a[1] * e.b[0] > 0 ? 0 : 1,
    h = Math.ceil((e.to - e.from) / zh);
  let f = `M${t(r(e.from))}`;
  for (let p = 1; p <= h; p++) f += `A${u} ${l} 0 ${d} ${t(r(e.from + ((e.to - e.from) * p) / h))}`;
  return f;
}
function PS(e, t, n, r) {
  const [s, o] = e.axisX,
    [i, a] = e.axisY,
    c = [s * t[0] * r, -o * t[1] * r, i * t[0] * r, -a * t[1] * r],
    u = n([e.origin[0] * t[0], e.origin[1] * t[1]]);
  return `matrix(${c.map((l) => Math.round(l * 1e4) / 1e4).join(" ")} ${u})`;
}
function ql(e, t, n) {
  return [e[0] + (t[0] - e[0]) * n, e[1] + (t[1] - e[1]) * n, e[2] + (t[2] - e[2]) * n];
}
function si(e, t) {
  return e[0] * t[0] + e[1] * t[1];
}
function IS(e, t, n) {
  const r = Xi(0.12, t, n),
    s = Xi(t, 0.93, n),
    o = 0.9 + 0.1 * Math.max(0, 1 - n * n) ** 0.225,
    i = (a) => {
      const c = e.inner[a] + (e.mid[a] - e.inner[a]) * r;
      return (c + (e.rim[a] - c) * s) * o;
    };
  return [i(0), i(1), i(2)];
}
function Bl(e, t, n) {
  return `matrix(${Ct(e[0] * n)} 0 0 ${Ct(e[1] * n)} ${t([0, 0])})`;
}
function oi(e, t) {
  const n = t.stops
    .map((r) => `<stop offset="${r.offset}" stop-color="${r.color}" stop-opacity="${r.opacity}"/>`)
    .join("");
  return `<radialGradient id="${e}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" fx="${t.focus}" fy="0" gradientTransform="${t.transform}">${n}</radialGradient>`;
}
function Xi(e, t, n) {
  const r = Math.min(1, Math.max(0, (n - e) / (t - e)));
  return r * r * (3 - 2 * r);
}
function Ct(e) {
  return String(Math.round(e * 100) / 100);
}
const AS = -15 + 259 / 2;
const $S = 0.62;
const Hl = 96;
const CS = Math.PI * 2;
const ii = {
  dots: 22,
  orbit: 19,
  radar: 19,
  progress: 19,
  gather: 19,
  wave: 16,
  send: 20,
  receive: 20,
  dock: 20,
  ball: 18,
  pencil: 17,
  bang: 13,
  standby: 13,
};
const Vl = {
  dots: 1.5,
  orbit: 1.14,
  radar: 1.14,
  progress: 1.32,
  gather: 1.15,
  wave: 1.42,
  send: 1.12,
  receive: 1.12,
  dock: 1.3,
  ball: 1.22,
  pencil: 1.18,
  bang: 1.28,
  standby: 1.75,
};
const _S = 22;
const Gl = 62;
const RS = 0.84;
const OS = 0.22;
const LS = 1.02;
const NS = 9;
const FS = 1400;
const qh = 1500;
const Yi = 1700;
const Xs = 2500;
const hr = 0.68;
const ks = Xs * hr;
const jS = 2.4;
const zS = 120;
const DS = La("progress") * 1e3;
const qS = La("spawning") * 1e3;
const BS = [-2, -1, 1, 2];
const _t = (e) => ((e % 1) + 1) % 1;
const HS = (e, t) => {
  const n = e.length,
    r = (t / n) * Math.PI * 2,
    s = Math.cos(r),
    o = Math.sin(r);
  return Array.from({ length: n }, (i, a) => {
    const [c, u] = e[(((a - t) % n) + n) % n],
      l = c - b,
      d = u - b;
    return [b + l * s - d * o, b + l * o + d * s];
  });
};
const Bh = Array.from({ length: Hl }, (e, t) => {
  const n = (t / Hl) * CS;
  return [b + Math.cos(n) * b, b + Math.sin(n) * b];
});
const Wl = hh(88, 18).ring;
const VS = HS(Wl, Wl.length / 2);
const ai = (e) => (e === "pencil" ? VS : Bh);
const GS = (e, t) => {
  const n = e / 2,
    r = b - t / 2 + n,
    s = b + t / 2 - n;
  return `M${b - n} ${r}A${n} ${n} 0 0 1 ${b + n} ${r}L${b + n} ${s}A${n} ${n} 0 0 1 ${b - n} ${s}Z`;
};
const WS = (e, t, n) => {
  const r = e / 2,
    s = t / 2,
    o = b - n / 2,
    i = b + n / 2;
  return `M${b - r} ${o + r}A${r} ${r} 0 0 1 ${b + r} ${o + r}L${b + s} ${i - s}A${s} ${s} 0 0 1 ${b - s} ${i - s}Z`;
};
const US = GS(30, 88);
const KS = WS(30, 17, 96);
const Rt = (e, t, n, r, s) => ({ type: "disc", key: e, cx: t, cy: n, r, opacity: s });
const lo = (e, t, n, r) => ({ type: "ring", key: e, cx: b, cy: b, r: t, width: n, opacity: r });
const Hh = (e, t, n, r) => ({ type: "shape", key: e, d: t, transform: n, opacity: r });
const XS = (e, t, n, r) => ({ type: "stroke", key: e, d: t, width: n, opacity: r });
const YS = { lift: 0, pop: 1, tone: 1 };
const Vh = (e, t, n, r) => {
  const s = _t((e.stateTime * 1e3) / FS + 0.119),
    o = Math.abs(s - t / 3),
    i = Math.min(o, 1 - o),
    a = r ? 1 : Math.exp(-(i * i) / (2 * 0.15 * 0.15)),
    c = r ? 0 : 1;
  return { lift: a * NS * n * c, pop: 1 + c * (RS + OS * a - 1), tone: 1 - c * 0.5 * (1 - a) };
};
const ZS = (e) =>
  0.42 + 0.29 * Math.sin(e * 0.0021) * Math.sin(e * 0.0034) + 0.29 * Math.sin(e * 0.0013 + 1.7);
const QS = (e, t) => ZS(e) * (0.55 + 0.45 * Math.sin(e * 0.012 - Math.abs(t) * 1.05));
const JS = (e) => -Math.PI * 1.25 + Oa(e)() * Math.PI * 1.5;
const eM = (e) => {
  const r = 1082.2060353798126,
    s = 40,
    o = Math.sqrt((2 * s) / r);
  if (e < o) return 0.5 * r * e * e;
  const i = _t((e - o) / 0.62);
  return s - 208 * i * (1 - i);
};
const Ua = (e) => {
  const t = _t(e / Xs);
  if (t < hr) {
    const r = t / hr,
      s = r * r * (3 - 2 * r),
      o = de(r / 0.08, 0, 1) * de((1 - r) / 0.08, 0, 1);
    return {
      x: -54 + 118 * s,
      y: 26,
      wig: Math.sin(r * 24) * 3.2 * o,
      rot: 17 + Math.sin(e * 6e-4) * 1,
    };
  }
  const n = Fs((t - hr) / (1 - hr));
  return {
    x: 64 - 118 * n,
    y: 26 - 20 * Math.sin(n * Math.PI),
    wig: 0,
    rot: 17 - 2 * Math.sin(n * Math.PI) + Math.sin(e * 6e-4) * 1,
  };
};
const Gh = (e) => {
  const t = Ua(e);
  return [b + t.x, b + t.y + t.wig + 19];
};
const tM = (() => {
  const e = [];
  for (let t = 0; t < ks; t++) {
    const n = Gh(t),
      r = e[e.length - 1];
    (r === void 0 || Math.hypot(n[0] - r.point[0], n[1] - r.point[1]) > jS) &&
      e.push({ at: t, point: n });
  }
  return e;
})();
const nM = (e) => {
  const t = _t(e / Xs) * Xs,
    n = Math.min(t, ks),
    r = tM.filter((a) => a.at <= n),
    s = r.length > 0 ? r[r.length - 1].at : n,
    o = n > s ? [Gh(n)] : [],
    i = [...r.map((a) => a.point), ...o].slice(-64);
  return t < ks ? i : i.slice(Math.floor(((t - ks) / 1e3) * zS));
};
const rM = (e) => {
  const t = e.length;
  let n = `M${e[0][0].toFixed(1)} ${e[0][1].toFixed(1)}`;
  if (t === 2) return n + `L${e[1][0].toFixed(1)} ${e[1][1].toFixed(1)}`;
  for (let r = 0; r < t - 1; r++) {
    const s = e[Math.max(r - 1, 0)],
      o = e[r],
      i = e[r + 1],
      a = e[Math.min(r + 2, t - 1)],
      c = o[0] + (i[0] - s[0]) / 6,
      u = o[1] + (i[1] - s[1]) / 6,
      l = i[0] - (a[0] - o[0]) / 6,
      d = i[1] - (a[1] - o[1]) / 6;
    n += `C${c.toFixed(1)} ${u.toFixed(1)} ${l.toFixed(1)} ${d.toFixed(1)} ${i[0].toFixed(1)} ${i[1].toFixed(1)}`;
  }
  return n;
};
const sM = (e, t, n) => {
  const r = [b - Gl, b + Gl],
    s = [];
  for (let o = 0; o < 2; o++) {
    const i = de((e - o * 0.12) / (1 - o * 0.12), 0, 1);
    if (i <= 0.004) continue;
    const a = Ge(i),
      c = io(i),
      u = Vh(t, o === 0 ? 0 : 2, e, n);
    s.push(Rt(`dots.${o}`, b + (r[o] - b) * c, b - u.lift, _S * a * u.pop * LS, a * u.tone));
  }
  return s;
};
const oM = (e, t) => {
  const n = Ge(e),
    r = 52 * io(e),
    s = 12,
    o = t.stateTime * 1e3 * 0.0017;
  return Array.from({ length: 5 }, (i, a) => {
    const c = o + (a * Math.PI * 2) / 5,
      u = Math.cos(c),
      l = 0.5 + 0.5 * de(u, 0, 1);
    return Rt(
      `orbit.${a}`,
      b + r * Math.sin(c),
      b - r * 0.42 * Math.cos(c),
      Math.max(s * l * n, 0.3),
      de((u + 0.4) / 0.6, 0.18, 1) * n,
    );
  });
};
const iM = (e, t, n) => {
  const r = Ge(e),
    s = 1300,
    o = 104;
  return Array.from({ length: 3 }, (i, a) => {
    const c = _t((t.stateTime * 1e3) / s + a / 3);
    return lo(`radar.${a}`, n + (o - n) * c, 3.4 * (1 - c * 0.55), r * (1 - c) * 0.9);
  });
};
const aM = (e, t) => {
  const n = Ge(e),
    r = 62 * io(e),
    s = de((t.shotTime * 1e3) / DS, 0, 1),
    o = de(s / 0.85, 0, 1),
    i = lo("progress.track", r, 5, n * 0.16);
  return o <= 0
    ? [i]
    : [
        i,
        {
          type: "ring",
          key: "progress.arc",
          cx: b,
          cy: b,
          r,
          width: 5,
          opacity: n,
          arc: { fraction: o, startDeg: -90 },
        },
      ];
};
const cM = (e, t) => {
  const n = Ge(e),
    r = [];
  for (let s = 0; s < 5; s++) {
    const o = de(((t.shotTime * 1e3) / qS - s * 0.09) / 0.62, 0, 1);
    if (o >= 1) continue;
    const i = 1 - Math.pow(1 - o, 3),
      a = s * 2.4 + o * 2.2,
      c = 96 * (1 - i);
    r.push(
      Rt(
        `gather.${s}`,
        b + c * Math.cos(a),
        b + c * Math.sin(a) * 0.8,
        9 * (0.5 + 0.5 * i) * n,
        n * de(o * 5, 0, 1) * (1 - i * 0.25),
      ),
    );
  }
  return r;
};
const uM = (e, t) => {
  const n = t.stateTime * 1e3,
    r = 44,
    s = [];
  for (const o of BS) {
    const i = de((e - Math.abs(o) * 0.1) / (1 - Math.abs(o) * 0.1), 0, 1);
    if (i <= 0.004) continue;
    const a = io(i),
      c = QS(n, o),
      u = (7 + 9 * de(c, 0.08, 1)) * Ge(i),
      l = 6 * de(c, 0, 1) * i;
    s.push(Rt(`wave.${o}`, b + o * r * a, b - l, u, i));
  }
  return s;
};
const lM = (e, t) => {
  const n = Ge(e),
    r = _t((t.stateTime * 1e3) / qh),
    s = de((r - 0.18) / 0.55, 0, 1),
    o = s * s * (0.4 + 0.6 * s),
    i = 0.74,
    a = -0.62,
    c = [];
  if (s > 0 && s < 1) {
    const h = 108 * o;
    c.push(Rt("send.packet", b + i * h, b + a * h, 10 * (1 - o * 0.55) * n, n * (1 - o * o)));
  }
  const u = de((r - 0.26) / 0.55, 0, 1),
    l = u * u * (0.4 + 0.6 * u);
  if (s > 0 && u > 0 && u < 1) {
    const h = 108 * l;
    c.push(Rt("send.streak", b + i * h, b + a * h, 5 * (1 - l * 0.6) * n, n * 0.3 * (1 - l)));
  }
  const d = de((r - 0.18) / 0.3, 0, 1);
  return (
    d > 0 && d < 1 && c.push(lo("send.launch", 20 + 34 * Ge(d), 2.8 * (1 - d), n * (1 - d) * 0.8)),
    c
  );
};
const dM = (e, t) => {
  const n = Ge(e),
    r = t.stateTime * 1e3,
    s = JS(Math.floor(r / Yi)),
    o = _t(r / Yi),
    i = de(o / 0.6, 0, 1),
    a = 1 - Math.pow(1 - i, 3),
    c = Math.cos(s),
    u = Math.sin(s),
    l = 108 * (1 - a),
    d = [];
  if (i < 1) {
    const f = 18 * Math.sin(i * Math.PI) * (1 - a * 0.7);
    d.push(
      Rt(
        "receive.packet",
        b + c * l - u * f,
        b + u * l + c * f,
        3.5 + 6.5 * a,
        n * de(i * 3.5, 0, 1) * (0.3 + 0.7 * a),
      ),
    );
  }
  const h = de((o - 0.58) / 0.32, 0, 1);
  return (
    h > 0 &&
      h < 1 &&
      d.push(lo("receive.absorb", 20 + 26 * Ge(h), 2.8 * (1 - h), n * (1 - h) * 0.8)),
    d
  );
};
const hM = (e, t) => {
  const n = Ge(e),
    r = t.stateTime * 1e3,
    s = 42,
    o = 1.1,
    i = [];
  for (let a = 0; a < 2; a++) {
    const c = de((t.stateTime - (0.2 + a * 1.3)) / 0.9, 0, 1);
    if (c <= 0) continue;
    const u = 1 - Math.pow(1 - c, 3),
      l = r * 0.001 * o + a * Math.PI,
      d = b + s * Math.sin(l),
      h = b + s * 0.5 * Math.cos(l) + Math.sin(r * 0.003 + a) * 2,
      f = b - 120 + a * 30,
      p = b + 95;
    i.push(Rt(`dock.${a}`, f + (d - f) * u, p + (h - p) * u, (7 + 3 * u) * n, n * de(c * 4, 0, 1)));
  }
  return i;
};
const fM = (e, t) => {
  const n = t.stateTime * 1e3,
    r = Ua(n),
    s = ((r.rot - 90) * Math.PI) / 180,
    o = 68,
    i = Math.cos(s) * o,
    a = Math.sin(s) * o,
    c = b + (r.x + i) * e,
    u = b + (r.y + r.wig * 0.15 + a) * e,
    l = [
      Hh(
        "pencil.shaft",
        US,
        `translate(${c.toFixed(1)} ${u.toFixed(1)}) rotate(${(r.rot * e).toFixed(1)}) scale(${Ge(e).toFixed(3)}) translate(${-b} ${-b})`,
        de(e * 1.6 - 0.3, 0, 1),
      ),
    ],
    d = nM(n);
  return (d.length >= 2 && l.push(XS("pencil.ink", rM(d), 6, de(e * 1.2, 0, 1))), l);
};
const pM = (e, t) => {
  const n = t.stateTime,
    r = Ge(de(e * 1.1, 0, 1)),
    s = Math.exp(-(n % 2.2) * 5.5),
    o = Math.sin(n * 42) * 2.2 * s;
  return [
    Hh(
      "bang.bar",
      KS,
      `translate(0 ${(-26 - (1 - r) * 70).toFixed(1)}) rotate(${o.toFixed(2)} ${b} ${(b - 74).toFixed(1)}) translate(${b} ${b}) scale(${de(e * 1.2, 0, 1).toFixed(3)}) translate(${-b} ${-b})`,
      de(e * 1.5 - 0.2, 0, 1),
    ),
  ];
};
const mM = (e, t) => {
  const n = 0.5 + 0.5 * Math.sin(t.stateTime * 1e3 * 0.0016);
  return [Rt("standby.halo", b, b, 26 + 7 * n, Ge(e) * (0.06 + 0.1 * n))];
};
const gM = (e, t, n, r, s) => {
  switch (e) {
    case "dots":
      return sM(t, n, s);
    case "orbit":
      return oM(t, n);
    case "radar":
      return iM(t, n, r);
    case "progress":
      return aM(t, n);
    case "gather":
      return cM(t, n);
    case "wave":
      return uM(t, n);
    case "send":
      return lM(t, n);
    case "receive":
      return dM(t, n);
    case "dock":
      return hM(t, n);
    case "ball":
      return [];
    case "pencil":
      return fM(t, n);
    case "bang":
      return pM(t, n);
    case "standby":
      return mM(t, n);
  }
};
function yM(e, t) {
  const { kind: n, isReducedMotion: r } = e,
    s = de(e.amount, 0, 1),
    o = de(e.swap, 0, 1),
    i = o < 0.999 ? e.outgoing : null,
    a = (G) => (G === n ? s * o : G === i ? s * (1 - o) : 0),
    c = (G) => (G === n ? e.clock : e.outgoingClock),
    u = de(s / $S, 0, 1),
    d = n === "pencil" || i === "pencil" ? (o >= 0.999 ? ai(n) : Zw(ai(i), ai(n), Fs(o))) : Bh,
    h = n ? ii[n] * o + (i ? ii[i] : ii[n]) * (1 - o) : 19,
    f = a("dots"),
    p = n === "dots" || i === "dots",
    m = p ? Vh(c("dots"), 1, s, r) : YS;
  let g = p ? 1 + (m.pop - 1) * (f / Math.max(s, 0.001)) : 1;
  const y = a("receive");
  if (y > 0.004) {
    const G = _t((c("receive").stateTime * 1e3) / Yi),
      J = de((G - 0.58) / 0.34, 0, 1);
    g *= 1 + 0.11 * Math.sin(J * Math.PI) * y;
  }
  const w = a("send");
  if (w > 0.004) {
    const G = _t((c("send").stateTime * 1e3) / qh),
      J = G < 0.18 ? -0.06 * Math.sin((G / 0.18) * Math.PI) : 0,
      ye = G >= 0.18 && G < 0.42 ? 0.05 * Math.sin(((G - 0.18) / 0.24) * Math.PI) : 0;
    g *= 1 + (J + ye) * w;
  }
  const S = a("bang");
  S > 0.004 && (g *= 1 + 0.04 * Math.exp(-(c("bang").stateTime % 2.2) * 5.5) * S);
  let v = 0,
    x = 0,
    E = 0;
  const A = a("pencil");
  if (A > 0.004) {
    const G = Ua(c("pencil").stateTime * 1e3);
    ((v += G.x * A), (x += (G.y + G.wig * 0.5) * A), (E += G.rot * A));
  }
  S > 0.004 && (x += 58 * S);
  const j = a("ball");
  j > 0.004 && (x += eM(c("ball").stateTime) * j);
  const F = (h / b) * g,
    O = a("standby"),
    L = O > 0 ? (0.28 + 0.2 * Math.sin(c("standby").stateTime * 1e3 * 0.0016)) * O : 0,
    T = {
      scale: 1 - s + F * s,
      dx: v * s,
      dy: -m.lift * f + x * s,
      rotation: E * s,
      opacity: (1 - (1 - m.tone) * f) * (1 - L),
      round: Fs(u),
      ring: d,
    },
    I = 1 - rk(de((t - 44) / 90, 0, 1)),
    $ = n == null ? 1 : Vl[n],
    R = i ? Vl[i] : $,
    U = 1 + ($ * o + R * (1 - o) - 1) * s * I,
    W = [];
  for (const G of [i, n]) {
    if (G == null) continue;
    const J = a(G);
    J > 0.004 && W.push(...gM(G, J, c(G), h, r));
  }
  return { core: T, isFaceVisible: s < 0.5, zoom: U, parts: W.filter((G) => G.opacity > 0) };
}
const kM = fv(192);
const wM = xv(96);
const bM = 0.6;
function Ka(e, t, n) {
  return t === "sphere" ? bS({ ...e }, n) : iv({ ...e, body: t, inspect: e.inspectWeight }, n);
}
function xM(e, t, n = t) {
  const r = e.bodies
      .map(({ body: l, weight: d }) => ({ shape: Ka(e, l, t), weight: d }))
      .sort((l, d) => d.weight - l.weight),
    s = r[0]?.shape.center ?? [t / 2, t / 2],
    o = r[0]?.shape.radius ?? 0,
    i = mv([kM, ...r.map(({ shape: l }) => pv(l.body, l.center))]),
    a = Oh(r.map(({ shape: l, weight: d }) => ({ outline: gv(l.body, l.center, i), weight: d }))),
    c = e.morph == null ? null : yM(e.morph, n),
    u = (vn * t) / 2 / b;
  return {
    size: t,
    center: s,
    body: c == null || c.core.round === 0 ? a : Sv(a, MM(c, s, o, i), c.core.round),
    eyes: r.length === 1 ? (r[0]?.shape.eyes ?? []) : PM(r),
    head: c == null || e.morph == null ? null : TM(c, e.morph.amount, e.zoom, u),
    parts: c?.parts ?? [],
    markScale: u,
    zoom: c?.zoom ?? 1,
  };
}
function vM(e, t, n, r, s = n, o = n) {
  return SM(xM(e, n, s), t, r, o);
}
function SM(e, t, n, r = e.size) {
  const { size: s, center: o } = e,
    i = Na(t),
    a = Gi(e.body),
    c = e.eyes.map(Gi).join("");
  let u = "",
    l = `<path d="${a}" fill="${i}"/>`;
  c !== "" && t.cutout
    ? ((u += `<mask id="${n}-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="${s}" height="${s}"><rect width="${s}" height="${s}" fill="#fff"/><path d="${c}" fill="#000"/></mask>`),
      (l = `<path d="${a}" fill="${i}" mask="url(#${n}-holes)"/>`))
    : c !== "" &&
      ((u += `<clipPath id="${n}-body"><path d="${a}"/></clipPath>`),
      (l += `<path d="${c}" fill="${Fa(t)}" clip-path="url(#${n}-body)"/>`));
  const d = e.head,
    h =
      d == null
        ? l
        : `<g transform="translate(${be(o[0] + d.translate[0])} ${be(o[1] + d.translate[1])}) rotate(${be(d.rotation)}) scale(${be(d.scale, 5)}) translate(${be(-o[0])} ${be(-o[1])})"${d.opacity < 1 ? ` opacity="${be(d.opacity, 3)}"` : ""}>${l}</g>`,
    f =
      e.parts.length === 0
        ? ""
        : `<g transform="translate(${s / 2} ${s / 2}) scale(${be(e.markScale, 5)}) translate(${-b} ${-b})">${e.parts.map((g) => EM(g, i)).join("")}</g>`,
    p = s / 2 + (AS - b) * e.markScale,
    m =
      e.zoom === 1
        ? `${f}${h}`
        : `<g transform="translate(${be(p)} ${be(p)}) scale(${be(e.zoom, 5)}) translate(${be(-p)} ${be(-p)})">${f}${h}</g>`;
  return `${ja(s, n, r)}${u === "" ? "" : `<defs>${u}</defs>`}${m}</svg>`;
}
function MM(e, t, n, r) {
  const s = n / b,
    o = e.core.ring.map(([i, a]) => [t[0] + (i - b) * s, t[1] + (a - b) * s]);
  return kv(o, t, r);
}
function TM(e, t, n, r) {
  const { core: s } = e,
    o = 1 - t,
    i = t > 0 ? (s.scale - o) / t : 0;
  return {
    translate: [s.dx * r, s.dy * r],
    rotation: s.rotation,
    scale: o + i * (vn / n) * t,
    opacity: s.opacity,
  };
}
function EM(e, t) {
  const n = e.opacity < 1 ? ` opacity="${be(e.opacity, 3)}"` : "";
  switch (e.type) {
    case "disc":
      return `<circle cx="${be(e.cx)}" cy="${be(e.cy)}" r="${be(e.r)}" fill="${t}"${n}/>`;
    case "ring": {
      const r = 2 * Math.PI * e.r,
        s =
          e.arc == null
            ? ""
            : ` stroke-dasharray="${be(r * e.arc.fraction)} ${be(r)}" transform="rotate(${be(e.arc.startDeg)} ${be(e.cx)} ${be(e.cy)})"`;
      return `<circle cx="${be(e.cx)}" cy="${be(e.cy)}" r="${be(e.r)}" fill="none" stroke="${t}" stroke-width="${be(e.width)}"${s}${n}/>`;
    }
    case "shape":
      return `<path d="${e.d}" transform="${e.transform}" fill="${t}"${n}/>`;
    case "stroke":
      return `<path d="${e.d}" fill="none" stroke="${t}" stroke-width="${be(e.width)}" stroke-linecap="round" stroke-linejoin="round"${n}/>`;
  }
}
function PM(e) {
  const t = (e[0]?.shape.radius ?? 0) * bM,
    n = [];
  return (
    e.forEach(({ shape: r }, s) => {
      for (const o of r.eyes) {
        const i = Lh(o),
          a = IM(n, s, i, t);
        if (a != null) {
          a.loops[s] = o;
          continue;
        }
        const c = e.map(() => null);
        ((c[s] = o), n.push({ anchor: i, loops: c }));
      }
    }),
    n.map((r) => {
      const s = r.loops.map((i) => (i == null ? null : wv(i))),
        o = vv([wM, ...s.map((i) => i?.stations ?? [])]);
      return Oh(
        e.map(({ weight: i }, a) => {
          const c = s[a];
          return { outline: c == null ? Mv(r.anchor, o.length) : bv(c, o), weight: i };
        }),
      );
    })
  );
}
function IM(e, t, n, r) {
  let s = null,
    o = r;
  for (const i of e) {
    if (i.loops[t] != null) continue;
    const a = Math.hypot(i.anchor[0] - n[0], i.anchor[1] - n[1]);
    a < o && ((s = i), (o = a));
  }
  return s;
}
function be(e, t = 2) {
  const n = 10 ** t;
  return String(Math.round(e * n) / n);
}
function Wh(e, t, n, r, s = {}) {
  const [o, ...i] = e.bodies;
  if (o == null || i.length > 0 || e.morph != null)
    return vM(e, t, n, r, s.displaySize ?? n, s.extent);
  if (o.body === "sphere") return vS(wS({ ...e, body: o.body }, t, n, s), t, r, s.extent);
  const a = { ...e, body: o.body, inspect: e.inspectWeight };
  return av(ov(a, t, n, s), r, s.extent);
}
const ci = new WeakMap();
function AM(e, t) {
  const n = t.split('"'),
    r = ci.get(e),
    s = r != null && e.firstChild === r.root ? $M(r.parts, n) : null;
  if (r != null && s != null) {
    for (const i of s) r.slots[(i - 1) / 2].value = n[i];
    r.parts = n;
    return;
  }
  e.innerHTML = t;
  const o = [...e.querySelectorAll("*")].flatMap((i) => [...i.attributes]);
  CM(o, n) ? ci.set(e, { root: e.firstChild, slots: o, parts: n }) : ci.delete(e);
}
function $M(e, t) {
  if (e.length !== t.length) return null;
  const n = [];
  for (let r = 0; r < t.length; r++)
    if (t[r] !== e[r]) {
      if (r % 2 === 0 || t[r].includes("&")) return null;
      n.push(r);
    }
  return n;
}
function CM(e, t) {
  return (
    t.length === e.length * 2 + 1 &&
    e.every((n, r) => t[2 * r].endsWith(` ${n.name}=`) && n.value === t[2 * r + 1])
  );
}
const ui = 48;
const _M = 60;
const RM = 0.1;
function OM(e) {
  let t = 2166136261;
  for (let n = 0; n < e.length; n++) t = Math.imul(t ^ e.charCodeAt(n), 16777619);
  return t >>> 0;
}
function LM() {
  return typeof window > "u" || typeof window.matchMedia != "function"
    ? !1
    : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function Uh(e, t) {
  return {
    display: "inline-block",
    position: "relative",
    flexShrink: 0,
    width: e,
    height: e,
    lineHeight: 0,
    ...t,
  };
}
function Kh(e) {
  const t = `${_r(e) * 100}%`;
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: t,
    height: t,
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
  };
}
const z_ = k.forwardRef(function (
  {
    body: t,
    appearance: n,
    size: r,
    fill: s = vn,
    resolution: o,
    id: i,
    seed: a,
    state: c,
    clip: u = null,
    morph: l = null,
    maxFrameRate: d = 60,
    isPlaying: h = !0,
    isEmphasized: f = !1,
    isFollowingPointer: p = !1,
    isStatic: m = !1,
    isProof: g = !1,
    className: y,
    style: w,
    children: S,
  },
  v,
) {
  const x = `motion-${k.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`,
    E = i ?? x,
    A = k.useRef(null),
    j = k.useRef(null),
    F = k.useRef(null);
  F.current ??= oh({ body: t });
  const O = F.current,
    L = k.useRef(null);
  L.current ??= LM();
  const T = m || L.current,
    I = h && !T,
    $ = k.useRef(null);
  $.current == null &&
    c !== void 0 &&
    ($.current = zw(O, c, {
      seed: OM(a ?? E),
      isCompact: typeof r == "number" ? r < ui : !0,
      isResting: !I,
    }));
  const R = $.current,
    U = k.useRef(typeof r == "number" ? r : 0),
    W = k.useRef(""),
    G = k.useRef(null),
    J = k.useRef(I);
  J.current = I;
  const ye = () => {
      const te = j.current,
        he = U.current,
        D = o ?? Math.round(he * _r(s) * 100) / 100;
      if (te == null || D <= 0) return;
      const V = Wh(O.frame(), n, D, E, {
        isProof: g,
        displaySize: he > 0 ? he : D,
        extent: "100%",
      });
      V !== W.current && ((W.current = V), AM(te, V));
    },
    K = k.useRef(ye);
  K.current = ye;
  const ae = () => {
      if (T) {
        (O.pause(), O.seek(0));
        for (let te = 0; te < _M; te++) O.advance(RM);
        K.current();
        return;
      }
      (K.current(), G.current?.wake());
    },
    ee = k.useRef(ae);
  return (
    (ee.current = ae),
    k.useImperativeHandle(
      v,
      () => ({
        setExpression: (te, he) => {
          (O.setExpression(te, he), ee.current());
        },
        blink: () => {
          (O.blink(), ee.current());
        },
        look: (te) => {
          (O.look(te), ee.current());
        },
        restart: () => {
          (O.seek(0), O.play(), ee.current());
        },
        poke: (te, he) => {
          L.current !== !0 && (O.poke(te, he), ee.current());
        },
        gaze: (te) => {
          L.current !== !0 && (O.setGaze(te), ee.current());
        },
      }),
      [O],
    ),
    k.useEffect(() => {
      (O.setBody(t, { isInstant: T }), ee.current());
    }, [O, t]),
    k.useEffect(() => {
      (R == null && u != null && O.load(u, { isPlaying: I }), ee.current());
    }, [O, R, u]),
    k.useEffect(() => {
      (R == null && O.setMorph(l, { isInstant: T }), ee.current());
    }, [O, R, l]),
    k.useEffect(() => {
      (c !== void 0 && R?.setState(c), ee.current());
    }, [R, c]),
    k.useEffect(() => {
      (R?.setEmphasis(f), ee.current());
    }, [R, f]),
    k.useEffect(() => {
      (R != null ? R.setResting(!I) : I ? O.play() : O.pause(), ee.current());
    }, [O, R, I]),
    k.useEffect(() => {
      ee.current();
    }, [n, s, o, g]),
    k.useEffect(() => {
      const te = A.current;
      if (typeof r == "number") {
        ((U.current = r), R?.setCompact(r < ui), ee.current());
        return;
      }
      if (te == null || typeof ResizeObserver > "u") return;
      const he = new ResizeObserver((D) => {
        const V = D.at(-1)?.contentRect.width ?? 0;
        V !== U.current && ((U.current = V), R?.setCompact(V < ui), ee.current());
      });
      return (he.observe(te), () => he.disconnect());
    }, [R, r]),
    k.useEffect(() => {
      if ((O.setGazeAlways(p), !p)) return;
      const te = (he) => {
        const D = A.current;
        D != null &&
          (O.setGaze(rw(D.getBoundingClientRect(), { x: he.clientX, y: he.clientY })),
          G.current?.wake());
      };
      return (
        window.addEventListener("pointermove", te, { passive: !0 }),
        () => {
          (window.removeEventListener("pointermove", te), O.setGaze(null), G.current?.wake());
        }
      );
    }, [O, p]),
    k.useEffect(() => {
      const te = A.current;
      if (T || te == null) return;
      const he = 1e3 / Math.max(1, d);
      let D = 0,
        V = 0,
        Y = !1,
        Z = !0;
      const Q = (ke) => {
          if (((D = 0), ke - V < he - 1)) {
            D = requestAnimationFrame(Q);
            return;
          }
          const we = (ke - V) / 1e3;
          if (
            ((V = ke),
            document.hidden || (J.current && R?.advance(we), O.advance(we)),
            K.current(),
            !J.current && O.isSettled)
          ) {
            Y = !1;
            return;
          }
          D = requestAnimationFrame(Q);
        },
        ie = () => {
          Y || !Z || ((Y = !0), (V = performance.now()), (D = requestAnimationFrame(Q)));
        },
        re =
          typeof IntersectionObserver > "u"
            ? null
            : new IntersectionObserver((ke) => {
                if (((Z = ke.at(-1)?.isIntersecting ?? !0), Z)) {
                  ie();
                  return;
                }
                (cancelAnimationFrame(D), (D = 0), (Y = !1));
              });
      return (
        re?.observe(te),
        (G.current = { wake: ie }),
        ie(),
        () => {
          (cancelAnimationFrame(D), re?.disconnect(), (G.current = null));
        }
      );
    }, [O, R, T, d]),
    M.jsxs("span", {
      "aria-hidden": !0,
      className: y,
      ref: A,
      style: Uh(r, w),
      children: [M.jsx("span", { ref: j, style: Kh(s) }), S],
    })
  );
});
function q_(e) {
  switch (e) {
    case "blob":
      return "sphere";
    case "flower":
      return "starFlower";
    case "heart":
      return "heartChubby";
    case "star":
      return "star6";
    default:
      return e;
  }
}
const ns = [0, 0, 0];
function NM(e, t) {
  return t == null
    ? { ink: ns, spot: ns, cutout: !0, inkPaint: e }
    : { ink: ns, spot: ns, cutout: !1, inkPaint: e, spotPaint: t };
}
const FM = "var(--grok-bot-still-ink)";
const Ul = 1e3;
const Kl = new Map();
function Xh(e, t = ao) {
  const n = `${e}:${t}`,
    r = Kl.get(n);
  if (r !== void 0) return r;
  const s = Ul * _r(t),
    o = s / 2;
  let i = 0;
  for (const u of Ka(Xa(e), e, s).body)
    for (const [l, d] of u) i = Math.max(i, Math.abs(l - o), Math.abs(d - o));
  const a = Ul / 2,
    c = i <= a ? t : (t * a) / i;
  return (Kl.set(n, c), c);
}
function jM({ body: e, ink: t, size: n, fill: r = ao, id: s = "grok-bot-still" }) {
  const o = Xh(e, r),
    i = n * _r(o),
    a = Yh((i - n) / 2),
    c = NM(typeof t == "string" ? t : FM),
    u = Wh(Xa(e), c, i, s, { displaySize: n }),
    l =
      typeof t == "string"
        ? ""
        : `<style>svg{--grok-bot-still-ink:${t.light}}@media (prefers-color-scheme:dark){svg{--grok-bot-still-ink:${t.dark}}}</style>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="${a} ${a} ${n} ${n}">${l}${u}</svg>`;
}
function B_(e) {
  return `data:image/svg+xml,${encodeURIComponent(jM(e))}`;
}
function Xa(e) {
  return oh({ body: e }).frame();
}
function Yh(e) {
  return Math.round(e * 1e3) / 1e3;
}
function ho(e, t) {
  return e + t;
}
const Or = 0;
function ME(e) {
  switch (e.phase) {
    case "reserved":
    case "terminal":
      return e.heightPx;
    case "state-table": {
      const t = e.sizes.get(e.active);
      if (t === void 0)
        throw new RangeError(`state-table slot has no size for active state "${e.active}"`);
      return t;
    }
  }
}
function xf(e) {
  switch (e.kind) {
    case "text":
      return e.heightPx;
    case "slot":
      return ME(e.contract);
    case "measured":
      return e.committedPx;
    case "chrome":
      return e.heightPx;
    case "sibling-remainder":
      throw new RangeError(`sibling remainder "${e.partId}" requires sibling resolution`);
  }
}
function Qa(e) {
  const t = Tf(e);
  return t.kind === "ordinary" ? t.ordinaryHeightPx : void 0;
}
function Tf(e) {
  let t = Or,
    n;
  for (const r of e.parts) {
    if (r.kind === "sibling-remainder") {
      if (n !== void 0)
        throw new RangeError(`row "${e.rowId}" has more than one sibling remainder`);
      n = r;
      continue;
    }
    t = ho(t, xf(r));
  }
  return n === void 0
    ? { kind: "ordinary", row: e, ordinaryHeightPx: t }
    : { kind: "sibling-remainder", row: e, ordinaryHeightPx: t, remainder: n };
}
function id(e) {
  const t = Qa(e);
  return t === void 0 || t === e.heightPx ? e : { ...e, heightPx: t };
}
export {
  q_ as bodyForShape,
  z_ as BotRenderer,
  ao as DEFAULT_FILL,
  NM as createAppearance,
  N_ as inkForColor,
  F_ as inkForTheme,
  Nw as recipeByName,
};
