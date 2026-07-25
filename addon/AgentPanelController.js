function MNAgentShowWaitingPage(controller, description) {
  if (!controller.webView) return;
  var html = [
    "<!doctype html><html><head><meta charset='utf-8'>",
    "<meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<style>body{font-family:-apple-system;padding:28px;line-height:1.6;color:#334155}",
    "button{border:0;border-radius:10px;padding:10px 16px;background:#2563eb;color:white}</style>",
    "</head><body><h2>正在启动 MarginNote Agent</h2>",
    "<p>正在等待本地 Host，连接恢复后会自动重试。</p>",
    description ? "<p style='color:#64748b'>" + String(description) + "</p>" : "",
    "<button onclick=\"location.href='mnagent://retry'\">重试</button></body></html>",
  ].join("");
  controller.loadingErrorPage = true;
  controller.webView.loadHTMLStringBaseURL(html, null);
}

function MNAgentLoadHost(controller) {
  if (!controller.webView) return;
  controller.hostLoaded = false;
  controller.loadingErrorPage = false;
  var url = NSURL.URLWithString(MN_AGENT_BASE_URL + "/");
  var request = NSURLRequest.requestWithURL(url);
  controller.webView.loadRequest(request);
}

function MNAgentEnsureHostLoaded(controller) {
  if (!controller.webView) return;
  controller.webView.delegate = controller;
  if (!controller.hostLoaded) MNAgentLoadHost(controller);
}

var AgentPanelController = JSB.defineClass(
  "AgentPanelController : UIViewController <UIWebViewDelegate>",
  {
    viewDidLoad: function () {
      var controller = self;
      controller.view.backgroundColor = UIColor.whiteColor();

      var bounds = controller.view.bounds;
      var width = bounds.width > 0 ? bounds.width : 480;
      var height = bounds.height > 0 ? bounds.height : 640;
      controller.webView = new UIWebView({
        x: 0,
        y: 0,
        width: width,
        height: height,
      });
      controller.webView.backgroundColor = UIColor.whiteColor();
      controller.webView.scalesPageToFit = true;
      controller.webView.autoresizingMask = 1 << 1 | 1 << 4 | 1 << 5;
      controller.webView.delegate = controller;
      controller.view.addSubview(controller.webView);
      controller.hostLoaded = false;
      controller.loadingErrorPage = false;
      MNAgentShowWaitingPage(controller, "");
    },

    viewDidLayoutSubviews: function () {
      if (!self.webView) return;
      var bounds = self.view.bounds;
      self.webView.frame = {
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height,
      };
    },

    viewWillAppear: function () {
      MNAgentEnsureHostLoaded(self);
    },

    viewWillDisappear: function () {
      if (!self.webView) return;
      self.webView.delegate = null;
      self.webView.stopLoading();
    },

    ensureHostLoaded: function () {
      MNAgentEnsureHostLoaded(self);
    },

    webViewDidFinishLoad: function () {
      if (self.loadingErrorPage) {
        self.loadingErrorPage = false;
        return;
      }
      self.hostLoaded = true;
    },

    webViewDidFailLoadWithError: function (webView, error) {
      var code = error && error.code;
      if (typeof code === "function") code = code.call(error);
      if (Number(code) === -999) return;

      self.hostLoaded = false;
      var description = error && error.localizedDescription;
      if (typeof description === "function") description = description.call(error);
      MNAgentShowWaitingPage(self, description || "Connection failed");
    },

    webViewShouldStartLoadWithRequestNavigationType: function (webView, request) {
      var url = request.URL();
      if (!url || String(url.scheme || "").toLowerCase() !== "mnagent") return true;
      if (String(url.host || "").toLowerCase() === "retry") {
        self.hostLoaded = false;
        MNAgentLoadHost(self);
      }
      return false;
    },
  },
);
