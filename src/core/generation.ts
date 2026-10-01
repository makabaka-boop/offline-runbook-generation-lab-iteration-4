/** 安装代次与 Cache Storage 键名的共享规则。页面、协调器、SW 必须使用同一判定。 */
export const MANUAL_CACHE_PREFIX = 'manual:stage:';

export interface InstallGeneration {
  version: string;
  installId: string;
}

export const stageCacheNameFor = (version: string, installId: number | string) =>
  `${MANUAL_CACHE_PREFIX}${version}:${installId}`;

export const installGenerationFromCacheName = (cacheName: string): InstallGeneration | null => {
  if (!cacheName.startsWith(MANUAL_CACHE_PREFIX)) return null;
  const body = cacheName.slice(MANUAL_CACHE_PREFIX.length);
  const separator = body.lastIndexOf(':');
  if (separator <= 0 || separator === body.length - 1) return null;
  return {
    version: body.slice(0, separator),
    installId: body.slice(separator + 1),
  };
};

export const cacheNameMatchesGeneration = (cacheName: string, generation: string): boolean =>
  installGenerationFromCacheName(cacheName)?.installId === generation;
