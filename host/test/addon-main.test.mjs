import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

async function loadAddon({ study }) {
  const preferences = new Map();
  const timers = [];
  let addonMethods = null;
  const context = vm.createContext({
    Application: {
      sharedInstance: () => ({ studyController: () => study }),
    },
    NSUserDefaults: {
      standardUserDefaults: () => ({
        boolForKey: (key) => Boolean(preferences.get(key)),
        removeObjectForKey: (key) => preferences.delete(key),
        setBoolForKey: (value, key) => preferences.set(key, value),
        setObjectForKey: (value, key) => preferences.set(key, value),
      }),
    },
    JSB: {
      require: () => {},
      defineClass: (_name, methods) => {
        addonMethods = methods;
        return methods;
      },
    },
    NSTimer: {
      scheduledTimerWithTimeInterval: (delay, repeats, callback) => {
        timers.push({ callback, delay, repeats });
      },
    },
    MNAgentBridge: { start: () => {}, stop: () => {} },
    AgentPanelController: { new: () => ({}) },
  });
  vm.runInContext(await readFile(new URL("../../addon/main.js", import.meta.url), "utf8"), context);
  context.JSB.newAddon("/addon");
  return { addonMethods, context, preferences, timers };
}

function createView(frame, bounds = frame) {
  return {
    frame: { ...frame },
    bounds: { ...bounds },
    hidden: false,
    superview: null,
    window: null,
    addSubview(view) {
      view.superview = this;
      view.window = this.window;
    },
  };
}

function createPanelView() {
  return {
    frame: {},
    superview: null,
    window: null,
    removeFromSuperview() {
      this.superview = null;
      this.window = null;
    },
  };
}

function plainFrame(frame) {
  return {
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
  };
}

function createNativeStudy() {
  const studyView = createView(
    { x: 10, y: 20, width: 1000, height: 700 },
    { x: 0, y: 0, width: 1000, height: 700 },
  );
  const hostView = createView(
    { x: 0, y: 0, width: 420, height: 700 },
    { x: 0, y: 0, width: 420, height: 700 },
  );
  let toggleCount = 0;
  const study = {
    view: studyView,
    extensionPanelController: { view: hostView },
    refreshAddonCommands: () => {},
    toggleExtensionPanel() {
      toggleCount += 1;
      hostView.window = hostView.window ? null : {};
    },
  };
  return { hostView, study, studyView, toggleCount: () => toggleCount };
}

test("addon uses MarginNote's native extension panel without changing the study frame", async () => {
  const { hostView, study, studyView, toggleCount } = createNativeStudy();
  const { addonMethods, context, preferences, timers } = await loadAddon({ study });
  const panelView = createPanelView();
  let ensureHostCount = 0;
  const addon = {
    window: {},
    panelController: {
      view: panelView,
      ensureHostLoaded: () => {
        ensureHostCount += 1;
      },
    },
  };
  context.self = addon;

  addonMethods.toggleAgentPanel();

  assert.equal(panelView.superview, hostView);
  assert.deepEqual(plainFrame(studyView.frame), { x: 10, y: 20, width: 1000, height: 700 });
  assert.deepEqual(plainFrame(panelView.frame), { x: 0, y: 0, width: 420, height: 700 });
  assert.equal(toggleCount(), 1);
  assert.equal(preferences.get("marginnote_agent_panel_visible"), true);
  assert.equal(ensureHostCount, 1);
  assert.deepEqual(
    timers.map((timer) => timer.delay),
    [0.05, 1, 3, 6],
  );

  addonMethods.toggleAgentPanel();

  assert.equal(panelView.superview, null);
  assert.deepEqual(plainFrame(studyView.frame), { x: 10, y: 20, width: 1000, height: 700 });
  assert.equal(toggleCount(), 2);
  assert.equal(preferences.get("marginnote_agent_panel_visible"), false);
});

