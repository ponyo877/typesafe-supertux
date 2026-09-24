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

#include "port/jev_bridge.hpp"

#include <algorithm>
#include <cmath>

#include "badguy/jev_order.hpp"
#include "object/player.hpp"

namespace {

unsigned s_options = 0;
float s_speed_scale = 1.f;

} // namespace

unsigned
jev_options()
{
  return s_options;
}

float
jev_speed_scale()
{
  return s_speed_scale;
}

float
jev_predict_landing_x(const Player& player, float ground_y)
{
  const Rectf& bbox = player.get_bbox();
  if (player.on_ground())
    return bbox.get_middle().x;

  // Plain gravity; letting go of jump would bring the player down sooner.
  const float gravity = 1000.f;
  const float vy = player.get_velocity_y();
  const float discriminant = vy * vy + 2.f * gravity * (ground_y - bbox.get_bottom());
  if (discriminant < 0.f)
    return bbox.get_middle().x;
  const float t = std::clamp((-vy + std::sqrt(discriminant)) / gravity, 0.f, 2.f);
  return bbox.get_middle().x + player.get_velocity_x() * t;
}

#ifdef __EMSCRIPTEN__

#include <sstream>
#include <vector>

#include <emscripten.h>

#include "badguy/badguy.hpp"
#include "badguy/walking_badguy.hpp"
#include "object/bullet.hpp"
#include "object/camera.hpp"
#include "supertux/game_session.hpp"
#include "supertux/globals.hpp"
#include "supertux/screen_manager.hpp"
#include "supertux/sector.hpp"

