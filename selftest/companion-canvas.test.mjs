// The canvas spoof runs on paths pages call in tight loops — a photo editor
// reading pixels back per frame hits getImageData thousands of times a second —
// so it caches the per-shape noise offsets instead of re-deriving forty string
// hashes on every call. Caching a fingerprint is only safe if the cached value
// is the one the uncached code would have produced, and only useful if the key
// distinguishes every shape it must.
//
// These tests pin both halves: the noise stays stable per account, distinct
// across accounts and restricted to the ImageData the page asked for, and the
// hot path stays close to the unwrapped native.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPOOF = readFileSync(join(ROOT, "extension", "cloak-companion", "spoof.js"), "utf8");

// A canvas stub thin enough to read but faithful on the points that matter:
// getImageData hands back a detached copy, putImageData writes through to the
// surface, and toDataURL serialises whatever the surface currently holds. That
// is enough for the wrappers to take exactly the read/mutate/restore path they
// take in the browser.
const CANVAS_STUB = `
  var surfaces = new WeakMap();
  function ImageData(data, width, height) {
    this.data = data; this.width = width; this.height = height;
  }
  function newSurface(width, height) {
    var surface = { width: width, height: height, pixels: new Uint8ClampedArray(width * height * 4) };
    for (var i = 0; i < surface.pixels.length; i++) surface.pixels[i] = (i * 7 + 11) & 255;
    return surface;
  }
  function readback(x, y, w, h) {
    var surface = surfaces.get(this), out = new Uint8ClampedArray(w * h * 4);
    for (var row = 0; row < h; row++) {
      var from = ((y + row) * surface.width + x) * 4, to = row * w * 4;
      for (var col = 0; col < w * 4; col++) out[to + col] = surface.pixels[from + col];
    }
    return new ImageData(out, w, h);
  }
  function writeback(image, x, y) {
    var surface = surfaces.get(this);
    for (var row = 0; row < image.height; row++) {
      var to = ((y + row) * surface.width + x) * 4, from = row * image.width * 4;
      for (var col = 0; col < image.width * 4; col++) surface.pixels[to + col] = image.data[from + col];
    }
  }
  function encode(surface) {
    return "data:," + Array.prototype.join.call(surface.pixels, ",");
  }
  // Two distinct 2D interfaces, as the browser has them, each brand-checking its
  // receiver: the engine throws "Illegal invocation" when the HTMLCanvas native
  // is handed an offscreen context. Sharing one function between the two would
  // hide exactly the mistake these tests exist to catch.
  function CanvasRenderingContext2D() {}
  function OffscreenCanvasRenderingContext2D() {}
  [CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D].forEach(function (iface) {
    iface.prototype.getImageData = function (x, y, w, h) {
      if (!(this instanceof iface)) throw new TypeError("Illegal invocation");
      return readback.call(this, x, y, w, h);
    };
    iface.prototype.putImageData = function (image, x, y) {
      if (!(this instanceof iface)) throw new TypeError("Illegal invocation");
      return writeback.call(this, image, x, y);
    };
  });
  function HTMLCanvasElement() {}
  HTMLCanvasElement.prototype.toDataURL = function () { return encode(this.surface); };
  // Not routed through toDataURL: the browser's two encoders are independent, and
  // chaining them here would let one wrapper's noise land on top of the other's.
  HTMLCanvasElement.prototype.toBlob = function (done) { done(encode(this.surface)); };
  function makeCanvas(width, height) {
    var context = new CanvasRenderingContext2D();
    var surface = newSurface(width, height);
    surfaces.set(context, surface);
    var canvas = new HTMLCanvasElement();
    canvas.width = width;
    canvas.height = height;
    canvas.surface = surface;
    canvas.getContext = function () { return context; };
    return canvas;
  }
  // Starts from the same surface as makeCanvas, because in the browser both
  // realms are reading one drawing and the engine's own per-seed noise reaches
  // both alike. Any disagreement between them is therefore the companion's.
  function OffscreenCanvas(width, height) {
    var context = new OffscreenCanvasRenderingContext2D();
    var surface = newSurface(width, height);
    surfaces.set(context, surface);
    this.width = width;
    this.height = height;
    this.surface = surface;
    this.getContext = function () { return context; };
  }
  OffscreenCanvas.prototype.convertToBlob = function () {
    // The encoder reads the surface as it is called and the promise settles
    // afterwards — which is what makes restoring on settlement safe.
    var encoded = encode(this.surface);
    return Promise.resolve(encoded);
  };
`;

