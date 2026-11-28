// A fake Playwright page for the journey's nav(): records what nav() clicks and waits for, with the drawer and the 更多 fold open or closed.
export function navPageHarness({ drawerClosed = false, drawerLabel = "打开导航", entryId = null, folded = false, staysHidden = false } = {}) {
  const events = [];
  let drawerOpen = !drawerClosed;
  let foldOpen = !folded;

  const missingLocator = (label) => {
    const loc = {
      first: () => loc,
      count: async () => 0,
      isVisible: async () => false,
      click: async () => { throw new Error(`unexpected click on missing locator ${label}`); },
      waitFor: async () => { throw new Error(`unexpected waitFor on missing locator ${label}`); },
      dispatchEvent: async () => { throw new Error(`unexpected dispatchEvent on missing locator ${label}`); },
      getAttribute: async () => null,
      locator: (sel) => missingLocator(`${label} >> ${sel}`),
      getByRole: (_role, opts) => missingLocator(`${label} >> role:${opts?.name}`),
    };
    return loc;
  };

  const foldToggle = {
    first: () => foldToggle,
    count: async () => (folded ? 1 : 0),
    getAttribute: async (attr) => (attr === "aria-expanded" ? String(foldOpen) : null),
    click: async () => {
      events.push("click:fold");
      foldOpen = true;
    },
  };

  const navDrawer = {
    first: () => navDrawer,
    count: async () => 1,
    isVisible: async () => drawerOpen,
    waitFor: async ({ state } = {}) => {
      events.push(`waitFor:nav:${state}`);
      if (state === "visible" && !drawerOpen) throw new Error("nav drawer did not open");
    },
  };

  const entryLocator = {
    first: () => entryLocator,
    count: async () => 1,
    isVisible: async () => drawerOpen && foldOpen && !staysHidden,
    locator: (sel) => {
      if (sel === "xpath=ancestor::*[@data-nav-fold][1]") {
        return {
          locator: (inner) => (inner === ".nav-fold__toggle" ? foldToggle : missingLocator(inner)),
        };
      }
      return missingLocator(sel);
    },
    waitFor: async ({ state } = {}) => {
      events.push(`waitFor:entry:${entryId}:${state}`);
      if (state === "visible" && !(drawerOpen && foldOpen && !staysHidden)) {
        throw new Error(`entry ${entryId} stayed hidden`);
      }
    },
    dispatchEvent: async (type) => {
      events.push(`dispatch:${entryId}:${type}`);
    },
  };

  const drawerButton = {
    first: () => drawerButton,
    count: async () => (drawerClosed ? 1 : 0),
    isVisible: async () => drawerClosed && !drawerOpen,
    click: async () => {
      events.push(`click:drawer:${drawerLabel}`);
      drawerOpen = true;
    },
  };

  const page = {
    getByRole: (role, opts = {}) => {
      if (role === "button" && opts.name === drawerLabel && opts.exact) return drawerButton;
      return missingLocator(`role:${role}:${opts.name}`);
    },
    locator: (sel) => {
      if (sel === '[data-tour="nav"]') return navDrawer;
      if (entryId && sel === `[data-tour="nav-${entryId}"]`) return entryLocator;
      if (sel === "nav") return missingLocator("nav");
      return missingLocator(sel);
    },
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
  };

  return { page, events };
}
