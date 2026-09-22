//  SuperTux - WalkingBadguy
//  Copyright (C) 2006 Christoph Sommer <christoph.sommer@2006.expires.deltadevelopment.de>
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

#include "badguy/walking_badguy.hpp"

#include <algorithm>
#include <math.h>

#include "object/player.hpp"
#include "sprite/sprite.hpp"
#include "supertux/sector.hpp"
#include "supertux/tile.hpp"

// Ice physics constant (identical to player ice physics)
static const float BADGUY_ICE_ACCELERATION_MULTIPLIER = 0.25f;

WalkingBadguy::WalkingBadguy(const Vector& pos,
                             const std::string& sprite_name_,
                             const std::string& walk_left_action_,
                             const std::string& walk_right_action_,
                             int layer_,
                             const std::string& light_sprite_name) :
  BadGuy(pos, sprite_name_, layer_, light_sprite_name),
  walk_left_action(walk_left_action_),
  walk_right_action(walk_right_action_),
  walk_speed(80),
  max_drop_height(-1),
  turn_around_timer(),
  turn_around_counter(),
  m_stay_on_platform_overridden(false),
  m_jev_jump_pending(false),
  m_jev_pursuing(false),
  m_jev_flank_left(false),
  m_jev_dodge_timer(),
  m_jev_dodge_left(false)
{
}

WalkingBadguy::WalkingBadguy(const Vector& pos,
                             Direction direction,
                             const std::string& sprite_name_,
                             const std::string& walk_left_action_,
                             const std::string& walk_right_action_,
                             int layer_,
                             const std::string& light_sprite_name) :
  BadGuy(pos, direction, sprite_name_, layer_, light_sprite_name),
  walk_left_action(walk_left_action_),
  walk_right_action(walk_right_action_),
  walk_speed(80),
  max_drop_height(-1),
  turn_around_timer(),
  turn_around_counter(),
  m_stay_on_platform_overridden(false),
  m_jev_jump_pending(false),
  m_jev_pursuing(false),
  m_jev_flank_left(false),
  m_jev_dodge_timer(),
  m_jev_dodge_left(false)
{
}

WalkingBadguy::WalkingBadguy(const ReaderMapping& reader,
                             const std::string& sprite_name_,
                             const std::string& walk_left_action_,
                             const std::string& walk_right_action_,
                             int layer_,
                             const std::string& light_sprite_name) :
  BadGuy(reader, sprite_name_, layer_, light_sprite_name),
  walk_left_action(walk_left_action_),
  walk_right_action(walk_right_action_),
  walk_speed(80),
  max_drop_height(-1),
  turn_around_timer(),
  turn_around_counter(),
  m_stay_on_platform_overridden(false),
  m_jev_jump_pending(false),
  m_jev_pursuing(false),
  m_jev_flank_left(false),
  m_jev_dodge_timer(),
  m_jev_dodge_left(false)
{
}

void
WalkingBadguy::initialize()
{
  if (m_frozen)
    return;
  set_action(m_dir == Direction::LEFT ? walk_left_action : walk_right_action);
  m_col.m_bbox.set_size(m_sprite->get_current_hitbox_width(), m_sprite->get_current_hitbox_height());
  m_physic.set_velocity_x(m_dir == Direction::LEFT ? -walk_speed : walk_speed);
  m_physic.set_acceleration_x (0.0);
}

void
WalkingBadguy::set_walk_speed (float ws)
{
  walk_speed = fabsf(ws);
  /* physic.set_velocity_x(dir == LEFT ? -walk_speed : walk_speed); */
}

void WalkingBadguy::set_ledge_behavior(LedgeBehavior behavior)
{
  switch (behavior)
  {
    case LedgeBehavior::STRICT:
      max_drop_height = 0;
      break;

    case LedgeBehavior::SMART:
      max_drop_height = 16.f;
      break;

    case LedgeBehavior::NORMAL:
      max_drop_height = s_normal_max_drop_height;
      break;

    case LedgeBehavior::FALL:
      max_drop_height = -1;
      break;
  }
}

void
WalkingBadguy::add_velocity (const Vector& velocity)
{
  m_physic.set_velocity(m_physic.get_velocity() + velocity);
}

