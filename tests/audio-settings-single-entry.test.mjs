import test from 'node:test';
import assert from 'node:assert/strict';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* #1708: when the transcription setup gate is shown on 音频转写 (AudioView) or 课堂实录 (LiveClass),
   only ONE entry to Audio Settings appears on screen (the setup gate CTA); the PageHeader button stays
   hidden until transcription/live is ready, and reappears cleanly once configured or while loading/recovering. */

const ui = await loadInteractiveUi(`
  export { AudioView, AudioHeader } from './ui/app/page-views.jsx';
  export { default as LiveClass } from './ui/LiveClass.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { audioFocusPending, takeAudioSettingsFocus } from './ui/audio-focus.js';
  export { resetHostQueries } from './ui/host-query.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = ui.React.createElement;
const { AudioView, AudioHeader, LiveClass, AppContext, StudyServicesContext, audioFocusPending, takeAudioSettingsFocus, resetHostQueries, setUiLanguage } = ui.exports;

const BASE_DATA = { root: 'r', decks: [], jobs: [], sources: [], focus: { course: '', courses: [] } };
const SETTINGS_BUTTON_RE = /^(音频设置|打开音频设置|改用 Gemini 密钥|Audio settings|Open audio settings|Use a Gemini key instead)$/;

const buttonLabels = (mounted, root = mounted.tree) => mounted
  .findAll((node) => node.type === 'button', root)
  .map((node) => mounted.text(node).trim());

const settingsButtons = (mounted, root = mounted.tree) => mounted
  .findAll((node) => node.type === 'button' && SETTINGS_BUTTON_RE.test(mounted.text(node).trim()), root);

const headerOf = (mounted) => mounted.find((node) => node.type === 'header' && /\bsh-page-header\b/.test(String(node.props?.className || '')));

function preflightResponse(overrides = {}) {
  return {
    providers: { free: false, siliconflow: false, groq: false, paid: false },
    transcription: false,
    first: null,
    reason: 'no-provider',
    text: true,
    textProvider: 'auto',
    live: false,
    liveProvider: null,
    liveReason: 'no-provider',
    liveChoice: 'auto',
    liveLocal: { supported: false, ready: false },
    liveLoopback: { supported: false, ready: false },
    ...overrides,
  };
}

function makeAudioApp(navLog, extra = {}) {
  return {
    data: BASE_DATA,
    host: {},
    nav: {
      navigate: (page) => navLog.push({ via: 'navigate', page, focusPending: audioFocusPending() }),
      show: { page: (page) => navLog.push({ via: 'show.page', page, focusPending: audioFocusPending() }) },
    },
    lib: {},
    set: {},
    learn: {},
    sources: {},
    ...extra,
  };
}

test('AudioView hides the header audio-settings button while AudioSetupGate is shown, leaving strictly one entry in zh and en', async () => {
  await withBrowserGlobals(async () => {
    for (const [lang, expectedGateLabel, expectedSourcesLabel] of [
      ['zh', '打开音频设置', '查看资料'],
      ['en', 'Open audio settings', 'View sources'],
    ]) {
      resetHostQueries();
      takeAudioSettingsFocus();
      setUiLanguage(lang);
      const navLog = [];
      const call = async (action) => {
        if (action === 'audio.preflight') return preflightResponse({ transcription: false, reason: 'no-provider' });
        if (action === 'audio.settings.get') return { freeKey: { set: false }, siliconflowKey: { set: false }, groqKey: { set: false }, paidKey: { set: false } };
        return {};
      };
      const mounted = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: { call, busy: false, act: async () => {} } },
        h(AppContext.Provider, { value: makeAudioApp(navLog) }, h(AudioView)),
      ));
      try {
        await mounted.flush(5);
        const header = headerOf(mounted);
        assert.ok(header, `${lang}: PageHeader is rendered`);
        assert.equal(settingsButtons(mounted, header).length, 0, `${lang}: header hides its audio-settings button while setup gate is shown`);
        assert.deepEqual(buttonLabels(mounted, header), [expectedSourcesLabel], `${lang}: header keeps only the sources link`);

        const pageSettings = settingsButtons(mounted);
        assert.equal(pageSettings.length, 1, `${lang}: strictly one audio-settings entry on screen`);
        assert.equal(mounted.text(pageSettings[0]).trim(), expectedGateLabel);

        click(pageSettings[0]);
        assert.deepEqual(navLog, [{ via: 'show.page', page: 'settings', focusPending: true }], `${lang}: setup gate CTA requests audio focus and opens settings`);
        takeAudioSettingsFocus();
      } finally {
        mounted.unmount();
        setUiLanguage('zh');
      }
    }
  });
});

test('AudioView transitions cleanly across loading, paid-missing gate, inline key save, and preflight failure', async () => {
  await withBrowserGlobals(async () => {
    resetHostQueries();
    takeAudioSettingsFocus();
    setUiLanguage('zh');
    const navLog = [];
    let resolvePreflight;
    let configured = false;
    const savedPatches = [];
    const call = (action, args) => {
      if (action === 'audio.preflight') {
        if (!resolvePreflight) {
          return new Promise((resolve) => { resolvePreflight = resolve; });
        }
        return Promise.resolve(configured
          ? preflightResponse({ transcription: true, first: 'siliconflow', reason: null, providers: { free: false, siliconflow: true, groq: false, paid: false } })
          : preflightResponse({ transcription: false, reason: 'no-provider' }));
      }
      if (action === 'audio.settings.set') {
        savedPatches.push(args);
        configured = true;
        return Promise.resolve({ siliconflowKey: { set: true, hint: '••••1234' } });
      }
      if (action === 'audio.test') return Promise.resolve({ siliconflow: { ok: true } });
      if (action === 'audio.settings.get') return Promise.resolve({ siliconflowKey: { set: configured } });
      return Promise.resolve({});
    };

    const mounted = ui.mount(() => h(
      StudyServicesContext.Provider,
      { value: { call, busy: false, act: async () => {} } },
      h(AppContext.Provider, { value: makeAudioApp(navLog) }, h(AudioView)),
    ));
    try {
      // 1. Loading state (preflight pending): no setup gate yet, header provides the single entry.
      assert.equal(settingsButtons(mounted, headerOf(mounted)).length, 1, 'loading: header shows audio-settings entry');
      assert.equal(settingsButtons(mounted).length, 1, 'loading: strictly one entry on screen');

      // 2. Preflight resolves unconfigured: gate appears and header hides its button.
      await mounted.act(async () => {
        resolvePreflight(preflightResponse({ transcription: false, reason: 'no-provider' }));
      });
      await mounted.flush(5);
      assert.equal(settingsButtons(mounted, headerOf(mounted)).length, 0, 'unconfigured: header button hidden');
      assert.equal(settingsButtons(mounted).length, 1, 'unconfigured: strictly one entry (inside setup gate)');

      // 3. Inline key save inside AudioSetupGate refreshes readiness -> gate closes and header button returns.
      const keyInput = mounted.find((node) => node.type === 'input' && node.props?.name === 'audio-key');
      assert.ok(keyInput, 'setup gate renders inline key input');
      const saveBtn = mounted.find((node) => node.type === 'button' && mounted.text(node).trim() === '保存并验证');
      assert.ok(saveBtn, 'setup gate renders save-and-verify button');
      await mounted.act(async () => {
        keyInput.props.onChange({ target: { value: 'sk-test-1234' } });
      });
      await mounted.act(async () => {
        const keyForm = mounted.find((node) => node.type === 'form' && /\bsh-secret\b/.test(String(node.props?.className || '')));
        assert.ok(keyForm, 'setup gate renders secret key form');
        keyForm.props.onSubmit({ preventDefault() {} });
      });
      await mounted.flush(8);
      assert.equal(savedPatches.length, 1, 'inline save sent audio.settings.set');
      assert.equal(settingsButtons(mounted, headerOf(mounted)).length, 1, 'configured: header button reappears');
      assert.equal(settingsButtons(mounted).length, 1, 'configured: strictly one entry on screen');
      assert.equal(mounted.text(settingsButtons(mounted)[0]).trim(), '音频设置');

      click(settingsButtons(mounted)[0]);
      assert.deepEqual(navLog, [{ via: 'navigate', page: 'settings', focusPending: true }], 'configured header button opens settings with audio focus');
    } finally {
      mounted.unmount();
    }

    // 4. Paid-missing setup gate also hides the header entry and leaves strictly one entry.
    resetHostQueries();
    const paidMissingMounted = ui.mount(() => h(
      StudyServicesContext.Provider,
      { value: { call: async (action) => (action === 'audio.preflight' ? preflightResponse({ transcription: false, reason: 'paid-missing' }) : {}), busy: false, act: async () => {} } },
      h(AppContext.Provider, { value: makeAudioApp([]) }, h(AudioView)),
    ));
    try {
      await paidMissingMounted.flush(5);
      assert.equal(settingsButtons(paidMissingMounted, headerOf(paidMissingMounted)).length, 0, 'paid-missing: header button hidden');
      assert.equal(settingsButtons(paidMissingMounted).length, 1, 'paid-missing: strictly one entry in setup gate');
      assert.equal(paidMissingMounted.text(settingsButtons(paidMissingMounted)[0]).trim(), '打开音频设置');
    } finally {
      paidMissingMounted.unmount();
    }

    // 5. Preflight failure keeps header entry without crashing.
    resetHostQueries();
    const failMounted = ui.mount(() => h(
      StudyServicesContext.Provider,
      { value: { call: async (action) => { if (action === 'audio.preflight') throw new Error('offline'); return {}; }, busy: false, act: async () => {} } },
      h(AppContext.Provider, { value: makeAudioApp([]) }, h(AudioView)),
    ));
    try {
      await failMounted.flush(5);
      assert.equal(settingsButtons(failMounted, headerOf(failMounted)).length, 1, 'error fallback: header button stays reachable');
      assert.equal(settingsButtons(failMounted).length, 1, 'error fallback: strictly one entry');
    } finally {
      failMounted.unmount();
    }
  });
});

test('AudioView: a failed job card leaves out its own audio-settings button while the setup gate is up, and brings it back once transcription is ready', async () => {
  await withBrowserGlobals(async () => {
    setUiLanguage('zh');
    const failedJob = { id: 'j1', type: 'audio-import', status: 'failed', stage: '转写服务的密钥无效，请到音频设置里检查', name: 'lecture.mp3', createdAt: 1, updatedAt: 2 };
    for (const [transcription, expected] of [[false, 1], [true, 2]]) {
      resetHostQueries();
      const call = async (action) => (action === 'audio.preflight'
        ? preflightResponse(transcription ? { transcription: true, first: 'siliconflow', reason: null } : { transcription: false, reason: 'no-provider' })
        : {});
      const mounted = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: { call, busy: false, act: async () => {} } },
        h(AppContext.Provider, { value: makeAudioApp([], { data: { ...BASE_DATA, jobs: [failedJob] } }) }, h(AudioView)),
      ));
      try {
        await mounted.flush(5);
        const labels = buttonLabels(mounted);
        assert.ok(mounted.find((node) => node.props?.['data-job-id'] === 'j1'), `the failed job card is on the page (${labels.join(' | ')})`);
        // Gated: only the gate's button. Ready: the header's, and the failed job card's own.
        assert.equal(settingsButtons(mounted).length, expected, `transcription ${transcription}: ${labels.join(' | ')}`);
      } finally {
        mounted.unmount();
      }
    }
  });
});

test('LiveClass hides the header audio-settings button across all LiveSetup variants in zh and en', async () => {
  await withBrowserGlobals(async () => {
    const cases = [
      {
        label: 'gemini-only zh',
        lang: 'zh',
        readiness: preflightResponse({ live: false, liveReason: 'no-provider', liveLocal: { supported: false, ready: false } }),
        expectedGateButton: '打开音频设置',
      },
      {
        label: 'local-supported zh',
        lang: 'zh',
        readiness: preflightResponse({ live: false, liveReason: 'no-provider', liveLocal: { supported: true, ready: false } }),
        expectedGateButton: '改用 Gemini 密钥',
      },
      {
        label: 'no-gemini-key zh',
        lang: 'zh',
        readiness: preflightResponse({ live: false, liveReason: 'no-gemini-key', liveLocal: { supported: true, ready: true } }),
        expectedGateButton: '打开音频设置',
      },
      {
        label: 'gemini-only en',
        lang: 'en',
        readiness: preflightResponse({ live: false, liveReason: 'no-provider', liveLocal: { supported: false, ready: false } }),
        expectedGateButton: 'Open audio settings',
      },
      {
        label: 'local-supported en',
        lang: 'en',
        readiness: preflightResponse({ live: false, liveReason: 'no-provider', liveLocal: { supported: true, ready: false } }),
        expectedGateButton: 'Use a Gemini key instead',
      },
    ];

    for (const item of cases) {
      takeAudioSettingsFocus();
      setUiLanguage(item.lang);
      const opened = [];
      const mounted = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: { call: async () => ({ sessions: [] }) } },
        h(LiveClass, {
          data: BASE_DATA,
          visible: true,
          onSettings: () => opened.push(audioFocusPending()),
          initialReadiness: item.readiness,
        }),
      ));
      try {
        const header = headerOf(mounted);
        assert.ok(header, `${item.label}: PageHeader rendered`);
        assert.equal(settingsButtons(mounted, header).length, 0, `${item.label}: header button hidden while LiveSetup is shown`);
        const allSettings = settingsButtons(mounted);
        assert.equal(allSettings.length, 1, `${item.label}: strictly one audio-settings entry on screen`);
        assert.equal(mounted.text(allSettings[0]).trim(), item.expectedGateButton);
        click(allSettings[0]);
        assert.deepEqual(opened, [true], `${item.label}: clicking gate CTA requests audio focus and calls onSettings`);
        takeAudioSettingsFocus();
      } finally {
        mounted.unmount();
        setUiLanguage('zh');
      }
    }
  });
});

test('LiveClass updates header entry cleanly on configured <-> unconfigured transitions, active session, error, and omitted callback', async () => {
  await withBrowserGlobals(async () => {
    setUiLanguage('zh');
    takeAudioSettingsFocus();
    let liveReady = false;
    let resolveFirstPreflight;
    let preflightCalls = 0;
    const opened = [];
    const call = (action) => {
      if (action === 'audio.preflight') {
        preflightCalls += 1;
        if (preflightCalls === 1) {
          return new Promise((resolve) => { resolveFirstPreflight = resolve; });
        }
        return Promise.resolve(preflightResponse({ live: liveReady, liveProvider: liveReady ? 'gemini' : null, liveReason: liveReady ? undefined : 'no-provider' }));
      }
      if (action === 'live.list') return Promise.resolve({ sessions: [] });
      return Promise.resolve({});
    };

    let visible = true;
    const renderLive = () => h(
      StudyServicesContext.Provider,
      { value: { call } },
      h(LiveClass, { data: BASE_DATA, visible, onSettings: () => opened.push(audioFocusPending()) }),
    );
    const mounted = ui.mount(renderLive);
    try {
      // 1. Loading (preflight pending): header shows the single entry.
      assert.equal(settingsButtons(mounted, headerOf(mounted)).length, 1, 'loading: header button shown');
      assert.equal(settingsButtons(mounted).length, 1, 'loading: strictly one entry');

      // 2. Preflight resolves unconfigured -> header hides, LiveSetup shows its CTA.
      await mounted.act(async () => {
        resolveFirstPreflight(preflightResponse({ live: false }));
      });
      await mounted.flush(5);
      assert.equal(settingsButtons(mounted, headerOf(mounted)).length, 0, 'unconfigured: header hidden');
      assert.equal(settingsButtons(mounted).length, 1, 'unconfigured: single gate entry');

      // 3. Navigate away (visible=false) -> configure key -> return (visible=true): header returns, gate disappears.
      liveReady = true;
      visible = false;
      mounted.rerender();
      visible = true;
      mounted.rerender();
      await mounted.flush(5);
      assert.equal(settingsButtons(mounted, headerOf(mounted)).length, 1, 'configured after return: header button restored');
      assert.equal(settingsButtons(mounted).length, 1, 'configured after return: strictly one entry');
      click(settingsButtons(mounted)[0]);
      assert.deepEqual(opened, [true], 'configured header button opens settings with audio focus');
      takeAudioSettingsFocus();

      // 4. Navigate away -> clear key -> return: gate returns and header hides again.
      liveReady = false;
      visible = false;
      mounted.rerender();
      visible = true;
      mounted.rerender();
      await mounted.flush(5);
      assert.equal(settingsButtons(mounted, headerOf(mounted)).length, 0, 'unconfigured again: header hidden');
      assert.equal(settingsButtons(mounted).length, 1, 'unconfigured again: single gate entry');
    } finally {
      mounted.unmount();
    }

    // 5. Active session suppresses LiveSetup, so header entry stays visible.
    const activeMounted = ui.mount(() => h(
      StudyServicesContext.Provider,
      { value: { call: async () => ({ sessions: [] }) } },
      h(LiveClass, {
        data: BASE_DATA,
        visible: true,
        onSettings: () => {},
        initialReadiness: preflightResponse({ live: false }),
        initialSession: { id: 's1', title: 'Class', course: '', status: 'live', elapsedMs: 0, segments: [], total: 0, revision: 1, interim: '', translating: 0, generatedIds: [], warnings: [] },
      }),
    ));
    try {
      assert.equal(settingsButtons(activeMounted, headerOf(activeMounted)).length, 1, 'active session: header button remains');
      assert.equal(settingsButtons(activeMounted).length, 1, 'active session: strictly one entry');
    } finally {
      activeMounted.unmount();
    }

    // 5b. A class that ended in error is not active: the gate follows the readiness alone, in both directions.
    const brokenSession = { id: 's2', title: 'Class', course: '', status: 'error', elapsedMs: 0, segments: [], total: 0, revision: 1, interim: '', translating: 0, generatedIds: [], warnings: [], message: 'connection lost' };
    for (const [live, headerButtons, why] of [[false, 0, 'unconfigured: the gate is the one entry'], [true, 1, 'configured: the header is the one entry']]) {
      const errored = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: { call: async () => ({ sessions: [] }) } },
        h(LiveClass, { data: BASE_DATA, visible: true, onSettings: () => {}, initialReadiness: preflightResponse({ live }), initialSession: brokenSession }),
      ));
      try {
        assert.equal(settingsButtons(errored, headerOf(errored)).length, headerButtons, `error session, ${why}`);
        assert.equal(settingsButtons(errored).length, 1, `error session, ${why}: strictly one entry`);
      } finally {
        errored.unmount();
      }
    }

    // 6. Omitted onSettings callback: renders without crashing and leaves no dead settings button.
    const noCbMounted = ui.mount(() => h(
      StudyServicesContext.Provider,
      { value: { call: async () => ({ sessions: [] }) } },
      h(LiveClass, { data: BASE_DATA, visible: true, initialReadiness: preflightResponse({ live: true }) }),
    ));
    try {
      assert.equal(settingsButtons(noCbMounted).length, 0, 'omitted onSettings: no dead audio-settings button');
    } finally {
      noCbMounted.unmount();
    }
  });
});

test('AudioHeader omits missing action callbacks cleanly without empty action containers', async () => {
  await withBrowserGlobals(async () => {
    setUiLanguage('zh');
    const sourcesOnly = ui.mount(() => h(AudioHeader, { onSources: () => {} }));
    try {
      assert.deepEqual(buttonLabels(sourcesOnly), ['查看资料']);
    } finally {
      sourcesOnly.unmount();
    }

    const empty = ui.mount(() => h(AudioHeader, {}));
    try {
      assert.deepEqual(buttonLabels(empty), []);
      assert.equal(empty.find((node) => /\bsh-page-header__actions\b/.test(String(node.props?.className || ''))), null);
    } finally {
      empty.unmount();
    }
  });
});
