import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInteractiveUi, syntheticEvent, withBrowserGlobals } from './helpers/react-harness.mjs';

/* ui/components/Tooltip.jsx: an empty `content` draws no card and closes an open one. The close itself is a state update from a layout effect, so it lands
   one render later; the card (not in the top layer) is hidden from what it is drawn with (`open && worded`), so the render in which its words go already
   hides it. A layout effect of a sibling runs in that same commit, before the Tooltip's own close re-renders it, and reads the panel as it was committed. */
async function harness() {
  const { exports, mount, React: R } = await loadInteractiveUi("export { default as Tooltip } from './ui/components/Tooltip.jsx';");
  let panel = null;
  // The props of the card's panel in the render being committed (the harness commits each render pass as it is drawn).
  const create = R.createElement;
  R.createElement = (type, props, ...children) => {
    if (type === 'span' && props?.role === 'tooltip') panel = props;
    return create(type, props, ...children);
  };
  const seen = [];
  function Probe({ content }) {
    R.useLayoutEffect(() => { seen.push({ content, hidden: panel?.hidden }); });
    return null;
  }
  const view = (content, forceOpen = false) => R.createElement(R.Fragment, null,
    R.createElement(exports.Tooltip, { content, forceOpen }, R.createElement('button', { type: 'button' }, 'x')),
    R.createElement(Probe, { content }));
  return { mount, view, seen, panel: () => panel };
}

test('an open card is hidden in the very commit its words go, before its own close re-renders it', async () => {
  await withBrowserGlobals(async () => {
    // Held open by the caller (forceOpen), and opened by the card's own handler (keyboard focus).
    for (const how of ['forceOpen', 'focus']) {
      const { mount, view, seen, panel } = await harness();
      const forced = how === 'forceOpen';
      const mounted = mount(view('说明', forced));
      if (!forced) {
        const button = mounted.find((node) => node?.type === 'button');
        await mounted.act(() => button.props.onFocus(syntheticEvent({ target: { matches: () => true } })));
      }
      assert.equal(panel().hidden, false, `${how}: the card is open`);
      seen.length = 0;
      mounted.rerender(view('', forced));
      assert.deepEqual(seen[0], { content: '', hidden: true }, `${how}: hidden in the commit in which its words went, not one render later`);
      assert.equal(panel().hidden, true, `${how}: and it stays hidden`);
      mounted.unmount();
    }
  });
});