namespace {

/** How often the state is handed to the page; set by the page to match its
    model. Jev takes 70-500ms to answer, so anything faster than the default
    would only produce states nobody looks at, while a local model answers
    within a logic step or two. */
float s_send_interval = 0.25f;

/** Every badguy is one question (or a few); keep the request small. */
const size_t MAX_BADGUYS = 8;

/** Pursuers allowed offscreen at once, so the player is chased, not buried. */
const size_t MAX_OFFSCREEN_PURSUERS = 4;

const float TILE = 32.f;

float s_time_since_send = 0.f;

/** How often the benchmark (tools/eval) gets its own view of the level, in
    seconds; 0 means it did not ask for one. */
float s_bench_interval = 0.f;
float s_time_since_bench = 0.f;

/** When the player last touched down, for "just landed" (tools/coevo). */
bool s_player_was_on_ground = true;
float s_player_landed_at = -10.f;
const float JUST_LANDED = 0.3f;  // seconds; he cannot jump again that fast

/** When the player left the ground lately, for "hopping": jumping again and
    again, which makes him hard to catch on the ground. */
std::vector<float> s_player_takeoffs;
const float HOPPING_WINDOW = 2.f;  // seconds
const size_t HOPPING_JUMPS = 2;    // takeoffs within the window

/** Badguys take a zone of the level (for the co-evolved tables, which learn
    what works where): this wide, counted from the left. */
const float ZONE_WIDTH = 400.f;

const char* order_name(JevOrder order)
{
  switch (order)
  {
    case JevOrder::CHARGE: return "charge";
    case JevOrder::RETREAT: return "retreat";
    case JevOrder::HOLD: return "hold";
    case JevOrder::JUMP: return "jump";
    case JevOrder::AMBUSH: return "ambush";
    case JevOrder::INTERCEPT: return "intercept";
    case JevOrder::STALK: return "stalk";
    case JevOrder::FLANK: return "flank";
    case JevOrder::SPECIAL: return "special";
    default: return "patrol";
  }
}

const char* describe_distance(float dx)
{
  const float tiles = std::abs(dx) / TILE;
  if (tiles < 2.f) return "touching";
  if (tiles < 6.f) return "near";
  if (tiles < 12.f) return "medium";
  return "far";
}

const char* describe_player_height(const Rectf& badguy, const Player& player)
{
  const Rectf& tux = player.get_bbox();
  if (tux.get_bottom() <= badguy.get_top() + 4.f)
  {
    const bool overhead = std::abs(tux.get_middle().x - badguy.get_middle().x) < 3.f * TILE;
    if (overhead && player.get_velocity_y() > 0.f)
      return "above me and falling toward me";
    return "above me";
  }
  if (tux.get_top() >= badguy.get_bottom() - 4.f)
    return "below me";
  return "same level";
}

const char* describe_movement(float vx, bool player_is_left)
{
  if (std::abs(vx) < 10.f) return "standing";
  return ((vx < 0.f) == player_is_left) ? "toward the player" : "away from the player";
}

const char* describe_player_motion(const Player& player, bool player_is_left)
{
  const float vx = player.get_velocity_x();
  if (std::abs(vx) < 10.f) return "standing";
  return ((vx < 0.f) != player_is_left) ? "coming toward me" : "moving away";
}

const char* describe_count(int count)
{
  if (count == 0) return "none";
  if (count == 1) return "one";
  return "several";
}

const char* describe_power(const Player& player)
{
  if (player.get_bonus() == BONUS_FIRE) return "fire";
  return player.is_big() ? "big" : "small";
}

void write_player(std::ostream& out, const Player& player, bool rich)
{
  const float vx = player.get_velocity_x();
  const float vy = player.get_velocity_y();
  out << "{\"moving\":\"" << (std::abs(vx) < 10.f ? "standing" : (vx < 0.f ? "left" : "right"))
      << "\",\"vertical\":\"" << (player.on_ground() ? "on the ground" : (vy < 0.f ? "rising" : "falling"))
      << "\",\"size\":\"" << (player.is_big() ? "big" : "small")
      << "\",\"invincible\":" << (player.is_invincible() ? "true" : "false");
  if (rich)
    out << ",\"power\":\"" << describe_power(player) << "\""
        << ",\"recovering\":" << (player.is_recovering() ? "true" : "false")
        << ",\"just_landed\":" << (g_game_time - s_player_landed_at < JUST_LANDED ? "true" : "false")
        << ",\"hopping\":" << (s_player_takeoffs.size() >= HOPPING_JUMPS ? "true" : "false")
        << ",\"speed\":\"" << (std::abs(vx) < 30.f ? "still" : std::abs(vx) < 250.f ? "walk" : "run") << "\"";
  out << "}";
}

/** Whether one of the player's fireballs is flying at `badguy`. */
bool fireball_coming(Sector& sector, const Rectf& badguy)
{
  for (const auto& bullet : sector.get_objects_by_type<Bullet>())
  {
    const Rectf& bbox = bullet.get_bbox();
    const float dx = badguy.get_middle().x - bbox.get_middle().x;
    if (std::abs(bbox.get_middle().y - badguy.get_middle().y) < 1.5f * TILE &&
        std::abs(dx) < 8.f * TILE && bullet.get_movement().x * dx > 0.f)
      return true;
  }
  return false;
}

/** Lets pursuers far away give up, and keeps at most a few chasing offscreen. */
void manage_pursuit(Sector& sector)
{
  std::vector<std::pair<float, WalkingBadguy*>> offscreen;
  for (auto& badguy : sector.get_objects_by_type<WalkingBadguy>())
  {
    if (!badguy.is_jev_pursuing())
      continue;
    const Player* player = sector.get_nearest_player(badguy.get_bbox());
    if (!player || !badguy.is_valid())
    {
      badguy.stop_jev_pursuit();
      continue;
    }
    const Vector d = player->get_bbox().get_middle() - badguy.get_bbox().get_middle();
    const float distance = glm::length(d);
    if (distance > JEV_PURSUIT_RANGE)
      badguy.stop_jev_pursuit();
    else if (std::abs(d.x) > 1280.f || std::abs(d.y) > 800.f) // BadGuy's offscreen distances
      offscreen.emplace_back(distance, &badguy);
  }
  if (offscreen.size() <= MAX_OFFSCREEN_PURSUERS)
    return;
  std::sort(offscreen.begin(), offscreen.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });
  for (size_t i = MAX_OFFSCREEN_PURSUERS; i < offscreen.size(); ++i)
    offscreen[i].second->stop_jev_pursuit();
}

