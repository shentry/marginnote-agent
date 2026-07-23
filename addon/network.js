var MNAgentHTTP = {
  isNil: function (value) {
    if (value === null || typeof value === "undefined") return true;
    try {
      return typeof NSNull !== "undefined" && value instanceof NSNull;
    } catch (error) {
      return false;
    }
  },

  request: function (path, method, body, callback) {
    var url = NSURL.URLWithString(MN_AGENT_BASE_URL + path);
    var request = NSMutableURLRequest.requestWithURL(url);
    request.setHTTPMethod(method || "GET");
    request.setTimeoutInterval(5);
    request.setValueForHTTPHeaderField("application/json", "Accept");
    request.setValueForHTTPHeaderField("MarginNote-Agent-Addon", "X-MN-Agent-Client");

    if (body !== null && typeof body !== "undefined") {
      request.setValueForHTTPHeaderField("application/json", "Content-Type");
      var bodyData = NSData.dataWithStringEncoding(JSON.stringify(body), 4);
      if (!bodyData) throw new Error("Failed to encode request body");
      request.setHTTPBody(bodyData);
    }

    NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(
      request,
      NSOperationQueue.mainQueue(),
      function (response, data, error) {
        if (!MNAgentHTTP.isNil(error)) {
          var description = error.localizedDescription;
          if (typeof description === "function") description = description.call(error);
          callback(new Error(String(description || "Network request failed")), null, 0);
          return;
        }

        var status = 0;
        if (!MNAgentHTTP.isNil(response) && typeof response.statusCode === "function") {
          status = response.statusCode();
        }
        var payload = {};
        if (!MNAgentHTTP.isNil(data) && typeof data.length === "function" && data.length() > 0) {
          try {
            var responseText = String(NSString.stringWithContentsOfData(data) || "");
            payload = responseText ? JSON.parse(responseText) : {};
          } catch (parseError) {
            callback(parseError, null, status);
            return;
          }
        }

        if (status >= 400) {
          callback(new Error(String(payload.error || "HTTP " + status)), payload, status);
          return;
        }
        callback(null, payload, status);
      },
    );
  },

  get: function (path, callback) {
    this.request(path, "GET", null, callback);
  },

  post: function (path, body, callback) {
    this.request(path, "POST", body, callback);
  },
};