test("addon lets MarginNote create the native extension panel before mounting", async () => {
  const studyView = createView(
    { x: 10, y: 20, width: 1000, height: 700 },
    { x: 0, y: 0, width: 1000, height: 700 },
  );
  const hostView = createView(
    { x: 0, y: 0, width: 420, height: 700 },
    { x: 0, y: 0, width: 420, height: 700 },
  );
  let toggleCount = 0;
  const study = {
    view: studyView,
    extensionPanelController: null,
    refreshAddonCommands: () => {},
    toggleExtensionPanel() {
      toggleCount += 1;
      if (!this.extensionPanelController) this.extensionPanelController = { view: hostView };
      hostView.window = hostView.window ? null : {};
    },
  };
  const { addonMethods, context } = await loadAddon({ study });
  const panelView = createPanelView();
  const addon = { window: {}, panelController: { view: panelView } };
  context.self = addon;

  addonMethods.toggleAgentPanel();

  assert.equal(panelView.superview, hostView);
  assert.deepEqual(plainFrame(panelView.frame), { x: 0, y: 0, width: 420, height: 700 });
  assert.deepEqual(plainFrame(studyView.frame), { x: 10, y: 20, width: 1000, height: 700 });
  assert.equal(toggleCount, 1);

  addonMethods.toggleAgentPanel();

  assert.equal(panelView.superview, null);
  assert.equal(hostView.window, null);
  assert.equal(toggleCount, 2);
});

test("native panel layout follows its host bounds without touching MarginNote content", async () => {
  const { hostView, study, studyView } = createNativeStudy();
  const { addonMethods, context } = await loadAddon({ study });
  const panelView = createPanelView();
  const addon = { window: {}, panelController: { view: panelView } };
  context.self = addon;

  addonMethods.toggleAgentPanel();
  hostView.bounds = { x: 0, y: 0, width: 500, height: 760 };
  addonMethods.controllerWillLayoutSubviews(study);
  const resizedPanelFrame = plainFrame(panelView.frame);

  addonMethods.controllerWillLayoutSubviews(study);

  assert.deepEqual(plainFrame(panelView.frame), resizedPanelFrame);
  assert.deepEqual(plainFrame(studyView.frame), { x: 10, y: 20, width: 1000, height: 700 });
  assert.deepEqual(plainFrame(panelView.frame), { x: 0, y: 0, width: 500, height: 760 });
});

test("addon does not close a native extension panel that was already open", async () => {
  const { hostView, study, toggleCount } = createNativeStudy();
  hostView.window = {};
  const { addonMethods, context } = await loadAddon({ study });
  const panelView = createPanelView();
  const addon = { window: {}, panelController: { view: panelView } };
  context.self = addon;

  addonMethods.toggleAgentPanel();
  addonMethods.toggleAgentPanel();

  assert.equal(panelView.superview, null);
  assert.ok(hostView.window);
  assert.equal(toggleCount(), 0);
});

test("addon yields panel ownership after the native panel is closed externally", async () => {
  const { hostView, study, toggleCount } = createNativeStudy();
  const { addonMethods, context } = await loadAddon({ study });
  const panelView = createPanelView();
  const addon = { window: {}, panelController: { view: panelView } };
  context.self = addon;

  addonMethods.toggleAgentPanel();
  hostView.window = null;
  addonMethods.controllerWillLayoutSubviews(study);
  hostView.window = {};
  addonMethods.controllerWillLayoutSubviews(study);
  addonMethods.toggleAgentPanel();

  assert.equal(panelView.superview, null);
  assert.ok(hostView.window);
  assert.equal(toggleCount(), 1);
});

test("addon retries restoring a remembered panel until the study window is ready", async () => {
  const { hostView, study } = createNativeStudy();
  const { addonMethods, context, preferences, timers } = await loadAddon({ study });
  const panelView = createPanelView();
  const addon = {
    window: null,
    panelController: { view: panelView, ensureHostLoaded: () => {} },
  };
  context.self = addon;
  preferences.set("marginnote_agent_panel_visible", true);

  addonMethods.notebookWillOpen();
  assert.deepEqual(
    timers.map((timer) => timer.delay),
    [0.2, 0.8, 2, 4],
  );

  timers[0].callback();
  assert.equal(panelView.superview, null);

  addon.window = {};
  timers[1].callback();
  assert.equal(panelView.superview, hostView);
});
