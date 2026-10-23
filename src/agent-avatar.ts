/** Raster-only avatar payloads keep portable templates small and safe to render in an <img>. */
export const MAX_AGENT_AVATAR_BYTES = 48 * 1024;
export const MAX_AGENT_AVATAR_DATA_URL_CHARS = 65_536;
/** Keep imported team templates comfortably below the local HTTP request-size limit. */
export const MAX_TEAM_AVATAR_DATA_URL_CHARS = 500_000;

/** Validate a canonical base64 data URL and its raster file signature. SVG and remote URLs fail. */
export function isSafeAgentAvatarDataUrl(value: string): boolean {
  if (value.length > MAX_AGENT_AVATAR_DATA_URL_CHARS) return false;
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const [, mime, encoded] = match;
  if (encoded.length % 4 !== 0) return false;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  if (
    !decoded.length ||
    decoded.length > MAX_AGENT_AVATAR_BYTES ||
    btoa(decoded) !== encoded
  )
    return false;
  const byte = (index: number) => decoded.charCodeAt(index);
  if (mime === "png")
    return (
      decoded.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (value, index) => byte(index) === value,
      )
    );
  if (mime === "jpeg")
    return (
      decoded.length >= 3 &&
      byte(0) === 0xff &&
      byte(1) === 0xd8 &&
      byte(2) === 0xff
    );
  return (
    decoded.length >= 12 &&
    decoded.slice(0, 4) === "RIFF" &&
    decoded.slice(8, 12) === "WEBP"
  );
}
