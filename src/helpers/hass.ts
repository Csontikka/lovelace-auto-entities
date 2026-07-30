/*
Resolving the Home Assistant base element used to leak every caller.

    await Promise.race([
      customElements.whenDefined("home-assistant"),
      customElements.whenDefined("hc-main"),
    ]);

Promise.race() does not cancel the losing promise. "hc-main" only exists on a
Cast device, so in a normal frontend customElements.whenDefined("hc-main") stays
pending for the lifetime of the page, and every reaction attached to it stays in
its reaction list forever. Those reactions capture the awaiting async scope --
which for this card is bind_templates(), holding `this`, i.e. the row, and
through its Lit parts the entire rendered subtree.

A heap snapshot after forced GC showed exactly that chain:

    <pending promise>.reactions_or_result
      -> closure -> Context -> Context(previous)
      -> <template-entity-row>  (as a scope variable)
      -> _$Do -> _$AH -> _$AV -> the detached DOM

Two changes:

1. Skip the wait entirely once either element is defined -- the normal case
   after startup, and the only case that matters for rows created later.
2. Resolve at most once per page and share the result, so a slow start cannot
   leave one pending reaction per caller. The waiter closure below deliberately
   captures nothing but its own resolve function.

card-mod solves the same problem with @watchable/unpromise; this keeps the fix
dependency free.
*/

const BASE_ELEMENTS = ["home-assistant", "hc-main"];

let baseElPromise: Promise<any> | null = null;

function definedBaseElement(): string | undefined {
  return BASE_ELEMENTS.find((name) => customElements.get(name));
}

async function waitForBaseElementDefinition(): Promise<void> {
  if (definedBaseElement()) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    for (const name of BASE_ELEMENTS) customElements.whenDefined(name).then(finish);
  });
}

async function findBaseEl(): Promise<any> {
  await waitForBaseElementDefinition();
  const element = definedBaseElement() ?? "home-assistant";
  let found = document.querySelector(element);
  while (!found) {
    await new Promise((r) => window.setTimeout(r, 100));
    found = document.querySelector(element);
  }
  return found;
}

export function hass_base_el(): Promise<any> {
  if (!baseElPromise) baseElPromise = findBaseEl();
  return baseElPromise;
}

export async function hass() {
  const base: any = await hass_base_el();
  while (!base.hass) await new Promise((r) => window.setTimeout(r, 100));
  return base.hass;
}