void
WalkingBadguy::active_update(float dt_sec, float dest_x_velocity, float modifier)
{
  BadGuy::active_update(dt_sec);

  // Walk down slopes smoothly.
  if (on_ground() && m_floor_normal.y != 0 && (m_floor_normal.x * m_physic.get_velocity_x()) >= 0) {
    m_physic.set_velocity_y((std::abs(m_physic.get_velocity_x()) * std::abs(m_floor_normal.x)) + 100.f);
  }

  float current_x_velocity = m_physic.get_velocity_x ();

  if (m_frozen)
    return;
  /* We're very close to our target speed. Just set it to avoid oscillation */
  if ((current_x_velocity > (dest_x_velocity - 5.0f)) &&
           (current_x_velocity < (dest_x_velocity + 5.0f)))
  {
    m_physic.set_velocity_x (dest_x_velocity);
    m_physic.set_acceleration_x (0.0);
  }
  /* Check if we're going too slow or even in the wrong direction */
  else if (((dest_x_velocity <= 0.0f) && (current_x_velocity > dest_x_velocity)) ||
           ((dest_x_velocity > 0.0f) && (current_x_velocity < dest_x_velocity)))
  {
    /* acceleration == walk-speed => it will take one second to get from zero
     * to full speed. */
    float ice_multiplier = (m_on_ice && on_ground()) ? BADGUY_ICE_ACCELERATION_MULTIPLIER : 1.0f;
    m_physic.set_acceleration_x (dest_x_velocity * modifier * ice_multiplier);
  }
  /* Check if we're going too fast */
  else if (((dest_x_velocity <= 0.0f) && (current_x_velocity < dest_x_velocity)) ||
           ((dest_x_velocity > 0.0f) && (current_x_velocity > dest_x_velocity)))
  {
    /* acceleration == walk-speed => it will take one second to get twice the
     * speed to normal speed. */
    float ice_multiplier = (m_on_ice && on_ground()) ? BADGUY_ICE_ACCELERATION_MULTIPLIER : 1.0f;
    m_physic.set_acceleration_x ((-1.f) * dest_x_velocity * ice_multiplier);
  }
  else
  {
    /* The above should have covered all cases. */
    assert(false);
  }

  if (max_drop_height > -1 && on_ground() && might_fall(max_drop_height+1) && !m_stay_on_platform_overridden)
    turn_around();
  m_stay_on_platform_overridden = false;

  if ((m_dir == Direction::LEFT) && (m_physic.get_velocity_x () > 0.0f)) {
    m_dir = Direction::RIGHT;
    set_action (walk_right_action, /* loops = */ -1);
  }
  else if ((m_dir == Direction::RIGHT) && (m_physic.get_velocity_x () < 0.0f)) {
    m_dir = Direction::LEFT;
    set_action (walk_left_action, /* loops = */ -1);
  }
}

void
WalkingBadguy::active_update(float dt_sec)
{
  if (jev_update(dt_sec))
    return;

  active_update (dt_sec, (m_dir == Direction::LEFT) ? -walk_speed : +walk_speed);
}

void
WalkingBadguy::set_jev_order(JevOrder order, float ttl)
{
  if (order == JevOrder::FLANK && get_jev_order() != JevOrder::FLANK)
  {
    // Go around the player: past them, whichever side they are on now.
    if (const Player* player = get_nearest_player())
      m_jev_flank_left = player->get_bbox().get_middle().x < get_bbox().get_middle().x;
  }

  BadGuy::set_jev_order(order, ttl);
  if (order == JevOrder::JUMP)
    m_jev_jump_pending = true;
  if (jev_options() & JEV_OPT_PURSUIT)
    m_jev_pursuing = true;
}

bool
WalkingBadguy::can_follow_jev_orders() const
{
  return is_active() && !m_frozen;
}

bool
WalkingBadguy::always_active() const
{
  return m_jev_pursuing && (jev_options() & JEV_OPT_PURSUIT);
}

bool
WalkingBadguy::jev_in_control() const
{
  return get_jev_order() != JevOrder::DEFAULT || always_active();
}