function canvasWindow(seed) {
  const context = vm.createContext({ Intl, Date, Math, Object, String, Array, JSON, Promise });
  vm.runInContext("var window = this;", context);
  context.navigator = { userAgent: "Mozilla/5.0 (Macintosh) Chrome/145.0.0.0 Safari/537.36" };
  vm.runInContext(CANVAS_STUB, context);
  vm.runInContext(SPOOF, context);
  // spoof.js publishes nothing on window; its entry point comes back from the
  // toString handshake.
  if (seed) {
    vm.runInContext(
      `Function.prototype.toString.call(null, "cloak.shared-state.v1")
         .spoof(null, ${JSON.stringify(seed)});`,
      context,
    );
  }
  return context;
}

/// Hash a strided sample of the buffer, the way real fingerprinting scripts —
/// and selftest/probe.html — reduce a canvas to one comparable number.
function strideHash(bytes) {
  let hash = 0;
  for (let i = 0; i < bytes.length; i += 113) hash = (hash * 33 + bytes[i]) >>> 0;
  return hash.toString(16);
}

function readPixels(context, expression) {
  return vm.runInContext(`Array.prototype.slice.call(${expression})`, context);
}

test("getImageData noise is stable per account and differs across accounts", () => {
  const read = (seed) => readPixels(
    canvasWindow(seed),
    'makeCanvas(60, 40).getContext("2d").getImageData(0, 0, 60, 40).data',
  );

  const first = read("92934");
  assert.deepEqual(read("92934"), first, "the same account must hash to the same canvas");
  assert.notDeepEqual(read("41207"), first, "two accounts sharing a canvas hash are linkable");
});

test("getImageData perturbs the strided sample a fingerprinter reduces", () => {
  const bare = readPixels(canvasWindow(null), 'makeCanvas(60, 40).getContext("2d").getImageData(0, 0, 60, 40).data');
  const spoofed = readPixels(canvasWindow("92934"), 'makeCanvas(60, 40).getContext("2d").getImageData(0, 0, 60, 40).data');

  assert.notEqual(
    strideHash(spoofed),
    strideHash(bare),
    "noise that a stride-113 sampler steps over does not change the reported fingerprint",
  );
});

test("the offset cache keys on the rect, not just the label", () => {
  const context = canvasWindow("92934");
  vm.runInContext('var ctx = makeCanvas(64, 64).getContext("2d");', context);

  const small = readPixels(context, "ctx.getImageData(0, 0, 8, 8).data");
  const large = readPixels(context, "ctx.getImageData(0, 0, 64, 64).data");
  const smallAgain = readPixels(context, "ctx.getImageData(0, 0, 8, 8).data");

  assert.deepEqual(smallAgain, small, "a differently shaped read evicted or corrupted the 8x8 plan");
  assert.equal(large.length, 64 * 64 * 4);
});

test("toDataURL hands back the noised image without keeping the noise", () => {
  const context = canvasWindow("92934");
  vm.runInContext("var canvas = makeCanvas(60, 40);", context);
  const before = readPixels(context, "canvas.surface.pixels");

  const noised = vm.runInContext("canvas.toDataURL()", context);
  const after = readPixels(context, "canvas.surface.pixels");

  assert.notEqual(noised, `data:,${before.join(",")}`, "the exported image carries no per-account noise");
  assert.deepEqual(after, before, "the page's own canvas was left corrupted after the export");
  assert.equal(vm.runInContext("canvas.toDataURL()", context), noised, "repeat exports must agree");
});