/** How far ahead of `player`, up to `range`, the first tile of `type` blocks
    a probe `height` tall starting `top` below the player's feet; -1 if none. */
float probe_ahead(Sector& sector, const Rectf& bbox, float dir, float top, float height,
                  float range, uint32_t type, bool free_means_hit)
{
  for (float d = 4.f; d <= range; d += 8.f)
  {
    const float x = dir > 0.f ? bbox.get_right() + d : bbox.get_left() - d;
    const Rectf probe(std::min(x, x + dir * 8.f), bbox.get_bottom() + top,
                      std::max(x, x + dir * 8.f), bbox.get_bottom() + top + height);
    const bool free = sector.is_free_of_tiles(probe, false, type);
    if (free == free_means_hit)
      return d;
  }
  return -1.f;
}

/** How high the wall starting `d` ahead of the player (to the right) is. */
float wall_height(Sector& sector, const Rectf& bbox, float d)
{
  const float x = bbox.get_right() + d + 2.f;
  float height = 0.f;
  while (height < 8.f * TILE &&
         !sector.is_free_of_tiles(Rectf(x, bbox.get_bottom() - height - TILE + 2.f, x + 8.f, bbox.get_bottom() - height - 2.f)))
    height += TILE;
  return height;
}

/** How wide the gap starting `d` ahead of the player (to the right) is. */
float gap_width(Sector& sector, const Rectf& bbox, float d)
{
  const float x = bbox.get_right() + d;
  for (float w = 0.f; w < 8.f * TILE; w += 8.f)
    if (!sector.is_free_of_tiles(Rectf(x + w, bbox.get_bottom() + 2.f, x + w + 8.f, bbox.get_bottom() + 3.f * TILE)))
      return w;
  return 8.f * TILE;
}

/** The nearest spot above the player to jump onto: ground with room for the
    player on it, 1.5 to 5 tiles up and at most 4 tiles to either side.
    Sets `dx` (to its middle) and `dy` (up, positive), or returns false. */
bool find_ledge(Sector& sector, const Rectf& bbox, float& dx, float& dy)
{
  const float cx = bbox.get_middle().x;
  const float bottom = bbox.get_bottom();
  float best = 1e9f;
  for (float x = -4.f * TILE; x <= 4.f * TILE; x += TILE / 2.f)
  {
    for (float h = 1.5f * TILE; h <= 5.f * TILE; h += TILE / 4.f)
    {
      const float top = bottom - h;
      const bool floor = !sector.is_free_of_tiles(Rectf(cx + x - 6.f, top + 1.f, cx + x + 6.f, top + 6.f));
      const bool room = sector.is_free_of_tiles(Rectf(cx + x - 12.f, top - 40.f, cx + x + 12.f, top - 1.f));
      if (floor && room)
      {
        const float cost = std::abs(x) + h / 2.f;
        if (cost < best)
        {
          best = cost;
          dx = x;
          dy = h;
        }
        break;  // the lowest spot in this column
      }
    }
  }
  return best < 1e9f;
}

/** The benchmark's view of the level: coordinates and what lies ahead, which
    the decision models never see. Handed to `window.jev_on_bench(json)`. */
