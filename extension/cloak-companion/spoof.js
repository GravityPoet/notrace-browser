// MAIN world. Defines window.__cloakSpoof(tz); does NOT run by itself.
// Re-entrant: the page-visible Intl/Date are wrapped exactly once; a later call
// with a different zone just retargets the shared holder (st.tz), so switching
// zones never stacks Proxies. Used by both apply.js (content script) and the
// service worker's executeScript fallback — single source of truth.
// Wrapped in an IIFE because this runs in the page's global scope: top-level
// function declarations would otherwise publish installFingerprintSpoof and
// friends on window, naming the companion to anyone who looks.
(function () {

// Cross-injection state lives on non-enumerable properties so a page cannot
// find the companion by walking Object.keys(window). The per-account seed is
// never stored here at all: it is unique and permanent, so anything holding it
// on the page's global is a super-cookie. It is consumed as an argument and only
// its derived hash survives, inside the wrapper closures.
function hide(name, value) {
  try {
    Object.defineProperty(window, name, {
      value: value, configurable: true, enumerable: false, writable: true,
    });
  } catch (_) { window[name] = value; }
}

// Every replaced native would otherwise report its JavaScript source from
// toString(), which is a decisive "this function was patched" tell. Map each
// replacement back to the native it stands in for and answer toString() from
// that. The map lives on a hidden global so a second injection of this file
// keeps the earlier wrappers masked instead of re-exposing them.
if (!window.__cloakNativeSources) hide("__cloakNativeSources", new WeakMap());
function maskSource(replacement, original) {
  try {
    window.__cloakNativeSources.set(replacement, original);
    if (!window.__cloakToStringPatched) {
      hide("__cloakToStringPatched", true);
      var nativeToString = Function.prototype.toString;
      var patched = function toString() {
        var target = window.__cloakNativeSources.get(this);
        return nativeToString.call(target || this);
      };
      try { Object.defineProperty(patched, "length", { value: nativeToString.length }); } catch (_) {}
      window.__cloakNativeSources.set(patched, nativeToString);
      Function.prototype.toString = patched;
    }
  } catch (_) {}
  return replacement;
}

hide("__cloakSpoof", function (tz, fpSeed) {
  try {
    if (!tz && !fpSeed) return;
    if (window.__cloakState) {
      if (tz) { window.__cloakState.tz = tz; hide("__cloakTZ", tz); }
      if (fpSeed) installFingerprintSpoof(fpSeed);
      return;
    }

    var st = { tz: tz || null };
    hide("__cloakState", st);
    if (tz) hide("__cloakTZ", tz);
    installBrowserIdentitySpoof();
    installHeadlessSurfaceSpoof();

    var RealDTF = Intl.DateTimeFormat;
    var WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var pad = function (n) { return String(n).padStart(2, "0"); };

    // Intl.DateTimeFormat construction builds an ICU formatter and is orders of
    // magnitude more expensive than using one. Building a fresh pair on every
    // call made getTimezoneOffset ~240x and Date→string ~300x slower than
    // native, which is enough to stall the main thread — and therefore click
    // handling — on any page that formats dates in a loop. The options never
    // vary, so the formatters are built once per zone and reused.
    var fmtZone = null, fmtParts = null, fmtAbbr = null;
    function formatters() {
      if (fmtZone !== st.tz) {
        fmtParts = new RealDTF("en-US", {
          timeZone: st.tz, hourCycle: "h23",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        fmtAbbr = new RealDTF("en-US", { timeZone: st.tz, timeZoneName: "short" });
        fmtZone = st.tz;
      }
    }
    function partsIn(date) {
      formatters();
      var o = {};
      var ps = fmtParts.formatToParts(date);
      for (var i = 0; i < ps.length; i++) o[ps[i].type] = ps[i].value;
      return o;
    }
    // Minutes east of UTC for `date` in the target zone (DST-correct via real ICU).
    // Callers that already hold the parts pass them in so a single Date→string
    // conversion formats once instead of three times.
    function eastFrom(p, date) {
      var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      return Math.round((asUTC - date.getTime()) / 60000);
    }
    // getTimezoneOffset is the hottest of these — date libraries call it on
    // essentially every operation. A zone's offset only changes at DST
    // transitions, and every modern IANA transition lands on a UTC hour
    // boundary, so one formatToParts per hour bucket is enough. Timestamps
    // before 1970 skip the cache: historical LMT offsets carry odd minutes and
    // a rounded answer there would be an inconsistency a checker could probe.
    var offsetBucket = null, offsetZone = null, offsetValue = 0;
    function eastMinutes(date) {
      var time = date.getTime();
      if (time < 0) return eastFrom(partsIn(date), date);
      var bucket = Math.floor(time / 3600000);
      if (bucket !== offsetBucket || offsetZone !== st.tz) {
        offsetValue = eastFrom(partsIn(date), date);
        offsetBucket = bucket;
        offsetZone = st.tz;
      }
      return offsetValue;
    }
    function abbr(date) {
      formatters();
      var x = fmtAbbr.formatToParts(date)
        .find(function (p) { return p.type === "timeZoneName"; });
      return x ? x.value : "";
    }
    function gmtFrom(east) {
      var s = east >= 0 ? "+" : "-", a = Math.abs(east);
      return "GMT" + s + pad(Math.floor(a / 60)) + pad(a % 60);
    }

    if (tz) {
      // Each replacement below is registered with maskSource so toString() still
      // reports the native it stands in for.
      var replaceMethod = function (obj, name, make) {
        var orig = obj[name];
        var next = make(orig);
        try { Object.defineProperty(next, "name", { value: orig.name || name }); } catch (_) {}
        try { Object.defineProperty(next, "length", { value: orig.length }); } catch (_) {}
        obj[name] = maskSource(next, orig);
      };

      // getTimezoneOffset returns minutes BEHIND UTC (positive when west).
      replaceMethod(Date.prototype, "getTimezoneOffset", function () {
        return function () {
          return isNaN(this) ? NaN : -eastMinutes(this);
        };
      });

      // Default Intl.DateTimeFormat to the target zone when the caller omits timeZone.
      var handler = {
        construct: function (T, a) { var o = a[1] ? Object.assign({}, a[1]) : {}; if (!o.timeZone) o.timeZone = st.tz; return new T(a[0], o); },
        apply: function (T, _t, a) { var o = a[1] ? Object.assign({}, a[1]) : {}; if (!o.timeZone) o.timeZone = st.tz; return T(a[0], o); },
      };
      Intl.DateTimeFormat = new Proxy(RealDTF, handler);

      // toLocale* default to the target zone too.
      ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].forEach(function (name) {
        replaceMethod(Date.prototype, name, function (orig) {
          return function (l, o) {
            o = o ? Object.assign({}, o) : {}; if (!o.timeZone) o.timeZone = st.tz;
            return orig.call(this, l, o);
          };
        });
      });

      // String forms reflect the target zone and offset.
      replaceMethod(Date.prototype, "toString", function () {
        return function () {
          if (isNaN(this)) return "Invalid Date";
          var p = partsIn(this);
          var dow = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
          return WD[dow] + " " + MO[+p.month - 1] + " " + p.day + " " + p.year + " " + p.hour + ":" + p.minute + ":" + p.second + " " + gmtFrom(eastFrom(p, this)) + " (" + abbr(this) + ")";
        };
      });
      replaceMethod(Date.prototype, "toTimeString", function () {
        return function () {
          if (isNaN(this)) return "Invalid Date";
          var p = partsIn(this);
          return p.hour + ":" + p.minute + ":" + p.second + " " + gmtFrom(eastFrom(p, this)) + " (" + abbr(this) + ")";
        };
      });
      replaceMethod(Date.prototype, "toDateString", function () {
        return function () {
          if (isNaN(this)) return "Invalid Date";
          var p = partsIn(this);
          var dow = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
          return WD[dow] + " " + MO[+p.month - 1] + " " + p.day + " " + p.year;
        };
      });
    }
    installFingerprintSpoof(fpSeed);
  } catch (_) { /* fail open: never break the page */ }
});

/// Synthesize a full browser identity from navigator.userAgent.
/// Used when __cloakBrowserIdentity is not injected (PWA main profile path).
/// Reads the native UA which already reflects the real engine version,
/// so it auto-follows CloakBrowser engine upgrades — zero Rust dependency.
function synthesizeIdentityFromUA() {
  try {
    var ua = navigator.userAgent;
    if (!ua) return null;
    var match = ua.match(/Chrome\/(\d+)/);
    if (!match) return null;
    var major = match[1];
    // Full version from UA: Chrome reports "Chrome/145.0.0.0" (rounded), use that.
    var fullMatch = ua.match(/Chrome\/([\d.]+)/);
    var full = fullMatch ? fullMatch[1] : major + ".0.0.0";
    return {
      userAgent: ua,
      platform: "MacIntel",
      uaData: {
        brands: [
          { brand: "Google Chrome", version: major },
          { brand: "Chromium", version: major },
          { brand: "Not)A;Brand", version: "24" },
        ],
        mobile: false,
        platform: "macOS",
        fullVersionList: [
          { brand: "Google Chrome", version: full },
          { brand: "Chromium", version: full },
          { brand: "Not)A;Brand", version: "24.0.0.0" },
        ],
        uaFullVersion: full,
        platformVersion: "15.5.0",
        architecture: "arm",
        bitness: "64",
        model: "",
      },
    };
  } catch (_) {
    return null;
  }
}

function installBrowserIdentitySpoof() {
  try {
    if (window.__cloakBrowserIdentityInstalled) return;
    var identity = window.__cloakBrowserIdentity || synthesizeIdentityFromUA();
    if (!identity || !identity.userAgent) return;
    hide("__cloakBrowserIdentityInstalled", true);

    function clone(value) {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    }
    // WebIDL attributes are enumerable and their getters are named "get <attr>".
    // Object.defineProperty defaults to enumerable:false and an anonymous getter,
    // so spelling both out keeps the descriptor indistinguishable from native.
    function defineGetter(obj, name, getter) {
      try {
        var previous = Object.getOwnPropertyDescriptor(obj, name);
        Object.defineProperty(getter, "name", { value: "get " + name });
        if (previous && previous.get) maskSource(getter, previous.get);
        Object.defineProperty(obj, name, {
          get: getter, configurable: true, enumerable: true,
        });
      } catch (_) {}
    }

    var navProto = window.Navigator && Navigator.prototype;
    if (navProto) {
      defineGetter(navProto, "userAgent", function () { return identity.userAgent; });
      if (identity.platform) {
        defineGetter(navProto, "platform", function () { return identity.platform; });
      }
    }

    if (identity.uaData && navProto) {
      var uaData = {
        get brands() { return clone(identity.uaData.brands || []); },
        get mobile() { return !!identity.uaData.mobile; },
        get platform() { return identity.uaData.platform || "macOS"; },
        getHighEntropyValues: function (hints) {
          var result = {
            brands: clone(identity.uaData.brands || []),
            mobile: !!identity.uaData.mobile,
            platform: identity.uaData.platform || "macOS",
          };
          var keys = Array.isArray(hints) ? hints : [];
          for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (Object.prototype.hasOwnProperty.call(identity.uaData, key)) {
              result[key] = clone(identity.uaData[key]);
            }
          }
          return Promise.resolve(result);
        },
        toJSON: function () {
          return {
            brands: clone(identity.uaData.brands || []),
            mobile: !!identity.uaData.mobile,
            platform: identity.uaData.platform || "macOS",
          };
        },
      };
      try { Object.defineProperty(uaData.getHighEntropyValues, "name", { value: "getHighEntropyValues" }); } catch (_) {}
      defineGetter(navProto, "userAgentData", function () { return uaData; });
    }
  } catch (_) {}
}

function installHeadlessSurfaceSpoof() {
  try {
    if (window.__cloakHeadlessSurfaceInstalled) return;
    hide("__cloakHeadlessSurfaceInstalled", true);

    function defineGetter(obj, name, getter) {
      try {
        var previous = Object.getOwnPropertyDescriptor(obj, name);
        Object.defineProperty(getter, "name", { value: "get " + name });
        if (previous && previous.get) maskSource(getter, previous.get);
        Object.defineProperty(obj, name, {
          get: getter, configurable: true, enumerable: true,
        });
      } catch (_) {}
    }
    // Interface objects on window are writable:true, enumerable:false — the
    // defineProperty default of writable:false would flag every synthesized one.
    function defineValue(obj, name, value) {
      try {
        Object.defineProperty(obj, name, {
          value: value, configurable: true, writable: true, enumerable: false,
        });
      } catch (_) {}
    }

    if (typeof window.ContentIndex === "undefined") {
      defineValue(window, "ContentIndex", function ContentIndex() {});
    }

    var navProto = window.Navigator && Navigator.prototype;
    if (typeof window.ContactsManager === "undefined") {
      defineValue(window, "ContactsManager", function ContactsManager() {});
      try {
        Object.defineProperty(window.ContactsManager.prototype, Symbol.toStringTag, {
          value: "ContactsManager",
          configurable: true,
        });
      } catch (_) {}
    }

    if (navProto && !("contacts" in navigator)) {
      var contacts = Object.create(window.ContactsManager ? window.ContactsManager.prototype : null);
      try {
        Object.defineProperties(contacts, {
          getProperties: {
            value: function getProperties() {
              return Promise.resolve(["name", "email", "tel", "address", "icon"]);
            },
            configurable: true,
          },
          select: {
            value: function select() {
              var ErrorCtor = window.DOMException || Error;
              return Promise.reject(new ErrorCtor("Permission denied", "NotAllowedError"));
            },
            configurable: true,
          },
        });
      } catch (_) {
        contacts = {
        getProperties: function () {
          return Promise.resolve(["name", "email", "tel", "address", "icon"]);
        },
        select: function () {
          var ErrorCtor = window.DOMException || Error;
          return Promise.reject(new ErrorCtor("Permission denied", "NotAllowedError"));
        },
        };
      }
      defineGetter(navProto, "contacts", function () { return contacts; });
    }

    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection && typeof connection.downlinkMax === "undefined") {
      // Prototype only. A WebIDL attribute never exists as an own property of an
      // instance, so defining it on `connection` itself was a stronger bot signal
      // than the missing attribute it was meant to hide.
      var connectionProto = Object.getPrototypeOf(connection);
      if (connectionProto) {
        defineGetter(connectionProto, "downlinkMax", function () { return 10; });
      }
    }
  } catch (_) {}
}

function installFingerprintSpoof(fpSeed) {
  try {
    if (!fpSeed || window.__cloakFingerprintInstalled) return;
    hide("__cloakFingerprintInstalled", true);

    // Only the hash survives; the account seed itself is not retained anywhere
    // the page can reach.
    var seed = hashString(String(fpSeed));

    function hashString(s) {
      var h = 2166136261 >>> 0;
      for (var i = 0; i < String(s).length; i++) {
        h ^= String(s).charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h >>> 0;
    }
    function noiseFor(label, modulo) {
      if (modulo <= 0) return 0;
      var h = seed ^ hashString(label);
      h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) % modulo;
    }
    // Marking wrappers with an own property (the old `__cloakWrapped`) named the
    // product to anyone calling Object.getOwnPropertyNames on a patched native.
    // A WeakSet keeps the same idempotency with nothing observable on the value.
    var wrappedFns = new WeakSet();
    function wrap(obj, name, fn) {
      if (!obj || !obj[name] || wrappedFns.has(obj[name])) return;
      var orig = obj[name];
      var wrapped = fn(orig);
      try { Object.defineProperty(wrapped, "name", { value: orig.name || name }); } catch (_) {}
      try { Object.defineProperty(wrapped, "length", { value: orig.length }); } catch (_) {}
      wrappedFns.add(wrapped);
      maskSource(wrapped, orig);
      obj[name] = wrapped;
    }
    var nativeGetImageData = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype.getImageData;
    var nativePutImageData = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype.putImageData;

    // Deriving the offsets costs ~40 string hashes per call, which dwarfed the
    // handful of byte writes they describe: getImageData measured 1.1µs native
    // against 7.9µs wrapped, and a page that reads pixels in a loop paid that on
    // every iteration. The offsets depend only on the seed, the label and the
    // pixel dimensions, so derive them once per shape; the values are unchanged.
    // The cache is bounded because a page may ask for arbitrarily many rects.
    var pointPlans = new Map();
    function pointPlan(label, w, h) {
      var key = label + ":" + w + "x" + h;
      var points = pointPlans.get(key);
      if (points) return points;
      points = [];
      for (var i = 0; i < 8; i++) {
        var base = label + ":" + i;
        points.push([
          noiseFor(base + ":x:" + w, w),
          noiseFor(base + ":y:" + h, h),
          1 + noiseFor(base + ":r", 7),
          1 + noiseFor(base + ":g", 7),
          1 + noiseFor(base + ":b", 7),
        ]);
      }
      if (pointPlans.size > 64) pointPlans.clear();
      pointPlans.set(key, points);
      return points;
    }
    function restoreCanvasNoise(ctx, originals) {
      for (var i = originals.length - 1; i >= 0; i--) {
        try { nativePutImageData.call(ctx, originals[i][2], originals[i][0], originals[i][1]); } catch (_) {}
      }
    }
    function applyCanvasNoise(canvas, label) {
      var ctx, originals;
      try {
        if (!canvas || !canvas.width || !canvas.height) return null;
        ctx = canvas.getContext && canvas.getContext("2d");
        if (!ctx || !nativeGetImageData || !nativePutImageData) return null;
        var points = pointPlan(label, canvas.width, canvas.height);
        originals = [];
        for (var i = 0; i < 8; i++) {
          var point = points[i], x = point[0], y = point[1];
          var original = nativeGetImageData.call(ctx, x, y, 1, 1);
          var changed = nativeGetImageData.call(ctx, x, y, 1, 1);
          var data = changed.data;
          data[0] = (data[0] + point[2]) & 255;
          data[1] = (data[1] + point[3]) & 255;
          data[2] = (data[2] + point[4]) & 255;
          data[3] = 255;
          originals.push([x, y, original]);
          nativePutImageData.call(ctx, changed, x, y);
        }
        return function () { restoreCanvasNoise(ctx, originals); };
      } catch (_) {
        if (ctx && originals) restoreCanvasNoise(ctx, originals);
        return null;
      }
    }
    function perturbCanvas(canvas, label, cb) {
      var restore = applyCanvasNoise(canvas, label);
      try {
        return cb();
      } finally {
        if (restore) restore();
      }
    }

    wrap(HTMLCanvasElement.prototype, "toDataURL", function (orig) {
      return function () {
        var self = this, args = arguments;
        return perturbCanvas(self, "toDataURL", function () { return orig.apply(self, args); });
      };
    });
    wrap(HTMLCanvasElement.prototype, "toBlob", function (orig) {
      return function () {
        var self = this, args = arguments;
        var restore = applyCanvasNoise(self, "toBlob");
        if (!restore) return orig.apply(self, args);
        if (typeof args[0] === "function") {
          var cb = args[0];
          var next = Array.prototype.slice.call(args);
          next[0] = function () {
            restore();
            return cb.apply(this, arguments);
          };
          try {
            return orig.apply(self, next);
          } catch (e) {
            restore();
            throw e;
          }
        }
        try {
          var result = orig.apply(self, args);
          setTimeout(function () { restore(); }, 0);
          return result;
        } catch (e2) {
          restore();
          throw e2;
        }
      };
    });
    if (window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype) {
      // Fingerprinters routinely hash a strided sample of the buffer instead of
      // every byte, so land extra perturbations on the stride as well. These
      // deltas depend on neither the rect nor the canvas, so derive them once.
      var sampleDeltas = [];
      for (var s = 0; s < 8; s++) sampleDeltas.push(1 + noiseFor("getImageData:sample:" + s, 251));
      wrap(CanvasRenderingContext2D.prototype, "getImageData", function (orig) {
        return function () {
          var image = orig.apply(this, arguments);
          try {
            var w = Math.max(1, image.width || arguments[2] || 1);
            var h = Math.max(1, image.height || arguments[3] || 1);
            var data = image.data, len = data.length;
            var points = pointPlan("getImageData", w, h);
            for (var i = 0; i < 8; i++) {
              var point = points[i], idx = (point[1] * w + point[0]) * 4;
              if (idx + 3 < len) {
                data[idx] = (data[idx] + point[2]) & 255;
                data[idx + 1] = (data[idx + 1] + point[3]) & 255;
                data[idx + 2] = (data[idx + 2] + point[4]) & 255;
                data[idx + 3] = 255;
              }
            }
            for (var j = 0; j < 8 && len; j++) {
              var sample = (j * 113) % len;
              data[sample] = (data[sample] + sampleDeltas[j]) & 255;
            }
          } catch (_) {}
          return image;
        };
      });
    }
    if (window.OffscreenCanvas && OffscreenCanvas.prototype) {
      wrap(OffscreenCanvas.prototype, "convertToBlob", function (orig) {
        return function () {
          return orig.apply(this, arguments);
        };
      });
    }

    var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (AC && AC.prototype) {
      wrap(AC.prototype, "startRendering", function (orig) {
        return function () {
          var result = orig.apply(this, arguments);
          return Promise.resolve(result).then(function (buffer) {
            try {
              for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
                var data = buffer.getChannelData(ch);
                var step = 97 + noiseFor("audio:step:" + ch, 29);
                var delta = (noiseFor("audio:delta:" + ch, 2001) - 1000) / 10000000;
                if (data.length) data[0] = data[0] + delta;
                for (var i = noiseFor("audio:start:" + ch, step); i < data.length; i += step) {
                  data[i] = data[i] + delta;
                }
              }
            } catch (_) {}
            return buffer;
          });
        };
      });
    }
  } catch (_) {}
}

})();
