import type { ResourceRef } from './types';

/**
 * 资源清单的规范化序列化：字段顺序固定，并在计算前统一摘要大小写。
 * 安装协调器、目录生成脚本必须使用同一份规则，才能得到相同的整单摘要。
 */
export function canonicalResourceList(resources: ResourceRef[]): string {
  return JSON.stringify(
    resources.map((ref) => ({
      kind: ref.kind,
      sha256: ref.sha256.trim().toLowerCase().replace(/^sha256-/, ''),
      url: ref.url,
    })),
  );
}

export function encodeCanonicalResourceList(resources: ResourceRef[]): Uint8Array {
  return new TextEncoder().encode(canonicalResourceList(resources));
}
