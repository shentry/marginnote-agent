function MNAgentLoadHost(controller) {
  if (!controller.webView) return;
  var url = NSURL.URLWithString(MN_AGENT_BASE_URL + "/");
  var request = NSURLRequest.requestWithURL(url);
  controller.webView.loadRequest(request);
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
      MNAgentLoadHost(controller);
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
      if (self.webView) self.webView.delegate = self;
    },

    viewWillDisappear: function () {
      if (!self.webView) return;
      self.webView.stopLoading();
      self.webView.delegate = null;
    },

    webViewDidFailLoadWithError: function (webView, error) {
      var description = error.localizedDescription;
      if (typeof description === "function") description = description.call(error);
      var html = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width,initial-scale=1'>",
        "<style>body{font-family:-apple-system;padding:28px;line-height:1.6;color:#334155}",
        "button{border:0;border-radius:10px;padding:10px 16px;background:#2563eb;color:white}</style>",
        "</head><body><h2>MarginNote Agent Host 未启动</h2>",
        "<p>在项目目录运行 <code>npm start</code>，然后点击重试。</p>",
        "<p style='color:#64748b'>" + String(description || "Connection failed") + "</p>",
        "<button onclick=\"location.href='mnagent://retry'\">重试</button></body></html>",
      ].join("");
      webView.loadHTMLStringBaseURL(html, null);
    },

    webViewShouldStartLoadWithRequestNavigationType: function (webView, request) {
      var url = request.URL();
      if (!url || String(url.scheme || "").toLowerCase() !== "mnagent") return true;
      if (String(url.host || "").toLowerCase() === "retry") MNAgentLoadHost(self);
      return false;
    },
  },
);