bool
WalkingBadguy::jev_stomp_imminent(const Player& player) const
{
  const Rectf& me = get_bbox();
  const Rectf& tux = player.get_bbox();
  const float vy = player.get_velocity_y();
  if (player.on_ground() || vy <= 0.f || tux.get_bottom() > me.get_top() + 16.f)
    return false;

  const float t = (me.get_top() - tux.get_bottom()) / vy;
  if (t > JEV_STOMP_WARNING)
    return false;
  const float x = tux.get_middle().x + player.get_velocity_x() * t;
  return std::abs(x - me.get_middle().x) < (me.get_width() + tux.get_width()) / 2.f + 4.f;
}

void
WalkingBadguy::jev_stand(float dt_sec, Direction facing)
{
  // A target velocity of 0 results in an acceleration of 0, so stop by hand.
  m_physic.set_velocity_x(0.f);
  if (m_dir != facing)
  {
    m_dir = facing;
    set_action(m_dir == Direction::LEFT ? walk_left_action : walk_right_action, /* loops = */ -1);
  }
  // Facing a ledge must not turn us around, over and over until we get dizzy.
  m_stay_on_platform_overridden = true;
  active_update(dt_sec, 0.f);
}

void
WalkingBadguy::jev_run(float dt_sec, bool left, float speed)
{
  // Charging into a spike pit is not a tactic.
  if (on_ground() && jev_spikes_ahead(left))
  {
    jev_stand(dt_sec, left ? Direction::LEFT : Direction::RIGHT);
    return;
  }

  if (m_jev_jump_pending && on_ground())
  {
    m_physic.set_velocity_y(-JEV_JUMP_SPEED);
    m_jev_jump_pending = false;
  }

  // Don't let a ledge break off the chase.
  m_stay_on_platform_overridden = true;
  active_update(dt_sec, left ? -speed : speed, JEV_ACCELERATION_MODIFIER);
}

bool
WalkingBadguy::jev_special(float, const Player&)
{
  return false;
}

bool
WalkingBadguy::jev_update(float dt_sec)
{
  // E.g. a rolling Igel or a flipped Snail runs its course.
  if (!can_follow_jev_orders())
    return false;

  const bool pursuing = always_active();
  JevOrder order = get_jev_order();
  // Keep chasing while the model looks after the badguys nearer the player.
  if (order == JevOrder::DEFAULT && pursuing)
    order = JevOrder::CHARGE;
  if (order == JevOrder::DEFAULT)
    return false;

  const Player* player = get_nearest_player();
  if (!player)
    return false;

  const Rectf& me = get_bbox();
  const Rectf& tux = player->get_bbox();
  const float dx = tux.get_middle().x - me.get_middle().x;
  const bool player_left = dx < 0.f;
  const Direction towards = player_left ? Direction::LEFT : Direction::RIGHT;
  float speed = std::max(walk_speed, JEV_RUN_SPEED * jev_speed_scale());
  if (pursuing && is_offscreen())
    speed = std::max(speed, JEV_CATCHUP_SPEED * jev_speed_scale());

  // Get out from under a stomp without waiting for the model.
  if ((jev_options() & JEV_OPT_REFLEX) && order != JevOrder::RETREAT)
  {
    if (!m_jev_dodge_timer.started() && jev_stomp_imminent(*player))
    {
      m_jev_dodge_left = tux.get_middle().x + player->get_velocity_x() * JEV_STOMP_WARNING > me.get_middle().x;
      m_jev_dodge_timer.start(JEV_DODGE_TIME);
    }
    if (m_jev_dodge_timer.started())
    {
      jev_run(dt_sec, m_jev_dodge_left, speed * 1.3f);
      return true;
    }
  }

  switch (order)
  {
    case JevOrder::HOLD:
      jev_stand(dt_sec, towards);
      break;

    case JevOrder::RETREAT:
      jev_run(dt_sec, !player_left, speed);
      break;

    case JevOrder::AMBUSH:
      if (std::abs(dx) < JEV_AMBUSH_RANGE && std::abs(tux.get_bottom() - me.get_bottom()) < 2 * 32.f)
      {
        // Strike.
        BadGuy::set_jev_order(JevOrder::CHARGE, 1.f);
        jev_run(dt_sec, player_left, speed * 1.2f);
      }
      else
      {
        jev_stand(dt_sec, towards);
      }
      break;

    case JevOrder::INTERCEPT:
    {
      const float to_landing = jev_predict_landing_x(*player, me.get_bottom()) - me.get_middle().x;
      if (std::abs(to_landing) < 8.f)
        jev_stand(dt_sec, towards);
      else
        jev_run(dt_sec, to_landing < 0.f, speed * 1.2f);
      break;
    }

    case JevOrder::STALK:
      // Wait out the player's blinking just outside their reach.
      if (std::abs(dx) < JEV_STALK_MIN)
        jev_run(dt_sec, !player_left, speed);
      else if (std::abs(dx) > JEV_STALK_MAX)
        jev_run(dt_sec, player_left, speed);
      else
        jev_stand(dt_sec, towards);
      break;

    case JevOrder::FLANK:
      if (player_left != m_jev_flank_left)
      {
        // Made it past the player: attack them from behind.
        BadGuy::set_jev_order(JevOrder::CHARGE, 1.f);
        jev_run(dt_sec, player_left, speed);
      }
      else
      {
        if (on_ground() && std::abs(dx) < JEV_FLANK_JUMP_RANGE)
          m_jev_jump_pending = true;
        jev_run(dt_sec, m_jev_flank_left, speed * 1.2f);
      }
      break;

    case JevOrder::SPECIAL:
      if (!jev_special(dt_sec, *player))
        jev_run(dt_sec, player_left, speed);
      break;

    case JevOrder::JUMP:
    case JevOrder::CHARGE:
    default:
      jev_run(dt_sec, player_left, speed);
      break;
  }
  return true;
}

