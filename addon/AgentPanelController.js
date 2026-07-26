// 等待页与 host/src/web/styles.css 使用同一套令牌，避免 Host 启动前后观感断层。
function MNAgentShowWaitingPage(controller, description) {
  if (!controller.webView) return;
  var detail = description
    ? "<p class='detail'>" +
      String(description).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      "</p>"
    : "";
  var html = [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>",
    "<meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<style>",
    ":root{color-scheme:light dark;",
    "--bg:hsl(40 24% 97%);--surface:hsl(0 0% 100%);--border:hsl(38 15% 88%);",
    "--text:hsl(232 22% 14%);--muted:hsl(232 9% 42%);--faint:hsl(232 7% 58%);",
    "--accent:hsl(246 58% 46%);--accent-soft:hsl(246 62% 96%);--on-accent:#fff}",
    "@media(prefers-color-scheme:dark){:root{",
    "--bg:hsl(240 14% 10%);--surface:hsl(240 12% 14%);--border:hsl(240 8% 23%);",
    "--text:hsl(240 14% 90%);--muted:hsl(240 7% 64%);--faint:hsl(240 6% 56%);",
    "--accent:hsl(248 70% 68%);--accent-soft:hsl(248 28% 22%);--on-accent:hsl(248 45% 10%)}}",
    "*{box-sizing:border-box}",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
    "padding:24px;background:var(--bg);color:var(--text);text-align:center;",
    "font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;",
    "-webkit-font-smoothing:antialiased}",
    ".card{width:100%;max-width:320px}",
    ".mark{width:40px;height:40px;margin:0 auto 14px;border-radius:12px;",
    "background:var(--accent-soft);position:relative}",
    ".mark span{position:absolute;top:50%;left:50%;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;",
    "border-radius:50%;background:var(--accent);animation:pulse 1.8s ease-out infinite}",
    "@keyframes pulse{0%{transform:scale(.7);opacity:.5}",
    "50%{transform:scale(1);opacity:1}100%{transform:scale(.7);opacity:.5}}",
    "h1{margin:0 0 6px;font-size:15px;font-weight:650;letter-spacing:-.01em}",
    "p{margin:0;color:var(--muted);font-size:13px}",
    ".detail{margin-top:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;",
    "background:var(--surface);color:var(--faint);font-size:11.5px;line-height:1.55;",
    "word-break:break-word}",
    "button{margin-top:18px;padding:8px 20px;border:0;border-radius:10px;cursor:pointer;",
    "background:var(--accent);color:var(--on-accent);font:inherit;font-size:13px;font-weight:600}",
    "</style></head><body><div class='card'>",
    "<div class='mark'><span></span></div>",
    "<h1>正在启动 MarginNote Agent</h1>",
    "<p>正在等待本地 Host，连接恢复后会自动重试。</p>",
    detail,
    "<button onclick=\"location.href='mnagent://retry'\">重试</button>",
    "</div></body></html>",
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
