INCLUDE("DNS");

const IO = {
  readFile: function(file, charset) {
    var res;
    
    const is = CC["@mozilla.org/network/file-input-stream;1"]
      .createInstance(CI.nsIFileInputStream );
    is.init(file ,0x01, 0400, null);
    const sis = CC["@mozilla.org/scriptableinputstream;1"]
      .createInstance(CI.nsIScriptableInputStream);
    sis.init(is);
    
    res = sis.read(sis.available());
    is.close();
    
    if (charset !== null) { // use "null" if you want uncoverted data...
      const unicodeConverter = CC["@mozilla.org/intl/scriptableunicodeconverter"]
        .createInstance(CI.nsIScriptableUnicodeConverter);
      try {
        unicodeConverter.charset = charset || "UTF-8";
      } catch(ex) {
        unicodeConverter.charset = "UTF-8";
      }
      res = unicodeConverter.ConvertToUnicode(res);
    }
  
    return res;
  },
  writeFile: function(file, content, charset) {
    const unicodeConverter = CC["@mozilla.org/intl/scriptableunicodeconverter"]
      .createInstance(CI.nsIScriptableUnicodeConverter);
    try {
      unicodeConverter.charset = charset || "UTF-8";
    } catch(ex) {
      unicodeConverter.charset = "UTF-8";
    }
    
    content = unicodeConverter.ConvertFromUnicode(content);
    const os = CC["@mozilla.org/network/file-output-stream;1"]
      .createInstance(CI.nsIFileOutputStream);
    os.init(file, 0x02 | 0x08 | 0x20, 0700, 0);
    os.write(content, content.length);
    os.close();
  }
};


function nsISupportWrapper(wrapped) {
  this.wr\u0061ppedJSObject = wrapped;
}
nsISupportWrapper.prototype = {
  QueryInterface: xpcom_generateQI([CI.nsISupports])
}

