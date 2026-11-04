#!/bin/bash
# Prepare a movie file for movie night: one MP4 that plays in Firefox (macOS, and Android GeckoView browsers),
# Chrome and Safari. See docs/movie-night.md for the device results behind these choices.
#
# usage: prepare-movie.sh [--hdr] INPUT OUTPUT.mp4
#   default  picture copied untouched (H.264, or SDR HEVC tagged hvc1); sound -> AAC stereo 256k.
#            Refuses HDR sources: Firefox does not render HDR correctly, so those need --hdr.
#   --hdr    HDR10 / Dolby Vision -> SDR, tone-mapped once on the GPU (libplacebo bt.2390, Dolby Vision metadata
#            applied), re-encoded HEVC 10-bit on NVENC. Needs an ffmpeg with libplacebo, Vulkan and NVENC
#            (jellyfin-ffmpeg 8.1 portable works).
# env: FFMPEG / FFPROBE (default: on PATH), START and DURATION in seconds for a test clip,
#      VBITRATE / VMAX / VBUF for --hdr (default 26M / 38M / 76M).
set -euo pipefail
HDR=0
if [ "${1:-}" = "--hdr" ]; then HDR=1; shift; fi
IN=${1:?usage: prepare-movie.sh [--hdr] INPUT OUTPUT.mp4}
OUT=${2:?usage: prepare-movie.sh [--hdr] INPUT OUTPUT.mp4}
FF=${FFMPEG:-ffmpeg}
FP=${FFPROBE:-ffprobe}
CLIP=()
[ -n "${START:-}" ] && CLIP+=(-ss "$START")
[ -n "${DURATION:-}" ] && CLIP+=(-t "$DURATION")
COMMON=(-map 0:v:0 -map 0:a:0 -map_chapters -1 -c:a aac -b:a 256k -ac 2 -movflags +faststart)
IFS=, read -r codec transfer < <("$FP" -v error -select_streams v:0 -show_entries stream=codec_name,color_transfer -of csv=p=0 "$IN")

if [ "$HDR" = 1 ]; then
  "$FF" -hide_banner -y -init_hw_device vulkan=vk:0 -filter_hw_device vk -hwaccel vulkan -hwaccel_output_format vulkan \
    ${CLIP[@]+"${CLIP[@]}"} -i "$IN" \
    -vf "libplacebo=format=p010le:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:gamut_mode=perceptual:peak_detect=1:apply_dolbyvision=1,hwdownload,format=p010le" \
    -c:v hevc_nvenc -preset p7 -tune hq -rc vbr -b:v "${VBITRATE:-26M}" -maxrate "${VMAX:-38M}" -bufsize "${VBUF:-76M}" \
    -profile:v main10 -spatial_aq 1 -temporal_aq 1 -rc-lookahead 32 -multipass fullres -bf 4 -b_ref_mode middle -tag:v hvc1 \
    -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
    "${COMMON[@]}" "$OUT"
else
  case "$transfer" in
    smpte2084|arib-std-b67) echo "HDR source ($transfer): run with --hdr" >&2; exit 2 ;;
  esac
  case "$codec" in
    h264) TAG=() ;;
    hevc) TAG=(-tag:v hvc1) ;;
    *) echo "video codec $codec: re-encode it (not handled here)" >&2; exit 2 ;;
  esac
  "$FF" -hide_banner -y ${CLIP[@]+"${CLIP[@]}"} -i "$IN" -c:v copy ${TAG[@]+"${TAG[@]}"} "${COMMON[@]}" "$OUT"
fi
