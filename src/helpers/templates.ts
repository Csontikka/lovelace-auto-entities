import { hass } from "./hass";
import { BrowserID } from "./browser_id";

type TemplateCallback = (value: string) => void;
// Entries created by an older build of a sibling card may still hold plain
// functions, so every read path must accept both shapes.
type CallbackEntry = TemplateCallback | WeakRef<TemplateCallback>;

interface CachedTemplate {
  template: string;
  variables: object;
  value: string;
  /*
  Held WEAKLY -- this is the leak fix.

  window.cardMod_template_cache is shared by several cards (card-mod,
  template-entity-row, auto-entities, state-switch). A registered callback is a
  closure over the element that registered it, so a strong reference here keeps
  that element -- and its entire detached subtree -- reachable from `window` for
  the lifetime of the page. Measured on one dashboard: 20 view switches left
  1320 detached rows alive, retained through exactly this Set.

  Contract: the registering element MUST keep its own strong reference to the
  callback (see each card's _templateCallbacks). That is what keeps updates
  flowing while the element lives; when the element dies, the callback dies with
  it and the entry retires itself.
  */
  callbacks: Set<CallbackEntry>;
  unsubscribe: Promise<() => Promise<void>>;
}

interface RenderTemplateResult {
  result: string;
  listeners: any;
}

(window as any).cardMod_template_cache =
  (window as any).cardMod_template_cache || {};

const cachedTemplates: Record<string, CachedTemplate> = (window as any)
  .cardMod_template_cache;

function deref(entry: CallbackEntry): TemplateCallback | undefined {
  return typeof entry === "function" ? entry : entry?.deref();
}

function findEntry(
  cache: CachedTemplate,
  callback: TemplateCallback
): CallbackEntry | undefined {
  for (const e of cache.callbacks) if (deref(e) === callback) return e;
  return undefined;
}

async function retire_if_unused(
  key: string,
  cache: CachedTemplate
): Promise<void> {
  if (cache.callbacks.size > 0) return;
  if (cachedTemplates[key] !== cache) return;
  const unsubscriber = cache.unsubscribe;
  delete cachedTemplates[key];
  if (unsubscriber) await (await unsubscriber)();
}

function template_updated(
  key: string,
  result: RenderTemplateResult
): Promise<void> {
  const cache = cachedTemplates[key];
  if (!cache) {
    return;
  }
  cache.value = result.result;
  for (const e of [...cache.callbacks]) {
    const f = deref(e);
    if (f === undefined) {
      // Owner was collected -- drop the dead entry.
      cache.callbacks.delete(e);
      continue;
    }
    f(result.result);
  }
  retire_if_unused(key, cache);
}

export function hasTemplate(str) {
  if (!str) return false;
  return String(str).includes("{%") || String(str).includes("{{");
}

export async function bind_template(
  callback: TemplateCallback,
  template: string,
  variables: object
): Promise<void> {
  const hs = await hass();
  const connection = hs.connection;

  const cacheKey = JSON.stringify([template, variables]);
  let cache = cachedTemplates[cacheKey];

  // Detach from every OTHER entry first. bind_template is async and callers do
  // not await it, so two binds for the same element can interleave; the old code
  // stopped at the first match (`break`), which could leave the callback
  // registered in a stale entry that nothing would ever clean up.
  unbind_template(callback, cacheKey);
  cache = cachedTemplates[cacheKey];

  if (!cache) {
    callback("");

    variables = {
      user: hs.user.name,
      browser: BrowserID,
      hash: location.hash.substr(1) || "",
      ...variables,
    };

    cachedTemplates[cacheKey] = cache = {
      template,
      variables,
      value: "",
      callbacks: new Set([new WeakRef(callback)]),
      unsubscribe: connection.subscribeMessage(
        (result: RenderTemplateResult) => template_updated(cacheKey, result),
        {
          type: "render_template",
          template,
          variables,
        }
      ),
    };
  } else {
    callback(cache.value);
    if (!findEntry(cache, callback)) cache.callbacks.add(new WeakRef(callback));
  }
}

/*
Deliberately SYNCHRONOUS.

This used to be `async` and awaited the WebSocket unsubscribe at the end. Callers
do not await it, so that left a floating promise whose continuation closure
captured `callback` -- and a callback closes over the element that registered it.
Until the unsubscribe settled, that chain kept the element (and its detached
subtree) reachable. A heap snapshot showed exactly this path surviving a forced
GC for 1320 rows.

Retiring an emptied entry is still fine, just handed to a closure that only sees
the cache entry, never the callback.
*/
export function unbind_template(
  callback: TemplateCallback,
  exceptKey?: string
): void {
  if (!callback) return;
  // No `break`: after interleaved binds the same callback can sit in more than
  // one entry, and leaving any behind is exactly the leak.
  for (const [key, cache] of Object.entries(cachedTemplates)) {
    if (key === exceptKey) continue;
    const entry = findEntry(cache, callback);
    if (entry === undefined) continue;
    cache.callbacks.delete(entry);
    if (cache.callbacks.size === 0) void retire_if_unused(key, cache);
  }
}
