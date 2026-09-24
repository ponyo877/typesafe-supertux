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

// Checks that a reported death or clear came with a path Tux could have
// taken. The server cannot play the game back, but the page sends the path
// of the attempt (src/port/jev_bridge.cpp: every 0.1 s of game time
// [t ms, x, y, vx, vy, flags], flags 1 = on the ground, the held controls
// from 2 up), and a made-up path gives itself away: it jumps, flies, runs
// too fast, goes through rock, moves without the speed to do it, or does
// not start at the start. Used by worker.js and tools/jev-proxy/server.mjs;
// tools/web/verify-test.mjs checks it against real and made-up paths.
//
// It is not proof: a real path played once could be sent again (the server
// limits that by time and by token), and a program imitating SuperTux's
// physics could make one up. It stops everything short of that.

const STEP = 100;            // ms between samples
const MAX_SAMPLES = 9000;    // 15 minutes
const MAX_SPEED_X = 480;     // px/s; Tux runs at 320, more after a bounce or down a slope
const MAX_SPEED_Y = 1400;    // px/s
const GRAVITY = 1000;        // px/s^2
const MIN_CLEAR_MS = 44000;  // 14,000 px at 320 px/s

const LIMITS = {
  badTiming: 0.02,     // share of intervals that are not about STEP long
  jump: 0.01,          // share of moves longer than the speed limit allows
  tooFast: 0.01,       // share of samples over the speed limits
  unexplained: 0.05,   // share of moves longer than the velocities explain
  inRock: 0.02,        // share of samples inside solid tiles
  floating: 0.03,      // share of airborne intervals that do not fall
  noWall: 0.02,        // share of moves held back with nothing in the way
};

function cell(map, x, y) {
  const tx = Math.floor(x / map.tile), ty = Math.floor(y / map.tile);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height)
    return 0;
  return parseInt(map.cells[ty * map.width + tx], 16);
}

/** Something solid beside Tux (x, y his middle) on the side he moves to. */
function wallBeside(map, x, y, direction) {
  for (let ahead = 8; ahead <= 32; ahead += 8)
    for (let up = -40; up <= 40; up += 8)
      if (cell(map, x + direction * (16 + ahead), y + up) & 3)
        return true;
  return false;
}

/**
 * kind: "death" or "clear"; path: the samples; at: [x, y] reported for a
 * death; map: level-map.json. Returns { ok, reason, stats }.
 */
export function verify(kind, path, at, map) {
  const fail = (reason, stats) => ({ ok: false, reason, stats });

  if (!Array.isArray(path) || path.length < 5 || path.length > MAX_SAMPLES)
    return fail("length");
  for (const p of path)
    if (!Array.isArray(p) || p.length !== 6 || !p.every(Number.isInteger))
      return fail("shape");

  const [t0, x0, y0] = path[0];
  if (t0 > 2 * STEP || Math.abs(x0 - map.start[0]) > 48 || Math.abs(y0 - map.start[1]) > 64)
    return fail("start");

  const counts = { badTiming: 0, jump: 0, tooFast: 0, unexplained: 0, inRock: 0, floating: 0, noWall: 0, airborne: 0 };
  let integrated = 0;
  for (let i = 0; i < path.length; i++) {
    const [t, x, y, vx, vy] = path[i];
    if (Math.abs(vx) > MAX_SPEED_X || Math.abs(vy) > MAX_SPEED_Y) counts.tooFast++;
    if (cell(map, x, y) & 1) counts.inRock++;
    if (i === 0) continue;

    const [pt, px, py, pvx, pvy, pflags] = path[i - 1];
    const flags = path[i][5];
    const dt = t - pt;
    if (dt <= 0) return fail("time");
    if (dt < STEP * 0.8 || dt > STEP * 1.3) counts.badTiming++;
    const s = dt / 1000;
    const dx = x - px, dy = y - py;

    // No move beyond the speed limits, and none beyond what the velocities
    // at both ends allow (made-up positions tend to come with made-up,
    // mismatching speeds).
    if (Math.abs(dx) > MAX_SPEED_X * s + 12 || Math.abs(dy) > MAX_SPEED_Y * s + 12) counts.jump++;
    // On the ground, slopes move him up and down with no vertical speed, as
    // steeply as he moves across.
    const grounded = (flags & 1) || (pflags & 1);
    const dyAllowed = Math.max(Math.abs(vy), Math.abs(pvy)) * s + 16 + (grounded ? Math.abs(dx) : 0);
    if (Math.abs(dx) > Math.max(Math.abs(vx), Math.abs(pvx)) * s + 16 || Math.abs(dy) > dyAllowed)
      counts.unexplained++;

    // Where the velocities say he went. Running into a wall keeps the speed
    // but not the move; then there has to be a wall, and the move counts.
    const expected = (vx + pvx) / 2 * s;
    if (Math.abs(dx) < Math.abs(expected) - 4) {
      if (!wallBeside(map, px, py, Math.sign(expected)) && !wallBeside(map, x, y, Math.sign(expected)))
        counts.noWall++;
      integrated += dx;
    } else {
      integrated += expected;
    }

    // In the air, gravity pulls: the vertical speed has to grow, if not by
    // the full amount (letting go of jump, a ceiling, a bounce).
    if (!(flags & 1) && !(pflags & 1)) {
      counts.airborne++;
      const gain = (vy - pvy) / s;
      if (gain < -GRAVITY * 0.5 && vy < 0 && vy < pvy - 50) {
        // Rising faster in the air: only a bounce off a badguy does that.
      } else if (gain < GRAVITY * 0.2 && vy < MAX_SPEED_Y * 0.9 && dy <= 0) {
        counts.floating++;
      }
    }
  }

  const intervals = path.length - 1;
  const stats = { ...counts, intervals, samples: path.length };
  if (counts.badTiming > LIMITS.badTiming * intervals) return fail("timing", stats);
  if (counts.jump > LIMITS.jump * intervals + 1) return fail("teleport", stats);
  if (counts.tooFast > LIMITS.tooFast * path.length + 1) return fail("speed", stats);
  if (counts.unexplained > LIMITS.unexplained * intervals + 2) return fail("unexplained", stats);
  if (counts.inRock > LIMITS.inRock * path.length + 1) return fail("rock", stats);
  if (counts.floating > LIMITS.floating * Math.max(counts.airborne, 1) + 2) return fail("floating", stats);
  if (counts.noWall > LIMITS.noWall * intervals + 2) return fail("no wall", stats);

  // How far the velocities say Tux went, against how far he went: the
  // right-minus-left distance of the path has to be the one its speeds add
  // up to (held back only by walls).
  const last = path[path.length - 1];
  const net = last[1] - x0;
  if (Math.abs(integrated - net) > 0.1 * Math.abs(net) + 200)
    return fail("distance", { ...stats, integrated: Math.round(integrated), net });

  if (kind === "death") {
    if (!Array.isArray(at) || Math.abs(at[0] - last[1]) > 48 || Math.abs(at[1] - last[2]) > 64)
      return fail("death place", stats);
  } else if (kind === "clear") {
    if (last[1] < map.goal_x - 64) return fail("not at goal", stats);
    if (last[0] < MIN_CLEAR_MS) return fail("too quick", stats);
  } else {
    return fail("kind");
  }
  return { ok: true, reason: "ok", stats };
}
