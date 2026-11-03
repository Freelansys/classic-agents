/**
 * Change tracking for state that is shared by reference: a proxy over a plain
 * object that reports every change made through it, at any depth, so whoever
 * keeps the object can write it through as it changes. Nothing is compared:
 * a change is seen as it is made.
 *
 * Only plain objects and arrays are tracked. Anything else — a `Map`, a
 * `Date`, a class instance — is handed out as it is, since a proxy would
 * break its methods. A change must be made through the proxy to be seen, so
 * an object is wrapped before anyone else is given it, and an object put into
 * a tracked one is read back through it before it is changed.
 */

/** Each proxy's target, and each target's proxy. */
const targets = new WeakMap<object, object>();
const proxies = new WeakMap<object, object>();

function isPlain(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Wraps `value` so a change anywhere in it calls `changed`: once, after the
 * synchronous run of changes that made it, so a burst of changes is reported
 * once. `skip` names properties of `value` itself whose values are handed out
 * untracked — live objects that are kept some other way.
 */
export function track<T extends object>(
  value: T,
  changed: () => void,
  skip: ReadonlySet<PropertyKey> = new Set(),
): T {
  let queued = false;
  const report = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      changed();
    });
  };

  const wrap = (target: object, top: boolean): object => {
    const known = proxies.get(target);
    if (known) return known;
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        const v: unknown = Reflect.get(t, key, receiver);
        if (typeof v !== "object" || v === null) return v;
        if ((top && skip.has(key)) || targets.has(v) || !isPlain(v)) return v;
        // A proxy may not stand in for a value that can never change.
        const own = Reflect.getOwnPropertyDescriptor(t, key);
        if (own && !own.configurable && !own.writable) return v;
        return wrap(v, false);
      },
      set(t, key, v) {
        const done = Reflect.set(t, key, v);
        if (done) report();
        return done;
      },
      deleteProperty(t, key) {
        const done = Reflect.deleteProperty(t, key);
        if (done) report();
        return done;
      },
      defineProperty(t, key, descriptor) {
        const done = Reflect.defineProperty(t, key, descriptor);
        if (done) report();
        return done;
      },
    });
    proxies.set(target, proxy);
    targets.set(proxy, target);
    return proxy;
  };

  return wrap(value, true) as T;
}

/** Whether `value` is a proxy {@link track} made. */
export function isTracked(value: unknown): boolean {
  return typeof value === "object" && value !== null && targets.has(value);
}

/**
 * A deep copy of `value` with no proxy left in it, to write: plain objects
 * and arrays are copied, functions and `undefined` properties dropped, and
 * anything else structured-cloned.
 */
export function snapshot(value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (typeof value !== "object" || value === null) return value;
  const raw = targets.get(value) ?? value;
  if (Array.isArray(raw)) return raw.map(snapshot);
  if (!isPlain(raw)) return structuredClone(raw);
  const copy: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (v === undefined || typeof v === "function") continue;
    copy[key] = snapshot(v);
  }
  return copy;
}
