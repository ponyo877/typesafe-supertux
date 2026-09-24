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

// Writes the level's tiles for checking players' paths on the server
// (tools/web/cloudflare/verify.js) to tools/web/cloudflare/level-map.json.
//
//   node tools/web/level-map.mjs     (with tools/jev-proxy/server.mjs running)
//
// The game itself reports its tiles (jev_dump_level_map in
// src/port/jev_bridge.cpp), so the map is what the game plays on. Run it
// again when the level or the tile set changes.

import { chromium } from "../eval/node_modules/playwright/index.mjs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--mute-audio"] });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8765/play.html?ai=off");
await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const map = JSON.parse(await page.evaluate(() => Module.UTF8ToString(Module._jev_dump_level_map())));
await browser.close();

// Where Tux starts (the middle of the player at the spawnpoint of
// shallow_green.stl) and where the level ends (its end sequence trigger).
map.start = [112, 560];
map.goal_x = 14100;
await writeFile(join(here, "cloudflare", "level-map.json"), JSON.stringify(map));
console.log(`${map.width} x ${map.height} tiles, ${[...map.cells].filter((c) => c !== "0").length} not empty`);
