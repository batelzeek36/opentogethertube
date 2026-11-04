# Movie night: running this fork as a private watch party

How this fork is run for private movie nights: one host, the monolith in Docker, movie files served next to it,
everything reached through one Cloudflare named tunnel. The config files live in `deploy/movie-night/`.
Private values (the file token, room names, accounts, the real hostname) never go in this repository.

## Layout on the host

`~/movie-night/` holds:

| Path | What it is |
|---|---|
| `docker-compose.yml` | the stack: `ott` (built from this repo), `redis`, `postgres`. Copy of `deploy/movie-night/docker-compose.yml` |
| `env/production.toml` | OTT config (direct files only, rate limits) |
| `movies/` | the movie files. Any `.mp4/.m4v/.mov/.webm` dropped here is served at once |
| `route.txt` | `/<token>/`: a long random string. It is the only thing guarding the files, keep it private |
| `serve.mjs` | the file server (`deploy/movie-night/serve.mjs`): `/<token>/<slug>` on 127.0.0.1:8977, with Range requests |
| `tunnel.yml` | cloudflared config (template: `tunnel.example.yml`): files and site on one hostname |

A file's link is `https://<host>/<token>/<slug>`, where the slug is the file name with every run of
non-alphanumerics turned into `-`: `The Movie (2026).mp4` becomes `The-Movie-2026.mp4`.

## Resource protection

Everything movie night runs on sits in one systemd slice, so CI jobs, renders or builds on the same host cannot
starve it. The weights only matter under contention: when nobody is watching, the stack uses almost nothing and
the rest of the machine gets everything.

- `systemd/movie.slice`: `CPUWeight=10000` (the default for `user.slice` and `system.slice` is 100),
  `IOWeight=10000`, `MemoryMin=4G` (protects up to 4 GB the group actually uses; it does not reserve memory).
- `systemd/movie-serve.service`, `systemd/movie-tunnel.service`: the file server and the tunnel, in the slice,
  `Restart=always`, enabled at boot.
