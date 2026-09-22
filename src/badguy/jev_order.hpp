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

class Player;

/** A short-lived order given to a badguy by an external decision model (see
    port/jev_bridge.hpp). The model only picks the order a few times per
    second; the badguy carries it out every logic step. Once an order expires
    the badguy falls back to its regular behaviour. */
enum class JevOrder
{
  DEFAULT = 0, /**< Regular behaviour */
  CHARGE,      /**< Run towards the nearest player */
  RETREAT,     /**< Run away from the nearest player */
  HOLD,        /**< Stand still, facing the nearest player */
  JUMP,        /**< Jump once, then keep running towards the nearest player */

  // Given by the rich prompt only
  AMBUSH,      /**< Wait; charge once the player comes close, lands nearby or passes */
  INTERCEPT,   /**< Run to where the player is going to land and wait there */
  STALK,       /**< Keep 3-5 tiles away; charge when the player turns their back */
  FLANK,       /**< Jump over the player and attack from the other side */
  SPECIAL      /**< Kind specific: Igel rolls, MrBomb blows up next to the player, ... */
};

/** Options of the bridge, set by the page with jev_set_options(). All off
    by default, which is what the basic Laya prompt and Jev get. */
enum : unsigned
{
  JEV_OPT_RICH = 1u << 0,    /**< Report the extra facts of the rich prompt */
  JEV_OPT_JUMPY = 1u << 1,   /**< Let Jumpy take orders too */
  JEV_OPT_PURSUIT = 1u << 2, /**< Badguys that got an order keep chasing offscreen */
  JEV_OPT_REFLEX = 1u << 3   /**< Dodge a stomp without waiting for the model */
};

/** The options in effect (defined in port/jev_bridge.cpp). */
unsigned jev_options();

/** Multiplies the speeds below; set by the page. */
float jev_speed_scale();

/** Where the player's feet will be at `ground_y` (in x), following their
    current jump; their current x if they are on the ground or rising past
    it. */
float jev_predict_landing_x(const Player& player, float ground_y);

/** Horizontal speed when charging or retreating. Tux walks at 230 and runs
    at 320, so this is fast but can still be outrun. */
static const float JEV_RUN_SPEED = 200.f;

/** Chasing offscreen: catches up with a walking player, not a running one. */
static const float JEV_CATCHUP_SPEED = 260.f;

/** Passed as `modifier` to WalkingBadguy::active_update(); 1 would take a
    full second to reach JEV_RUN_SPEED. */
static const float JEV_ACCELERATION_MODIFIER = 3.f;

/** Roughly three tiles high: clears a big Tux (two tiles). */
static const float JEV_JUMP_SPEED = 450.f;

/** Stalking keeps between these distances (px). */
static const float JEV_STALK_MIN = 3 * 32.f;
static const float JEV_STALK_MAX = 5 * 32.f;

/** Ambushing badguys strike once the player is this close (px). */
static const float JEV_AMBUSH_RANGE = 3 * 32.f;

/** Flanking badguys jump when the player is this close (px). */
static const float JEV_FLANK_JUMP_RANGE = 2.5f * 32.f;

/** Reflex: dodge when a falling player would land on us within this time. */
static const float JEV_STOMP_WARNING = 0.25f;
static const float JEV_DODGE_TIME = 0.3f;

/** Pursuers further than this from the player give up (px). */
static const float JEV_PURSUIT_RANGE = 3000.f;

/* EOF */
