import { describePersistentContract } from './contract/persistentContract';
import { awsPersistentHarness } from './contract/awsPersistentHarness';

describePersistentContract('aws', awsPersistentHarness);