const IOUtil = {
  asyncNetworking: true,
  proxiedDNS: 0,

  attachToChannel: function(channel, key, requestInfo) {
    if (channel instanceof CI.nsIWritablePropertyBag2) 
      channel.setPropertyAsInterface(key, new nsISupportWrapper(requestInfo));
  },
  extractFromChannel: function(channel, key, preserve) {
    if (channel instanceof CI.nsIPropertyBag2) {
      try {
        var requestInfo = channel.getPropertyAsInterface(key, CI.nsISupports);
        if (requestInfo) {
          if(!preserve && (channel instanceof CI.nsIWritablePropertyBag)) channel.deleteProperty(key);
          return requestInfo.wr\u0061ppedJSObject;
        }
      } catch(e) {}
    }
    return null;
  },

  extractInternalReferrer: function(channel) {
    if (channel instanceof CI.nsIPropertyBag2) try {
      return channel.getPropertyAsInterface("docshell.internalReferrer", CI.nsIURL);
    } catch(e) {}
    return null;
  },
  extractInternalReferrerSpec: function(channel) {
    var ref = this.extractInternalReferrer(channel);
    return ref && ref.spec || null;
  },
  
  getProxyInfo: function(channel) {
    return CI.nsIProxiedChannel && (channel instanceof CI.nsIProxiedChannel) 
    ? channel.proxyInfo
    : Components.classes["@mozilla.org/network/protocol-proxy-service;1"]
        .getService(Components.interfaces.nsIProtocolProxyService)
        .resolve(channel.URI, 0);
  },
  
  
  canDoDNS: function(channel) {
    if (!channel || IOS.offline) return false;
    
    var proxyInfo = this.getProxyInfo(channel);
    switch(this.proxiedDNS) {
      case 1:
        return proxyInfo && (proxyInfo.flags & CI.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST);
      case 2:
        return true;
      default:
        return !proxyInfo || proxyInfo.type == "direct";   
    }

  },
  
  abort: function(channel, noNetwork) {
    if (noNetwork && !ChannelReplacement.supported) {
      // this is for Gecko 1.1 which doesn't allow us to cancel in asyncOpen()
      channel.loadFlags |= CI.nsICachingChannel.LOAD_ONLY_FROM_CACHE; 
    }
    channel.cancel(Components.results.NS_ERROR_ABORT);
  },
  
  findWindow: function(channel) {
    for each(var cb in [channel.notificationCallbacks,
                       channel.loadGroup && channel.loadGroup.notificationCallbacks]) {
      if (cb instanceof CI.nsIInterfaceRequestor) {
        if (CI.nsILoadContext) try {
        // For Gecko 1.9.1
          return cb.getInterface(CI.nsILoadContext).associatedWindow;
        } catch(e) {}
        
        try {
          // For Gecko 1.9.0
          return cb.getInterface(CI.nsIDOMWindow);
        } catch(e) {}
      }
    }
    return null;
  },
  
  readFile: IO.readFile,
  writeFile: IO.writeFile,
  
  unwrapURL: function(url) {
    
    try {
      if (!(url instanceof CI.nsIURI))
        url = IOS.newURI(url, null, null);
      
      switch (url.scheme) {
        case "view-source":
          return this.unwrapURL(url.path);
        case "wyciwyg":
          return this.unwrapURL(url.path.replace(/^\/\/\d+\//, ""));
        case "jar":
          if (url instanceof CI.nsIJARURI)
            return this.unwrapURL(url.JARFile);
      }
    }
    catch (e) {}
    
    return url;
  },
  
  
  get _channelFlags() {
    delete this._channelFlags;
    var ff = {};
    [CI.nsIHttpChannel, CI.nsICachingChannel].forEach(function(c) {
      for (var p in c) {
        if (/^[A-Z_]+$/.test(p)) ff[p] = c[p];
      }
    });
    return this._channelFlags = ff;
  },
  humanFlags: function(loadFlags) {
    var hf = [];
    var c = this._channelFlags;
    for (var p in c) {
      if (loadFlags & c[p]) hf.push(p + "=" + c[p]);
    }
    return hf.join("\n");
  },
  
  queryNotificationCallbacks: function(chan, iid) {
    var cb;
    try {
      cb = chan.notificationCallbacks.getInterface(iid);
      if (cb) return cb;
    } catch(e) {}
    
    try {
      return chan.loadGroup && chan.loadGroup.notificationCallbacks.getInterface(iid);
    } catch(e) {}
    
    return null;
  },
  
 
  anonymizeURI: function(uri, cookie) {
    if (uri instanceof CI.nsIURL) {
      uri.query = this.anonymizeQS(uri.query, cookie);
    } else return this.anonymizeURL(uri, cookie);
    return uri;
  },
  anonymizeURL: function(url, cookie) {
    var parts = url.split("?");
    if (parts.length < 2) return url;
    parts[1] = this.anonymizeQS(parts[1], cookie);
    return parts.join("?");
  },
  anonymizeQS: function(qs, cookie) {
    if (!qs) return qs;
    if (!/[&=]/.test(qs)) return '';
    
    var cookieNames, hasCookies;
    if ((hasCookies = !!cookie)) {
      cookieNames = cookie.split(/\s*;\s*/).map(function(nv) {
        return nv.split("=")[0];
      })
    }
    
    var parms = qs.split("&");
    var nv, name;
    for (var j = parms.length; j-- > 0;) {
      nv = parms[j].split("=");
      name = nv[0];
      if (/(?:auth|s\w+(?:id|key)$)/.test(name) || cookie && cookieNames.indexOf(name) > -1)
        parms.splice(j, 1);
    }
    return parms.join("&");
  },
  
  runWhenPending: function(channel, callback) {
    if (channel.isPending()) {
      callback();
      return false;
    } else {
      new LoadGroupWrapper(channel, {
        addRequest: function(r, ctx) {
          callback();
        }
      });
      return true;
    }
  }
  
};

function CtxCapturingListener(tracingChannel, notify) {
  this.originalListener = tracingChannel.setNewListener(this);
  if (notify) this.notify = true;
}
CtxCapturingListener.prototype = {
  originalListener: null,
  originalCtx: null,
  notify: false,
  onDataAvailable: function(request, context, inputStream, offset, count) {
    this.originalCtx = context;
  },
  onStartRequest: function(request, context) {
    this.originalCtx = context;
    if (this.notify) this.originalListener.onStartRequest(request, context);
  },
  onStopRequest: function(request, context, statusCode) {
    this.originalCtx = context;
    if (this.notify) this.originalListener.onStopRequest(request, context, statusCode);
  },
  QueryInterface: function (aIID) {
    if (aIID.equals(CI.nsIStreamListener) ||
        aIID.equals(CI.nsISupports)) {
        return this;
    }
    throw Components.results.NS_NOINTERFACE;
  }
}

function ChannelReplacement(chan, newURI, newMethod) {
  return this._init(chan, newURI, newMethod);
}

ChannelReplacement.supported = "nsITraceableChannel" in CI;

ChannelReplacement.prototype = {
  listener: null,
  context: null,
  _ccListener: null,
  oldChannel: null,
  channel: null,
  window: null,
  get _unsupportedError() {
    return new Error("Can't replace channels without nsITraceableChannel!");
  },
  
  _init: function(chan, newURI, newMethod) {
    if (!(ChannelReplacement.supported && chan instanceof CI.nsITraceableChannel))
      throw this._unsupportedError;
  
    newURI = newURI || chan.URI;
    
    var newChan = IOS.newChannelFromURI(newURI);
    
    // porting of http://mxr.mozilla.org/mozilla-central/source/netwerk/protocol/http/src/nsHttpChannel.cpp#2750
    
    var loadFlags = chan.loadFlags;
    if (chan.URI.schemeIs("https"))
      loadFlags &= ~chan.INHIBIT_PERSISTENT_CACHING;
    
    
    newChan.loadGroup = chan.loadGroup;
    newChan.notificationCallbacks = chan.notificationCallbacks;
    newChan.loadFlags = loadFlags;
    
    if (!(newChan instanceof CI.nsIHttpChannel))
      return newChan;
    
    if (!newMethod) {
      if (newChan instanceof CI.nsIUploadChannel && chan instanceof CI.nsIUploadChannel && chan.uploadStream ) {
        var stream = chan.uploadStream;
        if (stream instanceof CI.nsISeekableStream) {
          stream.seek(stream.NS_SEEK_SET, 0);
        }
        
        try {
          var ctype = newChan.getRequestHeader("Content-type");
          var clen = newChan.getRequestHeader("Content-length");
          if (ctype && clen) {
            newChan.setUploadStream(stream, ctype, parseInt(clen));
          }
        } catch(e) {
          newChan.setUploadStream(stream, '', -1);
        }
        
        newChan.requestMethod = chan.requestMethod;
      }
    } else {
      newChan.method = newMethod;
    }
    
    if (chan.referrer) newChan.referrer = chan.referrer;
    newChan.allowPipelining = chan.allowPipelining;
    newChan.redirectionLimit = chan.redirectionLimit - 1;
    if (chan instanceof CI.nsIHttpChannelInternal && newChan instanceof CI.nsIHttpChannelInternal) {
      if (chan.URI == chan.documentURI) {
        newChan.documentURI = newURI;
      } else {
        newChan.documentURI = chan.documentURI;
      }
    }
    
    if (chan instanceof CI.nsIEncodedChannel && newChan instanceof CI.nsIEncodedChannel) {
      newChan.applyConversion = chan.applyConversion;
    }
    
    // we can't transfer resume information because we can't access mStartPos and mEntityID :(
    // http://mxr.mozilla.org/mozilla-central/source/netwerk/protocol/http/src/nsHttpChannel.cpp#2826
    
    if ("nsIApplicationCacheChannel" in CI &&
      chan instanceof CI.nsIApplicationCacheChannel && newChan instanceof CI.nsIApplicationCacheChannel) {
      newChan.applicationCache = chan.applicationCache;
      newChan.inheritApplicationCache = chan.inheritApplicationCache;
    }
    
    if (chan instanceof CI.nsIPropertyBag && newChan instanceof CI.nsIWritablePropertyBag) 
      for (var properties = chan.enumerator, p; properties.hasMoreElements();)
        if ((p = properties.getNext()) instanceof CI.nsIProperty)
          newChan.setProperty(p.name, p.value);
    
    this.oldChannel = chan;
    this.channel = newChan;
    
    if (chan.loadFlags & chan.LOAD_DOCUMENT_URI) {
      this.window = IOUtil.findWindow(chan);
    }
    
    return this;
  },
  
  _onChannelRedirect: function(trueRedir) {
    var oldChan = this.oldChannel;
    var newChan = this.channel;
    
    if (trueRedir && oldChan.redirectionLimit === 0) {
      oldChan.cancel(NS_ERROR_REDIRECT_LOOP);
      throw NS_ERROR_REDIRECT_LOOP;
    }
    
    newChan.loadFlags |= newChan.LOAD_REPLACE;
    // nsHttpHandler::OnChannelRedirect()
    const CES = CI.nsIChannelEventSink;
    const flags = CES.REDIRECT_INTERNAL;
    CC["@mozilla.org/netwerk/global-channel-event-sink;1"].getService(CES)
      .onChannelRedirect(oldChan, newChan, flags);
    var ces;
    for (var cess = CC['@mozilla.org/categorymanager;1'].getService(CI.nsICategoryManager)
              .enumerateCategory("net-channel-event-sinks");
        cess.hasMoreElements();) {
      ces = cess.getNext();
      if (ces instanceof CES)
        ces.onChannelRedirect(oldChan, newChan, flags);
    }
    ces = IOUtil.queryNotificationCallbacks(oldChan, CES);
    if (ces) ces.onChannelRedirect(oldChan, newChan, flags);
    // ----------------------------------
    
    newChan.originalURI = oldChan.originalURI;
    
    ces =  IOUtil.queryNotificationCallbacks(oldChan, CI.nsIHttpEventSink);
    if (ces) ces.onRedirect(oldChan, newChan);
    
  },
  
  replace: function(isRedir) {
    
    this._onChannelRedirect(isRedir);
    
    // dirty trick to grab listenerContext
    var oldChan = this.oldChannel;
    
    var ccl = new CtxCapturingListener(oldChan);
    
    oldChan.cancel(NS_BINDING_REDIRECTED); // this works because we've been called after loadGroup->addRequest(), therefore asyncOpen() always return NS_OK
    
    oldChan.notificationCallbacks =
        oldChan.loadGroup = null; // prevent loadGroup removal and wheel stop
    
    if (oldChan instanceof CI.nsIRequestObserver) {
      oldChan.onStartRequest(oldChan, null);
    }

    this.listener = ccl.originalListener;
    this.context = ccl.originalCtx;
    this._ccListener = ccl;
    
    return this;
  },
  
  open: function() {
    var oldChan = this.oldChannel, newChan = this.channel;

    var overlap, fail = false;
    
    if (!(this.window && (overlap = ABERequest.getLoadingChannel(this.window)) !== oldChan)) {
      try {
        if (ABE.consoleDump && this.window) {
          ABE.log("Opening delayed channel: " + oldChan.name + " - (current loading channel for this window " + (overlap && overlap.name) + ")");
        }

        newChan.asyncOpen(this.listener, this.context);
        
        // safe browsing hook
        try {
          CC["@mozilla.org/channelclassifier"].createInstance(CI.nsIChannelClassifier).start(newChan, true);
        } catch (e) {
          // may throw if host app doesn't implement url classification
        }
      } catch (e) {
        // redirect failed: we must notify the original channel litener, so let's restore bindings
        fail = true;
      }
    } else {
      if (ABE.consoleDump) {
        ABE.log("Detected double load on the same window: " + oldChan.name + " - " + (overlap && overlap.name));
      }
    }
    
    this.cancel(NS_BINDING_REDIRECTED, fail);
  },
  
  cancel: function(status, fail) {
    var oldChan = this.oldChannel, newChan = this.channel;
    if (fail) {
      oldChan.notificationCallbacks = newChan.notificationCallbacks;
      this._ccListener.notify = true;
      if (oldChan instanceof CI.nsIRequestObserver)
        try {
        oldChan.onStartRequest(oldChan, null);
        } catch(e) {}
    }
    
    if (oldChan instanceof CI.nsIRequestObserver)
      try {  
        oldChan.onStopRequest(oldChan, null, status);
      } catch(e) {}
    
    if (newChan.loadGroup)
      try {
        newChan.loadGroup.removeRequest(oldChan, null, status);
      } catch(e) {}

    oldChan.notificationCallbacks = null;
    delete this._ccListener;
    delete this.window;
    delete this.oldChannel;
  }
}

function LoadGroupWrapper(channel, callbacks) {
  this._channel = channel;
  this._inner = channel.loadGroup;
  this._callbacks = callbacks;
  channel.loadGroup = this;
}
LoadGroupWrapper.prototype = {
  QueryInterface: xpcom_generateQI(CI.nsISupports, CI.nsILoadGroup),
  
  get activeCount() {
    return this._inner ? this._inner.activeCount : 0;
  },
  set defaultLoadRequest(v) {
    return this._inner ? this._inner.defaultLoadRequest = v : v;
  },
  get defaultLoadRequest() {
    return this._inner ? this._inner.defaultLoadRequest : null;
  },
  set groupObserver(v) {
    return this._inner ? this._inner.groupObserver = v : v;
  },
  get groupObserver() {
    return this._inner ? this._inner.groupObserver : null;
  },
  set notificationCallbacks(v) {
    return this._inner ? this._inner.notificationCallbacks = v : v;
  },
  get notificationCallbacks() {
    return this._inner ? this._inner.notificationCallbacks : null;
  },
  get requests() {
    return this._inner ? this._inner.requests : this._emptyEnum;
  },
  
  addRequest: function(r, ctx) {
    this.detach();
    if (this._inner) this._inner.addRequest(r, ctx);
    if (r === this._channel && ("addRequest" in this._callbacks))
      try {
        this._callbacks.addRequest(r, ctx);
      } catch (e) {}
  },
  removeRequest: function(r, ctx, status) {
    this.detach();
    if (this._inner) this._inner.removeRequest(r, ctx, status);
    if (r === this._channel && ("removeRequest" in this._callbacks))
      try {
        this._callbacks.removeRequest(r, ctx, status);
      } catch (e) {}
  },
  
  detach: function() {
    if (this._channel.loadGroup) this._channel.loadGroup = this._inner;
  },
  _emptyEnum: {
    QueryInterface: xpcom_generateQI(CI.nsISupports, CI.nsISimpleEnumerator),
    getNext: function() { return null; },
    hasMoreElements: function() { return false; }
  }
}