test("<canvas> and OffscreenCanvas read one drawing the same way", () => {
  // Wrapping only CanvasRenderingContext2D left the two realms disagreeing about
  // the same pixels, which no real browser does and the bare engine does not
  // either — its own noise reaches both. One expression exposed the companion.
  const context = canvasWindow("92934");
  const html = readPixels(context, 'makeCanvas(60, 40).getContext("2d").getImageData(0, 0, 60, 40).data');
  const offscreen = readPixels(context, 'new OffscreenCanvas(60, 40).getContext("2d").getImageData(0, 0, 60, 40).data');
  const bare = readPixels(canvasWindow(null), 'new OffscreenCanvas(60, 40).getContext("2d").getImageData(0, 0, 60, 40).data');

  assert.deepEqual(offscreen, html, "the two realms report different pixels for one drawing");
  assert.notDeepEqual(offscreen, bare, "OffscreenCanvas reads went through unnoised");
});

test("every encoder of one canvas agrees, as two encoders of one canvas must", async () => {
  // A page can call both and compare. The PNG bytes behind them decode to the
  // same pixels in any real browser, so a label per method was a cheap tell.
  const context = canvasWindow("92934");
  vm.runInContext("var canvas = makeCanvas(60, 40);", context);

  const dataUrl = vm.runInContext("canvas.toDataURL()", context);
  const blob = await vm.runInContext("new Promise(function (done) { canvas.toBlob(done); })", context);
  const offscreen = await vm.runInContext("new OffscreenCanvas(60, 40).convertToBlob()", context);

  assert.equal(blob, dataUrl, "toDataURL and toBlob export different images");
  assert.equal(offscreen, dataUrl, "the same drawing encodes differently through OffscreenCanvas");
});

test("convertToBlob carries per-account noise without keeping it", async () => {
  // This wrapper used to call straight through and add nothing. The engine does
  // not noise encoded output at all, so every account on the machine shared one
  // OffscreenCanvas image — exactly the link this product exists to break.
  const context = canvasWindow("92934");
  vm.runInContext("var off = new OffscreenCanvas(60, 40);", context);
  const before = readPixels(context, "off.surface.pixels");

  const encoded = await vm.runInContext("off.convertToBlob()", context);
  const after = readPixels(context, "off.surface.pixels");

  assert.notEqual(encoded, `data:,${before.join(",")}`, "the exported image carries no per-account noise");
  assert.deepEqual(after, before, "the page's own canvas was left corrupted after the export");
  assert.equal(await vm.runInContext("off.convertToBlob()", context), encoded, "repeat exports must agree");

  const other = canvasWindow("41207");
  assert.notEqual(
    await vm.runInContext("new OffscreenCanvas(60, 40).convertToBlob()", other),
    encoded,
    "two accounts exporting one drawing are linkable by the bytes",
  );
});

test("the getImageData hot path stays close to the unwrapped native", () => {
  const measure = (context) => vm.runInContext(
    `(function () {
       var ctx = makeCanvas(300, 150).getContext("2d");
       for (var w = 0; w < 500; w++) { ctx.getImageData(10, 10, 1, 1); }
       var start = Date.now();
       for (var i = 0; i < 20000; i++) { ctx.getImageData(10, 10, 1, 1); }
       return Math.max(1, Date.now() - start);
     })()`,
    context,
  );

  const bare = measure(canvasWindow(null));
  const spoofed = measure(canvasWindow("92934"));

  // Deriving the offsets per call measured 6.4x the native cost in the engine.
  // The ratio is self-calibrating, so this holds on slow CI hardware too.
  assert.ok(
    spoofed / bare < 4,
    `getImageData cost ${spoofed}ms against ${bare}ms native — the per-shape offset cache is gone`,
  );
});
