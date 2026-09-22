//  SuperTux
//  Copyright (C) 2006 Matthias Braun <matze@braunis.de>
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

#include "badguy/jumpy.hpp"

#include <algorithm>

#include "object/player.hpp"
#include "sprite/sprite.hpp"

static const float JUMPYSPEED =- 600;
static const float JUMPY_MID_TOLERANCE = 4;
static const float JUMPY_LOW_TOLERANCE = 2;

Jumpy::Jumpy(const ReaderMapping& reader) :
  BadGuy(reader, "images/creatures/jumpy/snowjumpy.sprite"),
  pos_groundhit(0.0f, 0.0f),
  groundhit_pos_set(false)
{
  parse_type(reader);

  set_action(m_dir, "middle");
  // TODO: Create a suitable sound for this...
  // SoundManager::current()->preload("sounds/skid.wav");
}

GameObjectTypes
Jumpy::get_types() const
{
  return {
    { "snow", _("Snow") },
    { "wooden", _("Wooden") },
    { "corrupted", _("Corrupted") },
    { "metal", _("Metal") },
    { "bag", _("Bag") }
  };
}

std::string
Jumpy::get_default_sprite_name() const
{
  switch (m_type)
  {
    case WOODEN:
      return "images/creatures/jumpy/woodjumpy.sprite";
    case CORRUPTED:
      return "images/creatures/jumpy/corruptjumpy.sprite";
    case METAL:
      return "images/creatures/jumpy/metaljumpy.sprite";
    case BAG:
      return "images/creatures/bag/bag.sprite";
    default:
      return m_default_sprite_name;
  }
}

void
Jumpy::collision_solid(const CollisionHit& chit)
{
  hit(chit);
  if (m_frozen)
    BadGuy::collision_solid(chit);
}

HitResponse
Jumpy::collision_badguy(BadGuy& , const CollisionHit& chit)
{
  return hit(chit);
}

HitResponse
Jumpy::hit(const CollisionHit& chit)
{
  if (chit.bottom) {
    pos_groundhit = get_pos();
    groundhit_pos_set = true;

    if (m_frozen || get_state() != STATE_ACTIVE)
    {
      m_physic.set_velocity(0.f, 0.f);
    }
    else
    {
      const Vector hop = jev_hop();
      m_physic.set_velocity(hop.x, hop.y);
    }
    // TODO: Create a suitable sound for this...
    // SoundManager::current()->play("sounds/skid.wav", get_pos());
    update_on_ground_flag(chit);
  } else if (chit.top) {
    m_physic.set_velocity_y(0);
  } else if (chit.left || chit.right) {
    m_physic.set_velocity_x(0);
  }

  return CONTINUE;
}

bool
Jumpy::can_follow_jev_orders() const
{
  return (jev_options() & JEV_OPT_JUMPY) && is_active() && !m_frozen;
}

Vector
Jumpy::jev_hop() const
{
  const JevOrder order = can_follow_jev_orders() ? get_jev_order() : JevOrder::DEFAULT;
  const Player* player = get_nearest_player();
  if (order == JevOrder::DEFAULT || !player)
    return Vector(0.f, JUMPYSPEED);

  const float dx = player->get_bbox().get_middle().x - get_bbox().get_middle().x;
  const float towards = (dx < 0.f) ? -1.f : 1.f;
  const float scale = jev_speed_scale();
  // A hop of -450 lasts 0.9 s, one of -750 lasts 1.5 s.
  Vector hop(0.f, -450.f);
  switch (order)
  {
    case JevOrder::SPECIAL: // come down right on the player
      hop = Vector(std::clamp(dx / 1.5f, -250.f, 250.f) * scale, -750.f);
      break;
    case JevOrder::JUMP:
      hop.y = -750.f;
      break;
    case JevOrder::RETREAT:
      hop.x = -towards * 150.f * scale;
      break;
    case JevOrder::HOLD:
    case JevOrder::AMBUSH:
      hop.y = -350.f;
      break;
    case JevOrder::STALK:
      if (std::abs(dx) < JEV_STALK_MIN)
        hop.x = -towards * 120.f * scale;
      else if (std::abs(dx) > JEV_STALK_MAX)
        hop.x = towards * 120.f * scale;
      break;
    case JevOrder::INTERCEPT:
    {
      const float to_landing = jev_predict_landing_x(*player, get_bbox().get_bottom()) - get_bbox().get_middle().x;
      hop.x = std::clamp(to_landing / 0.9f, -200.f, 200.f) * scale;
      break;
    }
    default: // CHARGE, FLANK
      hop.x = towards * 170.f * scale;
      break;
  }

  // Never hop into a spike pit.
  const float flight = -2.f * hop.y / 1000.f;
  if (hop.x != 0.f && jev_spikes_at(get_bbox().get_middle().x + hop.x * flight))
    hop.x = 0.f;
  return hop;
}

void
Jumpy::active_update(float dt_sec)
{
  BadGuy::active_update(dt_sec);

  if (m_frozen)
    return;

  auto player = get_nearest_player();
  if (player)
  {
    m_dir = (player->get_pos().x > get_pos().x) ? Direction::RIGHT : Direction::LEFT;
  }

  if (!groundhit_pos_set)
  {
    set_action("editor", m_dir);
    return;
  }

  if (get_pos().y > pos_groundhit.y)
  {
    // Jumpy is below its groundhit position,
    // ground tile probably doesn't exist anymore
    set_action(m_dir, "down");
    return;
  }

  if ( get_pos().y < (pos_groundhit.y - JUMPY_MID_TOLERANCE ) )
    set_action(m_dir, "up");
  else if ( get_pos().y >= (pos_groundhit.y - JUMPY_MID_TOLERANCE) &&
            get_pos().y < (pos_groundhit.y - JUMPY_LOW_TOLERANCE) )
    set_action(m_dir, "middle");
  else
    set_action(m_dir, "down");
}

void
Jumpy::on_flip(float height)
{
  BadGuy::on_flip(height);
  groundhit_pos_set = false;
}

void
Jumpy::freeze()
{
  BadGuy::freeze();
  m_physic.set_velocity_y(std::max(0.0f, m_physic.get_velocity_y()));
}

bool
Jumpy::is_freezable() const
{
  return true;
}

bool
Jumpy::is_flammable() const
{
  return true;
}

std::vector<Direction>
Jumpy::get_allowed_directions() const
{
  return {};
}

/* EOF */
