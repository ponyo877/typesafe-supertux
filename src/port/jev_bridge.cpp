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
        << ",\"recovering\":" << (player.is_recovering() ? "true" : "false");
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

} // extern "C"

namespace jev_bridge {

void
tick(Sector& sector, float dt_sec)
{
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
          << ",\"fireball_coming\":" << (fireball_coming(sector, bbox) ? "true" : "false");
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

} // namespace jev_bridge

#else

namespace jev_bridge {

void
tick(Sector&, float)
{
}

} // namespace jev_bridge

#endif

/* EOF */
