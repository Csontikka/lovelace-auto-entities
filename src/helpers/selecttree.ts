const TIMEOUT_ERROR = "SELECTTREE-TIMEOUT";

/*
customElements.whenDefined() for a name that never gets registered stays pending
for the lifetime of the page. Awaiting it directly means the async scope -- which
holds `el` -- is captured by that promise's reaction list and can never be
collected. That happens with a mistyped card type, or a card that was removed
while dashboards still reference it.

Waiting with a deadline keeps the behaviour for elements that simply load late,
while making sure we let go of the element if the definition never arrives. The
waiter closure below captures only its own resolve function and timer.
*/
const DEFINITION_TIMEOUT = 5000;

export async function whenDefinedOrTimeout(
  name: string,
  timeout = DEFINITION_TIMEOUT
): Promise<void> {
  if (customElements.get(name)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeout);
    customElements.whenDefined(name).then(finish);
  });
}

export async function await_element(el, hard = false) {
  if (el.localName?.includes("-"))
    await whenDefinedOrTimeout(el.localName);
  if (el.updateComplete) await el.updateComplete;
  if (hard) {
    if (el.pageRendered) await el.pageRendered;
    if (el._panelState) {
      let rounds = 0;
      while (el._panelState !== "loaded" && rounds++ < 5)
        await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function _selectTree(root, path, all = false) {
  let el = [root];

  // Split and clean path
  if (typeof path === "string") {
    path = path.split(/(\$| )/);
  }
  while (path[path.length - 1] === "") path.pop();

  // For each element in the path
  for (const [i, p] of path.entries()) {
    if (p === "$") {
      await Promise.all([...el].map((e) => await_element(e)));
      el = [...el].map((e) => e.shadowRoot);
      continue;
    }

    // Only pick the first one for the next step
    const e = el[0];
    if (!e) return null;

    if (!p.trim().length) continue;

    await await_element(e);
    el = e.querySelectorAll(p);
  }
  return all ? el : el[0];
}

export async function selectTree(root, path, all = false, timeout = 10000) {
  // The timer is cleared once the race is decided; leaving it armed keeps the
  // rejection closure (and the pending timeout promise behind it) alive for the
  // full timeout even when the lookup finished immediately.
  let timer: number | undefined;
  const deadline = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(TIMEOUT_ERROR)), timeout);
  });
  try {
    return await Promise.race([_selectTree(root, path, all), deadline]);
  } catch (err) {
    if (!err.message || err.message !== TIMEOUT_ERROR) throw err;
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
