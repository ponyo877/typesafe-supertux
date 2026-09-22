#!/usr/bin/env node
//  SuperTux
//  Copyright (C) 2026 ponyo877
//
//  This program is free software: you can redistribute it and/or modify
//  it under the terms of the GNU General Public License as published by
//  the Free Software Foundation, either version 3 of the License, or
//  (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//  GNU General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Collects the license texts of everything compiled into the WebAssembly
// build, or shipped in its data, into mk/emscripten/third-party-licenses.txt.
// Several of them (BSD, MIT, FreeType, the fonts' licenses) ask for their
// text to accompany binary copies; the web build links to this file.
//
//   node tools/web/collect-licenses.mjs [build dir]
//
// Needs the emsdk (EMSDK, default ~/emsdk) and the build directory's vcpkg
// packages. Run it again when the dependencies change.

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const build = resolve(process.argv[2] || join(repo, "build.wasm"));
const emsdk = process.env.EMSDK || join(homedir(), "emsdk");
const emscripten = join(emsdk, "upstream/emscripten");
const ports = join(emscripten, "cache/ports");
const vcpkg = join(build, "vcpkg_installed/wasm32-emscripten/share");

// [name, what it is here, license, file]
const COMPONENTS = [
  ["Emscripten", "compiler runtime and JavaScript glue", "MIT / University of Illinois NCSA", join(emscripten, "LICENSE")],
  ["musl libc", "C library (via Emscripten)", "MIT", join(emscripten, "system/lib/libc/musl/COPYRIGHT")],
  ["libc++", "C++ standard library (via Emscripten)", "Apache 2.0 with LLVM exceptions", join(emscripten, "system/lib/libcxx/LICENSE.TXT")],
  ["libc++abi", "C++ runtime (via Emscripten)", "Apache 2.0 with LLVM exceptions", join(emscripten, "system/lib/libcxxabi/LICENSE.TXT")],
  ["compiler-rt", "compiler support library (via Emscripten)", "Apache 2.0 with LLVM exceptions", join(emscripten, "system/lib/compiler-rt/LICENSE.TXT")],
  ["SDL 3", "window, input and audio", "zlib", join(ports, "sdl3/SDL-release-3.4.2/LICENSE.txt")],
  ["SDL_ttf 3", "text rendering", "zlib", join(ports, "sdl3_ttf/SDL_ttf-release-3.2.2/LICENSE.txt")],
  ["FreeType", "font rasterizer (used under the FreeType License)", "FTL", join(ports, "freetype/freetype-VER-2-13-3/docs/FTL.TXT")],
  ["HarfBuzz", "text shaping", "MIT (\"Old MIT\")", join(ports, "harfbuzz/harfbuzz-3.2.0/COPYING")],
  ["libogg", "Ogg container", "BSD 3-Clause", join(ports, "ogg/libogg-1.3.5/COPYING")],
  ["libvorbis", "Vorbis audio decoder", "BSD 3-Clause", join(ports, "vorbis/libvorbis-1.3.7/COPYING")],
  ["zlib (Emscripten port)", "compression", "zlib", join(ports, "zlib/zlib-1.3.1/LICENSE")],
  ["zlib (vcpkg)", "compression", "zlib", join(vcpkg, "zlib/copyright")],
  ["libpng", "PNG images", "libpng License", join(vcpkg, "libpng/copyright")],
  ["libjpeg-turbo", "JPEG images; this software is based in part on the work of the Independent JPEG Group", "IJG / BSD 3-Clause / zlib", join(vcpkg, "libjpeg-turbo/copyright")],
  ["SDL_image 3", "image loading", "zlib", join(vcpkg, "sdl3-image/copyright")],
  ["PhysicsFS", "virtual file system", "zlib", join(vcpkg, "physfs/copyright")],
  ["{fmt}", "string formatting", "MIT", join(vcpkg, "fmt/copyright")],
  ["GLM", "math library", "MIT / Happy Bunny", join(vcpkg, "glm/copyright")],
  ["Squirrel", "scripting language", "MIT", join(repo, "external/simplesquirrel/libs/squirrel/COPYRIGHT")],
  ["simplesquirrel", "Squirrel bindings", "MIT", join(repo, "external/simplesquirrel/LICENSE")],
  ["tinygettext", "translations", "zlib", join(repo, "external/tinygettext/LICENSE.md")],
  ["FindLocale", "locale detection", "MIT-style", join(repo, "external/findlocale/LICENSE")],
  ["sexp-cpp", "S-expression parser", "GPL 3", null],
  ["obstack", "from the GNU C Library", "LGPL 2.1 or later", null],
  ["SDL_SavePNG", "screenshots", "zlib/libpng", null],
  ["Partio ZIP", "ZIP reader, from Walt Disney Animation Studios' Partio", "BSD 3-Clause (Disney)", join(repo, "external/partio_zip/zip_manager.cpp")],
  ["Varela Round (font)", "shipped in the game data", "SIL Open Font License 1.1", join(repo, "data/fonts/VARELA_ROUND_LICENSE.txt")],
  ["Dekko (font)", "shipped in the game data", "SIL Open Font License 1.1", join(repo, "data/fonts/DEKKO_LICENSE.txt")],
  ["Noto Sans (font)", "shipped in the game data", "SIL Open Font License 1.1", join(repo, "data/fonts/NOTO_SANS_LICENSE.txt")],
  ["Source Code Pro (font)", "shipped in the game data", "SIL Open Font License 1.1", join(repo, "data/fonts/SOURCECODEPRO_LICENSE.md")],
  ["Roboto (font)", "shipped in the game data", "SIL Open Font License 1.1", join(repo, "data/fonts/Roboto_License.txt")],
  ["Mapo Backpacking (font)", "shipped in the game data", "KOGL Type 1", join(repo, "data/fonts/MapoBackpacking_License.txt")],
];

