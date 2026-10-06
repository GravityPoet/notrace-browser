// Copyright 2026 NoTrace contributors. SPDX-License-Identifier: BSD-3-Clause
#include "base/notrace_render_privacy.h"

#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <set>

int main() {
  using namespace base::notrace;
  constexpr std::array<uint64_t, 8> seeds = {
      0, 33328, 68226, 55995, 1, 0x8000000000000001ULL,
      0xffffffffffffffffULL, 0x100000001ULL};
  for (uint64_t seed : seeds) {
    assert(RectFactor(seed, "example.test", 1) >= 0.9999985);
    assert(RectFactor(seed, "example.test", 1) <= 1.0000015);
    assert(RectFactor(seed, "example.test", 1) == RectFactor(seed, "example.test", 1));
    const double scale = FontScale(seed);
    assert(scale >= 0.997 && scale <= 1.003);
    assert(scale == FontScale(seed));
    for (unsigned c = 0; c < 3; ++c) {
      assert(ShaderChannelScale(seed, c) >= 0.994);
      assert(ShaderChannelScale(seed, c) <= 1.006);
      for (uint32_t y = 0; y < 17; ++y) {
        for (uint32_t x = 0; x < 19; ++x) {
          for (unsigned v = 0; v < 256; ++v) {
            const auto original = static_cast<uint8_t>(v);
            const auto result = CanvasChannel(seed, x, y, c, original);
            assert(std::abs(int(result) - int(original)) <= 1);
            assert(result == CanvasChannel(seed, x, y, c, result));
            if (!seed || !v || v == 255)
              assert(original == result);
          }
        }
      }
    }
  }
  std::set<double> cached_font_sizes;
  std::set<uint64_t> image_signatures;
  for (uint64_t seed : {uint64_t{33328}, uint64_t{68226}, uint64_t{55995}}) {
    cached_font_sizes.insert(std::floor(18.0 * FontScale(seed) * 100) / 100);
    uint64_t signature = 0;
    for (unsigned y = 0; y < 16; ++y)
      for (unsigned x = 0; x < 16; ++x)
        for (unsigned c = 0; c < 3; ++c)
          signature = signature * 257 + CanvasChannel(seed, x, y, c, 126);
    image_signatures.insert(signature);
    // Full read and a crop both address the same absolute pixel.
    assert(CanvasChannel(seed, 12, 13, 1, 126) ==
           CanvasChannel(seed, 9 + 3, 10 + 3, 1, 126));
  }
  assert(cached_font_sizes.size() == 3);
  assert(image_signatures.size() == 3);
  assert(FoldCanvasSeed(1) != FoldCanvasSeed(0x100000001ULL));
  assert(FoldCanvasSeed(1) != FoldCanvasSeed(0x8000000000000001ULL));
  assert(RectFactor(33328, "example.test", 1) != RectFactor(33328, "another.test", 1));
  assert(RectFactor(33328, "example.test", 1) != RectFactor(68226, "example.test", 1));
  assert(RectFactor(0, "example.test", 1) == 1);
  std::cout << "native helper: bounded/idempotent/stable/full-width-seed/crop/"
               "three-seed font cache checks passed\n";
}
