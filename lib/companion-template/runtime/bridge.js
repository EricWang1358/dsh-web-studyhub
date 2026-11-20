/* StudyHub host postMessage bridge with Sandpack-style ready/ping handshake
   so initial theme, slide-jump, and label updates are never dropped in a race. */

export const COMPANION_PROTOCOL = "studyhub-companion/1";
export const COMPANION_CAPABILITIES = ["theme", "goto", "labels"];

export function createCompanionBridge({ boot, lesson, h, T, root, paintTheme, getCurrentContext, onGoto }) {
  function postHost(payload) {
    if (!boot || !boot.channelToken || window.parent === window) return false;
    try {
      window.parent.postMessage(
        Object.assign({ protocol: COMPANION_PROTOCOL, token: boot.channelToken }, payload),
        "*",
      );
      return true;
    } catch {
      return false;
    }
  }

  function announceReady(meta) {
    return postHost(Object.assign(
      {
        kind: "ready",
        version: 1,
        capabilities: COMPANION_CAPABILITIES,
        slideTotal: Array.isArray(lesson?.slides) ? lesson.slides.length : 1,
      },
      meta || {},
    ));
  }

  function mount() {
    if (!boot || !boot.channelToken) return { mounted: false };
    window.__shCompanionMounted = true;
    const askBtn = h("button.tool.tool--ask", {
      text: boot.askLabel || T.askBtn,
      attr: { type: "button" },
      on: {
        click: () => postHost({
          kind: "inquiry",
          context: getCurrentContext(window.getSelection?.()?.toString() || ""),
        }),
      },
    });
    document.querySelector(".top__tools")?.prepend(askBtn);

    const pill = h("button.sh-sel-pill", {
      text: boot.selectionLabel || T.askSel,
      attr: { type: "button", hidden: "" },
      on: {
        mousedown: (e) => e.preventDefault(),
        click: () => {
          const q = window.getSelection?.()?.toString() || "";
          pill.hidden = true;
          postHost({ kind: "inquiry", context: getCurrentContext(q) });
        },
      },
    });
    document.body.append(pill);

    document.addEventListener("selectionchange", () => {
      const sel = window.getSelection?.();
      const txt = sel ? sel.toString().trim() : "";
      if (!txt || txt.length < 2 || !sel.rangeCount) { pill.hidden = true; return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) { pill.hidden = true; return; }
      pill.hidden = false;
      pill.style.left = Math.max(8, Math.min(window.innerWidth - 160, rect.left + rect.width / 2 - 60)) + "px";
      pill.style.top = Math.max(8, rect.top - 38) + "px";
    });

    window.addEventListener("message", (ev) => {
      const data = ev?.data;
      if (!data || data.protocol !== COMPANION_PROTOCOL || data.token !== boot.channelToken) return;
      if (data.kind === "ping") {
        announceReady({ replyToPing: true });
        return;
      }
      if (data.kind === "goto" && Number.isInteger(data.slide)) {
        const total = Array.isArray(lesson?.slides) ? lesson.slides.length : 1;
        onGoto(Math.max(0, Math.min(total - 1, data.slide - 1)), 0);
      }
      if (data.kind === "theme" && (data.theme === "dark" || data.theme === "light")) {
        root.dataset.theme = data.theme;
        paintTheme();
      }
      if (data.kind === "labels") {
        if (data.askLabel) askBtn.textContent = String(data.askLabel);
        if (data.selectionLabel) pill.textContent = String(data.selectionLabel);
      }
    });

    return { mounted: true, askBtn, pill };
  }

  return { postHost, announceReady, mount };
}
