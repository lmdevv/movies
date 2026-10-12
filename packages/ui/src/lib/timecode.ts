/**
 * Format a playback position as a timecode: `m:ss` under an hour, `h:mm:ss` from an hour.
 * Negative values get a leading minus, as remaining time does (`-1:33:18`).
 *
 * @param seconds - Position in seconds; fractions are dropped and non-finite values read as 0.
 */
export function formatTimecode(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.trunc(seconds) : 0;
  const sign = whole < 0 ? "-" : "";
  const total = Math.abs(whole);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");

  return hours > 0
    ? `${sign}${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${sign}${minutes}:${rest}`;
}
