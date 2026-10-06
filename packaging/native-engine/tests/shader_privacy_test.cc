// Copyright 2026 NoTrace contributors. SPDX-License-Identifier: BSD-3-Clause
#include "base/notrace_shader_privacy.h"

#include <cassert>
#include <iostream>
#include <vector>

int main() {
  using base::notrace::IsolateFragmentSource;
  const std::string webgl1 = "precision mediump float;void main(){"
      "gl_FragColor=vec4(gl_FragCoord.x/64.,gl_FragCoord.y/64.,0.376,1.);}";
  const std::string webgl2 = "#version 300 es\nprecision highp float;"
      "layout(location=0) out vec4 color;void main(void){color=vec4(.5);return;}";
  for (const auto& source : {webgl1, webgl2}) {
    const auto first = IsolateFragmentSource(source, 33328);
    assert(first);
    assert(first == IsolateFragmentSource(source, 33328));
    assert(first != IsolateFragmentSource(source, 68226));
    assert(first->find(".rgb *= vec3(") != std::string::npos);
    assert(first->find("return;") != std::string::npos || source == webgl1);
    assert(!IsolateFragmentSource(source, 0));
  }
  assert(IsolateFragmentSource("/* void main(){} */" + webgl1, 1));
  assert(IsolateFragmentSource("// main bogus\n" + webgl1, 1));
  assert(IsolateFragmentSource("float notrace_original_main;" + webgl1, 1));
  for (const std::string& source : std::vector<std::string>{
      "#define main other\n" + webgl1,
      "#if 1\n" + webgl1 + "\n#endif",
      "precision mediump float;void main(){gl_FragData[0]=vec4(1.);}",
      "#version 300 es\n out ivec4 outputColor;void main(){outputColor=ivec4(1);}",
      "out vec4 color[2];void main(){color[0]=vec4(1.);}",
      "out vec4 a,b;void main(){a=b=vec4(1.);}",
      "/* comment not closed", "void main(){"}) {
    assert(!IsolateFragmentSource(source, 1));
  }
  std::cout << "native shader front-end: GLSL1/3 deterministic and conservative checks passed\n";
}
