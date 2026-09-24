# Labeling guide: which move should Tux make?

You are the teacher for an AI that plays Tux through a SuperTux level
(Shallow Green). For each situation below, pick the one move that gives Tux
the best chance of getting through the level: moving right, alive, without
getting stuck. Your answers become a lookup table the AI follows; later it
keeps learning from play, against badguys that learn too.

## The game in brief

- The level goes from left to right. A tile is 32 px. Tux walks at 230 px/s
  and runs at 320 px/s. Holding jump longer jumps higher: a quick tap clears
  about 1 tile, a full jump about 3 tiles standing and a bit more running; a
  running jump carries about 4 to 5 tiles forward.
- Landing on a badguy from above stomps it (a stomped Snail becomes a shell,
  a stomped Mr. Bomb explodes a moment later, so step away). Touching one
  from the side hurts Tux; a small Tux dies.
- Badguys in this level may be clever: they can wait, retreat when Tux
  jumps at them, cut off where he lands, jump over him, or come from both
  sides. Jumpy hops high and comes down on Tux's head.
- Some walls are too high to jump. The way up is then a ledge (a branch or a
  step) to jump onto first, sometimes behind Tux.

## What the facts mean

Everything is seen looking right, where the level goes.

| fact | values | meaning |
|---|---|---|
| air | ground, rising, falling | what Tux is doing |
| speed | still, walk, run | how fast he moves |
| wall | none, near/far + low (up to 2 tiles), high (up to 4), cliff (higher) | the next wall ahead; near is under 1.5 tiles, far under 5 |
| gap | none, near/far + narrow (up to 2 tiles), wide | the next hole ahead |
| spikes | none, near (under 2 tiles), far (under 5) | spikes ahead |
| ledge | none, ahead/behind/above + low (up to 3 tiles up) / high (up to 5) | the nearest spot to jump onto, only looked for on the ground |
| enemy | none, touching (under 40 px), near (under 120 px), medium (under 260 px) | the nearest badguy ahead on about his level |
| enemy_coming | true / false | that badguy moves toward Tux |
| enemy_kind | walker, bomb, jumpy | what it is (walker when there is none) |
| enemy_above | true / false | a badguy right above Tux (a Jumpy coming down, a leaf in the air) |
| enemy_behind | true / false | a badguy close behind him |

## The moves

A move is chosen, carried out, and then the next one is chosen. Walking,
running, waiting and backing off last a fifth of a second; a jump lasts until
Tux lands.

| move | what Tux does |
|---|---|
| run | run right |
| walk | walk right |
| wait | stand still |
| back | walk left for a quarter second |
| hop | a small jump to the right (about 1 tile high) |
| jump | a medium jump to the right (about 2 tiles high); the usual stomp |
| long jump | a running full jump to the right: far and high, for gaps and high walls |
| high jump | a full jump straight up, for a ledge right above |
| back jump | a full jump to the left, for a ledge behind |

A jump move chosen in the air only steers (like walk, back or wait).

## How to answer

One JSON object per line, for every situation in your file, in the same order:

```
{"id": 17, "order": "long jump", "why": "wide gap close ahead"}
```

- `order` is one of: run, walk, wait, back, hop, jump, long jump, high jump, back jump.
- `why` is a few words.
- Judge each situation on its facts, the way a good player would: keep
  moving right, clear what is in the way, stomp or avoid badguys depending
  on what they do, and never stand where a badguy will land.
