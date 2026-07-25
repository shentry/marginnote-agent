import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadPanelController() {
  let methods = null;
  const requests = [];
  const webView = {
    delegate: null,
    loadRequest(request) {
      requests.push(request);
    },
    loadHTMLStringBaseURL(html) {
      this.html = html;
    },
    stopLoading() {},
  };
  const context = vm.createContext({
    JSB: {
      defineClass: (_name, definedMethods) => {
        methods = definedMethods;
        return definedMethods;
      },
    },
    MN_AGENT_BASE_URL: "http://127.0.0.1:42117",
    NSURL: { URLWithString: (value) => ({ value }) },
    NSURLRequest: { requestWithURL: (url) => ({ url }) },
  });
  vm.runInContext(
    await readFile(new URL("../../addon/AgentPanelController.js", import.meta.url), "utf8"),
    context,
  );
  return {
    context,
    methods,
    requests,
    webView,
  };
}

test("panel retries the Host after its first connection fails", async () => {
  const panel = await loadPanelController();
  const controller = {
    view: { superview: {} },
    webView: panel.webView,
    hostLoaded: false,
    loadingErrorPage: false,
  };
  panel.context.self = controller;

  panel.methods.webViewDidFailLoadWithError(panel.webView, {
    code: -1004,
    localizedDescription: "Could not connect",
  });

  assert.match(panel.webView.html, /自动重试/);
  panel.methods.webViewShouldStartLoadWithRequestNavigationType(panel.webView, {
    URL: () => ({ scheme: "mnagent", host: "retry" }),
  });
  assert.equal(panel.requests.length, 1);
  assert.equal(panel.requests[0].url.value, "http://127.0.0.1:42117/");
});

test("showing an unloaded panel starts a fresh Host request", async () => {
  const panel = await loadPanelController();
  const controller = {
    view: { superview: {} },
    webView: panel.webView,
    hostLoaded: false,
    loadingErrorPage: false,
  };
  panel.context.self = controller;

  panel.methods.ensureHostLoaded();

  assert.equal(panel.requests.length, 1);
  assert.equal(panel.webView.delegate, controller);
  assert.equal(panel.requests[0].url.value, "http://127.0.0.1:42117/");
});
