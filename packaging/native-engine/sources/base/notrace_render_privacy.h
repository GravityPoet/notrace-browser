// Copyright 2026 NoTrace contributors. SPDX-License-Identifier: BSD-3-Clause
#ifndef BASE_NOTRACE_RENDER_PRIVACY_H_
#define BASE_NOTRACE_RENDER_PRIVACY_H_

#include <cstdint>
#include <string_view>

namespace base::notrace {

constexpr uint64_t Mix64(uint64_t value) {
  value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
  value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
  return value ^ (value >> 31);
}

// Real font size, not a getter-only lie. The caller quantizes the result using
// the same key precision used to cache and render that font in every realm.
constexpr double FontScale(uint64_t seed) {
  return seed == 0 ? 1.0 :
      1.0 + (static_cast<double>(Mix64(seed) & 0xffffu) / 65535.0 - 0.5) * 0.006;
}

constexpr uint64_t ScopeHash(std::string_view scope) {
  uint64_t hash = 1469598103934665603ULL;
  for (char character : scope) {
    hash ^= static_cast<unsigned char>(character);
    hash *= 1099511628211ULL;
  }
  return hash;
}

constexpr double RectFactor(uint64_t seed, std::string_view scope,
                            uint64_t salt) {
  if (!seed)
    return 1.0;
  const double unit = static_cast<double>(Mix64(seed ^ ScopeHash(scope) ^ salt) &
                                         0xffffffffu) /
                      4294967295.0;
  return 1.0 + (unit - 0.5) * 0.000003;
}

constexpr uint32_t FoldCanvasSeed(uint64_t seed) {
  const uint64_t high = Mix64(seed >> 32);
  return static_cast<uint32_t>(seed) ^ static_cast<uint32_t>(high) ^
         static_cast<uint32_t>(high >> 32);
}

// At most one integer level; endpoints and alpha are preserved by the caller.
// The key depends on the two-value bin, not on its low bit. Therefore F(F(v))
// equals F(v): reading, serializing, and drawing back a lossless bitmap cannot
// repeatedly accumulate this perturbation. Coordinates are absolute canvas
// coordinates, so full reads and cropped reads use the same key.
constexpr uint8_t CanvasChannel(uint64_t seed, uint32_t x, uint32_t y,
                                uint32_t channel, uint8_t value) {
  if (seed == 0 || value == 0 || value == 255)
    return value;
  const uint32_t bin = static_cast<uint32_t>(value) & ~1u;
  uint32_t hash = FoldCanvasSeed(seed) ^ (x * 374761393u) ^
                  (y * 668265263u) ^ (channel * 0x9e3779b9u) ^
                  (bin * 2654435761u);
  hash ^= hash >> 16;
  hash *= 0x85ebca6bu;
  hash ^= hash >> 13;
  hash *= 0xc2b2ae35u;
  hash ^= hash >> 16;
  return static_cast<uint8_t>(bin | (hash & 1u));
}

// Shader output factors are bounded and do not fabricate GPU capabilities.
// Applying them before framebuffer storage lets CPU, PBO, float and texture
// consumers observe the same actual rendered values and native pack layout.
constexpr double ShaderChannelScale(uint64_t seed, uint32_t channel) {
  return seed == 0 ? 1.0 :
      1.0 + (static_cast<double>(Mix64(seed ^
          (uint64_t{channel + 1} * 0x9e3779b97f4a7c15ULL)) & 0xffffu) /
          65535.0 - 0.5) * 0.012;
}

}  // namespace base::notrace

#endif  // BASE_NOTRACE_RENDER_PRIVACY_H_
