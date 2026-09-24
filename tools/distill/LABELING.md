# Labeling guide: which order should this badguy follow?

You are the teacher for the enemy AI of a SuperTux level (Shallow Green). For
each situation below, pick the one order that gives this badguy the best
chance of hurting the player soon without getting stomped itself. Your
answers become a lookup table the badguys follow in the browser.

## The game in brief

- The player is Tux. He walks at 230 px/s, runs at 320 px/s, and jumps about
  3 to 4 tiles high (a tile is 32 px). The level goes from left to right.
- Tux kills a badguy by landing on it from above (a stomp). Touching a badguy
  from the side hurts Tux: a small Tux dies, a big one shrinks and blinks for
  a moment (then he cannot be hurt).
- A stomped Snail turns into a shell Tux can kick; a stomped Mr. Bomb lights
  its fuse and explodes a moment later; the others die.
- The human player mostly moves right, jumps over or onto badguys, and backs
  off when two come at once.

## What the facts mean

Every fact is about this badguy ("me") and the player:

| fact | values | meaning |
|---|---|---|
| kind | viciousivy, walkingleaf, igel, snail, mrbomb, jumpy | what I am (see "Specials") |
| distance | touching (< 2 tiles), near (< 6), medium (< 12), far | horizontal distance only |
| height | same level, above me, above me and falling toward me, below me | where the player is vertically |
| vertical | on the ground, rising, falling | what the player's jump is doing |
| motion | coming toward me, moving away, standing | the player's horizontal movement, relative to me |
| landing_near | true / false | while he is in the air, his predicted landing point is within 3 tiles of me |
| wall | true / false | a wall blocks my path toward the player |
| spikes | true / false | spikes right in front of me |
| between | true / false | an ally is between me and the player (closer to him, on my side) |
| beyond | true / false | an ally is on the other side of the player (within 8 tiles) |
| ready | true / false | my special move can be used now |
| invincible, fireball, recovering | true / false | the player has star power / a fireball flies at me / the player blinks after a hit |

## The orders (exactly what the game does with them)

An order lasts 1 second and is decided again 20 times a second, so pick what
is best right now, not a long plan.

| order | behaviour |
|---|---|
| charge | run straight at the player (200 px/s); does not turn back at ledges; stops before spikes |
| retreat | run away from the player |
| hold | stand still facing the player; stays on its platform |
| jump | run at the player and jump once (about 3 tiles high) as soon as it is on the ground |
| ambush | stand still; once the player is within 3 tiles horizontally and 2 vertically, charge at 1.2x speed |
| intercept | run at 1.2x speed to where the player will land and wait there (when he is on the ground: to where he stands) |
| stalk | keep 3 to 5 tiles away: back off when closer, come closer when farther, else stand facing him |
| flank | run at the player, jump over him when within 2.5 tiles, then charge him from behind |
| special | the kind's special move (below); for a snail this is the same as charge |

### Specials

- **igel** (hedgehog): a fast rolling charge. Afterwards it keeps rolling and
  takes no orders for a while, and then needs to recharge (`ready` is false).
- **mrbomb**: runs at the player at 1.2x speed and blows itself up once within
  about one tile. The blast hurts Tux; Mr. Bomb is gone either way.
- **viciousivy**, **walkingleaf**: a floating leap toward the player; only
  possible from the ground (`ready` is true when on the ground).
- **jumpy**: a high hop that comes down right on the player's head.
- **snail**: none (special = charge).

### Jumpy follows orders only when it lands

Jumpy never walks. When it touches the ground it hops again, and the order
chooses the hop: charge or flank hop toward the player; jump is a high hop
straight up; retreat hops away; hold and ambush are a small hop in place;
stalk is a gentle hop keeping its distance; intercept hops to where the player
will land; special comes down on his head.

## What happens regardless of your answer

- When the player is "above me and falling toward me" or has star power,
  the badguy retreats whatever the table says. Label those situations anyway,
  as if the override did not exist.
- When a stomp is about to land (within 0.25 s), the badguy dashes aside for
  0.3 s by reflex, unless it is retreating.
- Badguys never walk into spikes while following an order.

## How to answer

One JSON object per line, for every situation in your file, in the same order:

```
{"id": 17, "order": "intercept", "why": "he is in the air and will land next to me"}
```

- `order` is one of: charge, retreat, hold, jump, ambush, intercept, stalk, flank, special.
- `why` is a few words; it is kept to review the labels later.
- Judge each situation on its facts. Think about what a clever, cooperative
  enemy would do: badguys that all charge head-on are easy to jump over or
  stomp; ones that wait, cut off landings, attack from both sides or keep a
  safe distance until the right moment are not. Staying alive matters too: a
  stomped badguy hurts nobody.