const NO_FILE = {
  "sexp-cpp": "Licensed under the GNU General Public License version 3, the same as SuperTux; see LICENSE.txt.",
  "obstack": "Copyright (C) 1988-2005 Free Software Foundation, Inc. Part of the GNU C Library, licensed under the GNU\n" +
             "Lesser General Public License version 2.1 or later, used here under the GNU General Public License\n" +
             "version 3 as the LGPL permits; see LICENSE.txt.",
  "SDL_SavePNG": "Available under the zlib/libpng license: http://www.libpng.org/pub/png/src/libpng-LICENSE.txt",
};

const rule = "=".repeat(78);
let text =
  "Third-party software in this web version of SuperTux\n" +
  rule + "\n\n" +
  "SuperTux itself is licensed under the GNU General Public License version 3 (LICENSE.txt).\n" +
  "It is built with, or ships, the following software. Their license texts follow.\n\n" +
  COMPONENTS.map(([name, what, license]) => `  - ${name}: ${what} (${license})`).join("\n") + "\n";

for (const [name, what, license, file] of COMPONENTS) {
  let body = NO_FILE[name];
  if (!body) {
    body = (await readFile(file, "utf8")).trimEnd();
    // Partio's notice is the comment at the top of its only source file.
    if (name === "Partio ZIP")
      body = body.slice(body.indexOf("PARTIO SOFTWARE"), body.indexOf("*/")).trimEnd();
  }
  text += `\n\n${rule}\n${name} (${license})\n${what}\n${rule}\n\n${body}\n`;
}

const output = join(repo, "mk/emscripten/third-party-licenses.txt");
await writeFile(output, text);
console.log(`Wrote ${COMPONENTS.length} components (${text.length} bytes) to ${output}`);

// The in-game credits (data/credits.stxt) as plain text: the single level
// build skips the title screen, and with it the credits menu.
const stxt = await readFile(join(repo, "data/credits.stxt"), "utf8");
const string = `(?:\\(_\\s+)?"((?:[^"\\\\]|\\\\.)*)"`;
const entry = new RegExp(
  `\\(text\\s+\\(type "(\\w+)"\\)\\s+\\(string\\s+${string}` +
  `|\\(person\\s+\\(name\\s+${string}\\)?\\)(?:\\s+\\(info\\s+${string})?`, "g");
const unescape = (s) => s.replace(/\\(.)/g, "$1");
let credits = "SuperTux credits\n" + rule + "\n\nFrom the game's credits screen (data/credits.stxt).\n";
for (const m of stxt.matchAll(entry)) {
  if (m[1] === "heading")
    credits += `\n\n${unescape(m[2])}\n${"-".repeat(unescape(m[2]).length)}\n`;
  else if (m[1] === "reference")
    credits += `\n${unescape(m[2])}:\n`;
  else if (m[1])
    credits += `${unescape(m[2])}\n`;
  else
    credits += `  ${unescape(m[3])}${m[4] ? " - " + unescape(m[4]) : ""}\n`;
}
const creditsOutput = join(repo, "mk/emscripten/supertux-credits.txt");
await writeFile(creditsOutput, credits);
console.log(`Wrote the credits (${credits.length} bytes) to ${creditsOutput}`);
