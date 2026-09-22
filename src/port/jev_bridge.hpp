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

#pragma once

class Sector;

/** Lets a decision model running on the JavaScript side (Jev, or anything
    that speaks the same choice/score/noul format) give orders to the walking
    badguys near the player.

    Several times per second (see the exported `jev_set_send_interval()`)
    the state of those badguys is handed to `window.jev_on_state(json)`. The
    page answers whenever it is ready by calling the exported
    `jev_set_order(uid, order, ttl)`; see badguy/jev_order.hpp for the orders
    and mk/emscripten/jev-controller.js for the other end.

    Decision models are weak at arithmetic, so the state contains no
    coordinates, only facts such as "to my left", "near" or "above me and
    falling toward me". */
namespace jev_bridge {

/** Call once per logic step. Does nothing outside of Emscripten builds. */
void tick(Sector& sector, float dt_sec);

} // namespace jev_bridge

/* EOF */
