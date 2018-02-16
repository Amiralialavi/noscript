var RequestGuard = (() => {
  'use strict';
  const VERSION_LABEL =  `NoScript ${browser.runtime.getManifest().version}`;
  browser.browserAction.setTitle({title: VERSION_LABEL});
  const REPORT_URI = "https://noscript-csp.invalid/__NoScript_Probe__/";
  const REPORT_GROUP = "NoScript-Endpoint";
  const REPORT_TO = {
    name: "Report-To",
    value: JSON.stringify({ "url": REPORT_URI,
             "group": REPORT_GROUP,
             "max-age": 10886400 }),
  };
  const CSP = {
    name: "content-security-policy",
    start: `report-uri ${REPORT_URI};`,
    end: `;report-to ${REPORT_URI};`,
    isMine(header) {
      let {name, value} = header;
      return name.toLowerCase() === CSP.name &&
        value.startsWith(this.start) && value.endsWith(this.end);
    },
    create(...directives) {
      return `${this.start}${directives.join(';')}${this.end}`;
    },
    createBlocker(...types) {
        return this.create(...(types.map(type => `${type}-src 'none'`)));
    },
    blocks(header, type) {
      return header.includes(`;${type}-src 'none';`)
    },
    types: ["script", "object", "media"],
  };



  const policyTypesMap = {
      main_frame:  "",
      sub_frame: "frame",
      script: "script",
      xslt: "script",
      xbl: "script",
      font: "font",
      object: "object",
      object_subrequest: "fetch",
      xmlhttprequest: "fetch",
      ping: "ping",
      beacon: "ping",
      media: "media",
      other: "",
  };

  const TabStatus = {
    map: new Map(),
    types: ["script", "object", "media", "frame", "font"],
    newRecords() {
      return {
        allowed: {},
        blocked: {},
        noscriptFrames: {},
      }
    },

    initTab(tabId, records = this.newRecords()) {
      this.map.set(tabId, records);
      return records;
    },

    _record(request, what, optValue) {
      let {tabId, frameId, type, url, documentUrl} = request;
      let policyType = policyTypesMap[type] || type;
      let requestKey = Policy.requestKey(url, documentUrl, policyType);
      let map = this.map;
      let records;
      if (map.has(tabId)) {
        records = map.get(tabId);
      } else {
        records = this.initTab(tabId);
      }

      if (what === "noscriptFrame") {
        let nsf = records.noscriptFrames;
        if (frameId in nsf) {
          return null;
        }
        nsf[frameId] = optValue;
        what = optValue ? "blocked" : "allowed";
        if (frameId === 0) {
          request.type = type = "main_frame";
          Content.reportTo(request, type, type);
        }
      }
      let collection = records[what];
      if (type in collection) {
        collection[type].push(requestKey);
      } else {
        collection[type] = [requestKey];
      }
      return records;
    },

    record(request, what, optValue) {
      let records = this._record(request, what, optValue);
      if (records) {
        this.updateTab(request.tabId);
      }
    },

    _pendingTabs: new Set(),

    updateTab(tabId) {
      if (this._pendingTabs.size === 0) {
        window.setTimeout(() => { // clamp UI updates
          for (let tabId of this._pendingTabs) {
            this._updateTabNow(tabId);
          }
          this._pendingTabs.clear();
        }, 200);
      }
      this._pendingTabs.add(tabId);
    },
    _updateTabNow(tabId) {
      this._pendingTabs.delete(tabId);
      let records = this.map.get(tabId) || this.initTab(tabId);
      let {allowed, blocked, noscriptFrames} = records;
      let topAllowed = !(noscriptFrames && noscriptFrames[0]);

      let numAllowed = 0, numBlocked = 0, sum = 0;
      let report = this.types.map(t => {
        let a = allowed[t] && allowed[t].length || 0, b = blocked[t] && blocked[t].length || 0, s = a + b;
        numAllowed+= a, numBlocked += b, sum += s;
        return s && `<${t === "sub_frame" ? "frame" : t}>: ${b}/${s}`;
      }).filter(s => s).join("\n");


      let icon = topAllowed ?
        (numBlocked ? "part"
          : ns.policy.enforced ? "yes" : "global")
        : (numAllowed ? "sub" : "no");
      let showBadge = ns.local.showCountBadge && numBlocked > 0;

      let browserAction = browser.browserAction;
      browserAction.setIcon({tabId, path: {64: `/img/ui-${icon}64.png`}});
      browserAction.setBadgeText({tabId, text: showBadge ? numBlocked.toString() : ""});
      browserAction.setBadgeBackgroundColor({tabId, color: [255, 0, 0, 128]});
      browserAction.setTitle({tabId,
        title: `${VERSION_LABEL} \n${ns.policy.enforced ?
            _("BlockedItems", [numBlocked, numAllowed + numBlocked]) + ` \n${report}`
            : _("GloballyEnabled")}`
      });
    },

    totalize(sum, value) {
      return sum + value;
    },

    async probe(tabId) {
      if (tabId === undefined) {
        (await browser.tabs.query({})).forEach(tab => TabStatus.probe(tab.id));
      } else {
        try {
          TabStatus.recordAll(tabId, await ns.collectSeen(tabId));
        } catch (e) {
          error(e);
        }
      }
    },

    recordAll(tabId, seen) {
      if (seen) {
        let records = TabStatus.map.get(tabId);
        if (records) {
          records.allowed = {};
          records.blocked = {};
        }
        for (let thing of seen) {
          thing.request.tabId = tabId;
          TabStatus._record(thing.request, thing.allowed ? "allowed" : "blocked");
        }
        this._updateTabNow(tabId);
      }
    },

    async onActivatedTab(info) {
      let {tabId} = info;
      let seen = await ns.collectSeen(tabId);

      TabStatus.recordAll(tabId, seen);
    },
    onRemovedTab(tabId) {
      TabStatus.map.delete(tabId);
    },
  }
  browser.tabs.onActivated.addListener(TabStatus.onActivatedTab);
  browser.tabs.onRemoved.addListener(TabStatus.onRemovedTab);

  if (!("setIcon" in browser.browserAction)) { // unsupported on Android
    TabStatus._updateTabNow = TabStatus.updateTab = () => {};
  }

  const Content = {


    async hearFrom(message, sender) {
      debug("Received message from content", message, sender);
      switch (message.type) {
        case "pageshow":
          TabStatus.recordAll(sender.tab.id, message.seen);
          return true;
        case "enable":
          let {url, documentUrl, policyType} = message;
          let TAG = `<${policyType.toUpperCase()}>`;
          let origin = Sites.origin(url);
          // let parsedDoc = Sites.parse(documentUrl);
          let t = u => `${TAG}@${u}`;
          let ret = await Prompts.prompt({
            title: _("BlockedObjects"),
            message: _("allowLocal", TAG),
            options: [
                {label: _("allowLocal", url), checked: true},
                {label: _("allowLocal", origin)},
            ]});
          debug(`Prompt returned %o`);
          if (ret.button !== 0) return;
          let key = [url, origin][ret.option];
          if (!key) return;
          let {siteMatch, contextMatch, perms} = ns.policy.get(key, documentUrl);
          let {capabilities} = perms;
          if (!capabilities.has(policyType)) {
            perms = new Permissions(new Set(capabilities), false);
            perms.capabilities.add(policyType);

            /* TODO: handle contextual permissions
            if (documentUrl) {
              let context = new URL(documentUrl).origin;
              let contextualSites = new Sites([context, perms]);
              perms = new Permissions(new Set(capabilities), false, contextualSites);
            }
            */
            ns.policy.set(key, perms);
            ns.savePolicy();
          }
          return true;
          case "canScript":
            let records = TabStatus.map.get(sender.tab.id);
            debug("Records.noscriptFrames %o, canScript: %s", records && records.noscriptFrames, !(records && records.noscriptFrames[sender.frameId]));
            return !(records && records.noscriptFrames[sender.frameId]);
      }
    },

    async reportTo(request, allowed, policyType) {
      let {requestId, tabId, frameId, type, url, documentUrl, originUrl} = request;
      let pending = pendingRequests.get(requestId); // null if from a CSP report
      let initialUrl = pending ? pending.initialUrl : request.url;
      request = {requestId, tabId, frameId, type,
          url, documentUrl, originUrl, initialUrl};

      browser.tabs.sendMessage(
        tabId,
        {type: "seen", request, allowed, policyType, ownFrame: true},
        {frameId}
      );
      if (frameId === 0) return;

      browser.tabs.sendMessage(
        request.tabId,
        {type: "seen", request, allowed, policyType},
        {frameId: 0}
      );
    }
  };
  browser.runtime.onMessage.addListener(Content.hearFrom);



  const pendingRequests = new Map();
  function initPendingRequest(request) {
    let {requestId, url} = request;
    let redirected = pendingRequests.get(requestId);
    let initialUrl = redirected ? redirected.initialUrl : url;
    pendingRequests.set(requestId, {
      url, redirected,
      onCompleted: new Set(),
    });
  }


  const ABORT = {cancel: true}, ALLOW = {};
  const listeners = {
    onBeforeRequest(request) {
      try {
        initPendingRequest(request);
        let policy = ns.policy;
        if (policy.enforced) {
          let policyType = policyTypesMap[request.type];
          if (policyType) {
            let {url, originUrl, documentUrl} = request;
            if (("fetch" === policyType || "frame" === policyType) &&
              (url === originUrl && originUrl === documentUrl ||
                /^(?:chrome|resource|moz-extension|about):/.test(originUrl))
            ) {
              // livemark request or similar browser-internal, always allow;
              return ALLOW;
            }

            let allowed = policy.can(url, policyType, originUrl);
            Content.reportTo(request, allowed, policyType);

            if (!allowed) {
              debug(`Blocking ${policyType}`, request);
              TabStatus.record(request, "blocked");
              return ABORT;
            }
          }
        }
      } catch (e) {
        error(e);
      }

      return ALLOW;
    },

    onHeadersReceived(request) {
      // called for main_frame, sub_frame and object
      debug("onHeadersReceived", request);

      try {
        let header, blocker;
        let responseHeaders = request.responseHeaders;
        let content = {}
        for (let h of responseHeaders) {
          if (CSP.isMine(h)) {
            header = h;
            h.value = "";
          } else if (/^\s*Content-(Type|Disposition)\s*$/i.test(h.name)) {
            content[h.name.split("-")[1].trim().toLowerCase()] = h.value;
          }
        }

        let policy = ns.policy;
        if (policy.enforced) {
          let perms = policy.get(request.url, request.documentUrl).perms;
          if (policy.autoAllowTop && request.frameId === 0 && perms === policy.DEFAULT) {
            policy.set(Sites.optimalKey(request.url), perms = policy.TRUSTED.tempTwin);
          }

          let {capabilities} = perms;
          let canScript = capabilities.has("script");

          let blockedTypes;
          if (!content.disposition &&
            (!content.type || /^\s*(?:video|audio|application)\//.test(content.type))) {
            debug(`Suspicious content type "%s" in request %o with capabilities %o`,
              content.type, request, capabilities);
            blockedTypes = CSP.types.filter(t => !capabilities.has(t));
          } else if(!canScript) {
            blockedTypes = ["script"];
          }
          if (blockedTypes && blockedTypes.length) {
            blocker = CSP.createBlocker(...blockedTypes);
          }
        }

        if (blocker) {
          if (header) {
            header.value = blocker;
          } else {
            header = {name: CSP.name, value: blocker};
            responseHeaders.push(header);
          }
        }

        if (header) return {responseHeaders};
      } catch (e) {
        error(e, "Error in onHeadersReceived", uneval(request));
      }
      return ALLOW;
    },

    onResponseStarted(request) {
      if (request.type === "main_frame") {
        TabStatus.initTab(request.tabId);
      }
      let scriptBlocked = request.responseHeaders.some(
        h => CSP.isMine(h) && CSP.blocks(h.value, "script")
      );
      debug("%s scriptBlocked=%s setting noscriptFrame on ", request.url, scriptBlocked, request.tabId, request.frameId);
      TabStatus.record(request, "noscriptFrame", scriptBlocked);
      pendingRequests.get(request.requestId).scriptBlocked = scriptBlocked;
    },

    onCompleted(request) {
      let {requestId} = request;
      if (pendingRequests.has(requestId)) {
        let r = pendingRequests.get(requestId);
        pendingRequests.delete(requestId);
        for (let callback of r.onCompleted) {
          try {
            callback(request, r);
          } catch (e) {
            error(e);
          }
        }
      }
    },

    onErrorOccurred(request) {
      pendingRequests.delete(request.requestId);
    }
  };

  function fakeRequestFromCSP(report, request) {
    let type = report["violated-directive"].split("-", 1)[0]; // e.g. script-src 'none' => script
    if (type === "frame") type = "sub_frame";
    let url = report['blocked-uri'];
    if (url === 'self') url = request.documentUrl;
    return Object.assign({}, request, {
      url,
      type,
    });
  }

  async function onViolationReport(request) {
    try {
      let decoder = new TextDecoder("UTF-8");
      const report = JSON.parse(decoder.decode(request.requestBody.raw[0].bytes))['csp-report'];
      let csp = report["original-policy"]
      debug("CSP report", report);
      if (report['blocked-uri'] !== 'self') {
        let r = fakeRequestFromCSP(report, request);
        Content.reportTo(r, false, policyTypesMap[r.type]);
        TabStatus.record(r, "blocked");
      } else if (report["violated-directive"] === "script-src 'none'") {
        let r =  fakeRequestFromCSP(report, request);
        TabStatus.record(r, "noscriptFrame", true);
      }
    } catch(e) {
      error(e);
    }
    return ABORT;
  }

  const RequestGuard = {
    async start() {
      let wr = browser.webRequest;
      let listen = (what, ...args) => wr[what].addListener(listeners[what], ...args);

      let allTypes = Object.keys(policyTypesMap);
      let allUrls = ["<all_urls>"];
      let docTypes = ["main_frame", "sub_frame", "object"];

      listen("onBeforeRequest",
        {urls: allUrls, types: allTypes},
        ["blocking"]
      );
      listen("onHeadersReceived",
        {urls: allUrls, types: docTypes},
        ["blocking", "responseHeaders"]
      );
      listen("onResponseStarted",
        {urls: allUrls, types: docTypes},
        ["responseHeaders"]
      );
      listen("onCompleted",
        {urls: allUrls, types: allTypes},
      );
      listen("onErrorOccurred",
        {urls: allUrls, types: allTypes},
      );


      wr.onBeforeRequest.addListener(onViolationReport,
        {urls: [REPORT_URI], types: ["csp_report"]}, ["blocking", "requestBody"]);

      TabStatus.probe();
    },

    stop() {
      let wr = browser.webRequest;
      for (let [name, listener] of Object.entries(this.listeners)) {
        wr[name].removeListener(listener);
      }
      wr.onBeforeRequest.removeListener(onViolationReport);
    }
  };

  return RequestGuard;
})();
