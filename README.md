# Cooliomatic

Real-time chat rooms where everyone sees each other type, letter by letter. No sign-in — your name is remembered on your device.

- Static site (HTML/CSS/JS, no build) hosted on GitHub Pages
- Supabase Realtime (presence + broadcast) for rooms and live typing
- Supabase `devices` table (via `touch_device` / `get_device` RPCs) remembers each device's visits
- CoolioTube: watch YouTube together, synced
- Coolioboard: a shared drawing board in every room
- Vote-to-kick: start a vote and the room decides
- Up to 5 people per room; public rooms show in the lobby, private rooms are link/code only
