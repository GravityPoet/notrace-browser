// Copyright 2026 NoTrace contributors. SPDX-License-Identifier: BSD-3-Clause
#ifndef BASE_NOTRACE_SHADER_PRIVACY_H_
#define BASE_NOTRACE_SHADER_PRIVACY_H_

#include <charconv>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/notrace_render_privacy.h"

namespace base::notrace {

struct ShaderToken {
  std::string_view text;
  size_t offset;
  int depth;
};

inline bool ShaderIdentifier(char value) {
  return (value >= 'a' && value <= 'z') ||
         (value >= 'A' && value <= 'Z') || value == '_' ||
         (value >= '0' && value <= '9');
}

// Conservative source front-end, not a GLSL validator. Unrecognized constructs
// retain the original compiler path; never turn a rejected shader into valid
// code. ANGLE remains authoritative for parsing, validation and translation.
inline std::optional<std::string> IsolateFragmentSource(
    std::string_view source, uint64_t seed) {
  if (!seed || source.empty() || source.size() > 1024 * 1024)
    return std::nullopt;
  std::vector<ShaderToken> tokens;
  int depth = 0;
  for (size_t pos = 0; pos < source.size();) {
    const char value = source[pos];
    if (value == ' ' || value == '\t' || value == '\n' || value == '\r') {
      ++pos;
      continue;
    }
    if (value == '/' && pos + 1 < source.size() && source[pos + 1] == '/') {
      const size_t end = source.find('\n', pos + 2);
      pos = end == std::string_view::npos ? source.size() : end + 1;
      continue;
    }
    if (value == '/' && pos + 1 < source.size() && source[pos + 1] == '*') {
      const size_t end = source.find("*/", pos + 2);
      if (end == std::string_view::npos)
        return std::nullopt;
      pos = end + 2;
      continue;
    }
    if (value == '#') {
      const size_t end = source.find('\n', pos);
      const auto directive = source.substr(pos, end == std::string_view::npos ?
          source.size() - pos : end - pos);
      if (directive.find("define") != std::string_view::npos ||
          directive.find("if") != std::string_view::npos ||
          directive.find("include") != std::string_view::npos)
        return std::nullopt;
      pos = end == std::string_view::npos ? source.size() : end + 1;
      continue;
    }
    const size_t start = pos++;
    if (ShaderIdentifier(value)) {
      while (pos < source.size() && ShaderIdentifier(source[pos]))
        ++pos;
    }
    if (value == '}') {
      if (depth == 0)
        return std::nullopt;
      --depth;
    }
    tokens.push_back({source.substr(start, pos - start), start, depth});
    if (value == '{')
      ++depth;
  }
  if (depth != 0)
    return std::nullopt;
  std::optional<size_t> main_offset;
  std::vector<std::string> outputs;
  for (size_t index = 0; index < tokens.size(); ++index) {
    const auto& token = tokens[index];
    if (token.text == "void" && token.depth == 0 && index + 4 < tokens.size() &&
        tokens[index + 1].text == "main" && tokens[index + 2].text == "(") {
      size_t close = index + 3;
      if (tokens[close].text == "void")
        ++close;
      if (close + 1 < tokens.size() && tokens[close].text == ")" &&
          tokens[close + 1].text == "{") {
        if (main_offset)
          return std::nullopt;
        main_offset = tokens[index + 1].offset;
      }
    }
    if (token.text == "gl_FragColor") {
      if (outputs.empty())
        outputs.emplace_back("gl_FragColor");
    } else if (token.text == "gl_FragData") {
      // Dynamic indexing/MRT declarations need an AST-level implementation.
      return std::nullopt;
    } else if (token.depth == 0 && token.text == "out") {
      size_t next = index + 1;
      if (next < tokens.size() &&
          (tokens[next].text == "lowp" || tokens[next].text == "mediump" ||
           tokens[next].text == "highp"))
        ++next;
      if (next + 2 >= tokens.size() || tokens[next].text != "vec4")
        return std::nullopt;  // integer outputs/interface blocks untouched
      const auto name = tokens[next + 1].text;
      if (name.empty() || !ShaderIdentifier(name[0]) ||
          tokens[next + 2].text != ";")
        return std::nullopt;  // arrays/multiple declarations untouched
      outputs.emplace_back(name);
    }
  }
  if (!main_offset || outputs.empty() || outputs.size() > 16)
    return std::nullopt;
  std::string renamed = "notrace_original_main";
  while (source.find(renamed) != std::string_view::npos)
    renamed.push_back('_');
  std::string result(source);
  result.replace(*main_offset, 4, renamed);
  result.append("\nvoid main(){");
  result.append(renamed).append("();\n");
  std::string factors = "vec3(";
  for (uint32_t channel = 0; channel < 3; ++channel) {
    char number[32];
    const auto conversion = std::to_chars(
        number, number + sizeof(number), ShaderChannelScale(seed, channel),
        std::chars_format::fixed, 9);
    if (conversion.ec != std::errc{})
      return std::nullopt;
    if (channel)
      factors.push_back(',');
    factors.append(number, conversion.ptr);
  }
  factors.push_back(')');
  for (const auto& output : outputs)
    result.append(output).append(".rgb *= ").append(factors).append(";\n");
  result.append("}\n");
  return result;
}

}  // namespace base::notrace
#endif  // BASE_NOTRACE_SHADER_PRIVACY_H_
