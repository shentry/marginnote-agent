JSB.newAddon = function (mainPath) {
  JSB.require("config");
  JSB.require("network");
  JSB.require("tools");
  JSB.require("bridge");
  JSB.require("AgentPanelController");

  function layoutPanel(addon) {
    var study = Application.sharedInstance().studyController(addon.window);
    if (!study) return;
    var bounds = study.view.bounds;
    var width = Math.min(520, Math.max(360, bounds.width * 0.42));
    addon.panelController.view.frame = {
      x: bounds.width - width - 16,
      y: 16,
      width: width,
      height: Math.max(420, bounds.height - 32),
    };
  }

  function showAgentPanel(addon) {
    var study = Application.sharedInstance().studyController(addon.window);
    if (!study || !addon.panelController) return;
    if (!addon.panelController.view.superview) study.view.addSubview(addon.panelController.view);
    layoutPanel(addon);
    NSUserDefaults.standardUserDefaults().setBoolForKey(
      true,
      "marginnote_agent_panel_visible",
    );
    study.refreshAddonCommands();
  }

  function hideAgentPanel(addon) {
    var study = Application.sharedInstance().studyController(addon.window);
    if (addon.panelController && addon.panelController.view.window) {
      addon.panelController.view.removeFromSuperview();
    }
    NSUserDefaults.standardUserDefaults().setBoolForKey(
      false,
      "marginnote_agent_panel_visible",
    );
    if (study) study.refreshAddonCommands();
  }

  var MarginNoteAgentAddon = JSB.defineClass(
    "MarginNoteAgentAddon : JSExtension",
    {
      sceneWillConnect: function () {
        var addon = self;
        NSUserDefaults.standardUserDefaults().removeObjectForKey(
          "marginnote_agent_last_panel_error",
        );
        addon.panelController = AgentPanelController.new();
        MNAgentBridge.start(addon);
      },

      sceneDidDisconnect: function () {
        MNAgentBridge.stop();
      },

      notebookWillOpen: function () {
        var addon = self;
        NSTimer.scheduledTimerWithTimeInterval(0.2, false, function () {
          var visible = NSUserDefaults.standardUserDefaults().boolForKey(
            "marginnote_agent_panel_visible",
          );
          if (visible) showAgentPanel(addon);
        });
      },

      controllerWillLayoutSubviews: function (controller) {
        var study = Application.sharedInstance().studyController(self.window);
        if (controller === study) layoutPanel(self);
      },

      queryAddonCommandStatus: function () {
        return {
          image: "icon.png",
          object: self,
          selector: "toggleAgentPanel:",
          checked: Boolean(self.panelController && self.panelController.view.window),
        };
      },

      toggleAgentPanel: function (sender) {
        try {
          if (self.panelController && self.panelController.view.window) hideAgentPanel(self);
          else showAgentPanel(self);
        } catch (error) {
          var message = String(error && error.message ? error.message : error);
          NSUserDefaults.standardUserDefaults().setObjectForKey(
            message,
            "marginnote_agent_last_panel_error",
          );
          Application.sharedInstance().showHUD("MarginNote Agent: " + message, self.window, 4);
        }
      },
    },
    {},
  );

  return MarginNoteAgentAddon;
};
