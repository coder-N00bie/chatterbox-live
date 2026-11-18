# Cooliomatic

Real-time chat rooms where everyone sees each other type, letter by letter. No sign-in — your name is remembered on your device.

- Static site (HTML/CSS/JS, no build) hosted on GitHub Pages
- Supabase Realtime (presence + broadcast) for rooms and live typing
- Supabase `devices` table (via `touch_device` / `get_device` RPCs) remembers each device's visits
- CoolioTube: watch YouTube together, synced
- Coolioboard: a shared drawing board in every room
- Vote-to-kick: start a vote and the room decides
- Up to 5 people per room; public rooms show in the lobby, private rooms are link/code only

## Admin mode

Click **admin** at the bottom of the page (or go to `#admin`) and type the admin code. You'll see every device that has visited, with its IP address, country, and whether it's here now. You can **kick** people (sends them back to the lobby), **ban** a device, or **IP ban** a whole connection so nobody on it can get into the site. The admin code is checked on the server and stored only as a hash. 8 wrong tries locks that IP out for 15 minutes. The database setup is in `supabase/admin.sql`.
