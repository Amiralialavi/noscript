const CP_OK = 1;
const CP_NOP = function() { return CP_OK };
const CP_FRAMECHECK = 2;
const CP_SHOULDPROCESS = 4;
const CP_EXTERNAL = 0;

const PolicyState = {
  _debug: false,
  _uris: [],
  URI: null,
  hints: null,
  
  attach: function(channel) {
    if (this.URI === channel.URI) {
      if (this._debug) this.push(this.URI);
      IOUtil.attachToChannel(channel, "noscript.policyHints", this.hints);
      this.reset();
    }
  },
  extract: function(channel, detach) {
    var res = IOUtil.extractFromChannel(channel, "noscript.policyHints", !detach);
    if (detach && res !== null && this._debug) {
      var idx = this._uris.indexOf(this.URI);
      if (idx > -1) this._uris.splice(idx, 1);
    }
    return res;
  },
  detach: function(channel) {
    return this.extract(channel, true);
  },
  reset: function() {
    this.URI = this.hints = null;
  },
  cancel: function(hints) {
    this.reset();
    hints._psCancelled = true;
  },
  save: function(uri, hints) {
    if ("_psCancelled" in hints) return false;
    this.URI = uri;
    this.hints = new PolicyHints(hints);
    return true;
  },
  
  toString: function() {
    return this._uris.map(function(u) { return u.spec; }).join(", ");
  }
}

function PolicyHints(hints) {
  Array.prototype.push.apply(this, Array.slice(hints, 0));
}

PolicyHints.prototype = (function() {
  var proto = new Array();
  ["contentType", "contentLocation", "requestOrigin", "context", "mimeType", "extra"].forEach(function(p, i) {
    this.__defineGetter__(p, function() { return this[i] });
    this.__defineSetter__(p, function(v) { return this[i] = v });
   }, proto);
   proto.toArray = function() {
      return Array.slice(this, 0)
   };
   return proto;
})();

const NOPContentPolicy = {
  shouldLoad: CP_NOP,
  shouldProcess: CP_NOP
};

  
// nsIContentPolicy interface
// we use numeric constants for performance sake: 
// TYPE_OTHER = 1
// TYPE_SCRIPT = 2
// TYPE_IMAGE = 3
// TYPE_STYLESHEET = 4
// TYPE_OBJECT = 5
// TYPE_DOCUMENT = 6
// TYPE_SUBDOCUMENT = 7
// TYPE_REFRESH = 8
// TYPE_XBL = 9
// TYPE_PING = 10
// TYPE_XMLHTTPREQUEST = 11
// TYPE_OBJECT_SUBREQUEST = 12
// REJECT_SERVER = -3
// ACCEPT = 1


