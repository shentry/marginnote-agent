JSB.newAddon = function (mainPath) {
  JSB.require("config");
  JSB.require("network");
  JSB.require("tools");
  JSB.require("bridge");
  JSB.require("AgentPanelController");

  function nativePanelHost(study) {
    try {
      var controller = study.extensionPanelController;
      if (!controller || !controller.view || typeof study.toggleExtensionPanel !== "function") {
        return null;
      }
      return controller;
    } catch (error) {
      return null;
    }
  }

  function nativePanelIsVisible(controller) {
    if (!controller || !controller.view) return false;
    var view = controller.view;
    return Boolean(
      view.window &&
        !view.hidden &&
        Number(view.bounds.width) > 1 &&
        Number(view.bounds.height) > 1,
    );
  }

  function observePanelHost(addon) {
    var visible = nativePanelIsVisible(addon.panelHostController);
    if (addon.panelHostWasVisible && !visible) addon.panelOpenedHost = false;
    addon.panelHostWasVisible = visible;
    return visible;
  }

  function acquireNativePanelHost(study) {
    var controller = nativePanelHost(study);
    var openedHost = false;
    if (!nativePanelIsVisible(controller)) {
      study.toggleExtensionPanel();
      openedHost = true;
      controller = nativePanelHost(study);
    }
    if (!controller) throw new Error("MarginNote 原生扩展侧栏不可用");
    return { controller: controller, openedHost: openedHost };
  }

  function layoutPanel(addon) {
    if (!addon.panelController || !addon.panelHostController) return;
    observePanelHost(addon);
    if (addon.panelController.view.superview !== addon.panelHostController.view) return;
    var bounds = addon.panelHostController.view.bounds;
    addon.panelController.view.frame = {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Math.max(0, Number(bounds.width) || 0),
      height: Math.max(0, Number(bounds.height) || 0),
    };
  }

  function detachAgentPanel(addon) {
    var shouldCloseHost = Boolean(
      addon.panelOpenedHost &&
      addon.panelStudyController &&
      observePanelHost(addon)
    );
    if (addon.panelController && addon.panelController.view.superview) {
      addon.panelController.view.removeFromSuperview();
    }
    if (shouldCloseHost) addon.panelStudyController.toggleExtensionPanel();
    addon.panelVisible = false;
    addon.panelOpenedHost = false;
    addon.panelHostWasVisible = false;
    addon.panelStudyController = null;
    addon.panelHostController = null;
  }

  function agentPanelIsVisible(addon) {
    return Boolean(
      addon.panelVisible &&
        addon.panelController &&
        addon.panelHostController &&
        addon.panelController.view.superview === addon.panelHostController.view &&
        observePanelHost(addon),
    );
  }

  function scheduleHostReconnect(addon, delay) {
    NSTimer.scheduledTimerWithTimeInterval(delay, false, function () {
      if (!agentPanelIsVisible(addon)) return;
      if (typeof addon.panelController.ensureHostLoaded === "function") {
        addon.panelController.ensureHostLoaded();
      }
    });
  }

  function restoreVisiblePanel(addon) {
    if (!addon.panelController || !addon.window) return;
    var visible = NSUserDefaults.standardUserDefaults().boolForKey(
      "marginnote_agent_panel_visible",
    );
    if (!visible || agentPanelIsVisible(addon)) return;
    try {
      showAgentPanel(addon);
    } catch (error) {
      var message = String(error && error.message ? error.message : error);
      NSUserDefaults.standardUserDefaults().setObjectForKey(
        message,
        "marginnote_agent_last_panel_error",
      );
    }
  }

  function schedulePanelRestore(addon, delay) {
    NSTimer.scheduledTimerWithTimeInterval(delay, false, function () {
      restoreVisiblePanel(addon);
    });
  }

  function showAgentPanel(addon) {
    var study = Application.sharedInstance().studyController(addon.window);
    if (!study || !addon.panelController) return;
    var nativePanel = acquireNativePanelHost(study);
    var hostController = nativePanel.controller;

    if (
      addon.panelController.view.superview &&
      addon.panelController.view.superview !== hostController.view
    ) {
      detachAgentPanel(addon);
    }

    addon.panelStudyController = study;
    addon.panelHostController = hostController;
    addon.panelOpenedHost = nativePanel.openedHost;
    addon.panelHostWasVisible = nativePanelIsVisible(hostController);
    addon.panelVisible = true;
    addon.panelController.view.autoresizingMask = 1 << 1 | 1 << 4;
    if (addon.panelController.view.superview !== hostController.view) {
      hostController.view.addSubview(addon.panelController.view);
    }
    layoutPanel(addon);
    if (typeof addon.panelController.ensureHostLoaded === "function") {
      addon.panelController.ensureHostLoaded();
    }
    NSTimer.scheduledTimerWithTimeInterval(0.05, false, function () {
      layoutPanel(addon);
    });
    scheduleHostReconnect(addon, 1);
    scheduleHostReconnect(addon, 3);
    scheduleHostReconnect(addon, 6);
    NSUserDefaults.standardUserDefaults().setBoolForKey(
      true,
      "marginnote_agent_panel_visible",
    );
    study.refreshAddonCommands();
  }

  function hideAgentPanel(addon) {
    var study = Application.sharedInstance().studyController(addon.window);
    detachAgentPanel(addon);
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
        detachAgentPanel(self);
        self.panelController = null;
        MNAgentBridge.stop();
      },

      notebookWillOpen: function () {
        var addon = self;
        schedulePanelRestore(addon, 0.2);
        schedulePanelRestore(addon, 0.8);
        schedulePanelRestore(addon, 2);
        schedulePanelRestore(addon, 4);
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
          checked: agentPanelIsVisible(self),
        };
      },

      toggleAgentPanel: function (sender) {
        try {
          if (agentPanelIsVisible(self)) hideAgentPanel(self);
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
