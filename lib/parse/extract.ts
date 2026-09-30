import { classifyToken, expandCompound, impliedResolution, splitGroupSuffix } from './tokens';
import type { Quality } from './types';

/**
 * The quality signals hidden in a run of junk tokens. Shared by the
 * movies/tv path (`lib/parse/video.ts`) and the scene path
 * (`lib/parse/scene.ts`) so the two never drift: a fix to one must not need
 * a matching fix to the other.
 */
export function extractQuality(tokens: readonly string[]): Quality {
  let resolution: string | null = null;
  // A frame-size word is worth less than a number. `UHD.BluRay.1080p` is a
  // 1080p encode of a UHD disc and really is 1080p, so an explicit token
  // wins wherever it sits -- ten corpus names have the alias first.
  let aliased: string | null = null;
  let source: string | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  const hdr: string[] = [];
  const threeD: string[] = [];
  // `Bluray-2160p` must contribute both halves, so compounds are expanded.
  for (const raw of tokens.flatMap((t) => [...expandCompound(t)])) {
    // A group name fused to a tag hides the tag: `BLURAY-UNTOUCHED` and
    // `5.1-UnKn0wn` classify as nothing, because their right half is a group
    // and not vocabulary. The left half still says what it always said.
    const token = classifyToken(raw) === null
      ? splitGroupSuffix(raw)?.head ?? raw
      : raw;
    switch (classifyToken(token)) {
      case 'resolution': {
        const implied = impliedResolution(token);
        if (implied === null) resolution ??= token;
        else aliased ??= implied;
        break;
      }
      case 'source': source ??= token; break;
      case 'videoCodec': videoCodec ??= token; break;
      case 'audioCodec': audioCodec ??= token; break;
      case 'hdr': hdr.push(token); break;
      case 'threeD': threeD.push(token); break;
      // A broadcast standard stays ancillary -- it names a region, not a
      // frame size -- but it fixes one, so it can still answer when nothing
      // else does.
      default: aliased ??= impliedResolution(token); break;
    }
  }
  return { resolution: resolution ?? aliased, source, videoCodec, audioCodec, hdr, threeD };
}

export function collect(tokens: readonly string[], want: 'edition' | 'language'): readonly string[] {
  return tokens
    .flatMap((token) => [...expandCompound(token)])
    .filter((token) => classifyToken(token) === want);
}

export function titleFrom(tokens: readonly string[]): string {
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}