const MainContentPolicy = {
  shouldLoad: function(aContentType, aContentLocation, aRequestOrigin, aContext, aMimeTypeGuess, aInternalCall) {
      
    var originURL, locationURL, originSite, locationSite, scheme,
        forbid, isScript, isJava, isFlash, isSilverlight,
        isLegacyFrame, blockThisIFrame, contentDocument,
        logIntercept, logBlock,
        unwrappedLocation;
    
    logIntercept = this.consoleDump;
    if(logIntercept) {
      logBlock = logIntercept & LOG_CONTENT_BLOCK;
      logIntercept = logIntercept & LOG_CONTENT_INTERCEPT;
    } else logBlock = false;
    
    try {
      if (aContentType == 1 && !this.POLICY_OBJSUB) { // compatibility for type OTHER
        if (aContext instanceof CI.nsIDOMHTMLDocument) {
          aContentType = arguments.callee.caller ? 11 : 9;
        } else if ((aContext instanceof CI.nsIDOMHTMLElement)) {
          if ((aContext instanceof CI.nsIDOMHTMLEmbedElement || aContext instanceof CI.nsIDOMHTMLObjectElement)) {
            aContentType = 12;
          } else if (aContext.getAttribute("ping")) {
            aContentType = 10;
          }
        }
        arguments[0] = aContentType;
      }
      
      unwrappedLocation = IOUtil.unwrapURL(aContentLocation);
      scheme = unwrappedLocation.scheme;
      
      var isHTTP = /^https?$/.test(scheme);
      
      if (isHTTP) {
        if (aRequestOrigin && !aInternalCall) {
          
          if (aContentType != 3) // images are a bitch if cached!
            XOriginCache.store(aRequestOrigin, arguments.xOriginKey = unwrappedLocation);
          
          switch(aContentType) {
            // case 2: case 4: // scripts stall if blocked later
            case 1: case 12: // we may have no chance to check later for unknown and sub-plugin requests
              if (ABE.checkPolicy(aRequestOrigin, unwrappedLocation))
                return this.reject("ABE-denied inclusion", arguments); 
          }
        }
        
        if (HTTPS.httpsForced && !aInternalCall &&
              (aContentType != 6 && aContentType != 7
                || !this.POLICY_OBJSUB // Gecko < 1.9, early check for documents as well
            ) && scheme == "http"
          && HTTPS.forceHttpsPolicy(unwrappedLocation, aContext, aContentType))
          if (this.POLICY_OBJSUB) // if Gecko >= 1.9 we reject this request because we're gonna spawn a SSL one for images and the like
            return this.reject("Non-HTTPS", arguments); 
        
        if (logIntercept && this.cpConsoleFilter.indexOf(aContentType) > -1) {
          this.cpDump("processing", aContentType, aContentLocation, aRequestOrigin, aContext, aMimeTypeGuess, aInternalCall);
          if (this.consoleDump & LOG_CONTENT_CALL)
             this.dump(new Error().stack);
        }
        
      }
      
      switch (aContentType) {
        case 9: // XBL - warning, in 1.8.x could also be XMLHttpRequest...
          return this.forbidXBL && 
            this.forbiddenXMLRequest(aRequestOrigin, aContentLocation, aContext, this.forbiddenXBLContext) 
            ? this.reject("XBL", arguments) : CP_OK;
        
        case 11: // in Firefox 3 we check for cross-site XHR
          return this.forbidXHR && 
            this.forbiddenXMLRequest(aRequestOrigin, aContentLocation, aContext, this.forbiddenXHRContext) 
             ? this.reject("XHR", arguments) : CP_OK;
        
        case 10: // TYPE_PING
          if (this.jsEnabled || !this.getPref("noping", true) || 
              aRequestOrigin && this.isJSEnabled(this.getSite(aRequestOrigin.spec))
            )
            return CP_OK;
            
          return this.reject("Ping", arguments);
            
        case 2:
          if (this.forbidChromeScripts && this.checkForbiddenChrome(aContentLocation, aRequestOrigin)) {
            return this.reject("Chrome Access", arguments);
          }
          if (this.forbidJarDocuments && aRequestOrigin && this.checkJarDocument(aContentLocation, aContext, aRequestOrigin)) {
            return this.reject("Cross-site jar-embedded script", arguments);
          }
          forbid = isScript = true;
          break;
        case 3: // IMAGES
          if (this.blockNSWB && 
              !(this.jsEnabled || aRequestOrigin &&
                ((originSite = this.getSite(aRequestOrigin.spec)) == this.getSite(aContentLocation.spec)
                    || this.isJSEnabled(originSite)))
                && aContext instanceof CI.nsIDOMHTMLImageElement) {
            try {
              for (var parent = aContext; (parent = parent.parentNode);) {
                if (parent.nodeName.toUpperCase() == "NOSCRIPT")
                  return this.reject("Tracking Image", arguments);
              }
            } catch(e) {
              this.dump(e)
            }
          }
  
          PolicyState.cancel(arguments);
          return CP_OK;
        
        case 4: // STYLESHEETS
          if (PolicyUtil.isXSL(aContext) && /\/x[ms]l/.test(aMimeTypeGuess) &&
              !/chrome|resource/.test(aContentLocation.scheme) &&
                this.getPref("forbidXSLT", true)) {
            forbid = isScript = true; // we treat XSLT like scripts
            break;
          }
          
          if (this.forbidJarDocuments && aRequestOrigin && this.checkJarDocument(aContentLocation, aContext, aRequestOrigin)) {
            return this.reject("Cross-site jar-embedded stylesheet", arguments);
          }
          
          return CP_OK;
          
        case 5: 
        case 15:
          if (aContentLocation && aRequestOrigin && 
              (locationURL = aContentLocation.spec) == (originURL = aRequestOrigin.spec) && 
              (aContext instanceof CI.nsIDOMHTMLEmbedElement) &&
              aMimeTypeGuess && 
              this.isAllowedObject(locationURL, aMimeTypeGuess)
              ) {
            if (logIntercept) this.dump("Plugin document " + locationURL);
            return CP_OK; // plugin document, we'll handle it in our webprogress listener
          }
          
          if (this.checkJarDocument(aContentLocation, aContext)) 
            return this.reject("Plugin content from JAR", arguments);
          
          
          if (aContentType == 15 && aRequestOrigin && !this.isJSEnabled(this.getSite(aRequestOrigin.spec))) {
            // let's wire poor man's video/audio toggles if JS is disabled and therefore controls are not available
            this.delayExec(function() {
              aContext.addEventListener("click", function(ev) {
                var media = ev.currentTarget;
                if (media.paused) media.play();
                else media.pause();
              }, true);
            }, 0);
          }
          
          
          if (aMimeTypeGuess) // otherwise let's treat it as an iframe
            break;
          
          
          
        case 7:
          locationURL = aContentLocation.spec;
          originURL = aRequestOrigin && aRequestOrigin.spec;
          if (locationURL == "about:blank" || /^chrome:/.test(locationURL)
            || !originURL && (aContext instanceof CI.nsIDOMXULElement)  // custom browser like in Stumbleupon discovery window
          ) return CP_OK;
          
          if (!aMimeTypeGuess) {
            aMimeTypeGuess = this.guessMime(aContentLocation);
            if (logIntercept)
              this.dump("Guessed MIME '" + aMimeTypeGuess + "' for location " + locationURL);
          }
          
          if (aContentType == 15) {
            break; // we just need to guess the Mime for video/audio
          }
          
          isLegacyFrame = aContext instanceof CI.nsIDOMHTMLFrameElement;
     
          if(isLegacyFrame
             ? this.forbidFrames || // we shouldn't allow framesets nested inside iframes, because they're just as bad
                                    this.forbidIFrames &&
                                    (aContext.ownerDocument.defaultView.frameElement instanceof CI.nsIDOMHTMLIFrameElement) &&
                                    this.getPref("forbidMixedFrames", true)
             : this.forbidIFrames
             ) {
            try {
              contentDocument = aContext.contentDocument;
            } catch(e) {}
         
            blockThisIFrame = aInternalCall == CP_FRAMECHECK && !(
                    this.knownFrames.isKnown(locationURL, originSite = this.getSite(originURL)) ||
                    /^(?:chrome|resource|wyciwyg):/.test(locationURL) ||
                    locationURL == this._silverlightInstalledHack ||
                    locationURL == this.compatGNotes ||
                    (
                      originURL
                        ? (/^chrome:/.test(originURL) ||
                           /^(?:data|javascript):/.test(locationURL) &&
                            (contentDocument && (originURL == contentDocument.URL
                                                  || /^(?:data:|javascript:|about:blank$)/.test(contentDocument.URL)
                            ) || this.isFirebugJSURL(locationURL)
                           )
                          )
                        : contentDocument && 
                          this.getSite(contentDocument.URL) == (locationSite = this.getSite(locationURL))
                     )
                ) && this.forbiddenIFrameContext(originURL || (originURL = aContext.ownerDocument.URL), locationURL);
          }
          
        case 6:
  
          if (this.checkJarDocument(aContentLocation, aContext)) 
            return this.reject("JAR Document", arguments);
          
         
          
          if (aRequestOrigin && aRequestOrigin != aContentLocation) {
            
            if (this.safeToplevel && (aContext instanceof CI.nsIDOMChromeWindow) &&
                aContext.isNewToplevel &&
                !(/^(?:chrome|resource|file)$/.test(scheme) ||
                  this.isSafeJSURL(aContentLocation.spec))
                  ) {
              return this.reject("Top Level Window Loading", arguments);
            }
         
            if (isHTTP) {
              
              // external?
              if (aRequestOrigin.schemeIs("chrome") && aContext && aContext.ownerDocument &&
                aContext.ownerDocument.defaultView.isNewToplevel){
                this.requestWatchdog.externalLoad = aContentLocation.spec;
              }
              
            } else if(/^(?:data|javascript)$/.test(scheme)) {
              //data: and javascript: URLs
              locationURL = locationURL || aContentLocation.spec;
              if (!(this.isSafeJSURL(locationURL) || this.isPluginDocumentURL(locationURL, "iframe")) &&
                ((this.forbidData && !this.isFirebugJSURL(locationURL) || locationURL == "javascript:") && 
                  this.forbiddenJSDataDoc(locationURL, originSite = this.getSite(originURL = originURL || aRequestOrigin.spec), aContext) ||
                  aContext && (
                    (aContext instanceof CI.nsIDOMWindow) 
                      ? aContext
                      : aContext.ownerDocument.defaultView
                  ).isNewToplevel
                )
               ) {
                return this.reject("JavaScript/Data URL", arguments);
              }
            } else if(scheme != aRequestOrigin.scheme && 
                scheme != "chrome" && // faster path for common case
                this.isExternalScheme(scheme)) {
              // work-around for bugs 389106 & 389580, escape external protocols
              if (aContentType != 6 && !aInternalCall && 
                  this.getPref("forbidExtProtSubdocs", true) && 
                  !this.isJSEnabled(originSite = this.getSite(originURL = originURL || aRequestOrigin.spec)) &&
                  (!aContext.contentDocument || aContext.contentDocument.URL != originURL)
                  ) {
                return this.reject("External Protocol Subdocument", arguments);
              }
              if (!this.normalizeExternalURI(aContentLocation)) {
                return this.reject("Invalid External URL", arguments);
              }
            } else if(aContentType == 6 && scheme == "chrome" &&
              this.getPref("lockPrivilegedUI", false) && // block DOMI && Error Console
              /^(?:javascript:|chrome:\/\/(?:global\/content\/console|inspector\/content\/inspector|venkman\/content\/venkman)\.xul)$/
                .test(locationURL)) {
              return this.reject("Locked Privileged UI", arguments);
            }
          }
          
          if (!(this.forbidSomeContent || this.alwaysBlockUntrustedContent) ||
                !blockThisIFrame && (
                  !aMimeTypeGuess 
                  || aMimeTypeGuess.substring(0, 5) == "text/"
                  || aMimeTypeGuess == "application/xml" 
                  || aMimeTypeGuess == "application/xhtml+xml"
                  || aMimeTypeGuess.substring(0, 6) == "image/"
                  || !this.pluginForMime(aMimeTypeGuess)
                )
            ) {
            
            if (aContext instanceof CI.nsIDOMElement) {
              // this is alternate to what we do in countObject, since we can't get there
              // this.delayExec(this.opaqueIfNeeded, 0, aContext); // TODO uncomment
            }
            
            if (logBlock)
              this.dump("Document OK: " + aMimeTypeGuess + "@" + (locationURL || aContentLocation.spec) + 
                " --- PGFM: " + this.pluginForMime(aMimeTypeGuess));
            
            
            
            return CP_OK;
          }
          break;
        
        case 12:
          // Silverlight mindless activation scheme :(
          if (!this.forbidSilverlight 
              || !this.getExpando(aContext, "silverlight") || this.getExpando(aContext, "allowed"))
            return CP_OK;
  
          aMimeTypeGuess = "application/x-silverlight";
          break;
        default:
          return CP_OK;
      }
      
  
      locationURL = locationURL || aContentLocation.spec;
      locationSite = locationSite || this.getSite(locationURL);
      var untrusted = this.isUntrusted(locationSite);
      
      
      if(logBlock)
        this.dump("[CP PASS 2] " + aMimeTypeGuess + "*" + locationURL);
  
      if (isScript) {
        
        originSite = originSite || aRequestOrigin && this.getSite(aRequestOrigin.spec);
        
        // we must guess the right context here, see https://bugzilla.mozilla.org/show_bug.cgi?id=464754
        
        aContext = aContext && aContext.ownerDocument || aContext; // this way we always have a document
        
        if (aContentType == 2) { // "real" JavaScript include
        
          // Silverlight hack
          
          if (this.contentBlocker && this.forbidSilverlight && this.silverlightPatch &&
                originSite && /^(?:https?|file):/.test(originSite)) {
            this.applySilverlightPatch(aContext);
          }
                  
          if (originSite && locationSite == originSite) return CP_OK;
        } else isScript = false;
        
        if (aContext) // XSLT comes with no context sometimes...
          this.getExpando(aContext.defaultView.top, "codeSites", []).push(locationSite);
        
        
        forbid = !this.isJSEnabled(locationSite);
        if (forbid && this.ignorePorts && /:\d+$/.test(locationSite)) {
          forbid = !this.isJSEnabled(locationSite.replace(/:\d+$/, ''));
        }
  
        if ((untrusted || forbid) && aContentLocation.scheme != "data") {
          if (isScript) ScriptSurrogate.apply(aContext, locationURL);
          return this.reject(isScript ? "Script" : "XSLT", arguments);
        } else {
          return CP_OK;
        }
      }
  
      
      if (!(forbid || locationSite == "chrome:")) {
        var mimeKey = aMimeTypeGuess || "application/x-unknown"; 
        
        forbid = blockThisIFrame || untrusted && this.alwaysBlockUntrustedContent;
        if (!forbid && this.forbidSomeContent) {
          if (aMimeTypeGuess && !(this.allowedMimeRegExp && this.allowedMimeRegExp.test(aMimeTypeGuess))) {
            forbid = 
              (
                (isFlash = /^application\/(?:x-shockwave-flash|futuresplash)/i.test(aMimeTypeGuess)) ||
                (isJava = /^application\/x-java\b/i.test(aMimeTypeGuess)) || 
                (isSilverlight = /^application\/x-silverlight\b/i.test(aMimeTypeGuess)) 
              ) &&
              isFlash && this.forbidFlash || 
              isJava && this.forbidJava || 
              isSilverlight && this.forbidSilverlight;
            
            // see http://heasman.blogspot.com/2008/03/defeating-same-origin-policy-part-i.html
            if (isJava && /(?:[^\/\w\.\$\:]|^\s*\/\/)/.test(aContext.getAttribute("code") || "")) {
              return this.reject("Illegal Java code attribute " + aContext.getAttribute("code"), arguments);
            }
            
            if (forbid) {
              if (isSilverlight) {
                if (logIntercept) this.dump("Silverlight " + aContentLocation.spec + " " + typeof(aContext) + " " + aContentType + ", " + aInternalCall);
               
                
                forbid = aContentType == 12 || !this.POLICY_OBJSUB;
                this.setExpando(aContext, "silverlight", aContentType != 12);
                if (!forbid) return CP_OK;
                
                locationURL = this.resolveSilverlightURL(aRequestOrigin, aContext);
                locationSite = this.getSite(locationURL);
                
                if (!this.POLICY_OBJSUB)  forbid = locationURL != (aRequestOrigin && aRequestOrigin.spec);
                
                if(!forbid || this.isAllowedObject(locationURL, mimeKey, locationSite)) {
                  if (logIntercept && forbid) this.dump("Silverlight " + locationURL + " is whitelisted, ALLOW");
                  return CP_OK;
                }
              } else if (isFlash) {
                locationURL = this.addFlashVars(locationURL, aContext);
              }
            } else {
              forbid = this.forbidPlugins && !(isJava || isFlash || isSilverlight);
              if (forbid) {
                locationURL = this.addObjectParams(locationURL, aContext);
              }
            }
          }
        }
      }
  
      if(forbid && !this.contentBlocker) {
        
        originURL = originURL || (aRequestOrigin && aRequestOrigin.spec);
        originSite = originSite || this.getSite(originURL);
      
        var originOK = originSite 
          ? this.isJSEnabled(originSite) 
          : /^(?:javascript|data):/.test(originURL); // if we've got such an origin, parent should be trusted
        
        var locationOK = locationSite 
              ? this.isJSEnabled(locationSite) 
              : // use origin for javascript: or data:
                /^(?:javascript|data):/.test(locationURL) && originOK
        ;
        
        if (!locationOK && locationSite && this.ignorePorts && /:\d+$/.test(locationSite)) {
          if (this.isJSEnabled(locationSite.replace(/:\d+$/, ''))) {
            locationOK = this.autoTemp(locationSite);
          }
        }
        
        forbid = !(locationOK && (originOK || 
          !this.getPref(blockThisIFrame 
          ? "forbidIFramesParentTrustCheck" : "forbidActiveContentParentTrustCheck", true)
          ));
      }
       
      if (/\binnerHTML\b/.test(new Error().stack)) {
        if (this._bug453825) {
          aContext.ownerDocument.location.href = 'javascript:window.__defineGetter__("top", (Window.prototype || window).__lookupGetter__("top"))';
          if (this.consoleDump) this.dump("Locked window.top (bug 453825 work-around)");
        }
        if (this._bug472495) {
          aContext.ownerDocument.defaultView.addEventListener("DOMNodeRemoved", this._domNodeRemoved, true);
          if (this.consoleDump) this.dump("Added DOMNodeRemoved (bug 472495 work-around)");
        }
      }
      
      
      this.delayExec(this.countObject, 0, aContext, locationSite); 
      
      forbid = forbid && !(/^file:\/\/\//.test(locationURL) && /^resource:/.test(originURL || (aRequestOrigin && aRequestOrigin.spec || ""))); // fire.fm work around
      
      if (forbid) {
        try {  // moved here because of http://forums.mozillazine.org/viewtopic.php?p=3173367#3173367
          if (this.getExpando(aContext, "allowed") || 
            this.isAllowedObject(locationURL, mimeKey, locationSite)) {
            this.setExpando(aContext, "allowed", true);
            return CP_OK; // forceAllow
          }
        } catch(ex) {
          this.dump("Error checking plugin per-object permissions:" + ex);
        }
        
        if (isLegacyFrame) { // inject an embed and defer to load
          if (this.blockLegacyFrame(aContext, aContentLocation, aInternalCall || blockThisIFrame))
            return this.reject("Deferred Legacy Frame " + locationURL, arguments);
        } else {
          try {
            if ((aContext instanceof CI.nsIDOMNode) && (aContentType == 5 || aContentType == 7 || aContentType == 12 || aContentType == 15)) {
              
              if (this.consoleDump & LOG_CONTENT_BLOCK)
                this.dump("tagForReplacement");
                
              this.delayExec(this.tagForReplacement, 0, aContext, {
                url: locationURL,
                mime: mimeKey
              });
            } else if (this.consoleDump & LOG_CONTENT_BLOCK) this.dump("Context is not a DOMNode? " + aContentType);
          } catch(ex) {
            if(this.consoleDump) this.dump(ex);
          } finally {
            return this.reject("Forbidden " + (contentDocument ? ("IFrame " + contentDocument.URL) : "Content"), arguments);
          }
        }
      } else {
        
  
        if (isSilverlight) {
          this.setExpando(aContext, "silverlight", aContentType != 12);
        }
        if (this.consoleDump & LOG_CONTENT_CALL) {
          this.dump(locationURL + " Allowed, " + new Error().stack);
        }
      }
    } catch(e) {
      return this.reject("Content (Fatal Error, " + e  + " - " + e.stack + ")", arguments);
    } finally {
      if (isHTTP) PolicyState.save(unwrappedLocation, arguments);
      else PolicyState.reset();
    }
    return CP_OK;
  },
  
  
  shouldProcess: function(aContentType, aContentLocation, aRequestOrigin, aContext, aMimeType, aExtra) {
    return this.shouldLoad(aContentType, aContentLocation, aRequestOrigin, aContext, aMimeType, CP_SHOULDPROCESS);
  },
  check: function() {
    return false;
  }
}

var PolicyUtil = {
  isXSL: function(ctx) {
    return ctx && !(ctx instanceof CI.nsIDOMHTMLLinkElement || ctx instanceof CI.nsIDOMHTMLStyleElement);
  }
}