- `docker-compose.yml`: `cgroup_parent: movie.slice` and `restart: unless-stopped` on all three containers
  (needs Docker's systemd cgroup driver, the default on systemd distros).
- `movie-qos` (install to `/usr/local/sbin/`): network priority on the uplink. Internet-bound traffic is capped
  just under the measured upload (default 220 Mbit/s, set `MOVIE_QOS_CAP`) so the queue forms on the host, where
  packets from sockets in `movie.slice` always go first. LAN traffic is not capped. The tunnel unit runs it on
  every start (`ExecStartPost=-+`, so a failure there never stops the tunnel). Edit `DEV` for your interface.
  The cap applies to all internet uploads from the host at all times; the priority only matters while movie
  traffic is flowing.

Install: copy the units to `/etc/systemd/system/`, `systemctl daemon-reload`,
`systemctl enable --now movie-serve movie-tunnel`, then `docker compose up -d --force-recreate` in `~/movie-night`.
Check with `systemd-cgls -u movie.slice` and `sudo movie-qos status`.

Undo: `sudo movie-qos stop`, `systemctl disable --now movie-tunnel movie-serve`, remove the `cgroup_parent`
lines and recreate the containers.

Gotchas:
- nftables `socket cgroupv2` does not work in the postrouting hook ("Operation not supported"); mark in the
  output hook, classify everything else in postrouting.
- The rule resolves the slice to its cgroup id when loaded. If the slice is ever recreated, rerun `movie-qos start`
  (restarting the tunnel does it).
- `redis` has no volume: recreating it logs everyone out and drops the room states held there. Rooms reload from
  Postgres (`prevQueue`). `postgres` keeps its anonymous volume across `docker compose up --force-recreate`;
  check the mount name before and after anyway, and `pg_dump` first.

## Preparing a movie

Tested 2026-11-03 on Firefox 160 (macOS), an Android GeckoView browser (Firefox 157 engine, Galaxy S25) with
2-minute 4K clips. Safari on iPhone was not tested; Apple's documentation is quoted where it applies.

| | Firefox macOS | Android GeckoView |
|---|---|---|
| HEVC Main 10, 4K, tagged `hvc1` | plays, 0 dropped frames | plays, 0 dropped frames |
| HDR10 / Dolby Vision picture | plays, but mapped to SDR wrongly (too dark) | plays, washed out |
| Dolby Vision `dvh1` | not supported | not supported |
| AAC stereo | plays | plays |
| AAC 5.1 from ffmpeg's encoder | whole file fails ("AAC cookie" error) | plays |
| FLAC 5.1 in MP4 | plays | plays |
| E-AC3 (Dolby Digital Plus) | video plays, no sound | video plays, no sound |

Rules that follow:
- MP4 with `+faststart`, one video and one audio track, chapters dropped. MKV does not play in Safari.
- HEVC must carry the `hvc1` tag (Safari refuses `hev1`).
- Sound: AAC stereo 256k plays everywhere. Never AAC 5.1 from ffmpeg (breaks Firefox on macOS), never E-AC3,
  AC3, DTS or TrueHD.
- HDR sources: tone-map once to SDR. Firefox does not render HDR correctly (Mozilla's support page says so), and
  each browser maps it differently. libplacebo's `bt.2390` with the Dolby Vision metadata applied gave the most
  natural picture; Jellyfin's `tonemap_cuda` came out flatter and greyer on the same frame.

`deploy/movie-night/prepare-movie.sh` does both cases:

```bash
# SDR source (H.264 or HEVC): picture copied untouched, sound to AAC stereo. Minutes.
prepare-movie.sh "in.mkv" "~/movie-night/movies/The Movie (2026).mp4"
# HDR10 / Dolby Vision source: tone-mapped SDR, HEVC 10-bit on NVENC (GPU-bound, ~0.8x real time at 4K on an RTX 3080)
FFMPEG=/path/to/jellyfin-ffmpeg/ffmpeg FFPROBE=/path/to/jellyfin-ffmpeg/ffprobe \
  prepare-movie.sh --hdr "in.mkv" "out.mp4"
# test clip first: START=1200 DURATION=20 prepare-movie.sh ...
```

Write long encodes outside `movies/` and move the finished file in, or viewers can be handed a half-written file.
The `--hdr` path needs an ffmpeg with libplacebo, Vulkan and NVENC; the jellyfin-ffmpeg 8.1 portable Linux build
has all three. Distro ffmpeg 4.x drops the Dolby Vision record and has neither.

Bandwidth: each viewer pulls the file's bitrate (4K SDR at the defaults: ~26 Mbit/s average, peaks near 38).

## Adding a room

Normal way (standard OTT behaviour): log in, create a permanent unlisted room, paste the movie link into the
add box, then set the room's permissions so viewers can only chat, and "restore queue" to always.

Settings the rooms here use: `visibility=unlisted`, `queueMode=manual`, `restoreQueueBehavior=2` (always),
permissions `[[0,128],[1,128],[2,128],...]` (roles 0-2 may only chat; reactions ride on chat).

## Deploying a new build of the fork

1. Merge the branch to `master` with `--no-ff`, push, `git pull` in the clean clone the compose file builds from.
2. `docker tag <project>-ott:latest <project>-ott:before-<change>` (rollback) and `pg_dump` the database.
3. `docker compose build ott` (does not touch the running container).
4. Only when nobody is watching: `docker compose up -d --force-recreate ott`. Everyone reloads the page.
5. Verify: `/api/status` 200, each room's current movie and owner (redis key `room:<name>`), a chat reaction
   between two browsers.

Known issue: a restart of `ott` has dropped a playing room's current movie once (owner and settings kept), cause
not found. After any restart, check every room still has its movie and re-add it if not.

## Checking playback on real devices

`deploy/movie-night/lab/` is a codec lab: a page that reports `canPlayType`, Media Capabilities, and for each test
clip whether it plays, frames decoded and dropped, and whether sound decoded, and posts the results back to the
host. Run `lab-server.mjs` (127.0.0.1:8981), route `^/<token>/lab/` to it in `tunnel.yml` above the movie-files
rule, put 2-minute clips named like `index.html` expects in `~/movie-night/lab/`, and open
`https://<host>/<token>/lab/` on each device. Results land in `~/movie-night/lab/reports.jsonl`. Remove the route
afterwards.
