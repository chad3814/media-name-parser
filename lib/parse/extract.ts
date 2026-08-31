import { classifyToken, expandCompound } from './tokens';
import type { Quality } from './types';

/**
 * The quality signals hidden in a run of junk tokens. Shared by the
 * movies/tv path (`lib/parse/video.ts`) and the scene path
 * (`lib/parse/scene.ts`) so the two never drift: a fix to one must not need
 * a matching fix to the other.
 */
export function extractQuality(tokens: readonly string[]): Quality {
  let resolution: string | null = null;
  let source: string | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  const hdr: string[] = [];
  const threeD: string[] = [];
  // `Bluray-2160p` must contribute both halves, so compounds are expanded.
  for (const token of tokens.flatMap((t) => [...expandCompound(t)])) {
    switch (classifyToken(token)) {
      case 'resolution': resolution ??= token; break;
      // `UHD` classifies as a source; an explicit `1080p` elsewhere still wins
      // because `resolution` is set only from the resolution class.
      case 'source': source ??= token; break;
      case 'videoCodec': videoCodec ??= token; break;
      case 'audioCodec': audioCodec ??= token; break;
      case 'hdr': hdr.push(token); break;
      case 'threeD': threeD.push(token); break;
      default: break;
    }
  }
  return { resolution, source, videoCodec, audioCodec, hdr, threeD };
}

export function collect(tokens: readonly string[], want: 'edition' | 'language'): readonly string[] {
  return tokens
    .flatMap((token) => [...expandCompound(token)])
    .filter((token) => classifyToken(token) === want);
}

export function titleFrom(tokens: readonly string[]): string {
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}