void
WalkingBadguy::collision_solid(const CollisionHit& hit)
{

  update_on_ground_flag(hit);

  if (m_frozen || !is_active())
  {
    BadGuy::collision_solid(hit);
    return;
  }

  if (hit.top) {
    if (m_physic.get_velocity_y() < 0) m_physic.set_velocity_y(0);
  }
  if (hit.bottom) {
    if (m_physic.get_velocity_y() > 0) m_physic.set_velocity_y(0);
  }

  if ( hit.slope_normal.x == 0.0f &&
      ((hit.left && m_dir == Direction::LEFT) ||
      (hit.right && m_dir == Direction::RIGHT)) ) {
    if (!jev_in_control())
      turn_around();
    else if (get_jev_order() != JevOrder::HOLD && get_jev_order() != JevOrder::AMBUSH)
      // Turning around would only make us run into the wall again, as the
      // order decides where to go. Try to get over it instead. (Standing
      // badguys don't turn either: facing the player again right after would
      // make them dizzy.)
      m_jev_jump_pending = true;
  }

}

HitResponse
WalkingBadguy::collision_badguy(BadGuy& badguy, const CollisionHit& hit)
{
  if (hit.top) {
    return FORCE_MOVE;
  }

  if (badguy.is_frozen())
    collision_solid(hit);

  // While following an order, turning around would be undone right away, and
  // doing so over and over makes us dizzy (see turn_around()).
  if (!jev_in_control() &&
      ((hit.left && (m_dir == Direction::LEFT)) || (hit.right && (m_dir == Direction::RIGHT)))) {
    turn_around();
  }

  return CONTINUE;
}

void
WalkingBadguy::turn_around()
{
  if (m_frozen)
    return;
  m_dir = m_dir == Direction::LEFT ? Direction::RIGHT : Direction::LEFT;
  if (get_state() == STATE_INIT || get_state() == STATE_INACTIVE || get_state() == STATE_ACTIVE) {
    set_action(m_dir == Direction::LEFT ? walk_left_action : walk_right_action);
  }
  m_physic.set_velocity_x(-m_physic.get_velocity_x());
  m_physic.set_acceleration_x (-m_physic.get_acceleration_x ());

  // if we get dizzy, we fall off the screen
  if (turn_around_timer.started()) {
    if (turn_around_counter++ > 10) kill_fall();
  } else {
    turn_around_timer.start(1);
    turn_around_counter = 0;
  }

}

void
WalkingBadguy::unfreeze(bool melt)
{
  BadGuy::unfreeze(melt);
  WalkingBadguy::initialize();
}

/* EOF */