void send_bench(Sector& sector)
{
  const auto players = sector.get_players();
  if (players.empty())
    return;
  const Player& player = *players.front();
  const Rectf& bbox = player.get_bbox();
  const float dir = player.get_velocity_x() < -10.f ? -1.f : 1.f;

  std::ostringstream out;
  out << "{\"x\":" << bbox.get_middle().x << ",\"y\":" << bbox.get_middle().y
      << ",\"vx\":" << player.get_velocity_x() << ",\"vy\":" << player.get_velocity_y()
      << ",\"ground\":" << (player.on_ground() ? "true" : "false")
      << ",\"big\":" << (player.is_big() ? "true" : "false")
      << ",\"alive\":" << (player.is_active() ? "true" : "false")
      << ",\"safe\":" << (player.is_recovering() || player.is_invincible() ? "true" : "false")
      // A wall: solid tiles at body height. A gap: nothing solid within three
      // tiles below the feet. Spikes: hurting tiles at or just below the feet.
      << ",\"wall\":" << probe_ahead(sector, bbox, dir, -bbox.get_height() + 4.f, bbox.get_height() - 8.f, 96.f, Tile::SOLID, false)
      << ",\"gap\":" << probe_ahead(sector, bbox, dir, 2.f, 3.f * TILE, 128.f, Tile::SOLID, true)
      << ",\"spikes\":" << probe_ahead(sector, bbox, dir, -8.f, TILE, 128.f, Tile::HURTS, false);

  // The same to the right, where the level goes, whichever way the player
  // moves; with how high the wall and how wide the gap are, and a spot above
  // to jump onto (tools/coevo).
  const float wall_r = probe_ahead(sector, bbox, 1.f, -bbox.get_height() + 4.f, bbox.get_height() - 8.f, 160.f, Tile::SOLID, false);
  const float gap_r = probe_ahead(sector, bbox, 1.f, 2.f, 3.f * TILE, 160.f, Tile::SOLID, true);
  float ledge_dx = 0.f, ledge_dy = 0.f;
  // Looked for only on the ground, where a jump can start; it is the costly one.
  const bool ledge = player.on_ground() && find_ledge(sector, bbox, ledge_dx, ledge_dy);
  out << ",\"wall_r\":" << wall_r
      << ",\"wall_h\":" << (wall_r >= 0.f ? wall_height(sector, bbox, wall_r) : 0.f)
      << ",\"gap_r\":" << gap_r
      << ",\"gap_w\":" << (gap_r >= 0.f ? gap_width(sector, bbox, gap_r) : 0.f)
      << ",\"spikes_r\":" << probe_ahead(sector, bbox, 1.f, -8.f, TILE, 160.f, Tile::HURTS, false)
      << ",\"ledge\":" << (ledge ? "true" : "false")
      << ",\"ledge_dx\":" << ledge_dx << ",\"ledge_dy\":" << ledge_dy
      << ",\"enemies\":[";
  bool first = true;
  for (auto& badguy : sector.get_objects_by_type<BadGuy>())
  {
    if (!badguy.is_valid() || !badguy.is_active())
      continue;
    const Vector d = badguy.get_bbox().get_middle() - bbox.get_middle();
    if (std::abs(d.x) > 640.f || std::abs(d.y) > 400.f)
      continue;
    out << (first ? "" : ",") << "[" << d.x << "," << d.y << "," << badguy.get_physic().get_velocity_x()
        << "," << badguy.get_physic().get_velocity_y() << ",\"" << badguy.get_class_name() << "\"]";
    first = false;
  }
  out << "]}";

  const std::string json = out.str();
  EM_ASM({
    if (window.jev_on_bench)
      window.jev_on_bench(new TextDecoder().decode(HEAPU8.slice($0, $0 + $1)));
  }, json.data(), static_cast<int>(json.size()));
}

} // namespace

