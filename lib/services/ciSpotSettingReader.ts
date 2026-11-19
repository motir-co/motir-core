import type { CiSpotSettingValue } from '@/lib/dto/ciSpotSetting';
import { toCiSpotSettingValue } from '@/lib/mappers/ciSpotSettingMappers';
import { platformCiSpotSettingRepository } from '@/lib/repositories/platformCiSpotSettingRepository';

// THE CI SPOT SETTING'S SYSTEM READ (MOTIR-11725 · MOTIR-11716), on its own so the
// launch path can import it. The CI runner boot and the CI shard's AWS adapter
// read the setting on every launch; `ciSpotSettingService` also holds the
// superadmin read and save, which import `lib/platform/auth`, and that module
// reads the auth env at import time. Importing the service from the boot pulled
// it into the job registry's graph, which the Docs guards lane loads with no auth
// env. This module imports only the repository and the mapper.

export const ciSpotSettingReader = {
  /**
   * What a CI runner launch goes by. No principal, no session and no platform
   * transaction: the table's SELECT arm is unconditional. No row ⇒
   * `{ enabled: false, instanceTypes: CI_SPOT_DEFAULT_INSTANCE_TYPES }`; it never
   * throws for a missing row. Read from the database on every call.
   */
  async read(): Promise<CiSpotSettingValue> {
    return toCiSpotSettingValue(await platformCiSpotSettingRepository.find());
  },
};
