import type { DeviceGrantTokenDTO, DeviceGrantUpdatedDTO } from '@/lib/dto/cliDevice';

/**
 * Narrow a device poll's answer to the MINTED credential a `motir login` grant
 * returns. Since MOTIR-10189 the poll also answers `{ updated: true }` for a
 * `motir auth refresh` grant; a login test that gets that has found a bug, so it
 * fails loudly here instead of reading `access_token` off the wrong shape.
 */
export function asMinted(answer: DeviceGrantTokenDTO | DeviceGrantUpdatedDTO): DeviceGrantTokenDTO {
  if ('updated' in answer)
    throw new Error('Expected a minted token, got an update grant’s answer.');
  return answer;
}