extern "C" {

/** Called by the page once the decision model has answered. */
EMSCRIPTEN_KEEPALIVE
void
jev_set_order(int uid, int order, float ttl)
{
  if (!Sector::current() || uid == 0)
    return;
  if (order < static_cast<int>(JevOrder::DEFAULT) || order > static_cast<int>(JevOrder::SPECIAL))
    return;

  // The answer may be late, so the badguy can be gone by now. Uids differ
  // between sectors, so an answer from before a restart finds nothing.
  for (auto& badguy : Sector::current()->get_objects_by_type<BadGuy>())
  {
    if (badguy.get_uid().get_value() != static_cast<uint32_t>(uid))
      continue;

    if (badguy.can_follow_jev_orders())
      badguy.set_jev_order(static_cast<JevOrder>(order), std::clamp(ttl, 0.1f, 5.f));
    return;
  }
}

/** Called by the page to say how often it wants the state. 0 means every
    logic step; the page drops states that arrive while it is busy. */
EMSCRIPTEN_KEEPALIVE
void
jev_set_send_interval(float seconds)
{
  s_send_interval = std::clamp(seconds, 0.f, 2.f);
}

/** Called by the page to pick the JEV_OPT_* flags and scale the speeds. */
EMSCRIPTEN_KEEPALIVE
void
jev_set_options(int flags, float speed_scale)
{
  s_options = static_cast<unsigned>(flags);
  s_speed_scale = std::clamp(speed_scale, 0.5f, 2.f);
}

/** Called by the benchmark (tools/eval) to play many logic steps per browser
    frame. The step itself stays the same, so the game behaves as it does at
    normal speed; 0 plays in real time. */
EMSCRIPTEN_KEEPALIVE
void
jev_set_turbo(int steps)
{
  if (ScreenManager::current())
    ScreenManager::current()->set_turbo(steps);
}

/** Called by the benchmark to get its own view of the level every
    `seconds` (0 stops it), through `window.jev_on_bench(json)`. */
EMSCRIPTEN_KEEPALIVE
void
jev_set_bench(float seconds)
{
  s_bench_interval = std::max(seconds, 0.f);
  s_time_since_bench = 0.f;
}

/** Called by the benchmark to start the level over, with every badguy back
    in its place, once the current logic step is done. */
EMSCRIPTEN_KEEPALIVE
void
jev_bench_restart()
{
  if (GameSession::current())
    GameSession::current()->request_restart();
}

/** Called by the benchmark to put Tux on the ground at (x, bottom), so each
    run can start where the part of the level it measures begins. */
EMSCRIPTEN_KEEPALIVE
void
jev_bench_warp(float x, float bottom)
{
  if (!Sector::current())
    return;
  const auto players = Sector::current()->get_players();
  if (players.empty())
    return;

  Player& player = *players.front();
  const Rectf& bbox = player.get_bbox();
  player.set_pos(Vector(x - bbox.get_width() / 2.f, bottom - bbox.get_height() - 1.f));
  player.get_physic().set_velocity(0.f, 0.f);
  Sector::current()->get_camera().reset(player.get_pos());
}

/** Called by the benchmark to play Tux from the page. The bits are LEFT,
    RIGHT, UP, DOWN, JUMP and ACTION, in that order. */
EMSCRIPTEN_KEEPALIVE
void
jev_set_player_input(int bits)
{
  if (!Sector::current())
    return;
  const auto players = Sector::current()->get_players();
  if (players.empty())
    return;

  // A death starts the level over with a new player, so take the controller
  // every time rather than once.
  Player& player = *players.front();
  player.use_scripting_controller(true);

  static const char* const CONTROLS[] = { "left", "right", "up", "down", "jump", "action" };
  for (int i = 0; i < 6; ++i)
    player.do_scripting_controller(CONTROLS[i], (bits & (1 << i)) != 0);
}

} // extern "C"

namespace jev_bridge {

void
tick(Sector& sector, float dt_sec)
{
  if (s_bench_interval > 0.f && !sector.in_worldmap())
  {
    s_time_since_bench += dt_sec;
    if (s_time_since_bench >= s_bench_interval)
    {
      s_time_since_bench = 0.f;
      send_bench(sector);
    }
  }

  if (!sector.in_worldmap())
  {
    const auto players = sector.get_players();
    if (!players.empty())
    {
      const bool on_ground = players.front()->on_ground();
      if (on_ground && !s_player_was_on_ground)
        s_player_landed_at = g_game_time;
      if (!on_ground && s_player_was_on_ground && players.front()->get_velocity_y() < 0.f)
        s_player_takeoffs.push_back(g_game_time);
      while (!s_player_takeoffs.empty() && g_game_time - s_player_takeoffs.front() > HOPPING_WINDOW)
        s_player_takeoffs.erase(s_player_takeoffs.begin());
      s_player_was_on_ground = on_ground;
    }
  }

  s_time_since_send += dt_sec;
  if (s_time_since_send < s_send_interval)
    return;
  s_time_since_send = 0.f;

  if (sector.in_worldmap())
    return;

  if (s_options & JEV_OPT_PURSUIT)
    manage_pursuit(sector);

  std::vector<BadGuy*> badguys;
  for (auto& badguy : sector.get_objects_by_type<BadGuy>())
  {
    if (badguy.is_valid() && badguy.can_follow_jev_orders())
      badguys.push_back(&badguy);
  }
  if (badguys.empty())
    return;

  auto distance_to_player = [&sector](const BadGuy* badguy) {
    const Player* player = sector.get_nearest_player(badguy->get_bbox());
    if (!player) return 0.f;
    return glm::distance(player->get_bbox().get_middle(), badguy->get_bbox().get_middle());
  };

  std::sort(badguys.begin(), badguys.end(), [&](const BadGuy* a, const BadGuy* b) {
    return distance_to_player(a) < distance_to_player(b);
  });
  // Every badguy that could take orders counts as an ally, not only those
  // asked about.
  const std::vector<BadGuy*> everyone = badguys;
  if (badguys.size() > MAX_BADGUYS)
    badguys.resize(MAX_BADGUYS);

  const Player* nearest = sector.get_nearest_player(badguys.front()->get_bbox());
  if (!nearest)
    return;

  const bool rich = s_options & JEV_OPT_RICH;

  // Badguys already going for the player, close to him (for "an ally is
  // attacking", so the others can do something else).
  std::vector<const BadGuy*> attackers;
  for (const BadGuy* other : everyone)
  {
    const JevOrder order = other->get_jev_order();
    const bool attacking = order == JevOrder::CHARGE || order == JevOrder::JUMP || order == JevOrder::FLANK ||
                           order == JevOrder::INTERCEPT || order == JevOrder::SPECIAL;
    if (attacking && std::abs(other->get_bbox().get_middle().x - nearest->get_bbox().get_middle().x) < 3.f * TILE)
      attackers.push_back(other);
  }

  std::ostringstream out;
  out << "{\"player\":";
  write_player(out, *nearest, rich);
  out << ",\"enemies\":{";

  bool first = true;
  for (BadGuy* badguy : badguys)
  {
    const Player* player = sector.get_nearest_player(badguy->get_bbox());
    if (!player)
      continue;

    const Rectf& bbox = badguy->get_bbox();
    const float dx = player->get_bbox().get_middle().x - bbox.get_middle().x;
    const bool player_is_left = dx < 0.f;

    int allies = 0;
    for (const BadGuy* other : badguys)
    {
      if (other != badguy && glm::distance(other->get_bbox().get_middle(), bbox.get_middle()) < 5.f * TILE)
        ++allies;
    }

    // Is a wall right in the way to the player? A line of sight would be
    // blocked by every hilltop, which made badguys wait instead of walking
    // over. Walls further away don't matter: a charging badguy jumps when it
    // runs into one. Raise the probe so that walkable slopes don't count.
    const Rectf ahead = bbox.moved(Vector(player_is_left ? -TILE / 2.f : TILE / 2.f, -TILE * 0.75f));
    const bool wall = !sector.is_free_of_tiles(ahead, /* ignoreUnisolid = */ true);

    // All values are fixed phrases or class names, nothing needs escaping.
    if (!first) out << ",";
    first = false;
    out << "\"e" << badguy->get_uid().get_value() << "\":{"
        << "\"kind\":\"" << badguy->get_class_name() << "\""
        << ",\"player_is\":\"" << (player_is_left ? "to my left" : "to my right") << "\""
        << ",\"distance\":\"" << describe_distance(dx) << "\""
        << ",\"player_height\":\"" << describe_player_height(bbox, *player) << "\""
        << ",\"i_am_moving\":\"" << describe_movement(badguy->get_physic().get_velocity_x(), player_is_left) << "\""
        << ",\"wall_in_my_way\":" << (wall ? "true" : "false")
        << ",\"allies_nearby\":\"" << describe_count(allies) << "\""
        << ",\"current_action\":\"" << order_name(badguy->get_jev_order()) << "\"";

    if (rich)
    {
      // Allies closer to the player on our side, or already on the far side.
      bool ally_between = false;
      bool ally_beyond = false;
      for (const BadGuy* other : everyone)
      {
        if (other == badguy)
          continue;
        const float other_dx = player->get_bbox().get_middle().x - other->get_bbox().get_middle().x;
        if (std::abs(other_dx) > 8.f * TILE)
          continue;
        if ((other_dx < 0.f) == player_is_left)
          ally_between |= std::abs(other_dx) < std::abs(dx) &&
                          std::abs(other->get_bbox().get_bottom() - bbox.get_bottom()) < 3.f * TILE;
        else
          ally_beyond = true;
      }

      const char* landing = "none";
      if (!player->on_ground())
        landing = std::abs(jev_predict_landing_x(*player, bbox.get_bottom()) - bbox.get_middle().x) < 3.f * TILE
                  ? "near me" : "far from me";

      out << ",\"player_motion\":\"" << describe_player_motion(*player, player_is_left) << "\""
          << ",\"spikes_ahead\":" << (badguy->jev_spikes_ahead(player_is_left) ? "true" : "false")
          << ",\"ally_between\":" << (ally_between ? "true" : "false")
          << ",\"ally_beyond_player\":" << (ally_beyond ? "true" : "false")
          << ",\"landing\":\"" << landing << "\""
          << ",\"special\":\"" << badguy->jev_special_status() << "\""
          << ",\"fireball_coming\":" << (fireball_coming(sector, bbox) ? "true" : "false")
          << ",\"close\":" << (std::abs(dx) < TILE ? "true" : "false")
          << ",\"ally_attacking\":" << (std::any_of(attackers.begin(), attackers.end(),
                                                    [badguy](const BadGuy* a) { return a != badguy; }) ? "true" : "false")
          << ",\"zone\":" << static_cast<int>(std::max(bbox.get_middle().x, 0.f) / ZONE_WIDTH);
    }
    out << "}";
  }
  out << "}}";

  if (first)
    return;

  const std::string json = out.str();
  EM_ASM({
    if (window.jev_on_state)
      window.jev_on_state(new TextDecoder().decode(HEAPU8.slice($0, $0 + $1)));
  }, json.data(), static_cast<int>(json.size()));
}

void
event(const char* type, const char* detail)
{
  // Where the player is says how far this life got; the state deliberately
  // carries no coordinates, but a benchmark needs them.
  float x = 0.f;
  float y = 0.f;
  if (Sector::current())
  {
    const auto players = Sector::current()->get_players();
    if (!players.empty())
    {
      const Vector middle = players.front()->get_bbox().get_middle();
      x = middle.x;
      y = middle.y;
    }
  }

  std::ostringstream out;
  out << "{\"type\":\"" << type << "\",\"detail\":\"" << detail
      << "\",\"x\":" << x << ",\"y\":" << y << ",\"t\":" << g_game_time << "}";

  const std::string json = out.str();
  EM_ASM({
    if (window.jev_on_event)
      window.jev_on_event(new TextDecoder().decode(HEAPU8.slice($0, $0 + $1)));
  }, json.data(), static_cast<int>(json.size()));
}

} // namespace jev_bridge

#else

namespace jev_bridge {

void
tick(Sector&, float)
{
}

void
event(const char*, const char*)
{
}

} // namespace jev_bridge

#endif

/* EOF */
